#!/usr/bin/env node
/**
 * agy-pty.js — PTY wrapper for agy CLI print mode
 * 
 * Captures terminal output from agy -p, strips ANSI codes,
 * returns clean text response.
 * 
 * Usage:
 *   node scripts/agy-pty.js "your prompt"
 *   node scripts/agy-pty.js "prompt" --model "gemini-2.0-flash"
 *   node scripts/agy-pty.js "prompt" --timeout 60
 */

const pty = require('node-pty');
const path = require('path');
const fs = require('fs');

// ─── Configuration ──────────────────────────────────────────
const AGY_PATH = path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
const DEFAULT_MODEL = '';  // agy uses its default (Gemini 3.5 Flash Medium)
const DEFAULT_TIMEOUT = 60;      // seconds, hard kill
const AGY_PRINT_TIMEOUT = '30s'; // passed to agy --print-timeout

// ─── CLI Argument Parsing ──────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    prompt: '',
    model: DEFAULT_MODEL,
    timeout: DEFAULT_TIMEOUT,
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--model' && i + 1 < args.length) {
      options.model = args[++i];
    } else if (arg === '--timeout' && i + 1 < args.length) {
      options.timeout = parseInt(args[++i], 10);
    } else if (!arg.startsWith('--') && !options.prompt) {
      options.prompt = arg;
    }
    i++;
  }

  return options;
}

function showHelp() {
  console.error(`Usage: node agy-pty.js [options] "your prompt"

Options:
  --model <name>    Model to use (default: agy's default)
  --timeout <sec>   Hard timeout in seconds (default: ${DEFAULT_TIMEOUT})
  --help, -h        Show this help

Example:
  node scripts/agy-pty.js "what is 2+2?"
  node scripts/agy-pty.js "explain async/await" --model "gemini-2.0-flash"
`);
}

// ─── ANSI Stripping ────────────────────────────────────────
function stripAnsi(text) {
  return text
    // Standard CSI sequences: ESC [ ... m/letter
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    // OSC sequences: ESC ] ... BEL/ST
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '')
    // DEC private mode sequences
    .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
    // Other escape sequences
    .replace(/\x1b[\(\)][0-9A-Z]/g, '')
    // DCS, SOS, PM, APC sequences
    .replace(/\x1b[PX^_].*?\x1b\\/g, '')
    // Remaining control characters (except common whitespace)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    // OSC terminator (ST)
    .replace(/\x1b\\/g, '')
    // Extra carriage returns
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Error Detection ───────────────────────────────────────
function detectError(output) {
  const errorPatterns = [
    { pattern: /not logged into/i, message: 'AGY_AUTH_FAILURE: Not logged into Antigravity. Run "agy" interactively first.' },
    { pattern: /no active conversation/i, message: 'AGY_CONVERSATION_FAILURE: Failed to create conversation.' },
    { pattern: /failed to send message/i, message: 'AGY_SEND_FAILURE: Failed to send message.' },
    { pattern: /error getting token source/i, message: 'AGY_TOKEN_FAILURE: Could not get auth token from keyring.' },
  ];

  for (const { pattern, message } of errorPatterns) {
    if (pattern.test(output)) {
      return message;
    }
  }
  return null;
}

// Strip agy's internal status/error messages that appear in terminal output
function stripAgyNoise(text) {
  return text
    .replace(/Error: timed out waiting for response\s*/gi, '')
    .replace(/Error: failed to send message[^\n]*\n?/gi, '')
    .trim();
}

// ─── Core: Run agy via PTY ─────────────────────────────────
async function runAgy(prompt, options = {}) {
  const { model, timeout } = options;

  const agyArgs = ['-p', prompt, '--dangerously-skip-permissions', '--print-timeout', AGY_PRINT_TIMEOUT];
  if (model) {
    agyArgs.push('--model', model);
  }

  console.error(`[agy-pty] Spawning: ${AGY_PATH} ${agyArgs.map(a => `"${a}"`).join(' ')}`);

  return new Promise((resolve, reject) => {
    let output = '';
    let resolved = false;
    let hardTimer = null;

    const finish = (exitCode, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(hardTimer);

      // Try to kill remaining process (ok if already dead)
      try { term.kill(); } catch (_) { /* already dead */ }

      const clean = stripAgyNoise(stripAnsi(output));
      const error = detectError(output);
      
      const result = {
        text: clean,
        exitCode,
        signal,
        rawLength: output.length,
        cleanLength: clean.length,
        error,
      };

      console.error(`[agy-pty] Done: exit=${exitCode} signal=${signal} raw=${output.length}c clean=${clean.length}c`);

      if (error) {
        reject(new Error(error));
      } else {
        resolve(result);
      }
    };

    // Spawn agy via PTY
    let term;
    try {
      term = pty.spawn(AGY_PATH, agyArgs, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: process.cwd(),
        env: { ...process.env },
        // Use ConPTY on Windows — needed for WriteConsole capture
        experimentalUseConpty: true,
      });
    } catch (err) {
      reject(new Error(`AGY_SPAWN_FAILURE: ${err.message}`));
      return;
    }

    console.error(`[agy-pty] PID: ${term.pid}`);

    // Accumulate all PTY output
    term.onData((data) => {
      output += data;
    });

    // Resolve when agy exits naturally (print mode exits after response)
    term.onExit(({ exitCode, signal }) => {
      finish(exitCode, signal);
    });

    // Hard timeout as safety net
    hardTimer = setTimeout(() => {
      console.error(`[agy-pty] Hard timeout (${timeout}s), killing...`);
      try { term.kill(); } catch (_) {}
      // Give it a moment to die, then force-resolve
      setTimeout(() => finish(null, 'SIGTERM'), 500);
    }, timeout * 1000);
  });
}

// ─── Main ──────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();

  if (opts.help || !opts.prompt) {
    showHelp();
    process.exit(opts.help ? 0 : 1);
  }

  try {
    const result = await runAgy(opts.prompt, {
      model: opts.model,
      timeout: opts.timeout,
    });

    // Output clean text to stdout
    if (result.text) {
      process.stdout.write(result.text + '\n');
    }
    process.exit(result.exitCode || 0);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

main();
