import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const bannedWords = ["nigger", "hitler", "vagina", "dick"];

function containsBadWord(msg) {
  const lower = msg.toLowerCase();
  return bannedWords.some(word => lower.includes(word));
}

io.on("connection", (socket) => {
  console.log("A user joined");

  let nickname = "anonymous";

  socket.on("set nickname", (name) => {
    nickname = (name.trim() || "anonymous").toLowerCase();
    socket.emit("chat message", `you are now known as ${nickname}`);
  });

  socket.on("chat message", (msg) => {
    const cleanMsg = msg.toLowerCase();
    if (!containsBadWord(cleanMsg)) {
      io.emit("chat message", `${nickname}: ${cleanMsg}`);
    } else {
      socket.emit("chat message", "⚠️ message blocked by moderation");
    }
  });

  socket.on("disconnect", () => {
    console.log(`${nickname} left`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`server running on port ${PORT}`);
});

