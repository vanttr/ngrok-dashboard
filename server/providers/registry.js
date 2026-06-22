// server/providers/registry.js
'use strict';
const { fetchClaudeCodeProviderData } = require('./claude-code.js');
const { fetchCodexProviderData } = require('./codex.js');
const { fetchOpenRouterProviderData } = require('./openrouter.js');
const { fetchDeepSeekProviderData } = require('./deepseek.js');
const { fetchOpenCodeGoProviderData } = require('./opencode-go.js');
const { fetchOpenCodeZenProviderData } = require('./opencode-zen.js');
const { fetchExchangeRateProviderData } = require('./exchange-rates.js');

function createProviderRegistry(overrides = {}) {
  const defaultProviders = [
    { providerId: 'claude_code', displayName: 'Claude Code', exposeInProvidersApi: false, fetchProviderData: fetchClaudeCodeProviderData },
    { providerId: 'codex', displayName: 'Codex', exposeInProvidersApi: true, fetchProviderData: fetchCodexProviderData },
    { providerId: 'openrouter', displayName: 'OpenRouter', exposeInProvidersApi: true, fetchProviderData: fetchOpenRouterProviderData },
    { providerId: 'deepseek', displayName: 'DeepSeek', exposeInProvidersApi: true, fetchProviderData: fetchDeepSeekProviderData },
    { providerId: 'opencode_go', displayName: 'OpenCode Go', exposeInProvidersApi: true, fetchProviderData: fetchOpenCodeGoProviderData },
    { providerId: 'opencode_zen', displayName: 'OpenCode Zen', exposeInProvidersApi: true, fetchProviderData: fetchOpenCodeZenProviderData },
    { providerId: 'exchange_rates', displayName: 'Exchange Rates', exposeInProvidersApi: false, fetchProviderData: fetchExchangeRateProviderData }
  ];
  return defaultProviders.map(provider => ({ ...provider, ...(overrides[provider.providerId] || {}) }));
}

module.exports = { createProviderRegistry };
