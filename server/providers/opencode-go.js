// server/providers/opencode-go.js
'use strict';
const { createProviderResult } = require('./provider-result.js');

// Static Go limits from OpenCode docs (https://opencode.ai/docs/go/)
const GO_LIMITS = {
  fiveHour: { usedPercent: 0, resetsAt: null, windowDurationMins: 300 },
  sevenDay: { usedPercent: 0, resetsAt: null, windowDurationMins: 10080 },
  monthly: { usedDollars: 0, limitDollars: 60 }
};

const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

async function fetchOpenCodeGoProviderData({ settings, deps = {} } = {}) {
  const apiKey = settings.opencodeGoApiKey;
  if (!apiKey) {
    return createProviderResult({
      fiveHour: { ...GO_LIMITS.fiveHour },
      sevenDay: { ...GO_LIMITS.sevenDay },
      error: { message: 'OpenCode Go API key is not configured. Set it in usage.json. Showing static limits.' }
    });
  }
  const fetchFn = deps.fetchFn || fetch;
  try {
    const response = await fetchFn(GO_USAGE_URL, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!response.ok) {
      throw new Error(`OpenCode Go usage request failed with status ${response.status}.`);
    }
    const payload = await response.json();
    return createProviderResult({
      fiveHour: {
        usedPercent: payload?.fiveHour?.usedPercent ?? GO_LIMITS.fiveHour.usedPercent,
        resetsAt: payload?.fiveHour?.resetsAt ?? null,
        windowDurationMins: payload?.fiveHour?.windowDurationMins ?? GO_LIMITS.fiveHour.windowDurationMins
      },
      sevenDay: {
        usedPercent: payload?.sevenDay?.usedPercent ?? GO_LIMITS.sevenDay.usedPercent,
        resetsAt: payload?.sevenDay?.resetsAt ?? null,
        windowDurationMins: payload?.sevenDay?.windowDurationMins ?? GO_LIMITS.sevenDay.windowDurationMins
      }
    });
  } catch (err) {
    return createProviderResult({
      fiveHour: { ...GO_LIMITS.fiveHour },
      sevenDay: { ...GO_LIMITS.sevenDay },
      error: { message: `OpenCode Go API unavailable: ${err.message}. Showing static limits.` }
    });
  }
}

module.exports = { fetchOpenCodeGoProviderData, GO_LIMITS };
