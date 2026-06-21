// server/providers/opencode-zen.js
// OpenCode Zen — reads usage from local OpenCode SQLite DB
'use strict';
const { createProviderResult } = require('./provider-result.js');
const { getZenUsage } = require('./opencode-local-db.js');

async function fetchOpenCodeZenProviderData({ deps = {} } = {}) {
  try {
    const db = deps.openDB ? deps.openDB() : require('./opencode-local-db.js').openDB();
    if (!db) {
      return createProviderResult({
        error: { message: 'OpenCode DB not found. Run opencode CLI first to generate usage data.' }
      });
    }
    const usage = getZenUsage(db);
    db.close();
    return createProviderResult({
      balanceUsd: usage.totalCost
    });
  } catch (err) {
    return createProviderResult({
      error: { message: `Failed to read OpenCode Zen usage: ${err.message}` }
    });
  }
}

module.exports = { fetchOpenCodeZenProviderData };
