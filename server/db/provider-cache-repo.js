// server/db/provider-cache-repo.js
'use strict';

function createProviderCacheRepo(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS provider_cache (
      provider_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `);

  const upsertStatement = database.prepare(`
    INSERT INTO provider_cache (provider_id, data, fetched_at)
    VALUES (@providerId, @data, @fetchedAt)
    ON CONFLICT(provider_id) DO UPDATE SET
      data = excluded.data,
      fetched_at = excluded.fetched_at
  `);
  const getStatement = database.prepare(`
    SELECT provider_id, data, fetched_at FROM provider_cache WHERE provider_id = ?
  `);

  return {
    upsert({ providerId, data, fetchedAt }) {
      upsertStatement.run({ providerId, data: JSON.stringify(data), fetchedAt });
    },
    getByProviderId(providerId) {
      const row = getStatement.get(providerId);
      if (!row) return null;
      return { providerId: row.provider_id, data: JSON.parse(row.data), fetchedAt: row.fetched_at };
    }
  };
}

module.exports = { createProviderCacheRepo };
