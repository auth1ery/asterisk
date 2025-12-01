const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

let users = {}; // socket.id -> { color, nickname }

function randomColor() {
  const colors = ["#e74c3c", "#3498db", "#2ecc71", "#f1c40f", "#9b59b6", "#e67e22", "#1abc9c"];
  return colors[Math.floor(Math.random() * colors.length)];
}

io.on("connection", (socket) => {
  const color = randomColor();
  users[socket.id] = { color, nickname: "Anonymous" };

  // Send active user count immediately
  io.emit("user count", Object.keys(users).length);

  // Receive nickname from client
  socket.on("set nickname", (name) => {
    users[socket.id].nickname = name;
    io.emit("chat message", { color: "#888", msg: `${name} joined` });
    io.emit("user count", Object.keys(users).length);
  });

  socket.on("chat message", (msg) => {
    const user = users[socket.id];
    if (!user) return;
    io.emit("chat message", { color: user.color, msg: `${user.nickname}: ${msg}` });
  });

  socket.on("disconnect", () => {
    const user = users[socket.id];
    if (user) {
      io.emit("chat message", { color: "#888", msg: `${user.nickname} left` });
      delete users[socket.id];
      io.emit("user count", Object.keys(users).length);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`asterisk chat running on port ${PORT}`);
});
