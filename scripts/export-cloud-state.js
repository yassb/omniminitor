import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import {
  buildCloudDashboard,
  cloudOpportunityKey,
  sanitizeCloudStateOpportunity
} from '../src/cloudView.js';
import { config } from '../src/config.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(rootDir, 'cloud', 'data');
const SQL = await initSqlJs({
  locateFile: (file) => path.join(rootDir, 'node_modules', 'sql.js', 'dist', file)
});
const database = new SQL.Database(fs.readFileSync(config.databasePath));

function rows(sql) {
  const statement = database.prepare(sql);
  const values = [];
  while (statement.step()) values.push(statement.getAsObject());
  statement.free();
  return values;
}

const opportunities = rows(`
  SELECT opportunities.*, sites.name AS site_name, sites.url AS site_url
  FROM opportunities
  JOIN sites ON sites.id = opportunities.site_id
  ORDER BY opportunities.first_seen_at DESC
`).map(sanitizeCloudStateOpportunity);
const latestScan = rows('SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1')[0] || null;
const latestScanId = latestScan?.id || 0;
const sourceResults = latestScanId
  ? rows(`
      SELECT sites.name, sites.url, site_scan_results.status,
             site_scan_results.matches_found AS matches,
             site_scan_results.checked_at AS checkedAt,
             site_scan_results.duration_ms AS durationMs,
             site_scan_results.error
      FROM site_scan_results
      JOIN sites ON sites.id = site_scan_results.site_id
      WHERE site_scan_results.scan_id = ${Number(latestScanId)}
      ORDER BY sites.name
    `)
  : [];
const recentRuns = rows('SELECT * FROM scan_runs ORDER BY id DESC LIMIT 10').map((run) => ({
  startedAt: run.started_at,
  completedAt: run.completed_at,
  status: run.status,
  sitesChecked: run.sites_checked,
  healthySites: run.sites_checked - run.errors_count,
  matchesFound: run.matches_found,
  newOpportunities: run.new_opportunities,
  telegramSent: run.telegram_sent,
  telegramError: null,
  durationMs: run.duration_ms
}));
const seen = Object.fromEntries(
  opportunities.map((opportunity) => [cloudOpportunityKey(opportunity), opportunity.first_seen_at])
);
const state = {
  schemaVersion: 1,
  seen,
  opportunities,
  sourceResults,
  lastScan: recentRuns[0] || null,
  runs: recentRuns
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
fs.writeFileSync(
  path.join(outputDir, 'dashboard.json'),
  `${JSON.stringify(buildCloudDashboard(state, {
    telegramConfigured: Boolean(config.telegramBotToken && config.telegramChatId)
  }), null, 2)}\n`
);

console.log(JSON.stringify({ opportunities: opportunities.length, sources: sourceResults.length }));
