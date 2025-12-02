const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const { createReport } = require('./moderation/reports');
const { banUser } = require('./moderation/bans');
const { blockBanned } = require('./moderation/middleware');
const db = require('./db/database');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware to block banned users
blockBanned(io);

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Serve admin.html securely with secret injected
app.get('/admin.html', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'admin.html');
  let html = fs.readFileSync(htmlPath, 'utf8');

  // Replace placeholder in HTML with secret from environment variable
  html = html.replace('PLACEHOLDER', process.env.ADMIN_SECRET);

  res.send(html);
});

let users = {};  
let typingUsers = new Set(); 

function randomColor() {
  const colors = ["#e74c3c", "#3498db", "#2ecc71", "#f1c40f", "#9b59b6", "#e67e22", "#1abc9c"];
  return colors[Math.floor(Math.random() * colors.length)];
}

io.on("connection", (socket) => {

  const color = randomColor();
  users[socket.id] = { color, nickname: "Anonymous" };

  // Check if this socket is an admin
  socket.isAdmin = socket.handshake.auth?.admin && socket.handshake.auth?.key === process.env.ADMIN_SECRET;

  io.emit("user count", Object.keys(users).length);

  socket.on("set nickname", (name) => {
    users[socket.id].nickname = name;

    io.emit("chat message", { color: "#888", msg: `${name} joined` });
    io.emit("user count", Object.keys(users).length);
  });

  socket.on("chat message", (msg) => {
    const user = users[socket.id];
    if (!user) return;

    io.emit("chat message", { 
      color: user.color, 
      msg: `${user.nickname}: ${msg}`, 
    });

    if (typingUsers.has(socket.id)) {
      typingUsers.delete(socket.id);
      const nicknames = Array.from(typingUsers).map(id => users[id].nickname);
      const display = nicknames.slice(0, 3); 
      const extra = nicknames.length - display.length;
      io.emit("typing", display.concat(extra > 0 ? [`and ${extra} more`] : []));
    }
  });

  socket.on("typing", (isTyping) => {
    if (!users[socket.id]) return;

    if (isTyping) {
      typingUsers.add(socket.id);
    } else {
      typingUsers.delete(socket.id);
    }

    const nicknames = Array.from(typingUsers).map(id => users[id].nickname);
    const display = nicknames.slice(0, 3); 
    const extra = nicknames.length - display.length;
    io.emit("typing", display.concat(extra > 0 ? [`and ${extra} more`] : []));
  });

  socket.on('report', data => {
    const { messageId, reportedUserId, reason } = data;
    const reportId = createReport(socket.id, reportedUserId, messageId, reason);
    console.log('New report created:', reportId);
  });

  // Admin-only events
  socket.on('getReports', () => {
    if (!socket.isAdmin) return;
    // Fetch reports from DB and send to this socket
    db.all(`SELECT r.*, m.content as message
            FROM reports r
            LEFT JOIN messages m ON r.message_id = m.id
            WHERE r.status = 'pending'`, [], (err, rows) => {
      if (err) return console.error(err);
      socket.emit('reports', rows);
    });
  });

  socket.on('banUser', data => {
    if (!socket.isAdmin) return;
    const { userId } = data;
    banUser(userId, null, 'Manual admin ban', io);
    db.run(`UPDATE reports SET status='resolved' WHERE reported_user_id=?`, [userId]);
  });

  socket.on("disconnect", () => {
    const user = users[socket.id];
    if (user) {
      io.emit("chat message", { color: "#888", msg: `${user.nickname} left` });

      delete users[socket.id];
      typingUsers.delete(socket.id);

      io.emit("user count", Object.keys(users).length);

      io.emit(
        "typing",
        Array.from(typingUsers)
          .map(id => users[id]?.nickname)
          .filter(Boolean)
      );
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`asterisk chat running on port ${PORT}`);
});
