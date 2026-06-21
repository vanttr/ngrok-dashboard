// server/providers/opencode-local-db.js
// Reads usage data from the OpenCode local SQLite database
'use strict';
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const DB_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

function openDB() {
  try {
    return new Database(DB_PATH, { readonly: true });
  } catch {
    return null;
  }
}

function getProviderCost(db, providerId, sinceMs) {
  if (!db) return 0;
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total
    FROM session
    WHERE json_extract(model, '$.providerID') = ?
    AND time_created >= ?
  `).get(providerId, sinceMs);
  return Number(row.total || 0);
}

function getProviderStats(db, providerId) {
  if (!db) return { totalCost: 0, sessions: 0, lastSeen: null };
  const row = db.prepare(`
    SELECT 
      COALESCE(SUM(cost), 0) as total_cost,
      COUNT(*) as sessions,
      MAX(time_created) as last_seen
    FROM session
    WHERE json_extract(model, '$.providerID') = ?
  `).get(providerId);
  return {
    totalCost: Number(row.total_cost || 0),
    sessions: row.sessions || 0,
    lastSeen: row.last_seen || null
  };
}

// Go limits from OpenCode docs: 5h=$12, weekly=$30, monthly=$60
const GO_5H_LIMIT = 12;
const GO_WEEKLY_LIMIT = 30;
const GO_MONTHLY_LIMIT = 60;

function getGoUsage(db) {
  const now = Date.now();
  const fiveHourCost = getProviderCost(db, 'opencode-go', now - 5 * 60 * 60 * 1000);
  const weeklyCost = getProviderCost(db, 'opencode-go', now - 7 * 24 * 60 * 60 * 1000);
  const stats = getProviderStats(db, 'opencode-go');

  return {
    fiveHour: {
      usedPercent: Math.round((fiveHourCost / GO_5H_LIMIT) * 100),
      resetsAt: null,
      windowDurationMins: 300
    },
    sevenDay: {
      usedPercent: Math.round((weeklyCost / GO_WEEKLY_LIMIT) * 100),
      resetsAt: null,
      windowDurationMins: 10080
    },
    totalCost: stats.totalCost,
    sessions: stats.sessions,
    lastSeen: stats.lastSeen
  };
}

function getZenUsage(db) {
  const stats = getProviderStats(db, 'opencode');
  return {
    totalCost: stats.totalCost,
    sessions: stats.sessions,
    lastSeen: stats.lastSeen
  };
}

module.exports = { openDB, getGoUsage, getZenUsage, GO_5H_LIMIT, GO_WEEKLY_LIMIT, GO_MONTHLY_LIMIT };
