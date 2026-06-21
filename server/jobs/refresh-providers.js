// server/jobs/refresh-providers.js
'use strict';
const { createProviderResult } = require('../providers/provider-result.js');

const STALE_WARNING_MS = 6 * 60 * 1000;
const STALE_ERROR_MS = 30 * 60 * 1000;

function getProviderStatus({ fetchedAt, error, now = Date.now() }) {
  if (fetchedAt === null || fetchedAt === undefined) return 'never_fetched';
  if (error) return 'error';
  const age = now - fetchedAt;
  if (age >= STALE_ERROR_MS) return 'error';
  if (age >= STALE_WARNING_MS) return 'stale';
  return 'fresh';
}

function buildProviderApiRow(provider, cacheRow, now = Date.now()) {
  const payload = cacheRow?.data || createProviderResult();
  return {
    providerId: provider.providerId,
    displayName: provider.displayName,
    status: getProviderStatus({ fetchedAt: cacheRow?.fetchedAt ?? null, error: payload.error, now }),
    fiveHour: payload.fiveHour ?? null,
    sevenDay: payload.sevenDay ?? null,
    balanceUsd: payload.balanceUsd ?? null,
    balanceAud: payload.balanceAud ?? null,
    error: payload.error ?? null,
    fetchedAt: cacheRow?.fetchedAt ?? null
  };
}

function createRefreshService({ registry, providerCacheRepo, settings, now = () => Date.now() }) {
  const ownerFacingProviders = registry.filter(p => p.exposeInProvidersApi);

  async function refreshProvider(providerId) {
    const provider = registry.find(e => e.providerId === providerId);
    if (!provider) return null;
    try {
      const result = await provider.fetchProviderData({ settings, providerCacheRepo, deps: { now } });
      providerCacheRepo.upsert({ providerId: provider.providerId, data: result, fetchedAt: now() });
      return providerCacheRepo.getByProviderId(provider.providerId);
    } catch (error) {
      const previous = providerCacheRepo.getByProviderId(provider.providerId);
      providerCacheRepo.upsert({
        providerId: provider.providerId,
        data: { ...(previous?.data || createProviderResult()), error: { message: error.message } },
        fetchedAt: previous?.fetchedAt ?? now()
      });
      return providerCacheRepo.getByProviderId(provider.providerId);
    }
  }

  async function refreshAll() {
    for (const provider of registry) {
      await refreshProvider(provider.providerId);
    }
  }

  function listProviderRows() {
    return ownerFacingProviders.map(provider =>
      buildProviderApiRow(provider, providerCacheRepo.getByProviderId(provider.providerId), now())
    );
  }

  return { ownerFacingProviders, refreshAll, refreshProvider, listProviderRows };
}

module.exports = { createRefreshService, getProviderStatus, buildProviderApiRow };
