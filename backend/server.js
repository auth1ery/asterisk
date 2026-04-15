const express    = require('express');
const { WebSocketServer } = require('ws');
const http       = require('http');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const fs         = require('fs');
const path       = require('path');
const cors       = require('cors');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT        || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || '*';
const DATA_DIR     = path.join(__dirname, 'data');

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const f = path.join(DATA_DIR, '.secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = require('crypto').randomBytes(48).toString('hex');
  fs.writeFileSync(f, s);
  return s;
})();

const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const FRIENDS_FILE  = path.join(DATA_DIR, 'friends.json');
const DMS_FILE      = path.join(DATA_DIR, 'dms.json');

const MAX_MESSAGES    = 1000;
const HISTORY_SEND    = 200;
const MAX_DM_STORED   = 500;
const DM_HISTORY_SEND = 100;
const RATE_LIMIT      = 20;
const RATE_WINDOW     = 60 * 1000;

// ── Disk helpers ──────────────────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const loadJSON = (file, def) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return def; }
};
const saveJSON = (file, data) =>
  fs.writeFileSync(file, JSON.stringify(data, null, 2));

let accounts    = loadJSON(ACCOUNTS_FILE, {});
let messages    = loadJSON(MESSAGES_FILE, []);
let friendships = loadJSON(FRIENDS_FILE, { requests: [], accepted: [] });
let dms         = loadJSON(DMS_FILE, {});

// ── In-memory state ───────────────────────────────────────────────────────────
const clients     = new Map();  // ws → { username, color }
const typingUsers = new Map();  // username → timeoutId
const userRates   = new Map();  // username → { count, resetTime }

// ── WS send helpers ───────────────────────────────────────────────────────────
const push = (ws, data) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
};

function pushToUser(username, data) {
  for (const [ws, info] of clients) {
    if (info.username === username) push(ws, data);
  }
}

// ── Friend helpers ────────────────────────────────────────────────────────────
const areFriends = (a, b) =>
  friendships.accepted.some(f => f.users.includes(a) && f.users.includes(b));

const hasPending = (from, to) =>
  friendships.requests.some(r => r.from === from && r.to === to);

function getFriends(username) {
  return friendships.accepted
    .filter(f => f.users.includes(username))
    .map(f => {
      const other = f.users.find(u => u !== username);
      return { username: other, color: accounts[other.toLowerCase()]?.color || '#888' };
    });
}

function buildFriendsState(username) {
  return {
    type:     'friends_state',
    friends:  getFriends(username),
    incoming: friendships.requests
      .filter(r => r.to === username)
      .map(r => ({ id: r.id, from: r.from, color: accounts[r.from.toLowerCase()]?.color || '#888' })),
    outgoing: friendships.requests
      .filter(r => r.from === username)
      .map(r => ({ id: r.id, to: r.to }))
  };
}

// ── Message helpers ───────────────────────────────────────────────────────────
function appendMessage(msg) {
  messages.push(msg);
  if (messages.length > MAX_MESSAGES)
    messages.splice(0, messages.length - MAX_MESSAGES);
  saveJSON(MESSAGES_FILE, messages);
}

const dmKey = (a, b) => [a, b].sort().join(':');

function appendDM(a, b, msg) {
  const key = dmKey(a, b);
  if (!dms[key]) dms[key] = [];
  dms[key].push(msg);
  if (dms[key].length > MAX_DM_STORED)
    dms[key].splice(0, dms[key].length - MAX_DM_STORED);
  saveJSON(DMS_FILE, dms);
}

// ── Rate limit ────────────────────────────────────────────────────────────────
function checkRate(username) {
  const now = Date.now();
  let r = userRates.get(username);
  if (!r || now > r.resetTime) r = { count: 0, resetTime: now + RATE_WINDOW };
  if (r.count >= RATE_LIMIT) {
    userRates.set(username, r);
    return { allowed: false, remaining: 0, reset: r.resetTime };
  }
  r.count++;
  userRates.set(username, r);
  return { allowed: true, remaining: RATE_LIMIT - r.count, reset: r.resetTime };
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());

app.get('/api/health', (_, res) => res.json({ ok: true }));

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
};

// ── Register ──────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });
  if (username.length < 2 || username.length > 20)
    return res.status(400).json({ error: 'Username must be 2–20 characters.' });
  if (!/^[a-zA-Z0-9_-]+$/.test(username))
    return res.status(400).json({ error: 'Username: letters, numbers, _ and - only.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (accounts[username.toLowerCase()])
    return res.status(409).json({ error: 'That username is taken.' });

  const hash  = await bcrypt.hash(password, 10);
  const color = `hsl(${Math.floor(Math.random() * 360)},70%,68%)`;
  accounts[username.toLowerCase()] = { username, hash, color };
  saveJSON(ACCOUNTS_FILE, accounts);

  const token = jwt.sign({ username, color }, JWT_SECRET);
  res.json({ token, username, color });
});

