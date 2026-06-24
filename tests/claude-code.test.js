// tests/claude-code.test.js
// Unit tests for extractLimits — using the limits array for unambiguous percentages
'use strict';
const { extractLimits, normalizeClaudeUtilization } = require('../server/providers/claude-code.js');

function assert(label, fn) {
  try {
    fn();
    console.log(`  PASS: ${label}`);
  } catch (e) {
    console.error(`  FAIL: ${label} — ${e.message}`);
    process.exitCode = 1;
  }
}

// Realistic Claude API response
const realPayload = {
  five_hour: { utilization: 11.0, resets_at: "2026-06-24T05:00:00Z" },
  seven_day: { utilization: 64.0, resets_at: "2026-06-29T02:00:00Z" },
  limits: [
    { kind: "session",    group: "session", percent: 11, resets_at: "2026-06-24T05:00:00Z", is_active: false },
    { kind: "weekly_all", group: "weekly",  percent: 64, resets_at: "2026-06-29T02:00:00Z", is_active: true  }
  ]
};

assert('extracts percent from limits array', () => {
  const result = extractLimits(realPayload);
  if (result.fiveHour.usedPercent !== 11) throw new Error(`expected 11, got ${result.fiveHour.usedPercent}`);
  if (result.sevenDay.usedPercent !== 64) throw new Error(`expected 64, got ${result.sevenDay.usedPercent}`);
});

assert('extracts resetsAt from limits array', () => {
  const result = extractLimits(realPayload);
  if (result.fiveHour.resetsAt !== "2026-06-24T05:00:00Z") throw new Error(`wrong resetsAt: ${result.fiveHour.resetsAt}`);
  if (result.sevenDay.resetsAt !== "2026-06-29T02:00:00Z") throw new Error(`wrong resetsAt: ${result.sevenDay.resetsAt}`);
});

assert('window durations are correct', () => {
  const result = extractLimits(realPayload);
  if (result.fiveHour.windowDurationMins !== 300) throw new Error(`wrong 5h duration`);
  if (result.sevenDay.windowDurationMins !== 10080) throw new Error(`wrong 7d duration`);
});

// Falls back to five_hour / seven_day when limits is missing
const noLimitsPayload = {
  five_hour: { utilization: 0.06, resets_at: "2026-06-24T05:00:00Z" },
  seven_day: { utilization: 0.63, resets_at: "2026-06-29T02:00:00Z" }
};

assert('falls back to five_hour.utilization when limits missing', () => {
  const result = extractLimits(noLimitsPayload);
  if (result.fiveHour.usedPercent !== 6) throw new Error(`expected 6 (0.06*100), got ${result.fiveHour.usedPercent}`);
  if (result.sevenDay.usedPercent !== 63) throw new Error(`expected 63 (0.63*100), got ${result.sevenDay.usedPercent}`);
});

assert('falls back to five_hour.resets_at when limits missing', () => {
  const result = extractLimits(noLimitsPayload);
  if (result.fiveHour.resetsAt !== "2026-06-24T05:00:00Z") throw new Error(`wrong resetsAt: ${result.fiveHour.resetsAt}`);
});

// Edge case: empty limits array
assert('falls back when limits array is empty', () => {
  const result = extractLimits({
    five_hour: { utilization: 50.0, resets_at: "A" },
    seven_day: { utilization: 80.0, resets_at: "B" },
    limits: []
  });
  if (result.fiveHour.usedPercent !== 50) throw new Error(`expected 50, got ${result.fiveHour.usedPercent}`);
  if (result.sevenDay.usedPercent !== 80) throw new Error(`expected 80, got ${result.sevenDay.usedPercent}`);
  if (result.fiveHour.resetsAt !== "A") throw new Error(`wrong resetsAt`);
  if (result.sevenDay.resetsAt !== "B") throw new Error(`wrong resetsAt`);
});

// Edge case: null/undefined payload
assert('handles null payload', () => {
  const result = extractLimits(null);
  if (result.fiveHour.usedPercent !== null) throw new Error(`expected null, got ${result.fiveHour.usedPercent}`);
  if (result.sevenDay.usedPercent !== null) throw new Error(`expected null, got ${result.sevenDay.usedPercent}`);
});

// 100% edge case — previously the ≤ 1 heuristic would misinterpret value 1.0 as 100%
assert('correctly handles 1.0 in decimal format (1% not 100%)', () => {
  // If the API returned 1.0 in decimal format (meaning 1%), the old heuristic
  // normalizeClaudeUtilization(1.0) would return 100 — wrong
  // But with limits, we use the unambiguous percent field
  const result = extractLimits({
    five_hour: { utilization: 1.0 },
    limits: [{ kind: "session", percent: 1 }]
  });
  if (result.fiveHour.usedPercent !== 1) throw new Error(`expected 1, got ${result.fiveHour.usedPercent}`);
});

assert('correctly handles 100%', () => {
  const result = extractLimits({
    limits: [
      { kind: "session", percent: 100, resets_at: "Z" },
      { kind: "weekly_all", percent: 100, resets_at: "Y" }
    ]
  });
  if (result.fiveHour.usedPercent !== 100) throw new Error(`expected 100, got ${result.fiveHour.usedPercent}`);
  if (result.sevenDay.usedPercent !== 100) throw new Error(`expected 100, got ${result.sevenDay.usedPercent}`);
});

// Percent null in limits (should fall back)
assert('falls back when limits percent is null', () => {
  const result = extractLimits({
    five_hour: { utilization: 42.0, resets_at: "X" },
    limits: [{ kind: "session", percent: null, resets_at: "Y" }]
  });
  // percent is null, so falls back to five_hour.utilization
  if (result.fiveHour.usedPercent !== 42) throw new Error(`expected 42, got ${result.fiveHour.usedPercent}`);
  // resets_at should use limits (not null) since it's provided
  if (result.fiveHour.resetsAt !== "Y") throw new Error(`expected Y, got ${result.fiveHour.resetsAt}`);
});

// Percent 0 in limits (valid)
assert('handles 0% correctly', () => {
  const result = extractLimits({
    limits: [
      { kind: "session", percent: 0 },
      { kind: "weekly_all", percent: 0 }
    ]
  });
  if (result.fiveHour.usedPercent !== 0) throw new Error(`expected 0, got ${result.fiveHour.usedPercent}`);
  if (result.sevenDay.usedPercent !== 0) throw new Error(`expected 0, got ${result.sevenDay.usedPercent}`);
});

console.log('\nDone.');
