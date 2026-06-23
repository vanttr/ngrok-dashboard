// server/providers/codex.js
'use strict';
const { spawn } = require('child_process');
const { createProviderResult } = require('./provider-result.js');

function createJsonRpcError(message) {
  return new Error(`Codex JSON-RPC error: ${message}`);
}

function writeJsonRpc(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

function normalizeResetTimestamp(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const epochMs = value < 10000000000 ? value * 1000 : value;
    return new Date(epochMs).toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function resolveCommandAndArgs(deps) {
  if (deps.command) return { command: deps.command, args: ['app-server'] };
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'codex', 'app-server'] };
  }
  return { command: 'codex', args: ['app-server'] };
}

async function fetchCodexProviderData({ deps = {} } = {}) {
  const spawnFn = deps.spawnFn || spawn;
  const timeoutMs = deps.timeoutMs || 10000;
  const { command, args } = resolveCommandAndArgs(deps);
  const child = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let requestId = 0;
  let buffer = '';
  const initializePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Codex app-server timed out.')); }, timeoutMs);
    function cleanup() { clearTimeout(timeout); child.stdout?.off('data', onData); child.stderr?.off('data', onStderr); child.off('error', onError); child.off('exit', onExit); child.kill('SIGTERM'); }
    function onError(error) { cleanup(); reject(error); }
    function onExit(code) { cleanup(); reject(new Error(`Codex app-server exited before responding (code ${code}).`)); }
    function onStderr(chunk) { void chunk; /* stderr not fatal */ }
    function onData(chunk) {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { cleanup(); reject(new Error('Codex app-server returned invalid JSON.')); return; }
        if (message.error) { cleanup(); reject(createJsonRpcError(message.error.message || 'Unknown error')); return; }
        if (message.id === 2) { cleanup(); resolve(message.result); }
      }
    }
    child.on('error', onError);
    child.on('exit', onExit);
    child.stderr?.on('data', onStderr);
    child.stdout?.on('data', onData);
    requestId += 1;
    writeJsonRpc(child.stdin, { jsonrpc: '2.0', id: requestId, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'llm-dashboard', version: '0.1.0' }, capabilities: {} } });
    writeJsonRpc(child.stdin, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    requestId += 1;
    writeJsonRpc(child.stdin, { jsonrpc: '2.0', id: requestId, method: 'account/rateLimits/read', params: {} });
  });
  const payload = await initializePromise;
  return createProviderResult({
    fiveHour: {
      usedPercent: payload?.rateLimits?.primary?.usedPercent ?? null,
      resetsAt: normalizeResetTimestamp(payload?.rateLimits?.primary?.resetsAt),
      windowDurationMins: payload?.rateLimits?.primary?.windowDurationMins ?? null
    },
    sevenDay: {
      usedPercent: payload?.rateLimits?.secondary?.usedPercent ?? null,
      resetsAt: normalizeResetTimestamp(payload?.rateLimits?.secondary?.resetsAt),
      windowDurationMins: payload?.rateLimits?.secondary?.windowDurationMins ?? null
    }
  });
}

module.exports = { fetchCodexProviderData, normalizeResetTimestamp, resolveCommandAndArgs };
