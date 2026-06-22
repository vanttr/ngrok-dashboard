// tests/provider-services.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { normalizeWindow, createProviderResult } = require('../server/providers/provider-result.js');
const { getProviderStatus, buildProviderApiRow } = require('../server/jobs/refresh-providers.js');
const { createProviderRegistry } = require('../server/providers/registry.js');

describe('normalizeWindow', () => {
  it('returns null for falsy input', () => {
    assert.strictEqual(normalizeWindow(null), null);
    assert.strictEqual(normalizeWindow(undefined), null);
    assert.strictEqual(normalizeWindow(false), null);
  });

  it('normalizes valid window data', () => {
    const result = normalizeWindow({ usedPercent: 50, resetsAt: '2026-01-01T00:00:00Z', windowDurationMins: 300 });
    assert.strictEqual(result.usedPercent, 50);
    assert.strictEqual(result.resetsAt, '2026-01-01T00:00:00Z');
    assert.strictEqual(result.windowDurationMins, 300);
  });

  it('fills nulls for missing fields', () => {
    const result = normalizeWindow({});
    assert.strictEqual(result.usedPercent, null);
    assert.strictEqual(result.resetsAt, null);
    assert.strictEqual(result.windowDurationMins, null);
  });
});

describe('createProviderResult', () => {
  it('creates default result with all nulls', () => {
    const result = createProviderResult();
    assert.strictEqual(result.fiveHour, null);
    assert.strictEqual(result.sevenDay, null);
    assert.strictEqual(result.balanceUsd, null);
    assert.strictEqual(result.balanceAud, null);
    assert.strictEqual(result.error, null);
  });

  it('passes through provided values', () => {
    const result = createProviderResult({ balanceUsd: 10.5, error: { message: 'test' } });
    assert.strictEqual(result.balanceUsd, 10.5);
    assert.deepStrictEqual(result.error, { message: 'test' });
  });
});

describe('getProviderStatus', () => {
  it('returns never_fetched when fetchedAt is null/undefined', () => {
    assert.strictEqual(getProviderStatus({ fetchedAt: null, error: null, now: 1000 }), 'never_fetched');
    assert.strictEqual(getProviderStatus({ fetchedAt: undefined, error: null, now: 1000 }), 'never_fetched');
  });

  it('returns error when error is present', () => {
    assert.strictEqual(getProviderStatus({ fetchedAt: 1000, error: { message: 'fail' }, now: 1001 }), 'error');
  });

  it('returns fresh when fetched within 6 min', () => {
    const now = 1000000;
    assert.strictEqual(getProviderStatus({ fetchedAt: now - 1000, error: null, now }), 'fresh');
  });

  it('returns stale when fetched between 6-30 min ago', () => {
    const now = 1000000;
    assert.strictEqual(getProviderStatus({ fetchedAt: now - 7 * 60 * 1000, error: null, now }), 'stale');
  });

  it('returns error when fetched more than 30 min ago', () => {
    const now = 1000000;
    assert.strictEqual(getProviderStatus({ fetchedAt: now - 31 * 60 * 1000, error: null, now }), 'error');
  });
});

describe('buildProviderApiRow', () => {
  it('assembles row from provider and cache row', () => {
    const provider = { providerId: 'test', displayName: 'Test Provider' };
    const cacheRow = {
      data: createProviderResult({ fiveHour: { usedPercent: 10, resetsAt: null, windowDurationMins: 300 } }),
      fetchedAt: 1000
    };
    const row = buildProviderApiRow(provider, cacheRow, 1500); // fresh: < 6 min (500ms diff)
    assert.strictEqual(row.providerId, 'test');
    assert.strictEqual(row.displayName, 'Test Provider');
    assert.strictEqual(row.status, 'fresh');
    assert.strictEqual(row.fiveHour.usedPercent, 10);
    assert.strictEqual(row.error, null);
  });

  it('handles missing cache row', () => {
    const provider = { providerId: 'test', displayName: 'Test' };
    const row = buildProviderApiRow(provider, null, 1000);
    assert.strictEqual(row.status, 'never_fetched');
    assert.strictEqual(row.fiveHour, null);
  });

  it('preserves error from payload', () => {
    const provider = { providerId: 'test', displayName: 'Test' };
    const cacheRow = {
      data: createProviderResult({ error: { message: 'API failed' } }),
      fetchedAt: 1000
    };
    const row = buildProviderApiRow(provider, cacheRow, 1001);
    assert.strictEqual(row.status, 'error');
    assert.deepStrictEqual(row.error, { message: 'API failed' });
  });
});

describe('createProviderRegistry', () => {
  it('returns 7 providers (6 visible + 1 internal)', () => {
    const registry = createProviderRegistry();
    assert.strictEqual(registry.length, 7);
  });

  it('visible providers have exposeInProvidersApi=true', () => {
    const registry = createProviderRegistry();
    const visible = registry.filter(p => p.exposeInProvidersApi);
    assert.strictEqual(visible.length, 5);
    const ids = visible.map(p => p.providerId);
    assert.deepStrictEqual(ids.sort(), ['codex', 'deepseek', 'opencode_go', 'opencode_zen', 'openrouter'].sort());
  });

  it('exchange_rates is not exposed in API', () => {
    const registry = createProviderRegistry();
    const er = registry.find(p => p.providerId === 'exchange_rates');
    assert.ok(er);
    assert.strictEqual(er.exposeInProvidersApi, false);
  });

  it('accepts overrides', () => {
    const registry = createProviderRegistry({ claude_code: { displayName: 'Custom Claude' } });
    const claude = registry.find(p => p.providerId === 'claude_code');
    assert.strictEqual(claude.displayName, 'Custom Claude');
  });
});

describe('opencode-go static limits', () => {
  it('exports Go limit constants from opencode-local-db', () => {
    const { GO_5H_LIMIT, GO_WEEKLY_LIMIT, GO_MONTHLY_LIMIT } = require('../server/providers/opencode-local-db.js');
    assert.strictEqual(GO_5H_LIMIT, 12);
    assert.strictEqual(GO_WEEKLY_LIMIT, 30);
    assert.strictEqual(GO_MONTHLY_LIMIT, 60);
  });
});
