// server/providers/opencode-scraper.js
// Scrapes live Go/Zen usage from opencode.ai workspace pages
// Reads Firefox cookies from SQLite (readable even while Firefox runs)
// Injects into a clean Playwright browser — no profile lock issues
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');

const DEFAULT_WORKSPACE_ID = 'wrk_01KSPGXTQKD3H09JJKENAMW9SH';

function goUrl(workspaceId) {
  return `https://opencode.ai/workspace/${workspaceId || DEFAULT_WORKSPACE_ID}/go`;
}
function zenUrl(workspaceId) {
  return `https://opencode.ai/workspace/${workspaceId || DEFAULT_WORKSPACE_ID}`;
}

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
const CONTEXT_TIMEOUT = 25000; // 25s — kill zombies after this

async function getContext() {
  const { firefox } = require('@playwright/test');
  const MAX_AGE = 60 * 60 * 1000;

  if (_context && (Date.now() - _contextCreated) < MAX_AGE) return _context;
  
  if (_context) {
    try { await _context.close(); } catch {}
    _context = null;
  }

  ensureProfileCopy();

  // Wrap in a timeout so hung launches don't leave orphaned Firefox processes
  const launchPromise = firefox.launchPersistentContext(FF_TMP, { headless: true });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Firefox persistent context timed out after ' + CONTEXT_TIMEOUT/1000 + 's')), CONTEXT_TIMEOUT)
  );

  _context = await Promise.race([launchPromise, timeoutPromise]);
  _contextCreated = Date.now();
  return _context;
}

function parseResetTime(text) {
  // "Resets in 5 hours 0 minutes" or "Resets in 6 days 21 hours"
  // Handles newlines / excess whitespace from innerText across block elements
  if (!text) return null;
  const now = Date.now();

  // Collapse all whitespace sequences (newlines, tabs, spaces) into single spaces
  const s = text.replace(/\s+/g, ' ').trim();

  let ms = 0;

  // "Resets in 5 days 3 hours"
  let match = s.match(/Resets in (\d+) days? (\d+) hours?/);
  if (match) {
    ms = parseInt(match[1]) * 86400000 + parseInt(match[2]) * 3600000;
  }

  // "Resets in 5 hours 15 minutes"
  if (ms === 0) {
    match = s.match(/Resets in (\d+) hours? (\d+) minutes?/);
    if (match) {
      ms = parseInt(match[1]) * 3600000 + parseInt(match[2]) * 60000;
    }
  }

  // "Resets in 5 hours" (minutes omitted)
  if (ms === 0) {
    match = s.match(/Resets in (\d+) hours?/);
    if (match) {
      ms = parseInt(match[1]) * 3600000;
    }
  }

  // "Resets in 30 minutes" (hours omitted)
  if (ms === 0) {
    match = s.match(/Resets in (\d+) minutes?/);
    if (match) {
      ms = parseInt(match[1]) * 60000;
    }
  }

  if (ms > 0) {
    return new Date(now + ms).toISOString();
  }

  // Parse failure — log the section text for debugging
  console.warn(`[scraper] parseResetTime could not parse reset text: "${s.substring(0, 120)}"`);
  return null;
}

async function scrapeGoUsage(workspaceId) {
  const context = await getContext();
  const page = await context.newPage();
  
  try {
    await page.goto(goUrl(workspaceId), { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1500);
    
    if (page.url().includes('auth')) return null;
    
    const text = await page.evaluate(() => document.body.innerText);
    const rollingMatch = text.match(/Rolling Usage\s+(\d+)%/);
    const weeklyMatch = text.match(/Weekly Usage\s+(\d+)%/);
    const monthlyMatch = text.match(/Monthly Usage\s+(\d+)%/);
    
    const rollingSection = text.match(/Rolling Usage[\s\S]*?(?=Weekly Usage|Monthly Usage|$)/);
    const weeklySection = text.match(/Weekly Usage[\s\S]*?(?=Monthly Usage|$)/);
    const monthlySection = text.match(/Monthly Usage[\s\S]*?(?=Use your|Invite|$)/);
    
    return {
      fiveHour: rollingMatch ? parseInt(rollingMatch[1]) : null,
      fiveHourResetsAt: rollingSection ? parseResetTime(rollingSection[0]) : null,
      sevenDay: weeklyMatch ? parseInt(weeklyMatch[1]) : null,
      sevenDayResetsAt: weeklySection ? parseResetTime(weeklySection[0]) : null,
      monthlyPct: monthlyMatch ? parseInt(monthlyMatch[1]) : null,
      monthlyResetsAt: monthlySection ? parseResetTime(monthlySection[0]) : null,
    };
  } finally {
    await page.close();
  }
}

async function scrapeZenBalance(workspaceId) {
  const context = await getContext();
  const page = await context.newPage();
  
  try {
    await page.goto(zenUrl(workspaceId), { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1500);
    
    if (page.url().includes('auth')) return null;
    
    const text = await page.evaluate(() => document.body.innerText);
    const balanceMatch = text.match(/Current balance\s+\$?([\d.]+)/);
    
    return balanceMatch ? parseFloat(balanceMatch[1]) : null;
  } finally {
    await page.close();
  }
}

module.exports = { scrapeGoUsage, scrapeZenBalance, getContext, parseResetTime };
