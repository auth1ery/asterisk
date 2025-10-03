const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// serve static files (index.html, etc.)
app.use(express.static(path.join(__dirname, "public")));

// regex-based filter (no swears blocked, only bad stuff)
const bannedPatterns = [
  /\b(hitler|nazi|third\s*reich)\b/i,        // history refs
  /\b(rape|raping|rapist)\b/i,               // sexual violence
  /\b(nigg(er|a)?|fag(got)?)\b/i,            // slurs
  /\b(pedo|paedo|child\s*porn|cp)\b/i,       // child exploitation
  /\b(porn|sex(ual)?|cum|cock|pussy)\b/i     // explicit sexual content
];

function containsBadWord(msg) {
  return bannedPatterns.some(pattern => pattern.test(msg));
}

// store connected users
let users = {};

io.on("connection", (socket) => {
  console.log("a user connected");

  // default nickname
  users[socket.id] = "anonymous";

  // send system message when someone joins
  io.emit("chat message", {
    user: "system",
    msg: `user joined: ${users[socket.id]}`
  });

  // handle nickname change
  socket.on("set nickname", (nickname) => {
    const oldName = users[socket.id] || "anonymous";
    users[socket.id] = nickname;
    io.emit("chat message", {
      user: "system",
      msg: `${oldName} is now known as ${nickname}`
    });
  });

  // handle chat messages
  socket.on("chat message", (msg) => {
    if (containsBadWord(msg)) {
      socket.emit("chat message", {
        user: "system",
        msg: "⚠️ message blocked by moderation"
      });
      return;
    }

    io.emit("chat message", {
      user: users[socket.id],
      msg: msg
    });
  });

  // handle disconnect
  socket.on("disconnect", () => {
    io.emit("chat message", {
      user: "system",
      msg: `user left: ${users[socket.id]}`
    });
    delete users[socket.id];
    console.log("a user disconnected");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`server running on port ${PORT}`);
});