// ── Login ─────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const account = accounts[username?.toLowerCase()];
  if (!account || !await bcrypt.compare(password, account.hash))
    return res.status(401).json({ error: 'Invalid credentials.' });
  const token = jwt.sign({ username: account.username, color: account.color }, JWT_SECRET);
  res.json({ token, username: account.username, color: account.color });
});

// ── Verify ────────────────────────────────────────────────────────────────────
app.get('/api/verify', auth, (req, res) => {
  res.json({ username: req.user.username, color: req.user.color });
});

// ── Friends: get ──────────────────────────────────────────────────────────────
app.get('/api/friends', auth, (req, res) => {
  res.json(buildFriendsState(req.user.username));
});

// ── Friends: send request ─────────────────────────────────────────────────────
app.post('/api/friends/request', auth, (req, res) => {
  const me  = req.user.username;
  const { to } = req.body || {};

  if (!to)
    return res.status(400).json({ error: 'Missing target.' });
  if (to.toLowerCase() === me.toLowerCase())
    return res.status(400).json({ error: "Can't friend yourself." });
  if (!accounts[to.toLowerCase()])
    return res.status(404).json({ error: 'User not found.' });
  if (areFriends(me, to))
    return res.status(409).json({ error: 'Already friends.' });
  if (hasPending(me, to))
    return res.status(409).json({ error: 'Request already sent.' });

  // Mutual request → auto-accept
  const mutual = friendships.requests.find(r => r.from === to && r.to === me);
  if (mutual) {
    friendships.requests = friendships.requests.filter(r => r !== mutual);
    friendships.accepted.push({
      id: Math.random().toString(36).slice(2),
      users: [me, to].sort(),
      timestamp: Date.now()
    });
    saveJSON(FRIENDS_FILE, friendships);
    const toColor = accounts[to.toLowerCase()]?.color || '#888';
    pushToUser(me,  { type: 'friend_accepted', username: to,  color: toColor });
    pushToUser(to,  { type: 'friend_accepted', username: me,  color: req.user.color });
    return res.json({ status: 'accepted' });
  }

  const r = { id: Math.random().toString(36).slice(2), from: me, to, timestamp: Date.now() };
  friendships.requests.push(r);
  saveJSON(FRIENDS_FILE, friendships);
  pushToUser(to, { type: 'friend_request', id: r.id, from: me, color: req.user.color });
  res.json({ status: 'sent' });
});

// ── Friends: accept ───────────────────────────────────────────────────────────
app.post('/api/friends/accept', auth, (req, res) => {
  const me   = req.user.username;
  const { from } = req.body || {};
  const r = friendships.requests.find(r => r.from === from && r.to === me);
  if (!r) return res.status(404).json({ error: 'Request not found.' });

  friendships.requests = friendships.requests.filter(x => x !== r);
  friendships.accepted.push({
    id: Math.random().toString(36).slice(2),
    users: [me, from].sort(),
    timestamp: Date.now()
  });
  saveJSON(FRIENDS_FILE, friendships);

  const fromColor = accounts[from.toLowerCase()]?.color || '#888';
  pushToUser(me,   { type: 'friend_accepted', username: from, color: fromColor });
  pushToUser(from, { type: 'friend_accepted', username: me,   color: req.user.color });
  res.json({ status: 'accepted' });
});

// ── Friends: reject ───────────────────────────────────────────────────────────
app.post('/api/friends/reject', auth, (req, res) => {
  const me   = req.user.username;
  const { from } = req.body || {};
  friendships.requests = friendships.requests.filter(r => !(r.from === from && r.to === me));
  saveJSON(FRIENDS_FILE, friendships);
  res.json({ status: 'rejected' });
});

// ── Friends: cancel outgoing ──────────────────────────────────────────────────
app.post('/api/friends/cancel', auth, (req, res) => {
  const me  = req.user.username;
  const { to } = req.body || {};
  friendships.requests = friendships.requests.filter(r => !(r.from === me && r.to === to));
  saveJSON(FRIENDS_FILE, friendships);
  res.json({ status: 'cancelled' });
});

