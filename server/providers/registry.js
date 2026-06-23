// server/providers/registry.js
'use strict';
const { fetchClaudeCodeProviderData } = require('./claude-code.js');
const { fetchCodexProviderData } = require('./codex.js');
const { fetchOpenRouterProviderData } = require('./openrouter.js');
const { fetchDeepSeekProviderData } = require('./deepseek.js');
const { fetchOpenCodeGoProviderData } = require('./opencode-go.js');
const { fetchOpenCodeZenProviderData } = require('./opencode-zen.js');
const { fetchExchangeRateProviderData } = require('./exchange-rates.js');

function createWorkspaceProviders(workspaces = {}) {
  const providers = [];
  for (const [wsKey, ws] of Object.entries(workspaces)) {
    const workspaceId = ws.id;
    const label = ws.label || wsKey;
    providers.push({
      providerId: `opencode_go_${wsKey}`,
      displayName: `Go (${label})`,
      exposeInProvidersApi: true,
      fetchProviderData: (ctx) => fetchOpenCodeGoProviderData({ settings: { ...ctx.settings, workspaceId } })
    });
    providers.push({
      providerId: `opencode_zen_${wsKey}`,
      displayName: `Zen (${label})`,
      exposeInProvidersApi: true,
      fetchProviderData: (ctx) => fetchOpenCodeZenProviderData({ settings: { ...ctx.settings, workspaceId } })
    });
  }
  return providers;
}

function createProviderRegistry(overrides = {}, workspaces = {}) {
  const staticProviders = [
    { providerId: 'claude_code', displayName: 'Claude Code', exposeInProvidersApi: true, fetchProviderData: fetchClaudeCodeProviderData },
    { providerId: 'codex', displayName: 'Codex', exposeInProvidersApi: true, fetchProviderData: fetchCodexProviderData },
    { providerId: 'openrouter', displayName: 'OpenRouter', exposeInProvidersApi: true, fetchProviderData: fetchOpenRouterProviderData },
    { providerId: 'deepseek', displayName: 'DeepSeek', exposeInProvidersApi: true, fetchProviderData: fetchDeepSeekProviderData },
    { providerId: 'exchange_rates', displayName: 'Exchange Rates', exposeInProvidersApi: false, fetchProviderData: fetchExchangeRateProviderData }
  ];

  const hasWorkspaces = workspaces && Object.keys(workspaces).length > 0;
  const opencodeProviders = hasWorkspaces
    ? createWorkspaceProviders(workspaces)
    : [
        { providerId: 'opencode_go', displayName: 'OpenCode Go', exposeInProvidersApi: true, fetchProviderData: fetchOpenCodeGoProviderData },
        { providerId: 'opencode_zen', displayName: 'OpenCode Zen', exposeInProvidersApi: true, fetchProviderData: fetchOpenCodeZenProviderData }
      ];

  return [...staticProviders, ...opencodeProviders].map(
    provider => ({ ...provider, ...(overrides[provider.providerId] || {}) })
  );
}

module.exports = { createProviderRegistry };
