// server/providers/opencode-zen.js
// OpenCode Zen — scrapes live balance, falls back to config then local DB
'use strict';
const { createProviderResult } = require('./provider-result.js');

async function fetchOpenCodeZenProviderData({ settings } = {}) {
  // 1. Config override (fastest)
  if (settings && settings.zenBalanceUsd !== undefined && settings.zenBalanceUsd !== null && settings.zenBalanceUsd !== '') {
    const balance = Number(settings.zenBalanceUsd);
    if (Number.isFinite(balance)) {
      return createProviderResult({ balanceUsd: balance });
    }
  }

  // 2. Scrape live balance
  try {
    const { scrapeZenBalance } = require('./opencode-scraper.js');
    const balance = await scrapeZenBalance();
    if (balance !== null && Number.isFinite(balance)) {
      return createProviderResult({ balanceUsd: balance });
    }
  } catch (err) {
    console.error('Zen scraper error:', err.message);
  }

  // 3. Fall back to local DB
  try {
    const dbModule = require('./opencode-local-db.js');
    const db = dbModule.openDB();
    if (db) {
      const usage = dbModule.getZenUsage(db);
      db.close();
      return createProviderResult({ balanceUsd: usage.totalCost });
    }
  } catch {}

  return createProviderResult({
    error: { message: 'Zen balance unavailable.' }
  });
}

module.exports = { fetchOpenCodeZenProviderData };
