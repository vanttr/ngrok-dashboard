// server/providers/claude-code.js
// Claude Code usage provider — reads from claude.ai internal API using browser session cookie
// Uses Firefox cookies (separate from CLI OAuth) — cannot sign out the CLI
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');
const { createProviderResult } = require('./provider-result.js');

const FF_PROFILE = path.join(os.homedir(), 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles', 'g03o95vf.default-nightly');

function normalizeClaudeUtilization(utilization) {
  // Kept as fallback; prefer limits[].percent which is unambiguous
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null;
  if (utilization <= 1) return Math.round(utilization * 100);
  return Math.round(utilization);
}

/**
 * Extract usage percentages + reset times from the limits array.
 * The limits array has unambiguous `percent` values (already 0-100 integers).
 * Falls back to five_hour / seven_day fields if limits is missing.
 */
function extractLimits(payload) {
  const limits = Array.isArray(payload?.limits) ? payload.limits : [];
  const findLimit = (kind) => limits.find(l => l.kind === kind) || null;

  const sessionLimit = findLimit('session');
  const weeklyLimit  = findLimit('weekly_all');

  return {
    fiveHour: {
      usedPercent: sessionLimit?.percent ?? normalizeClaudeUtilization(payload?.five_hour?.utilization),
      resetsAt:    sessionLimit?.resets_at ?? payload?.five_hour?.resets_at ?? null,
      windowDurationMins: 300
    },
    sevenDay: {
      usedPercent: weeklyLimit?.percent ?? normalizeClaudeUtilization(payload?.seven_day?.utilization),
      resetsAt:    weeklyLimit?.resets_at ?? payload?.seven_day?.resets_at ?? null,
      windowDurationMins: 10080
    }
  };
}

function readSessionKey(cookiePath) {
  if (!fs.existsSync(cookiePath)) return null;
  let db;
  try {
    db = new Database(cookiePath, { readonly: true });
    const key = db.prepare(
      `SELECT value FROM moz_cookies WHERE host = '.claude.ai' AND name = 'sessionKey' ORDER BY expiry DESC LIMIT 1`
    ).pluck().get();
    return key || null;
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

async function fetchClaudeCodeProviderData({ deps = {} } = {}) {
  const fetcher = deps.fetchFn || fetch;

  // 1. Read session key from Firefox cookies
  const cookiePath = path.join(FF_PROFILE, 'cookies.sqlite');
  const sessionKey = readSessionKey(cookiePath);
  if (!sessionKey) {
    return createProviderResult({
      error: { message: 'Claude session expired. Log into claude.ai in Firefox.' }
    });
  }

  const headers = {
    'Cookie': `sessionKey=${sessionKey}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0'
  };

  try {
    // 2. Get organization ID
    const orgResp = await fetcher('https://claude.ai/api/organizations', { headers });
    if (!orgResp.ok) {
      throw new Error(`Organizations request failed (${orgResp.status})`);
    }
    const orgs = await orgResp.json();
    const orgId = orgs?.[0]?.uuid;
    if (!orgId) {
      throw new Error('No organization found');
    }

    // 3. Get usage data
    const usageResp = await fetcher(
      `https://claude.ai/api/organizations/${orgId}/usage`,
      { headers }
    );
    if (!usageResp.ok) {
      throw new Error(`Usage request failed (${usageResp.status})`);
    }
    const payload = await usageResp.json();

    return createProviderResult(extractLimits(payload));
  } catch (err) {
    return createProviderResult({
      error: { message: `Claude usage unavailable: ${err.message}` }
    });
  }
}

module.exports = { fetchClaudeCodeProviderData, readSessionKey, normalizeClaudeUtilization, extractLimits };
