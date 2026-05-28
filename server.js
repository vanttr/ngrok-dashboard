// server.js — Ngrok Tunnel Switcher
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---- Configuration ----
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'servers.json'), 'utf8'));
const SWITCHER_PORT = CONFIG.switcherPort || 9595;
const NGROK_OAUTH = '--oauth=google --oauth-allow-email=vant.tr@gmail.com';

// ---- Ngrok Process Manager ----
let ngrokProcess = null;
let ngrokUrl = null;

function startNgrok() {
  return new Promise((resolve, reject) => {
    const args = ['http', String(SWITCHER_PORT), ...NGROK_OAUTH.split(' '), '--log=stdout'];
    ngrokProcess = spawn('ngrok', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let resolved = false;

    ngrokProcess.stdout.on('data', (data) => {
      const text = data.toString();
      // ngrok v3 prints: "Forwarding  https://xxxxx.ngrok-free.dev -> http://localhost:9595"
      const match = text.match(/Forwarding\s+(https:\/\/[^\s]+)\s+->/);
      if (match && !resolved) {
        ngrokUrl = match[1];
        resolved = true;
        console.log(`ngrok tunnel: ${ngrokUrl}`);
        resolve(ngrokUrl);
      }
    });

    ngrokProcess.stderr.on('data', (data) => {
      console.error(`ngrok stderr: ${data.toString().trim()}`);
    });

    ngrokProcess.on('error', (err) => {
      console.error(`ngrok spawn failed: ${err.message}`);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    ngrokProcess.on('close', (code) => {
      console.log(`ngrok exited with code ${code}`);
      ngrokProcess = null;
      ngrokUrl = null;
      if (!resolved) {
        resolved = true;
        reject(new Error(`ngrok exited with code ${code}`));
      }
    });

    // Timeout: if ngrok doesn't produce a URL within 15 seconds, kill it
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (ngrokProcess) { ngrokProcess.kill('SIGTERM'); ngrokProcess = null; }
        reject(new Error('ngrok timed out waiting for URL'));
      }
    }, 15000);

    // Clean up the timer on successful resolution
    const originalResolve = resolve;
    resolve = (url) => { clearTimeout(timeout); originalResolve(url); };
  });
}

function stopNgrok() {
  if (ngrokProcess) {
    ngrokProcess.kill('SIGTERM');
    ngrokProcess = null;
    ngrokUrl = null;
  }
}

process.on('SIGINT', () => { stopNgrok(); process.exit(0); });
process.on('SIGTERM', () => { stopNgrok(); process.exit(0); });
