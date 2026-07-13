require('dotenv').config();
const admin = require('firebase-admin');

const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const apps = ['YouTube', 'TikTok', 'WhatsApp', 'Instagram', 'Chrome', 'Spotify', 'Netflix', 'Snapchat', 'Facebook', 'Messenger'];

async function seed() {
  for (let day = 0; day < 7; day++) {
    const d = new Date();
    d.setDate(d.getDate() - day);
    const dateStr = d.toISOString().split('T')[0];
    const usageList = apps.map(name => ({
      appName: name,
      totalTimeMs: Math.floor(Math.random() * 120 + 5) * 60000,
      totalTimeMin: Math.floor(Math.random() * 120 + 5),
    }));

    await db.collection('appUsage').doc(`test123_${dateStr}`).set({
      deviceId: 'test123',
      date: dateStr,
      timestamp: d.getTime(),
      apps: usageList,
    });
    console.log(`Added: ${dateStr}`);
  }
  console.log('Seed complete!');
}

seed().catch(console.error);
