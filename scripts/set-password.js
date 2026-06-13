// scripts/set-password.js
// Called by set-password.ps1 (via env var) or directly:
//   node scripts/set-password.js "your-password-here"
//
// This hashes your password and saves it to auth.json.
// After running this, restart the dashboard server.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Accept password from env var (PowerShell) or command-line argument
const password = process.env.DASH_SETUP_PASSWORD || process.argv[2];

if (!password) {
  console.log('Usage: node scripts/set-password.js "your-password-here"');
  console.log('Example: node scripts/set-password.js "MySecret123"');
  process.exit(1);
}

const authPath = path.join(__dirname, '..', 'auth.json');

// Load existing config (or create default)
let auth;
try {
  auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
} catch {
  auth = { google: { clientId: '', clientSecret: '' }, allowedEmails: [] };
}

// Hash the password
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');

// Save
auth.password = { salt, hash };
fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), 'utf8');

console.log('Password set in auth.json. Restart the dashboard server to activate authentication.');
