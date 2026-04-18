require('dotenv').config({ path: __dirname + '/.env' })
const express          = require('express');
const { WebSocketServer } = require('ws');
const http             = require('http');
const bcrypt           = require('bcrypt');
const jwt              = require('jsonwebtoken');
const fs               = require('fs');
const path             = require('path');
const cors             = require('cors');
const multer           = require('multer');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT        || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || '*';
const DATA_DIR     = path.join(__dirname, 'data');

// ── Disk helpers ──────────────────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const loadJSON = (file, def) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return def; }
};
const saveJSON = (file, data) =>
  fs.writeFileSync(file, JSON.stringify(data, null, 2));

// ── Constants ─────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || (() => {
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
const NODES_FILE    = path.join(DATA_DIR, 'nodes.json');

const CHANNELS        = ['global', 'debate', 'gaming', 'music'];
const MAX_MESSAGES    = 30000;
const HISTORY_SEND    = 6000;
const MAX_DM_STORED   = 5000;
const DM_HISTORY_SEND = 100;
const RATE_LIMIT      = 20;
const RATE_WINDOW     = 60 * 1000;

// ── Load state ────────────────────────────────────────────────────────────────
let accounts    = loadJSON(ACCOUNTS_FILE, {});
let messages    = loadJSON(MESSAGES_FILE, {});
let friendships = loadJSON(FRIENDS_FILE,  { requests: [], accepted: [] });
let dms         = loadJSON(DMS_FILE,      {});
let nodes       = loadJSON(NODES_FILE,    {});

CHANNELS.forEach(ch => { if (!messages[ch]) messages[ch] = []; });

// ── Migrate existing nodes to per-channel messages ────────────────────────────
let nodesDirty = false, msgsDirty = false;
Object.values(nodes).forEach(node => {
  if (!node.channels) {
    node.channels = ['general'];
    nodesDirty = true;
  }
  const oldKey = `node:${node.id}`;
  const newKey = `node:${node.id}:general`;
  if (messages[oldKey] && !messages[newKey]) {
    messages[newKey] = messages[oldKey];
    delete messages[oldKey];
    msgsDirty = true;
  } else if (!messages[newKey]) {
    messages[newKey] = [];
    msgsDirty = true;
  }
});
if (nodesDirty) saveJSON(NODES_FILE, nodes);
if (msgsDirty)  saveJSON(MESSAGES_FILE, messages);

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

function pushToNodeMembers(nodeId, data) {
  const node = nodes[nodeId];
  if (!node) return;
  for (const [ws, info] of clients)
    if (node.members.includes(info.username)) push(ws, data);
}

// ── Message helpers ───────────────────────────────────────────────────────────
function appendMessage(msg, channel = 'global') {
  if (!messages[channel]) messages[channel] = [];
  messages[channel].push(msg);
  if (messages[channel].length > MAX_MESSAGES)
    messages[channel].splice(0, messages[channel].length - MAX_MESSAGES);
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

const upload = multer({
  dest: path.join(DATA_DIR, 'uploads'),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB max
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/webm', 'video/ogg',
      'text/plain'
    ];
    cb(null, allowed.includes(file.mimetype));
  }
});

app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));

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

// the files

app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// ── Friends: get ──────────────────────────────────────────────────────────────
app.get('/api/friends', auth, (req, res) => {
  res.json(buildFriendsState(req.user.username));
});

