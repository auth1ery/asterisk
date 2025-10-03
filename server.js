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

// serve static files (our chat page)
app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  console.log("A user joined");

  socket.on("chat message", (msg) => {
    io.emit("chat message", msg); // send to all clients
  });

  socket.on("disconnect", () => {
    console.log("A user left");
  });
});

// Render provides PORT env var
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
