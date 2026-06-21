// server/providers/provider-result.js
'use strict';

function normalizeWindow(window) {
  if (!window) return null;
  return {
    usedPercent: window.usedPercent ?? null,
    resetsAt: window.resetsAt ?? null,
    windowDurationMins: window.windowDurationMins ?? null
  };
}

function createProviderResult({ fiveHour = null, sevenDay = null, balanceUsd = null, balanceAud = null, error = null } = {}) {
  return {
    fiveHour: normalizeWindow(fiveHour),
    sevenDay: normalizeWindow(sevenDay),
    balanceUsd,
    balanceAud,
    error
  };
}

module.exports = { normalizeWindow, createProviderResult };
