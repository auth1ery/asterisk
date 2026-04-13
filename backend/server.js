const express    = require('express');
const { WebSocketServer } = require('ws');
const http       = require('http');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const fs         = require('fs');
const path       = require('path');
const cors       = require('cors');

// ── Config ──────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT        || 3001;
const JWT_SECRET   = process.env.JWT_SECRET  || (() => {
  const f = path.join(__dirname, 'data', '.secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = require('crypto').randomBytes(48).toString('hex');
  fs.writeFileSync(f, s);
  return s;
})();
const FRONTEND_URL  = process.env.FRONTEND_URL || '*';
const DATA_DIR      = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const MAX_MESSAGES  = 1000;
const HISTORY_SEND  = 200;  // how many messages to send on connect

// ── Disk helpers ─────────────────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const loadJSON = (file, def) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return def; }
};
const saveJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

let accounts = loadJSON(ACCOUNTS_FILE, {});   // key = username.toLowerCase()
let messages = loadJSON(MESSAGES_FILE, []);

// ── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());

// Health check
app.get('/api/health', (_, res) => res.json({ ok: true }));

// Auth middleware
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
};

// ── Register ─────────────────────────────────────────────────────────────────
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
  const hue   = Math.floor(Math.random() * 360);
  const color = `hsl(${hue},70%,68%)`;

  accounts[username.toLowerCase()] = { username, hash, color };
  saveJSON(ACCOUNTS_FILE, accounts);

  const token = jwt.sign({ username, color }, JWT_SECRET);
  res.json({ token, username, color });
});

// ── Login ─────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const account = accounts[username?.toLowerCase()];
  if (!account) return res.status(401).json({ error: 'Invalid credentials.' });
  if (!await bcrypt.compare(password, account.hash))
    return res.status(401).json({ error: 'Invalid credentials.' });

  const token = jwt.sign({ username: account.username, color: account.color }, JWT_SECRET);
  res.json({ token, username: account.username, color: account.color });
});

// ── Verify ────────────────────────────────────────────────────────────────────
app.get('/api/verify', authMiddleware, (req, res) => {
  res.json({ username: req.user.username, color: req.user.color });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

const clients     = new Map(); // ws  → { username, color }
const typingUsers = new Map(); // username → timeoutId

function push(ws, data)     { if (ws.readyState === 1) ws.send(JSON.stringify(data)); }
function broadcast(data, skip = null) {
  const s = JSON.stringify(data);
  wss.clients.forEach(c => { if (c !== skip && c.readyState === 1) c.send(s); });
}
function broadcastAll(data) { broadcast(data, null); }

function userList()          { return [...clients.values()]; }
function syncUserList()      { broadcastAll({ type: 'user_list', users: userList() }); }
function syncTyping()        { broadcastAll({ type: 'typing', users: [...typingUsers.keys()] }); }

function appendMessage(msg) {
  messages.push(msg);
  if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
  saveJSON(MESSAGES_FILE, messages);
}

wss.on('connection', (ws, req) => {
  // Authenticate via ?token= in query string
  const params = new URL(req.url, 'http://x').searchParams;
  let user;
  try   { user = jwt.verify(params.get('token'), JWT_SECRET); }
  catch { ws.close(1008, 'Unauthorized'); return; }

  // Kick duplicate session for same username
  for (const [existingWs, info] of clients) {
    if (info.username === user.username) {
      push(existingWs, { type: 'kicked', reason: 'Signed in from another window.' });
      existingWs.close();
    }
  }

  clients.set(ws, { username: user.username, color: user.color });

  // Send history + user list
  push(ws, { type: 'history', messages: messages.slice(-HISTORY_SEND) });
  syncUserList();

  // Broadcast join system message
  const joinMsg = {
    type: 'system',
    id:   Math.random().toString(36).slice(2),
    text: `${user.username} joined`,
    timestamp: Date.now()
  };
  appendMessage(joinMsg);
  broadcast(joinMsg, ws);

  // ── Incoming messages ───────────────────────────────────────────────────
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const self = clients.get(ws);
    if (!self) return;

    switch (msg.type) {
      case 'message': {
        const text = msg.text?.trim();
        if (!text || text.length > 2000) return;

        // Clear typing state on send
        if (typingUsers.has(self.username)) {
          clearTimeout(typingUsers.get(self.username));
          typingUsers.delete(self.username);
          syncTyping();
        }

        const m = {
          type:      'message',
          id:        Math.random().toString(36).slice(2),
          username:  self.username,
          color:     self.color,
          text,
          timestamp: Date.now()
        };
        appendMessage(m);
        broadcastAll(m);
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

  // ── Disconnect ──────────────────────────────────────────────────────────
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
      type: 'system',
      id:   Math.random().toString(36).slice(2),
      text: `${self.username} left`,
      timestamp: Date.now()
    };
    appendMessage(leaveMsg);
    broadcastAll(leaveMsg);
  });

  ws.on('error', err => console.error('[ws error]', err.message));
});

server.listen(PORT, () => {
  console.log(`\n  * asterisk backend\n  → http://localhost:${PORT}\n`);
});
