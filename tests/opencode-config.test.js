const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, readFileSync, mkdtempSync, rmSync, renameSync } = require('fs');
const path = require('path');
const os = require('os');

// ---- Stub functions from server.js (pure, testable) ----

function parseModelId(modelStr) {
  if (!modelStr || typeof modelStr !== 'string') return { provider: '', modelId: '' };
  const idx = modelStr.indexOf('/');
  if (idx === -1) return { provider: '', modelId: modelStr };
  return {
    provider: modelStr.substring(0, idx),
    modelId: modelStr.substring(idx + 1)
  };
}

function parseModelsNdjson(stdout) {
  const models = [];
  const lines = stdout.split('\n');
  let i = 0;
  while (i < lines.length) {
    let line = lines[i].trim();
    if (!line) { i++; continue; }
    if (!line.startsWith('{') && !line.startsWith('}') && !line.startsWith('[') && !line.startsWith('"')) {
      const idLine = line;
      i++;
      let jsonStr = '';
      while (i < lines.length) {
        const nextLine = lines[i];
        const trimmed = nextLine.trim();
        if (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('}') &&
            !trimmed.startsWith('[') && !trimmed.startsWith('"') && !trimmed.startsWith(',')) {
          break;
        }
        jsonStr += (jsonStr ? '\n' : '') + nextLine;
        i++;
        try {
          const meta = JSON.parse(jsonStr);
          models.push({
            id: meta.id || '',
            provider: meta.providerID || '',
            name: meta.name || idLine,
            capabilities: meta.capabilities || {},
            cost: meta.cost || {},
            limit: meta.limit || {}
          });
          break;
        } catch { /* keep accumulating */ }
      }
    } else {
      i++;
    }
  }
  return models;
}

function readSubagentConfig(configPath) {
  const raw = readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  const agents = {};
  if (config.agent) {
    for (const [name, entry] of Object.entries(config.agent)) {
      if (entry.mode === 'subagent' && entry.model) {
        const parsed = parseModelId(entry.model);
        agents[name] = {
          model: entry.model,
          provider: parsed.provider,
          modelId: parsed.modelId
        };
      }
    }
  }
  return agents;
}

function patchAgentModels(configPath, updates) {
  const raw = readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  if (!config.agent) config.agent = {};

  for (const [name, model] of Object.entries(updates)) {
    if (!config.agent[name]) {
      throw new Error(`Unknown agent: ${name}`);
    }
    config.agent[name].model = model;
  }

  const tmpPath = configPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf8');
  renameSync(tmpPath, configPath);
}

// ---- Tests ----

