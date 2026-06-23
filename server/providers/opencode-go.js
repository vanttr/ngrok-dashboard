// server/providers/opencode-go.js
// OpenCode Go — scrapes live usage from opencode.ai workspace
'use strict';
const { createProviderResult } = require('./provider-result.js');

async function fetchOpenCodeGoProviderData({ settings } = {}) {
  const workspaceId = settings?.workspaceId;
  try {
    const { scrapeGoUsage } = require('./opencode-scraper.js');
    const usage = await scrapeGoUsage(workspaceId);

    if (usage && usage.fiveHour !== null) {
      return createProviderResult({
        fiveHour: {
          usedPercent: usage.fiveHour ?? 0,
          resetsAt: usage.fiveHourResetsAt ?? null,
          windowDurationMins: 300
        },
        sevenDay: {
          usedPercent: usage.sevenDay ?? 0,
          resetsAt: usage.sevenDayResetsAt ?? null,
          windowDurationMins: 10080
        },
        monthly: usage.monthlyPct !== null ? {
          usedPercent: usage.monthlyPct,
          resetsAt: usage.monthlyResetsAt ?? null,
          windowDurationMins: 43200
        } : null
      });
    }
  } catch (err) {
    console.error('Go scraper error:', err.message);
  }

  return createProviderResult({
    error: { message: 'OpenCode session expired. Log into opencode.ai in Firefox.' }
  });
}

module.exports = { fetchOpenCodeGoProviderData };
