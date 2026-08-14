import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('records completed scans and deduplicates opportunities by URL', async () => {
  const databasePath = path.resolve('data', `test-db-${process.pid}.sqlite`);
  process.env.DATABASE_PATH = databasePath;

  const databaseModule = await import('../src/db.js');
  const database = await databaseModule.openDatabase();
  const site = databaseModule.addSite(database, {
    url: 'https://faculty.example.ac.ma/',
    name: 'Test Faculty'
  });

  const scanId = databaseModule.startScanRun(database, {
    trigger: 'test',
    sitesTotal: 1
  });
  assert.equal(scanId, 1);

  databaseModule.recordSiteScanResult(database, {
    scanId,
    siteId: site.id,
    status: 'ok',
    matchesFound: 1,
    newOpportunities: 1,
    durationMs: 1250
  });
  databaseModule.finishScanRun(database, scanId, {
    sitesChecked: 1,
    matchesFound: 1,
    newOpportunities: 1,
    errors: [],
    durationMs: 1300
  });

  const opportunity = {
    siteId: site.id,
    title: 'Master Applied Linguistics 2026-2027',
    url: 'https://faculty.example.ac.ma/master-applied-linguistics',
    snippet: 'Call for applications. Deadline 31 August 2026.',
    matchedKeywords: '["Master","Linguistics"]',
    fingerprint: 'first-fingerprint'
  };
  assert.equal(databaseModule.saveOpportunity(database, opportunity).isNew, true);
  assert.equal(databaseModule.saveOpportunity(database, {
    ...opportunity,
    title: 'Updated Master Applied Linguistics 2026-2027',
    fingerprint: 'different-fingerprint'
  }).isNew, false);

  const run = databaseModule.listRecentScanRuns(database, 1)[0];
  assert.equal(run.status, 'completed');
  assert.equal(run.sites_checked, 1);
  assert.equal(run.duration_ms, 1300);
  assert.equal(databaseModule.listLatestSiteScanResults(database)[0].scan_id, scanId);
  assert.equal(databaseModule.listRecentOpportunities(database, 10).length, 1);

  fs.rmSync(databasePath, { force: true });
});
