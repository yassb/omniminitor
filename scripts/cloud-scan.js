import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCloudDashboard,
  cloudOpportunityKey,
  sanitizeCloudStateOpportunity
} from '../src/cloudView.js';
import { config } from '../src/config.js';
import { DEFAULT_SITES } from '../src/defaultSites.js';
import { assessOpportunityMatch, hasTargetYearSignal } from '../src/opportunityFilter.js';
import { findOpportunitiesForSite } from '../src/scraper.js';
import { isTelegramConfigured, sendOpportunityAlert } from '../src/telegram.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(rootDir, 'cloud', 'data');
const statePath = path.join(dataDir, 'state.json');
const dashboardPath = path.join(dataDir, 'dashboard.json');
const notify = config.notificationsEnabled && !process.argv.includes('--no-notify');

function readState() {
  if (!fs.existsSync(statePath)) {
    return { schemaVersion: 1, seen: {}, opportunities: [], sourceResults: [], runs: [] };
  }
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const state = readState();
state.seen ||= {};
state.opportunities ||= [];
state.runs ||= [];
const byKey = new Map(state.opportunities.map((opportunity) => [cloudOpportunityKey(opportunity), opportunity]));
const startedAt = new Date();
const newOpportunities = [];
const sourceResults = [];
let matchesFound = 0;

for (let index = 0; index < DEFAULT_SITES.length; index += 1) {
  const source = { ...DEFAULT_SITES[index], id: index + 1, enabled: 1 };
  const sourceStartedAt = Date.now();
  try {
    const found = await findOpportunitiesForSite(source);
    const accepted = found.filter((opportunity) => {
      if (!hasTargetYearSignal(opportunity)) return false;
      return assessOpportunityMatch(opportunity).level !== 'Rejected';
    });
    matchesFound += accepted.length;

    for (const opportunity of accepted) {
      const now = new Date().toISOString();
      const raw = sanitizeCloudStateOpportunity({
        ...opportunity,
        site_name: source.name,
        site_url: source.url,
        matched_keywords: opportunity.matchedKeywords,
        first_seen_at: now,
        last_seen_at: now
      });
      const key = cloudOpportunityKey(raw);
      const existing = byKey.get(key);
      const isNew = !state.seen[key];
      const saved = sanitizeCloudStateOpportunity({
        ...existing,
        ...raw,
        first_seen_at: existing?.first_seen_at || state.seen[key] || now,
        applied_at: existing?.applied_at || null
      });
      byKey.set(key, saved);
      state.seen[key] ||= saved.first_seen_at;
      if (isNew) newOpportunities.push(saved);
    }

    sourceResults.push({
      name: source.name,
      url: source.url,
      status: 'ok',
      matches: accepted.length,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - sourceStartedAt,
      error: null
    });
  } catch (error) {
    sourceResults.push({
      name: source.name,
      url: source.url,
      status: 'error',
      matches: 0,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - sourceStartedAt,
      error: String(error?.message || error).slice(0, 240)
    });
  }
}

let telegramSent = 0;
let telegramError = null;
if (notify && isTelegramConfigured()) {
  for (const opportunity of newOpportunities) {
    try {
      await sendOpportunityAlert(opportunity);
      telegramSent += 1;
    } catch (error) {
      telegramError = 'Telegram delivery failed';
      break;
    }
  }
}

state.opportunities = [...byKey.values()]
  .map(sanitizeCloudStateOpportunity)
  .sort((left, right) => String(right.last_seen_at || '').localeCompare(String(left.last_seen_at || '')))
  .slice(0, 400);
state.sourceResults = sourceResults;
state.lastScan = {
  startedAt: startedAt.toISOString(),
  completedAt: new Date().toISOString(),
  status: sourceResults.some((source) => source.status === 'error') ? 'completed-with-errors' : 'completed',
  sitesChecked: sourceResults.length,
  healthySites: sourceResults.filter((source) => source.status === 'ok').length,
  matchesFound,
  newOpportunities: newOpportunities.length,
  telegramSent,
  telegramError,
  durationMs: Date.now() - startedAt.getTime()
};
state.runs.unshift(state.lastScan);
state.runs = state.runs.slice(0, 10);

writeJson(statePath, state);
writeJson(dashboardPath, buildCloudDashboard(state, {
  telegramConfigured: isTelegramConfigured()
}));

console.log(JSON.stringify(state.lastScan));
