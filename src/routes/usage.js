const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');

const USAGE_COLLECTION = 'appUsage';
const DEVICES_COLLECTION = 'devices';
const STATUS_COLLECTION = 'deviceStatus';

router.get('/devices', async (req, res) => {
  try {
    if (!db) {
      return res.json({ devices: [] });
    }
    const regSnapshot = await db.collection(DEVICES_COLLECTION).get();
    const registered = regSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const statusSnapshot = await db.collection(STATUS_COLLECTION).get();
    const statusDevices = statusSnapshot.docs
      .filter(doc => !registered.find(r => r.id === doc.id))
      .map(doc => {
        const d = doc.data();
        return {
          id: doc.id,
          deviceId: d.deviceId,
          deviceName: d.deviceName || 'Unknown',
          childName: 'Child',
          lastSeen: d.timestamp || Date.now(),
        };
      });

    res.json({ devices: [...registered, ...statusDevices] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/devices/register', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    const { deviceId, deviceName, childName } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId is required' });
    }
    await db.collection(DEVICES_COLLECTION).doc(deviceId).set({
      deviceId,
      deviceName: deviceName || 'Unknown Device',
      childName: childName || 'Child',
      registeredAt: Date.now(),
      lastSeen: Date.now(),
    }, { merge: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/devices/:deviceId', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    const { deviceId } = req.params;
    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId is required' });
    }

    // 1. Delete from devices collection
    await db.collection(DEVICES_COLLECTION).doc(deviceId).delete();

    // 2. Delete from deviceStatus collection
    await db.collection(STATUS_COLLECTION).doc(deviceId).delete();

    // 3. Delete usage history for this device
    const usageSnapshot = await db
      .collection(USAGE_COLLECTION)
      .where('deviceId', '==', deviceId)
      .get();

    if (!usageSnapshot.empty) {
      const batch = db.batch();
      usageSnapshot.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }

    res.json({ success: true, message: `Device ${deviceId} removed` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/status/:deviceId', async (req, res) => {
  try {
    if (!db) {
      return res.json({ status: null });
    }
    const { deviceId } = req.params;
    const doc = await db.collection(STATUS_COLLECTION).doc(deviceId).get();
    res.json({ status: doc.exists ? doc.data() : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/usage/:deviceId', async (req, res) => {
  try {
    if (!db) {
      return res.json({ usage: [] });
    }
    const { deviceId } = req.params;
    const { date } = req.query;
    const docId = date ? `${deviceId}_${date}` : null;

    if (docId) {
      const doc = await db.collection(USAGE_COLLECTION).doc(docId).get();
      return res.json({ usage: doc.exists ? doc.data() : null });
    }

    const snapshot = await db
      .collection(USAGE_COLLECTION)
      .where('deviceId', '==', deviceId)
      .get();

    const usage = snapshot.docs
      .map(doc => doc.data())
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 30);
    res.json({ usage });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/usage/stats/:deviceId', async (req, res) => {
  try {
    if (!db) {
      return res.json({ stats: null });
    }
    const { deviceId } = req.params;
    const snapshot = await db
      .collection(USAGE_COLLECTION)
      .where('deviceId', '==', deviceId)
      .get();

    const days = snapshot.docs
      .map(doc => doc.data())
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 7);
    const aggregated = new Map();
    let totalScreenTimeMs = 0;
    let dayCount = 0;

    for (const day of days) {
      dayCount++;
      if (day.apps) {
        for (const app of day.apps) {
          const current = aggregated.get(app.appName) || 0;
          aggregated.set(app.appName, current + app.totalTimeMs);
          totalScreenTimeMs += app.totalTimeMs;
        }
      }
    }

    const topApps = [...aggregated.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([appName, totalTimeMs]) => ({
        appName,
        totalTimeMs,
        totalTimeMin: Math.round(totalTimeMs / 60000),
      }));

    res.json({
      stats: {
        totalScreenTimeMs,
        totalScreenTimeMin: Math.round(totalScreenTimeMs / 60000),
        averageDailyMin: dayCount > 0 ? Math.round(totalScreenTimeMs / 60000 / dayCount) : 0,
        topApps,
        daysTracked: dayCount,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