// gif
app.get('/api/giphy', async (req, res) => {
  const key = process.env.GIPHY_KEY;
  if (!key) return res.status(500).json({ error: 'GIPHY_KEY not set' });

  const { endpoint = 'trending', limit = 20, q } = req.query;
  const base = 'https://api.giphy.com/v1/gifs';
  const url = endpoint === 'search'
    ? `${base}/search?api_key=${key}&q=${encodeURIComponent(q)}&limit=${limit}`
    : `${base}/trending?api_key=${key}&limit=${limit}`;

  const response = await fetch(url);
  const data = await response.json();
  res.json(data);
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

// ── Nodes ─────────────────────────────────────────────────────────────────────
app.post('/api/nodes', auth, (req, res) => {
  const me = req.user.username;
  const { name } = req.body || {};
  if (!name?.trim() || name.length < 2 || name.length > 32)
    return res.status(400).json({ error: 'Name must be 2–32 chars.' });
  const all = Object.values(nodes);
  if (all.filter(n => n.owner === me).length >= 2)
    return res.status(400).json({ error: 'Max 2 nodes owned.' });
  if (all.filter(n => n.members.includes(me)).length >= 4)
    return res.status(400).json({ error: 'Max 4 nodes joined.' });
  const id = require('crypto').randomBytes(6).toString('hex');
  nodes[id] = {
    id, name: name.trim(), owner: me,
    members: [me], banned: [], invites: [],
    channels: ['general']         
  };
  messages[`node:${id}:general`] = [];
  saveJSON(NODES_FILE, nodes);
  saveJSON(MESSAGES_FILE, messages);
  res.json(nodes[id]);
});

app.get('/api/nodes/mine', auth, (req, res) => {
  const me = req.user.username;
  res.json(Object.values(nodes).filter(n => n.members.includes(me))
    .map(n => ({ id: n.id, name: n.name, owner: n.owner, memberCount: n.members.length })));
});

app.get('/api/nodes/discover', auth, (req, res) => {
  const me = req.user.username;
  res.json(Object.values(nodes).filter(n => !n.members.includes(me) && !n.banned.includes(me))
    .map(n => ({ id: n.id, name: n.name, owner: n.owner, memberCount: n.members.length })));
});

app.get('/api/nodes/:id', auth, (req, res) => {
  const me = req.user.username;
  const node = nodes[req.params.id];
  if (!node || !node.members.includes(me)) return res.status(404).json({ error: 'Not found.' });
  res.json({
    id: node.id, name: node.name, owner: node.owner,
    channels: node.channels || ['general'], 
    members: node.members.map(u => ({
      username: u,
      color: accounts[u?.toLowerCase()]?.color || '#888'
    }))
  });
});

// ── Node channels: create ─────────────────────────────────────────────────────
app.post('/api/nodes/:id/channels', auth, (req, res) => {
  const me   = req.user.username;
  const node = nodes[req.params.id];
  if (!node || node.owner !== me) return res.status(403).json({ error: 'Not owner.' });
  if (!node.channels) node.channels = ['general'];
  if (node.channels.length >= 10) return res.status(400).json({ error: 'Max 10 channels.' });

  const raw   = req.body?.name?.trim() || '';
  const cname = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 24);
  if (cname.length < 2)            return res.status(400).json({ error: 'Name too short.' });
  if (node.channels.includes(cname)) return res.status(409).json({ error: 'Channel already exists.' });

  node.channels.push(cname);
  messages[`node:${node.id}:${cname}`] = [];
  saveJSON(NODES_FILE, nodes);
  saveJSON(MESSAGES_FILE, messages);
  pushToNodeMembers(node.id, { type: 'node_channel_created', nodeId: node.id, channel: cname });
  res.json({ channel: cname });
});

// ── Node channels: delete ─────────────────────────────────────────────────────
app.delete('/api/nodes/:id/channels/:channel', auth, (req, res) => {
  const me      = req.user.username;
  const node    = nodes[req.params.id];
  const channel = req.params.channel;
  if (!node || node.owner !== me)      return res.status(403).json({ error: 'Not owner.' });
  if (channel === 'general')           return res.status(400).json({ error: "Can't delete #general." });
  if (!node.channels?.includes(channel)) return res.status(404).json({ error: 'Channel not found.' });

  node.channels = node.channels.filter(c => c !== channel);
  delete messages[`node:${node.id}:${channel}`];
  saveJSON(NODES_FILE, nodes);
  saveJSON(MESSAGES_FILE, messages);
  pushToNodeMembers(node.id, { type: 'node_channel_deleted', nodeId: node.id, channel });
  res.json({ status: 'deleted' });
});

// Must come before /:id/join
app.post('/api/nodes/join/invite/:code', auth, (req, res) => {
  const me = req.user.username;
  const node = Object.values(nodes).find(n =>
    n.invites.some(i => i.code === req.params.code && i.expires > Date.now()));
  if (!node) return res.status(404).json({ error: 'Invalid or expired invite.' });
  if (node.banned.includes(me)) return res.status(403).json({ error: 'You are banned.' });
  if (!node.members.includes(me)) {
    if (Object.values(nodes).filter(n => n.members.includes(me)).length >= 4)
      return res.status(400).json({ error: 'Max 4 nodes joined.' });
    node.members.push(me);
    saveJSON(NODES_FILE, nodes);
  }
  res.json({ node: { id: node.id, name: node.name, owner: node.owner } });
});

app.post('/api/nodes/:id/join', auth, (req, res) => {
  const me = req.user.username;
  const node = nodes[req.params.id];
  if (!node) return res.status(404).json({ error: 'Node not found.' });
  if (node.banned.includes(me)) return res.status(403).json({ error: 'You are banned.' });
  if (!node.members.includes(me)) {
    if (Object.values(nodes).filter(n => n.members.includes(me)).length >= 4)
      return res.status(400).json({ error: 'Max 4 nodes joined.' });
    node.members.push(me);
    saveJSON(NODES_FILE, nodes);
  }
  res.json({ node: { id: node.id, name: node.name, owner: node.owner } });
});

app.post('/api/nodes/:id/leave', auth, (req, res) => {
  const me = req.user.username;
  const node = nodes[req.params.id];
  if (!node) return res.status(404).json({ error: 'Not found.' });
  if (node.owner === me) return res.status(400).json({ error: 'Owner cannot leave.' });
  node.members = node.members.filter(u => u !== me);
  saveJSON(NODES_FILE, nodes);
  res.json({ status: 'left' });
});

app.post('/api/nodes/:id/invite', auth, (req, res) => {
  const me = req.user.username;
  const node = nodes[req.params.id];
  if (!node || node.owner !== me) return res.status(403).json({ error: 'Not the owner.' });
  const code = require('crypto').randomBytes(5).toString('hex');
  node.invites.push({ code, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  saveJSON(NODES_FILE, nodes);
  res.json({ code });
});

app.post('/api/nodes/:id/kick/:username', auth, (req, res) => {
  const me = req.user.username;
  const node = nodes[req.params.id];
  if (!node || node.owner !== me) return res.status(403).json({ error: 'Not owner.' });
  const target = req.params.username;
  node.members = node.members.filter(u => u !== target);
  saveJSON(NODES_FILE, nodes);
  pushToUser(target, { type: 'node_kicked', nodeId: node.id, nodeName: node.name });
  res.json({ status: 'kicked' });
});

app.post('/api/nodes/:id/ban/:username', auth, (req, res) => {
  const me = req.user.username;
  const node = nodes[req.params.id];
  if (!node || node.owner !== me) return res.status(403).json({ error: 'Not owner.' });
  const target = req.params.username;
  node.members = node.members.filter(u => u !== target);
  if (!node.banned.includes(target)) node.banned.push(target);
  saveJSON(NODES_FILE, nodes);
  pushToUser(target, { type: 'node_kicked', nodeId: node.id, nodeName: node.name });
  res.json({ status: 'banned' });
});

app.delete('/api/nodes/:id/messages/:msgId', auth, (req, res) => {
  const me = req.user.username;
  const node = nodes[req.params.id];
  if (!node || node.owner !== me) return res.status(403).json({ error: 'Not owner.' });
  const key = `node:${req.params.id}`;
  if (messages[key]) { messages[key] = messages[key].filter(m => m.id !== req.params.msgId); saveJSON(MESSAGES_FILE, messages); }
  pushToNodeMembers(req.params.id, { type: 'node_message_deleted', nodeId: req.params.id, msgId: req.params.msgId });
  res.json({ status: 'deleted' });
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
  push(ws, { type: 'history', messages: messages['global'].slice(-HISTORY_SEND), channel: 'global' });
  push(ws, buildFriendsState(user.username));
  syncUserList();

  // Broadcast join
  const joinMsg = {
    type: 'system', id: Math.random().toString(36).slice(2),
    text: `${user.username} joined`, timestamp: Date.now()
  };
  appendMessage(joinMsg, 'global');
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
      const channel = CHANNELS.includes(msg.channel) ? msg.channel : 'global';
      if ((!text && !msg.fileUrl) || text?.length > 2000) return;

      const rate = checkRate(self.username);
      push(ws, { type: 'rate_limit', remaining: rate.remaining, reset: rate.reset });
      if (!rate.allowed) return;

      if (typingUsers.has(self.username)) {
        clearTimeout(typingUsers.get(self.username));
        typingUsers.delete(self.username);
        syncTyping();
      }

      const m = {
        type: 'message',
        id: Math.random().toString(36).slice(2),
        username: self.username,
        color: self.color,
        text,
        channel,
        fileUrl:  msg.fileUrl  || msg.imageUrl || null,   // accept both for compat
        fileType: msg.fileType || null,           
        timestamp: Date.now()
      };

      appendMessage(m, channel);
      broadcastAll(m);

      break;
    }

    case 'dm': {
      const { to, text } = msg;
      if (!to || (!text?.trim() && !msg.fileUrl) || (text?.trim().length > 2000)) return;
      if (!areFriends(self.username, to)) return;

      const rate = checkRate(self.username);
      push(ws, { type: 'rate_limit', remaining: rate.remaining, reset: rate.reset });
      if (!rate.allowed) return;

      const m = {
        type: 'dm',
        id: Math.random().toString(36).slice(2),
        from: self.username,
        to,
        color: self.color,
        text: text?.trim() || '',
        fileUrl: msg.fileUrl || null,
        fileType: msg.fileType || null,
        timestamp: Date.now()
      };

      appendDM(self.username, to, m);
      push(ws, m);
      pushToUser(to, m);

      break;
    }

    case 'dm_history': {
      if (!msg.with) return;
      if (!areFriends(self.username, msg.with)) return;

      const history =
        (dms[dmKey(self.username, msg.with)] || []).slice(-DM_HISTORY_SEND);

      push(ws, {
        type: 'dm_history',
        with: msg.with,
        messages: history
      });

      break;
    }

    case 'typing': {
      if (typingUsers.has(self.username)) {
        clearTimeout(typingUsers.get(self.username));
      }

      const t = setTimeout(() => {
        typingUsers.delete(self.username);
        syncTyping();
      }, 3500);

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

    case 'node_message': {
  const node = nodes[msg.nodeId];
  if (!node || !node.members.includes(self.username)) return;
  const text    = msg.text?.trim();
  if (!text && !msg.fileUrl) return;
  const channel = node.channels?.includes(msg.channel) ? msg.channel : 'general';  // ← scoped

  const rate = checkRate(self.username);
  push(ws, { type: 'rate_limit', remaining: rate.remaining, reset: rate.reset });
  if (!rate.allowed) return;

  const m = {
    type: 'node_message', id: Math.random().toString(36).slice(2),
    nodeId: msg.nodeId, channel,                    // ← included in message
    username: self.username, color: self.color,
    text: text || '', fileUrl: msg.fileUrl || null, fileType: msg.fileType || null,
    timestamp: Date.now()
  };
  const key = `node:${msg.nodeId}:${channel}`;     // ← new key format
  if (!messages[key]) messages[key] = [];
  messages[key].push(m);
  if (messages[key].length > MAX_MESSAGES)
    messages[key].splice(0, messages[key].length - MAX_MESSAGES);
  saveJSON(MESSAGES_FILE, messages);
  pushToNodeMembers(msg.nodeId, m);
  break;
}

case 'node_history': {
  const node    = nodes[msg.nodeId];
  if (!node || !node.members.includes(self.username)) return;
  const channel = node.channels?.includes(msg.channel) ? msg.channel : 'general';
  push(ws, {
    type: 'node_history', nodeId: msg.nodeId, channel,
    messages: (messages[`node:${msg.nodeId}:${channel}`] || []).slice(-HISTORY_SEND)
  });
  break;
}

    case 'join_channel': {
      const ch = CHANNELS.includes(msg.channel) ? msg.channel : 'global';

      push(ws, {
        type: 'history',
        messages: (messages[ch] || []).slice(-HISTORY_SEND),
        channel: ch
      });

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
    appendMessage(leaveMsg, 'global');
    broadcastAll(leaveMsg);
  });

  ws.on('error', err => console.error('[ws error]', err.message));
});

server.listen(PORT, () => {
  console.log(`\n  * asterisk backend\n  → http://localhost:${PORT}\n`);
});
