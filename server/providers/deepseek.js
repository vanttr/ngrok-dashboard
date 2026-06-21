// server/providers/deepseek.js
'use strict';
const { createProviderResult } = require('./provider-result.js');
const { resolveUsdToAudRate } = require('./exchange-rates.js');

const DEEPSEEK_URL = 'https://api.deepseek.com/user/balance';

async function fetchDeepSeekProviderData({ settings, providerCacheRepo, deps = {} } = {}) {
  const apiKey = settings.deepseekApiKey;
  if (!apiKey) throw new Error('DeepSeek API key is not configured. Set it in usage.json.');
  const fetchFn = deps.fetchFn || fetch;
  const response = await fetchFn(DEEPSEEK_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`DeepSeek request failed with status ${response.status}.`);
  const payload = await response.json();
  const usdEntry = payload?.balance_infos?.find(entry => entry?.currency === 'USD') || payload?.balance_infos?.[0];
  const rawBalance = usdEntry?.total_balance;
  const balanceUsd = typeof rawBalance === 'string' ? Number.parseFloat(rawBalance) : rawBalance;
  if (typeof balanceUsd !== 'number' || !Number.isFinite(balanceUsd)) {
    throw new Error('DeepSeek response did not contain balance_infos[0].total_balance.');
  }
  const audRate = await resolveUsdToAudRate({ providerCacheRepo, deps });
  return createProviderResult({
    balanceUsd,
    balanceAud: Number((balanceUsd * audRate).toFixed(2))
  });
}

module.exports = { fetchDeepSeekProviderData };
