const url = process.argv[2];
if (!url) { console.error('Usage: node set-firestore-url.js <url>'); process.exit(1); }
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { admin, db } = require('../src/config/firebase');
if (!db) {
  console.error('Firestore db is not initialized. Check Firebase credentials.');
  process.exit(1);
}
db.collection('config').doc('backend').set({ url }, { merge: true }).then(() => {
  console.log('Firestore URL updated to', url);
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
