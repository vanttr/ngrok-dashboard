// tests/opencode-scraper.test.js
// Unit tests for parseResetTime — whitespace handling and edge cases
'use strict';
const { parseResetTime } = require('../server/providers/opencode-scraper.js');

function assert(label, fn) {
  try {
    fn();
    console.log(`  PASS: ${label}`);
  } catch (e) {
    console.error(`  FAIL: ${label} — ${e.message}`);
    process.exitCode = 1;
  }
}

// Helper: check that result is a valid ISO string within expected range
function isWithinMs(result, expectedMs, toleranceMs = 5000) {
  if (!result) return false;
  const actualMs = new Date(result).getTime() - Date.now();
  return Math.abs(actualMs - expectedMs) <= toleranceMs;
}

// Normal text — same line
assert('hours+minutes on same line', () => {
  const r = parseResetTime('Rolling Usage 85%\nResets in 4 hours 15 minutes\n');
  if (!isWithinMs(r, 4 * 3600000 + 15 * 60000)) throw new Error(`got ${r}`);
});

// Newlines in text (simulating innerText from multi-element HTML)
assert('hours+minutes with newlines between tokens', () => {
  const r = parseResetTime('Rolling Usage\n85%\nResets in\n4 hours\n15 minutes');
  if (!isWithinMs(r, 4 * 3600000 + 15 * 60000)) throw new Error(`got ${r}`);
});

// Days + hours
assert('days+hours', () => {
  const r = parseResetTime('Resets in 6 days 21 hours');
  if (!isWithinMs(r, 6 * 86400000 + 21 * 3600000)) throw new Error(`got ${r}`);
});

// Days + hours with newlines
assert('days+hours with newlines', () => {
  const r = parseResetTime('Resets in\n6 days\n21 hours');
  if (!isWithinMs(r, 6 * 86400000 + 21 * 3600000)) throw new Error(`got ${r}`);
});

// Hours only (no minutes mentioned)
assert('hours only (no minutes)', () => {
  const r = parseResetTime('Resets in 5 hours');
  if (!isWithinMs(r, 5 * 3600000)) throw new Error(`got ${r}`);
});

// Minutes only (no hours mentioned)
assert('minutes only (no hours)', () => {
  const r = parseResetTime('Resets in 30 minutes');
  if (!isWithinMs(r, 30 * 60000)) throw new Error(`got ${r}`);
});

// Singular forms
assert('singular "1 hour 1 minute"', () => {
  const r = parseResetTime('Resets in 1 hour 1 minute');
  if (!isWithinMs(r, 3600000 + 60000)) throw new Error(`got ${r}`);
});

assert('singular "1 day 1 hour"', () => {
  const r = parseResetTime('Resets in 1 day 1 hour');
  if (!isWithinMs(r, 86400000 + 3600000)) throw new Error(`got ${r}`);
});

// Null/empty input
assert('null input returns null', () => {
  if (parseResetTime(null) !== null) throw new Error('expected null');
});

assert('undefined input returns null', () => {
  if (parseResetTime(undefined) !== null) throw new Error('expected null');
});

assert('empty string returns null', () => {
  if (parseResetTime('') !== null) throw new Error('expected null');
});

// Text without reset info
assert('text without reset pattern returns null', () => {
  if (parseResetTime('Some unrelated text') !== null) throw new Error('expected null');
});

// Actual rolling section with all whitespace collapsed
assert('realistic rolling section with newlines', () => {
  const text = 'Rolling Usage\n15%\nResets in\n4 hours\n15 minutes\nWeekly Usage';
  const section = text.match(/Rolling Usage[\s\S]*?(?=Weekly Usage|Monthly Usage|$)/);
  const r = parseResetTime(section[0]);
  if (!isWithinMs(r, 4 * 3600000 + 15 * 60000)) throw new Error(`got ${r}`);
});

// Tab characters instead of spaces
assert('tabs between reset tokens', () => {
  const r = parseResetTime('Resets in\t4\thours\t15\tminutes');
  if (!isWithinMs(r, 4 * 3600000 + 15 * 60000)) throw new Error(`got ${r}`);
});

console.log('\nDone.');
