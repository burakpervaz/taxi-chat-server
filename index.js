// /server/index.js  — REPLACE ALL
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

const app = express();
app.use(cors());

app.get('/', (_req, res) => {
  res.send('Taxi Chat Server OK');
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ---- Simple room state (MVP: one room = "main") ------------------
const ROOM = 'main';
const roomMembers = new Set(); // socket.id list
const channels = {
  main: { floorHolder: null, queue: [] }
};

// Helper: broadcast peers list
function broadcastPeers() {
  io.to(ROOM).emit('peers', { peers: Array.from(roomMembers) });
}

io.on('connection', (socket) => {
  // Join room
  socket.join(ROOM);
  roomMembers.add(socket.id);
  broadcastPeers();

  // ---- PTT floor control ----------------------------------------
  socket.on('request-floor', () => {
    const ch = channels.main;
    if (!ch.floorHolder) {
      ch.floorHolder = socket.id;
      io.to(ROOM).emit('floor-granted', { holder: socket.id });
    } else {
      socket.emit('floor-denied', { holder: ch.floorHolder });
    }
  });

  socket.on('release-floor', () => {
    const ch = channels.main;
    if (ch.floorHolder === socket.id) {
      ch.floorHolder = null;
      io.to(ROOM).emit('floor-released');
    }
  });

  // ---- WebRTC Signaling relay -----------------------------------
  // Offer/Answer/ICE are simply forwarded to target peer
  socket.on('webrtc-offer', ({ to, sdp }) => {
    io.to(to).emit('webrtc-offer', { from: socket.id, sdp });
  });

  socket.on('webrtc-answer', ({ to, sdp }) => {
    io.to(to).emit('webrtc-answer', { from: socket.id, sdp });
  });

  socket.on('webrtc-ice', ({ to, candidate }) => {
    io.to(to).emit('webrtc-ice', { from: socket.id, candidate });
  });

  // ---- Disconnect cleanup ---------------------------------------
  socket.on('disconnect', () => {
    // release floor if the holder leaves
    const ch = channels.main;
    if (ch.floorHolder === socket.id) {
      ch.floorHolder = null;
      io.to(ROOM).emit('floor-released');
    }
    roomMembers.delete(socket.id);
    broadcastPeers();
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Taxi Chat server listening on :${PORT}`));


