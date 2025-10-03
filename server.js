const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

let users = {}; // store color for each socket

function randomColor() {
  const colors = ["#e74c3c", "#3498db", "#2ecc71", "#f1c40f", "#9b59b6", "#e67e22", "#1abc9c"];
  return colors[Math.floor(Math.random() * colors.length)];
}

io.on("connection", (socket) => {
  const color = randomColor();
  users[socket.id] = color;

  // system message: user joined
  io.emit("chat message", { color: "#888", msg: "user joined" });

  socket.on("chat message", (msg) => {
    io.emit("chat message", {
      color: users[socket.id],
      msg: msg
    });
  });

  socket.on("disconnect", () => {
    io.emit("chat message", { color: "#888", msg: "user left" });
    delete users[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`asterisk chat running on port ${PORT}`);
});
