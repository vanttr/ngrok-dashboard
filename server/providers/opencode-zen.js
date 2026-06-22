// server/providers/opencode-zen.js
// OpenCode Zen — prefers zenBalanceUsd from settings, falls back to local DB
'use strict';
const { createProviderResult } = require('./provider-result.js');
const { getZenUsage } = require('./opencode-local-db.js');

async function fetchOpenCodeZenProviderData({ settings, deps = {} } = {}) {
  // Prefer manually configured balance from usage.json
  if (settings && settings.zenBalanceUsd !== undefined && settings.zenBalanceUsd !== null && settings.zenBalanceUsd !== '') {
    const balance = Number(settings.zenBalanceUsd);
    if (Number.isFinite(balance)) {
      return createProviderResult({ balanceUsd: balance });
    }
  }

  // Fall back to local OpenCode DB
  try {
    const db = deps.openDB ? deps.openDB() : require('./opencode-local-db.js').openDB();
    if (!db) {
      return createProviderResult({
        error: { message: 'OpenCode DB not found. Run opencode CLI first.' }
      });
    }
    const usage = getZenUsage(db);
    db.close();
    return createProviderResult({ balanceUsd: usage.totalCost });
  } catch (err) {
    return createProviderResult({
      error: { message: `Failed to read Zen usage: ${err.message}` }
    });
  }
}

module.exports = { fetchOpenCodeZenProviderData };
