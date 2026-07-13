const sa = require('C:/Users/Tharindu/Downloads/control-7f5f8-firebase-adminsdk-fbsvc-704ecaf827.json');
const jwt = require('jsonwebtoken');
const https = require('https');

const now = Math.floor(Date.now() / 1000);
const payload = {
  iss: sa.client_email,
  scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase',
  aud: 'https://oauth2.googleapis.com/token',
  exp: now + 3600,
  iat: now
};

const assertion = jwt.sign(payload, sa.private_key, { algorithm: 'RS256' });

const tokenData = `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(assertion)}`;

function getToken() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const json = JSON.parse(d);
        if (json.access_token) resolve(json.access_token);
        else reject(new Error(d));
      });
    });
    req.write(tokenData);
    req.end();
  });
}

async function updateRules() {
  const token = await getToken();
  console.log('Got access token');

  const source = [
    'rules_version = "2";',
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /{document=**} {',
    '      allow read, write: if true;',
    '    }',
    '  }',
    '}'
  ].join('\n');

  const body = JSON.stringify({
    source: {
      files: [{
        name: "firestore.rules",
        content: source
      }]
    }
  });

  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firebaserules.googleapis.com',
      path: '/v1/projects/control-7f5f8/rulesets',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.write(body);
    req.end();
  });

  console.log('Ruleset created:', result.status, result.body.name);

  // Release the ruleset
  // Get current release first to know the structure
  const currentRelease = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firebaserules.googleapis.com',
      path: '/v1/projects/control-7f5f8/releases/cloud.firestore',
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.end();
  });

  console.log('Current release:', currentRelease.body);

  // Now try the right field name
  const releaseBody = JSON.stringify({
    rulesetName: result.body.name
  });

  const release = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firebaserules.googleapis.com',
      path: '/v1/projects/control-7f5f8/releases/cloud.firestore',
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.write(releaseBody);
    req.end();
  });

  console.log('Release status:', release.status);
  console.log('Release body:', release.body);
}

updateRules().catch(console.error);
