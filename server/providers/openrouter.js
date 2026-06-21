// server/providers/openrouter.js
'use strict';
const { createProviderResult } = require('./provider-result.js');
const { resolveUsdToAudRate } = require('./exchange-rates.js');

const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';

async function fetchJson(fetcher, url, apiKey) {
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`OpenRouter request failed with status ${response.status}.`);
  return response.json();
}

async function fetchOpenRouterProviderData({ settings, providerCacheRepo, deps = {} } = {}) {
  const apiKey = settings.openrouterApiKey;
  if (!apiKey) throw new Error('OpenRouter API key is not configured. Set it in usage.json.');
  const fetchFn = deps.fetchFn || fetch;
  const payload = await fetchJson(fetchFn, OPENROUTER_KEY_URL, apiKey);
  const remainingValue = payload?.data?.limit_remaining;
  let balanceUsd = typeof remainingValue === 'number' ? remainingValue
    : typeof remainingValue === 'string' && remainingValue.trim() ? Number(remainingValue) : null;
  if (balanceUsd !== null && !Number.isFinite(balanceUsd)) {
    throw new Error('OpenRouter response contained an invalid data.limit_remaining value.');
  }
  if (balanceUsd === null) {
    const creditsPayload = await fetchJson(fetchFn, OPENROUTER_CREDITS_URL, apiKey);
    const totalCredits = creditsPayload?.data?.total_credits;
    const totalUsage = creditsPayload?.data?.total_usage;
    if (typeof totalCredits !== 'number' || !Number.isFinite(totalCredits) ||
        typeof totalUsage !== 'number' || !Number.isFinite(totalUsage)) {
      return createProviderResult();
    }
    balanceUsd = Number(Math.max(0, totalCredits - totalUsage).toFixed(2));
  }
  const audRate = await resolveUsdToAudRate({ providerCacheRepo, deps });
  return createProviderResult({
    balanceUsd,
    balanceAud: Number((balanceUsd * audRate).toFixed(2))
  });
}

module.exports = { fetchOpenRouterProviderData };
