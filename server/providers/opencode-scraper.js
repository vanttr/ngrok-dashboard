// server/providers/opencode-scraper.js
// Scrapes live Go/Zen usage from opencode.ai workspace pages
// Copies Firefox Nightly profile to temp (avoids lock issues)
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const WORKSPACE_ID = 'wrk_01KSPGXTQKD3H09JJKENAMW9SH';
const GO_URL = `https://opencode.ai/workspace/${WORKSPACE_ID}/go`;
const ZEN_URL = `https://opencode.ai/workspace/${WORKSPACE_ID}`;

const FF_SRC = path.join(os.homedir(), 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles', 'g03o95vf.default-nightly');
const FF_TMP = path.join(os.tmpdir(), 'ngrok-dash-ff-profile');

function copyProfile() {
  fs.mkdirSync(FF_TMP, { recursive: true });
  // Copy essential files (always refresh to pick up new cookies)
  const essential = ['cookies.sqlite', 'key4.db', 'cert9.db', 'logins.json', 'pkcs11.txt', 'prefs.js'];
  for (const f of essential) {
    const src = path.join(FF_SRC, f);
    const dst = path.join(FF_TMP, f);
    if (fs.existsSync(src)) {
      // Only copy if source is newer or dst doesn't exist
      if (!fs.existsSync(dst) || fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs) {
        fs.copyFileSync(src, dst);
      }
    }
  }
}

let _context = null;

async function getContext() {
  if (_context) return _context;
  
  copyProfile();
  const { firefox } = require('@playwright/test');
  _context = await firefox.launchPersistentContext(FF_TMP, { headless: true });
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
