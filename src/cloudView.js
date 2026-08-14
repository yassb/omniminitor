import crypto from 'node:crypto';
import { extractConfirmedDeadline } from './deadlines.js';
import {
  classifyOpportunityFocuses,
  extractRelevantProgramNames,
  MASTER_NAMES_MARKER
} from './masterNames.js';
import {
  assessOpportunityMatch,
  hasTargetYearSignal,
  TARGET_OPPORTUNITY_YEAR
} from './opportunityFilter.js';
import { extractStoredOfficialUrl, removeStoredOfficialUrl } from './sourceLinks.js';

const dayMs = 24 * 60 * 60 * 1000;

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

export function cloudOpportunityKey(opportunity) {
  const url = safeHttpUrl(opportunity.url);
  if (url) return url.replace(/\/$/, '').toLowerCase();
  return crypto
    .createHash('sha256')
    .update(`${opportunity.site_url || ''}|${opportunity.title || ''}`)
    .digest('hex');
}

function parseKeywords(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function sanitizeCloudStateOpportunity(opportunity) {
  return {
    title: String(opportunity.title || '').trim().slice(0, 500),
    url: safeHttpUrl(opportunity.url),
    snippet: String(opportunity.snippet || '').trim().slice(0, 8000),
    matched_keywords: parseKeywords(
      opportunity.matched_keywords || opportunity.matchedKeywords
    ).map((keyword) => String(keyword).slice(0, 120)).slice(0, 40),
    site_name: String(opportunity.site_name || opportunity.siteName || '').trim().slice(0, 240),
    site_url: safeHttpUrl(opportunity.site_url || opportunity.siteUrl),
    first_seen_at: opportunity.first_seen_at || opportunity.firstSeenAt || null,
    last_seen_at: opportunity.last_seen_at || opportunity.lastSeenAt || null,
    applied_at: opportunity.applied_at || opportunity.appliedAt || null
  };
}

function cleanSnippet(value) {
  let text = removeStoredOfficialUrl(value);
  const markerIndex = text.toLowerCase().indexOf(MASTER_NAMES_MARKER.toLowerCase());
  if (markerIndex >= 0) {
    const separatorIndex = text.indexOf('|', markerIndex);
    text = separatorIndex >= 0 ? text.slice(separatorIndex + 1) : '';
  }
  return text
    .replace(/Published:\s*[^|]+\|?/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 360);
}

function sourceTypeFor(opportunity) {
  try {
    const host = new URL(opportunity.site_url || opportunity.url).hostname.toLowerCase();
    if (
      host === 'almaster-maroc.com' ||
      host.endsWith('.almaster-maroc.com') ||
      host === 'licence-professionnelle-maroc.com' ||
      host.endsWith('.licence-professionnelle-maroc.com')
    ) {
      return 'Aggregator';
    }
  } catch {
    // The scraper only stores HTTP URLs, but old state can contain malformed values.
  }
  return 'Official';
}

function programmeType(opportunity, names) {
  const text = `${names.join(' ')} ${opportunity.title || ''}`.toLowerCase();
  if (/licence professionnelle|licence professionnalisante|licence pro\b/.test(text)) {
    return 'Licence Professionnelle';
  }
  if (/licence d[' ]excellence|parcours d[' ]excellence|parcours excellence/.test(text)) {
    return "Licence d'Excellence";
  }
  return 'Master';
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function statusFor(opportunity, deadline, now) {
  if (opportunity.applied_at || opportunity.appliedAt) {
    return { status: 'Done', daysRemaining: null, sortGroup: 4 };
  }
  if (!deadline || deadline.getFullYear() !== TARGET_OPPORTUNITY_YEAR) {
    return { status: 'Deadline unknown', daysRemaining: null, sortGroup: 1 };
  }

  const today = startOfDay(now);
  const deadlineDay = startOfDay(deadline);
  const daysRemaining = Math.round((deadlineDay.getTime() - today.getTime()) / dayMs);
  return daysRemaining >= 0
    ? { status: 'Open', daysRemaining, sortGroup: 0 }
    : { status: 'Closed', daysRemaining, sortGroup: 3 };
}

export function buildCloudOpportunity(opportunity, { now = new Date() } = {}) {
  const applied = Boolean(opportunity.applied_at || opportunity.appliedAt);
  const names = extractRelevantProgramNames(opportunity);
  if (!hasTargetYearSignal(opportunity) && !(applied && names.length > 0)) return null;
  const assessment = assessOpportunityMatch(opportunity);
  if (assessment.level === 'Rejected' && !applied) return null;

  if (names.length === 0 && !applied) return null;
  const deadline = extractConfirmedDeadline(`${opportunity.title || ''} ${opportunity.snippet || ''}`);
  const status = statusFor(opportunity, deadline, now);
  const officialUrl = safeHttpUrl(extractStoredOfficialUrl(opportunity.snippet));
  const discoveryUrl = safeHttpUrl(opportunity.url);
  const confidence = assessment.level === 'Rejected'
    ? { level: 'Saved', score: null }
    : { level: assessment.level, score: assessment.score };

  return {
    id: crypto.createHash('sha1').update(cloudOpportunityKey(opportunity)).digest('hex').slice(0, 16),
    title: names[0] || opportunity.title || 'Untitled opportunity',
    additionalNames: names.slice(1, 3),
    announcementTitle: opportunity.title || '',
    summary: cleanSnippet(opportunity.snippet),
    siteName: opportunity.site_name || opportunity.siteName || 'Configured source',
    siteUrl: safeHttpUrl(opportunity.site_url || opportunity.siteUrl),
    discoveryUrl,
    officialUrl,
    primaryUrl: officialUrl || discoveryUrl,
    sourceType: sourceTypeFor(opportunity),
    programmeType: programmeType(opportunity, names),
    focuses: classifyOpportunityFocuses(opportunity),
    keywords: parseKeywords(opportunity.matched_keywords || opportunity.matchedKeywords),
    confidence,
    status: status.status,
    deadline: deadline && deadline.getFullYear() === TARGET_OPPORTUNITY_YEAR
      ? deadline.toISOString().slice(0, 10)
      : null,
    daysRemaining: status.daysRemaining,
    sortGroup: status.sortGroup,
    firstSeenAt: opportunity.first_seen_at || opportunity.firstSeenAt || null,
    lastSeenAt: opportunity.last_seen_at || opportunity.lastSeenAt || null,
    initialDone: applied
  };
}

function opportunityRank(opportunity) {
  return (
    (opportunity.initialDone ? 1000 : 0) +
    (opportunity.officialUrl ? 200 : 0) +
    (opportunity.sourceType === 'Official' ? 100 : 0) +
    (opportunity.confidence.score || 0)
  );
}

export function buildCloudDashboard(state, { now = new Date(), telegramConfigured = false } = {}) {
  const deduplicated = new Map();
  for (const rawOpportunity of state.opportunities || []) {
    const opportunity = buildCloudOpportunity(rawOpportunity, { now });
    if (!opportunity) continue;
    const existing = deduplicated.get(opportunity.id);
    if (!existing || opportunityRank(opportunity) > opportunityRank(existing)) {
      deduplicated.set(opportunity.id, opportunity);
    }
  }

  const opportunities = [...deduplicated.values()].sort((left, right) => {
    if (left.sortGroup !== right.sortGroup) return left.sortGroup - right.sortGroup;
    if (left.deadline && right.deadline) {
      return left.sortGroup === 0
        ? left.deadline.localeCompare(right.deadline)
        : right.deadline.localeCompare(left.deadline);
    }
    return String(right.firstSeenAt || '').localeCompare(String(left.firstSeenAt || ''));
  });

  const nextDeadline = opportunities.find((opportunity) => opportunity.status === 'Open') || null;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    targetCycle: `${TARGET_OPPORTUNITY_YEAR}-${TARGET_OPPORTUNITY_YEAR + 1}`,
    lastScan: state.lastScan || null,
    stats: {
      opportunities: opportunities.length,
      open: opportunities.filter((item) => item.status === 'Open').length,
      unknown: opportunities.filter((item) => item.status === 'Deadline unknown').length,
      closed: opportunities.filter((item) => item.status === 'Closed').length,
      sources: state.sourceResults?.length || 0,
      healthySources: state.sourceResults?.filter((source) => source.status === 'ok').length || 0,
      nextDeadline: nextDeadline
        ? { title: nextDeadline.title, deadline: nextDeadline.deadline }
        : null
    },
    alerts: { telegramConfigured: Boolean(telegramConfigured), whatsappQrAvailable: false },
    opportunities,
    sources: state.sourceResults || [],
    runs: (state.runs || []).slice(0, 10)
  };
}
