// server/providers/exchange-rates.js
'use strict';
const { createProviderResult } = require('./provider-result.js');

const EXCHANGE_RATES_URL = 'https://open.er-api.com/v6/latest/USD';

async function fetchUsdToAudRate({ fetchFn } = {}) {
  const fetcher = fetchFn || fetch;
  const response = await fetcher(EXCHANGE_RATES_URL);
  if (!response.ok) {
    throw new Error(`Exchange rate request failed with status ${response.status}.`);
  }
  const payload = await response.json();
  const audRate = payload?.rates?.AUD;
  if (typeof audRate !== 'number' || !Number.isFinite(audRate)) {
    throw new Error('Exchange rate response did not contain rates.AUD.');
  }
  return audRate;
}

async function fetchExchangeRateProviderData({ deps = {} } = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const audRate = await fetchUsdToAudRate({ fetchFn });
  return {
    ...createProviderResult(),
    rates: { AUD: audRate }
  };
}

async function resolveUsdToAudRate({ providerCacheRepo, deps = {} } = {}) {
  if (providerCacheRepo) {
    const cached = providerCacheRepo.getByProviderId('exchange_rates');
    const cachedRate = cached?.data?.rates?.AUD;
    if (typeof cachedRate === 'number' && Number.isFinite(cachedRate)) {
      return cachedRate;
    }
  }
  const fetchFn = deps.fetchFn || fetch;
  return fetchUsdToAudRate({ fetchFn });
}

module.exports = { fetchExchangeRateProviderData, resolveUsdToAudRate, fetchUsdToAudRate };
