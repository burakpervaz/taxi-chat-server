// Multi-room PTT + WebRTC signaling + Basit Auth (JWT, in-memory)
// Not: Free Render'da bellek geçicidir; deploy sonrası kullanıcılar sıfırlanır.
// Kalıcı DB (Supabase vs.) sonra ekleriz.

import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => res.send('Taxi Chat Server OK'));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ---- In-memory user store (deploy/resette silinir) ---------------
const usersByEmail = new Map();     // email -> user
const usersByUsername = new Map();  // username -> user
let nextUserId = 1;

// helper: public user
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, username: u.username });

// Register
app.post('/auth/register', async (req, res) => {
  try {
    const { email, name, username, password } = req.body || {};
    if (!email || !name || !username || !password) {
      return res.status(400).json({ error: 'email, name, username, password gerekli' });
    }
    if (usersByEmail.has(email)) return res.status(409).json({ error: 'email zaten kayıtlı' });
    if (usersByUsername.has(username)) return res.status(409).json({ error: 'kullanıcı adı mevcut' });

    const hash = await bcrypt.hash(password, 8); // kuralsız ama hash’li
    const user = { id: String(nextUserId++), email, name, username, hash };
    usersByEmail.set(email, user);
    usersByUsername.set(username, user);

    const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ user: publicUser(user), token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server' });
  }
});

// Login
app.post('/auth/login', async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body || {};
    if (!emailOrUsername || !password) {
      return res.status(400).json({ error: 'emailOrUsername ve password gerekli' });
    }
    let user = usersByEmail.get(emailOrUsername) || usersByUsername.get(emailOrUsername);
    if (!user) return res.status(401).json({ error: 'kullanıcı bulunamadı' });
    const ok = await bcrypt.compare(password, user.hash);
    if (!ok) return res.status(401).json({ error: 'şifre hatalı' });
    const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ user: publicUser(user), token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server' });
  }
});

// Me (isteğe bağlı)
app.get('/me', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  try {
    const payload = token ? jwt.verify(token, JWT_SECRET) : null;
    if (!payload) return res.status(401).json({ error: 'unauthorized' });
    const user = [...usersByEmail.values()].find(u => u.id === String(payload.uid));
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    res.json({ user: publicUser(user) });
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

// ---- Rooms state --------------------------------------------------
const rooms = new Map(); // name -> { floorHolder, members:Set<socketId> }
function ensureRoom(name) {
  if (!rooms.has(name)) rooms.set(name, { floorHolder: null, members: new Set() });
  return rooms.get(name);
}

// Socket auth (JWT)
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('unauthorized'));
  try {
    const { uid } = jwt.verify(token, JWT_SECRET);
    // user lookup
    const user = [...usersByEmail.values()].find(u => String(u.id) === String(uid));
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = publicUser(user);
    next();
  } catch (e) {
    next(new Error('unauthorized'));
  }
});

// ---- Socket.IO logic ----------------------------------------------
io.on('connection', (socket) => {
  let roomName = 'main';
  const user = socket.data.user; // {id,email,name,username}

  // join default room
  ensureRoom(roomName).members.add(socket.id);
  socket.join(roomName);
  socket.emit('joined', { room: roomName });
  broadcastPeers(roomName);

  // Room switch
  socket.on('join-room', ({ room }) => {
    socket.leave(roomName);
    const old = ensureRoom(roomName);
    old.members.delete(socket.id);
    if (old.floorHolder === socket.id) {
      old.floorHolder = null;
      io.to(roomName).emit('floor-released');
    }
    roomName = room || 'main';
    const r = ensureRoom(roomName);
    r.members.add(socket.id);
    socket.join(roomName);
    socket.emit('joined', { room: roomName });
    broadcastPeers(roomName);
  });

  // PTT
  socket.on('request-floor', () => {
    const r = ensureRoom(roomName);
    if (!r.floorHolder) {
      r.floorHolder = socket.id;
      io.to(roomName).emit('floor-granted', { holder: socket.id, username: user.username });
    } else {
      socket.emit('floor-denied', { holder: r.floorHolder });
    }
  });

  socket.on('release-floor', () => {
    const r = ensureRoom(roomName);
    if (r.floorHolder === socket.id) {
      r.floorHolder = null;
      io.to(roomName).emit('floor-released');
    }
  });

  // WebRTC signaling
  socket.on('webrtc-offer', ({ to, sdp }) => io.to(to).emit('webrtc-offer', { from: socket.id, sdp }));
  socket.on('webrtc-answer', ({ to, sdp }) => io.to(to).emit('webrtc-answer', { from: socket.id, sdp }));
  socket.on('webrtc-ice', ({ to, candidate }) => io.to(to).emit('webrtc-ice', { from: socket.id, candidate }));

  socket.on('disconnect', () => {
    const r = ensureRoom(roomName);
    r.members.delete(socket.id);
    if (r.floorHolder === socket.id) {
      r.floorHolder = null;
      io.to(roomName).emit('floor-released');
    }
    broadcastPeers(roomName);
  });

  function broadcastPeers(room) {
    const r = ensureRoom(room);
    // peers: [{id, username}]
    const peers = Array.from(r.members).map((sid) => {
      const s = io.sockets.sockets.get(sid);
      return s ? { id: sid, username: s.data.user?.username || 'user' } : { id: sid, username: 'user' };
    });
    io.to(room).emit('peers', { peers });
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Taxi Chat server listening on :${PORT}`));

