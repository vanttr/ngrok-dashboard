// server/providers/opencode-go.js
// OpenCode Go — scrapes live usage from opencode.ai workspace, falls back to local DB
'use strict';
const { createProviderResult } = require('./provider-result.js');

async function fetchOpenCodeGoProviderData() {
  // Try scraping first
  try {
    const { scrapeGoUsage } = require('./opencode-scraper.js');
    const usage = await scrapeGoUsage();
    
    if (usage && usage.fiveHour !== null) {
      return createProviderResult({
        fiveHour: {
          usedPercent: usage.fiveHour ?? 0,
          resetsAt: null,
          windowDurationMins: 300
        },
        sevenDay: {
          usedPercent: usage.sevenDay ?? 0,
          resetsAt: null,
          windowDurationMins: 10080
        }
      });
    }
  } catch (err) {
    console.error('Go scraper error:', err.message);
  }

  // Fall back to local DB
  try {
    const dbModule = require('./opencode-local-db.js');
    const db = dbModule.openDB();
    if (db) {
      const usage = dbModule.getGoUsage(db);
      db.close();
      const total = usage.totalCost;
      return createProviderResult({
        fiveHour: {
          usedPercent: Math.round((total / 12) * 100),
          resetsAt: null,
          windowDurationMins: 300
        },
        sevenDay: {
          usedPercent: Math.round((total / 30) * 100),
          resetsAt: null,
          windowDurationMins: 10080
        }
      });
    }
  } catch (e) {
    console.error('Go DB fallback error:', e.message);
  }

  return createProviderResult({
    error: { message: 'Go usage unavailable.' }
  });
}

module.exports = { fetchOpenCodeGoProviderData };
