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

const bannedWords = ["nigger", "hitler", "vagina"];

function containsBadWord(msg) {
  const lower = msg.toLowerCase();
  return bannedWords.some(word => lower.includes(word));
}

io.on("connection", (socket) => {
  let nickname = "Anonymous";

  // system join message
  socket.broadcast.emit("chat message", "a user joined".toLowerCase());

  socket.on("set nickname", (name) => {
    nickname = name.trim() || "Anonymous";
    socket.emit("chat message", `you are now known as ${nickname}`.toLowerCase());
    socket.broadcast.emit("chat message", `${nickname} joined the chat`.toLowerCase());
  });

  socket.on("chat message", (msg) => {
    if (!containsBadWord(msg)) {
      // keep nickname + message exactly as typed
      io.emit("chat message", `${nickname}: ${msg}`);
    } else {
      // system moderation message → lowercase
      socket.emit("chat message", "⚠️ message blocked by