describe('parseModelsNdjson', () => {
  it('parses a single model from NDJSON with multi-line JSON', () => {
    const input = `anthropic/claude-sonnet-4-20250514
{
  "id": "anthropic/claude-sonnet-4-20250514",
  "providerID": "anthropic",
  "name": "Claude Sonnet 4",
  "capabilities": {
    "tools": true,
    "vision": true,
    "promptCaching": true
  },
  "cost": {
    "input": 3,
    "output": 15,
    "currency": "USD"
  },
  "limit": {
    "maxTokens": 8192
  }
}`;
    const result = parseModelsNdjson(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'anthropic/claude-sonnet-4-20250514');
    assert.equal(result[0].provider, 'anthropic');
    assert.equal(result[0].name, 'Claude Sonnet 4');
    assert.deepEqual(result[0].capabilities.tools, true);
    assert.deepEqual(result[0].cost, { input: 3, output: 15, currency: 'USD' });
    assert.deepEqual(result[0].limit, { maxTokens: 8192 });
  });

  it('parses multiple models from multiple providers', () => {
    const input = `openai/gpt-4o
{
  "id": "openai/gpt-4o",
  "providerID": "openai",
  "name": "GPT-4o"
}
anthropic/claude-sonnet-4-20250514
{
  "id": "anthropic/claude-sonnet-4-20250514",
  "providerID": "anthropic",
  "name": "Claude Sonnet 4"
}`;
    const result = parseModelsNdjson(input);
    assert.equal(result.length, 2);
    assert.equal(result[0].provider, 'openai');
    assert.equal(result[1].provider, 'anthropic');
  });

  it('returns empty array for empty input', () => {
    const result = parseModelsNdjson('');
    assert.deepEqual(result, []);
  });

  it('parses model with ID line only, no JSON block', () => {
    const input = `openai/gpt-4o-mini
{
  "id": "openai/gpt-4o-mini",
  "providerID": "openai"
}`;
    const result = parseModelsNdjson(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'openai/gpt-4o-mini');
  });

  it('skips malformed JSON block, continues parsing next model', () => {
    const input = `openai/gpt-4o
{broken}
anthropic/claude-sonnet-4-20250514
{
  "id": "anthropic/claude-sonnet-4-20250514",
  "providerID": "anthropic"
}`;
    const result = parseModelsNdjson(input);
    // First model's JSON is broken so it's skipped, second is parsed
    assert.equal(result.length, 1);
    assert.equal(result[0].provider, 'anthropic');
  });

  it('handles multi-line JSON blocks with nested objects', () => {
    const input = `openrouter/anthropic/claude-3.5-sonnet
{
  "id": "openrouter/anthropic/claude-3.5-sonnet",
  "providerID": "openrouter",
  "name": "Claude 3.5 Sonnet (OpenRouter)",
  "capabilities": {
    "tools": true,
    "vision": false,
    "promptCaching": false
  },
  "cost": {
    "input": 3,
    "output": 15,
    "currency": "USD"
  }
}`;
    const result = parseModelsNdjson(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'openrouter/anthropic/claude-3.5-sonnet');
    assert.equal(result[0].provider, 'openrouter');
    assert.equal(result[0].capabilities.tools, true);
    assert.equal(result[0].cost.input, 3);
  });
});

describe('parseModelId', () => {
  it('splits simple "provider/model" on first / only', () => {
    const result = parseModelId('anthropic/claude-sonnet-4-20250514');
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.modelId, 'claude-sonnet-4-20250514');
  });

  it('handles compound model IDs with multiple slashes', () => {
    const result = parseModelId('openrouter/xiaomi/mimo-v2.5');
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.modelId, 'xiaomi/mimo-v2.5');
  });

  it('handles model string with no slash', () => {
    const result = parseModelId('gpt-4o');
    assert.equal(result.provider, '');
    assert.equal(result.modelId, 'gpt-4o');
  });

  it('handles opencode-go provider prefix', () => {
    const result = parseModelId('opencode-go/anthropic/claude-sonnet-4-20250514');
    assert.equal(result.provider, 'opencode-go');
    assert.equal(result.modelId, 'anthropic/claude-sonnet-4-20250514');
  });

  it('returns empty strings for null/undefined/empty input', () => {
    assert.deepEqual(parseModelId(null), { provider: '', modelId: '' });
    assert.deepEqual(parseModelId(undefined), { provider: '', modelId: '' });
    assert.deepEqual(parseModelId(''), { provider: '', modelId: '' });
  });
});

