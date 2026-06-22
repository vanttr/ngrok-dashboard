// server/providers/opencode-scraper.js
// Scrapes live Go/Zen usage from opencode.ai workspace pages
// Reads Firefox cookies from SQLite (readable even while Firefox runs)
// Injects into a clean Playwright browser — no profile lock issues
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');

const WORKSPACE_ID = 'wrk_01KSPGXTQKD3H09JJKENAMW9SH';
const GO_URL = `https://opencode.ai/workspace/${WORKSPACE_ID}/go`;
const ZEN_URL = `https://opencode.ai/workspace/${WORKSPACE_ID}`;

const FF_PROFILE = path.join(os.homedir(), 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles', 'g03o95vf.default-nightly');
const FF_TMP = path.join(os.tmpdir(), 'ngrok-dash-ff-profile');

function ensureProfileCopy() {
  // Copy essential Firefox profile files to temp (readable even when Firefox runs)
  // key4.db contains the encryption keys needed to decrypt cookies.sqlite
  fs.mkdirSync(FF_TMP, { recursive: true });
  const essential = ['cookies.sqlite', 'key4.db', 'cert9.db', 'prefs.js'];
  for (const f of essential) {
    const src = path.join(FF_PROFILE, f);
    const dst = path.join(FF_TMP, f);
    if (fs.existsSync(src)) {
      if (!fs.existsSync(dst) || fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs) {
        fs.copyFileSync(src, dst);
      }
    }
  }
}

let _context = null;
let _contextCreated = 0;

async function getContext() {
  const { firefox } = require('@playwright/test');
  const MAX_AGE = 60 * 60 * 1000;

  if (_context && (Date.now() - _contextCreated) < MAX_AGE) return _context;
  
  if (_context) {
    try { await _context.close(); } catch {}
    _context = null;
  }

  // Always copy profile (fast, ~1MB, works regardless of Firefox state)
  ensureProfileCopy();
  _context = await firefox.launchPersistentContext(FF_TMP, { headless: true });
  _contextCreated = Date.now();
  return _context;
}

async function scrapeGoUsage() {
  const context = await getContext();
  const page = await context.newPage();
  
  try {
    await page.goto(GO_URL, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1500);
    
    if (page.url().includes('auth')) return null;
    
    const text = await page.evaluate(() => document.body.innerText);
    const rollingMatch = text.match(/Rolling Usage\s+(\d+)%/);
    const weeklyMatch = text.match(/Weekly Usage\s+(\d+)%/);
    
    return {
      fiveHour: rollingMatch ? parseInt(rollingMatch[1]) : null,
      sevenDay: weeklyMatch ? parseInt(weeklyMatch[1]) : null,
    };
  } finally {
    await page.close();
  }
}

async function scrapeZenBalance() {
  const context = await getContext();
  const page = await context.newPage();
  
  try {
    await page.goto(ZEN_URL, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1500);
    
    if (page.url().includes('auth')) return null;
    
    const text = await page.evaluate(() => document.body.innerText);
    const balanceMatch = text.match(/Current balance\s+\$?([\d.]+)/);
    
    return balanceMatch ? parseFloat(balanceMatch[1]) : null;
  } finally {
    await page.close();
  }
}

module.exports = { scrapeGoUsage, scrapeZenBalance, getContext };
