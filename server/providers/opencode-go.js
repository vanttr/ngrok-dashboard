// server/providers/opencode-go.js
// OpenCode Go — reads total cost from local OpenCode SQLite DB
// Shows usage against known limits: 5h=$12, weekly=$30, monthly=$60
'use strict';
const { createProviderResult } = require('./provider-result.js');
const { getGoUsage } = require('./opencode-local-db.js');

async function fetchOpenCodeGoProviderData({ deps = {} } = {}) {
  try {
    const dbModule = require('./opencode-local-db.js');
    const db = dbModule.openDB();
    if (!db) {
      return createProviderResult({
        error: { message: 'OpenCode DB not found. Run opencode CLI first.' }
      });
    }
    const usage = getGoUsage(db);
    db.close();

    // Show total cost as percentage of each limit cap
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
  } catch (err) {
    return createProviderResult({
      error: { message: `Failed to read OpenCode Go usage: ${err.message}` }
    });
  }
}

module.exports = { fetchOpenCodeGoProviderData };