describe('readSubagentConfig', () => {
  it('extracts only subagent-mode agents from a temp opencode.json', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-config-test-'));
    const configPath = path.join(tmpDir, 'opencode.json');
    const config = {
      $schema: 'https://raw.githubusercontent.com/opencode-ai/opencode/main/schema.json',
      agent: {
        'coder': {
          mode: 'subagent',
          model: 'anthropic/claude-sonnet-4-20250514',
          description: 'Coding agent',
          prompt: 'You are a coder'
        },
        'debugger': {
          mode: 'subagent',
          model: 'openai/gpt-4o',
          description: 'Debugging agent'
        },
        'planner': {
          mode: 'plan',
          model: 'anthropic/claude-sonnet-4-20250514'
        },
        'no-model-agent': {
          mode: 'subagent'
        }
      }
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = readSubagentConfig(configPath);
    assert.equal(Object.keys(result).length, 2);
    assert.ok(result.coder);
    assert.equal(result.coder.model, 'anthropic/claude-sonnet-4-20250514');
    assert.equal(result.coder.provider, 'anthropic');
    assert.equal(result.coder.modelId, 'claude-sonnet-4-20250514');
    assert.ok(result.debugger);
    assert.equal(result.debugger.model, 'openai/gpt-4o');
    assert.equal(result.debugger.provider, 'openai');
    assert.equal(result.debugger.modelId, 'gpt-4o');
    // planner is not subagent mode, no-model-agent has no model
    assert.ok(!result.planner);
    assert.ok(!result['no-model-agent']);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty object when no subagent agents exist', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-config-test-'));
    const configPath = path.join(tmpDir, 'opencode.json');
    const config = {
      agent: {
        'helper': {
          mode: 'plan',
          model: 'anthropic/claude-sonnet-4-20250514'
        }
      }
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = readSubagentConfig(configPath);
    assert.deepEqual(result, {});

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty object when no agent field exists', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-config-test-'));
    const configPath = path.join(tmpDir, 'opencode.json');
    const config = { $schema: 'https://example.com/schema.json' };
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = readSubagentConfig(configPath);
    assert.deepEqual(result, {});

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('patchAgentModels', () => {
  it('patches only agent.model fields, preserves everything else', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-config-test-'));
    const configPath = path.join(tmpDir, 'opencode.json');
    const config = {
      $schema: 'https://raw.githubusercontent.com/opencode-ai/opencode/main/schema.json',
      agent: {
        'coder': {
          mode: 'subagent',
          model: 'anthropic/claude-sonnet-4-20250514',
          description: 'Coding agent',
          prompt: 'You are a coder'
        },
        'debugger': {
          mode: 'subagent',
          model: 'openai/gpt-4o',
          description: 'Debugging agent'
        }
      }
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    patchAgentModels(configPath, {
      coder: 'openai/gpt-4o',
      debugger: 'anthropic/claude-sonnet-4-20250514'
    });

    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    // Models should be updated
    assert.equal(updated.agent.coder.model, 'openai/gpt-4o');
    assert.equal(updated.agent.debugger.model, 'anthropic/claude-sonnet-4-20250514');
    // Everything else preserved
    assert.equal(updated.agent.coder.mode, 'subagent');
    assert.equal(updated.agent.coder.description, 'Coding agent');
    assert.equal(updated.agent.coder.prompt, 'You are a coder');
    assert.equal(updated.agent.debugger.mode, 'subagent');
    assert.equal(updated.agent.debugger.description, 'Debugging agent');
    // $schema preserved
    assert.equal(updated.$schema, config.$schema);

    // No .tmp file left behind
    assert.ok(!require('fs').existsSync(configPath + '.tmp'));

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws for unknown agent name', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-config-test-'));
    const configPath = path.join(tmpDir, 'opencode.json');
    const config = {
      agent: {
        'coder': {
          mode: 'subagent',
          model: 'anthropic/claude-sonnet-4-20250514'
        }
      }
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    assert.throws(() => {
      patchAgentModels(configPath, { 'nonexistent': 'openai/gpt-4o' });
    }, /Unknown agent: nonexistent/);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes atomically and leaves no .tmp file', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-config-test-'));
    const configPath = path.join(tmpDir, 'opencode.json');
    const config = {
      agent: {
        'coder': {
          mode: 'subagent',
          model: 'anthropic/claude-sonnet-4-20250514'
        }
      }
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    patchAgentModels(configPath, { coder: 'openai/gpt-4o' });

    // .tmp should not exist
    assert.equal(require('fs').existsSync(configPath + '.tmp'), false);
    // File should be valid and updated
    const content = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(content.agent.coder.model, 'openai/gpt-4o');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
