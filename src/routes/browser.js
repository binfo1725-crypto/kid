const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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

const browserHistory = loadMap('browser_history.json');

// POST /api/browser-history/:deviceId
router.post('/browser-history/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const b = req.body;
  if (!b || (!b.url && !b.title)) {
    return res.status(400).json({ error: 'missing url or title' });
  }

  if (!browserHistory.has(deviceId)) browserHistory.set(deviceId, []);
  const arr = browserHistory.get(deviceId);

  const cleanUrl = String(b.url || '').trim();
  const cleanTitle = String(b.title || '').trim();
  const browserName = String(b.browserName || 'Browser').trim();
  const packageName = String(b.packageName || '').trim();
  const ts = Number(b.timestamp) || Date.now();

  // Deduplication: don't record the same URL from same browser within 10 seconds
  const last = arr[arr.length - 1];
  if (last && last.url === cleanUrl && (ts - last.timestamp) < 10000) {
    return res.json({ ok: true, duplicate: true });
  }

  const isSearch = cleanUrl.includes('google.com/search') ||
    cleanUrl.includes('bing.com/search') ||
    cleanUrl.includes('search.yahoo.com') ||
    cleanUrl.includes('duckduckgo.com/?q=') ||
    cleanUrl.includes('ecosia.org/search') ||
    !cleanUrl.includes('.') ||
    cleanUrl.startsWith('search:');

  const entry = {
    id: `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    url: cleanUrl,
    title: cleanTitle || cleanUrl,
    browserName,
    packageName,
    isSearch,
    timestamp: ts
  };

  arr.push(entry);
  if (arr.length > 3000) arr.splice(0, arr.length - 3000);
  saveMap('browser_history.json', browserHistory);

  console.log(`[BrowserHistory] [${browserName}] ${cleanTitle || cleanUrl}`);
  res.json({ ok: true, entry });
});

// GET /api/browser-history/:deviceId
router.get('/browser-history/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const arr = browserHistory.get(deviceId) || [];
  res.json({ history: arr.slice().reverse() });
});

// DELETE /api/browser-history/:deviceId
router.delete('/browser-history/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  browserHistory.set(deviceId, []);
  saveMap('browser_history.json', browserHistory);
  res.json({ ok: true });
});

module.exports = router;