// ── Friends: remove ───────────────────────────────────────────────────────────
app.delete('/api/friends/:username', auth, (req, res) => {
  const me    = req.user.username;
  const other = req.params.username;
  friendships.accepted = friendships.accepted.filter(
    f => !(f.users.includes(me) && f.users.includes(other))
  );
  saveJSON(FRIENDS_FILE, friendships);
  pushToUser(me,    { type: 'friend_removed', username: other });
  pushToUser(other, { type: 'friend_removed', username: me });
  res.json({ status: 'removed' });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

function broadcast(data, skip = null) {
  const s = JSON.stringify(data);
  wss.clients.forEach(c => { if (c !== skip && c.readyState === 1) c.send(s); });
}
const broadcastAll = data => broadcast(data, null);

function userList()     { return [...clients.values()]; }
function syncUserList() { broadcastAll({ type: 'user_list', users: userList() }); }
function syncTyping()   { broadcastAll({ type: 'typing',   users: [...typingUsers.keys()] }); }

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  let user;
  try   { user = jwt.verify(params.get('token'), JWT_SECRET); }
  catch { ws.close(1008, 'Unauthorized'); return; }

  // Kick duplicate session
  for (const [oldWs, info] of clients) {
    if (info.username === user.username) {
      push(oldWs, { type: 'kicked', reason: 'Signed in from another window.' });
      oldWs.close();
    }
  }

  clients.set(ws, { username: user.username, color: user.color });

  // Send initial state
  push(ws, { type: 'history', messages: messages.slice(-HISTORY_SEND) });
  push(ws, buildFriendsState(user.username));
  syncUserList();

  // Broadcast join
  const joinMsg = {
    type: 'system', id: Math.random().toString(36).slice(2),
    text: `${user.username} joined`, timestamp: Date.now()
  };
  appendMessage(joinMsg);
  broadcast(joinMsg, ws);

  // ── Incoming messages ─────────────────────────────────────────────────────
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const self = clients.get(ws);
    if (!self) return;

    switch (msg.type) {

      case 'message': {
        const text = msg.text?.trim();
        if (!text || text.length > 2000) return;

        const rate = checkRate(self.username);
        push(ws, { type: 'rate_limit', remaining: rate.remaining, reset: rate.reset });
        if (!rate.allowed) return;

        if (typingUsers.has(self.username)) {
          clearTimeout(typingUsers.get(self.username));
          typingUsers.delete(self.username);
          syncTyping();
        }

        const m = {
          type: 'message', id: Math.random().toString(36).slice(2),
          username: self.username, color: self.color, text, timestamp: Date.now()
        };
        appendMessage(m);
        broadcastAll(m);
        break;
      }

      case 'dm': {
        const { to, text } = msg;
        if (!to || !text?.trim() || text.trim().length > 2000) return;
        if (!areFriends(self.username, to)) return; // must be friends

        const rate = checkRate(self.username);
        push(ws, { type: 'rate_limit', remaining: rate.remaining, reset: rate.reset });
        if (!rate.allowed) return;

        const m = {
          type: 'dm', id: Math.random().toString(36).slice(2),
          from: self.username, to, color: self.color,
          text: text.trim(), timestamp: Date.now()
        };
        appendDM(self.username, to, m);
        push(ws, m);         // echo to sender
        pushToUser(to, m);   // deliver to recipient
        break;
      }

      case 'dm_history': {
        if (!msg.with) return;
        if (!areFriends(self.username, msg.with)) return;
        const history = (dms[dmKey(self.username, msg.with)] || []).slice(-DM_HISTORY_SEND);
        push(ws, { type: 'dm_history', with: msg.with, messages: history });
        break;
      }

      case 'typing': {
        if (typingUsers.has(self.username)) clearTimeout(typingUsers.get(self.username));
        const t = setTimeout(() => { typingUsers.delete(self.username); syncTyping(); }, 3500);
        typingUsers.set(self.username, t);
        syncTyping();
        break;
      }

      case 'stop_typing': {
        if (typingUsers.has(self.username)) {
          clearTimeout(typingUsers.get(self.username));
          typingUsers.delete(self.username);
          syncTyping();
        }
        break;
      }
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  ws.on('close', () => {
    const self = clients.get(ws);
    if (!self) return;
    clients.delete(ws);

    if (typingUsers.has(self.username)) {
      clearTimeout(typingUsers.get(self.username));
      typingUsers.delete(self.username);
    }

    syncUserList();
    syncTyping();

    const leaveMsg = {
      type: 'system', id: Math.random().toString(36).slice(2),
      text: `${self.username} left`, timestamp: Date.now()
    };
    appendMessage(leaveMsg);
    broadcastAll(leaveMsg);
  });

  ws.on('error', err => console.error('[ws error]', err.message));
});

server.listen(PORT, () => {
  console.log(`\n  * asterisk backend\n  → http://localhost:${PORT}\n`);
});