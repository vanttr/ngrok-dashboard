// server/providers/claude-code.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProviderResult } = require('./provider-result.js');

function getClaudeCredentialsPath(homeDir = os.homedir(), platform = process.platform) {
  if (platform === 'win32') {
    return path.join(homeDir, '.claude', '.credentials.json');
  }
  return path.join(homeDir, '.claude', '.credentials.json');
}

function readCredentials(credentialsPath, readFileFn = fs.readFileSync) {
  const raw = JSON.parse(readFileFn(credentialsPath, 'utf8'));
  const oauth = raw.claudeAiOauth || raw.oauth || raw;
  return {
    accessToken: oauth.accessToken || oauth.access_token || raw.accessToken || raw.access_token,
    refreshToken: oauth.refreshToken || oauth.refresh_token || raw.refreshToken || raw.refresh_token,
    expiresAt: oauth.expiresAt || oauth.expires_at || raw.expiresAt || raw.expires_at || null
  };
}

function normalizeClaudeUtilization(utilization) {
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null;
  if (utilization <= 1) return Math.round(utilization * 100);
  return Math.round(utilization);
}

function computeResetsAt(apiResetsAt, windowDurationMins) {
  if (apiResetsAt) return apiResetsAt;
  return new Date(Date.now() + windowDurationMins * 60 * 1000).toISOString();
}

async function fetchClaudeCodeProviderData({ deps = {} } = {}) {
  const credentialsPath = deps.credentialsPath || getClaudeCredentialsPath(deps.homeDir || os.homedir(), deps.platform || process.platform);
  let credentials = readCredentials(credentialsPath, deps.readFileFn);
  if (!credentials.accessToken || !credentials.refreshToken) {
    throw new Error('Claude credentials file is missing OAuth tokens.');
  }
  const fetcher = deps.fetchFn || fetch;
  const response = await fetcher('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20'
    }
  });
  if (!response.ok) {
    throw new Error(`Claude usage request failed with status ${response.status}.`);
  }
  const payload = await response.json();

  // Check for OAuth error (token expired — needs refresh)
  if (payload?.error) {
    throw new Error(`Claude OAuth error: ${payload.error.message || payload.error}`);
  }

  return createProviderResult({
    fiveHour: {
      usedPercent: normalizeClaudeUtilization(payload?.five_hour?.utilization),
      resetsAt: computeResetsAt(payload?.five_hour?.resets_at, 300),
      windowDurationMins: 300
    },
    sevenDay: {
      usedPercent: normalizeClaudeUtilization(payload?.seven_day?.utilization),
      resetsAt: computeResetsAt(payload?.seven_day?.resets_at, 10080),
      windowDurationMins: 10080
    }
  });
}

module.exports = { fetchClaudeCodeProviderData, getClaudeCredentialsPath, readCredentials, normalizeClaudeUtilization };
