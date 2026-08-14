import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCloudDashboard,
  buildCloudOpportunity,
  sanitizeCloudStateOpportunity
} from '../src/cloudView.js';

function opportunity(overrides = {}) {
  return {
    title: 'Master English Studies 2026-2027',
    url: 'https://example.edu/master-english-2026',
    snippet: 'Master names: Master English Studies | Application deadline: 23/08/2026.',
    matched_keywords: JSON.stringify(['Master', 'English Studies']),
    site_name: 'Example University',
    site_url: 'https://example.edu/',
    first_seen_at: '2026-08-01T08:00:00.000Z',
    ...overrides
  };
}

test('builds a safe cloud card with a confirmed future deadline', () => {
  const result = buildCloudOpportunity(opportunity(), {
    now: new Date('2026-08-14T12:00:00Z')
  });

  assert.equal(result.status, 'Open');
  assert.equal(result.deadline, '2026-08-23');
  assert.equal(result.daysRemaining, 9);
  assert.equal(result.sourceType, 'Official');
  assert.equal(result.title, 'Master English Studies');
});

test('preserves a saved Done record even when the stricter matcher now rejects it', () => {
  const result = buildCloudOpportunity(opportunity({
    title: 'Candidature Master',
    snippet: 'Master names: Linguistics and Advanced English Studies | Master Linguistics and Advanced English Studies. Year 2026-2027.',
    applied_at: '2026-08-02 10:00:00'
  }), { now: new Date('2026-08-14T12:00:00Z') });

  assert.equal(result.status, 'Done');
  assert.equal(result.initialDone, true);
});

test('summarizes source health without exposing raw state fields', () => {
  const dashboard = buildCloudDashboard({
    opportunities: [opportunity()],
    sourceResults: [
      { name: 'Healthy', url: 'https://example.edu', status: 'ok' },
      { name: 'Broken', url: 'https://broken.example', status: 'error' }
    ],
    runs: [],
    secret: 'must-not-appear'
  }, {
    now: new Date('2026-08-14T12:00:00Z'),
    telegramConfigured: true
  });

  assert.equal(dashboard.stats.sources, 2);
  assert.equal(dashboard.stats.healthySources, 1);
  assert.equal(dashboard.alerts.telegramConfigured, true);
  assert.equal('secret' in dashboard, false);
});

test('keeps only public fields in the cloud scan state', () => {
  const result = sanitizeCloudStateOpportunity(opportunity({
    id: 42,
    site_id: 7,
    fingerprint: 'internal-fingerprint',
    notified_at: '2026-08-01 09:00:00',
    whatsapp_notified_at: '2026-08-01 09:01:00'
  }));

  assert.deepEqual(Object.keys(result).sort(), [
    'applied_at',
    'first_seen_at',
    'last_seen_at',
    'matched_keywords',
    'site_name',
    'site_url',
    'snippet',
    'title',
    'url'
  ]);
  assert.equal(result.matched_keywords[0], 'Master');
  assert.equal(JSON.stringify(result).includes('internal-fingerprint'), false);
});
