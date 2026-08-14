import { config } from './config.js';
import { assessOpportunityMatch } from './opportunityFilter.js';
import { extractConfirmedDeadline } from './deadlines.js';
import {
  extractStoredOfficialUrl,
  removeStoredOfficialUrl
} from './sourceLinks.js';
import {
  MASTER_NAMES_MARKER,
  classifyOpportunityFocuses,
  extractRelevantProgramNames
} from './masterNames.js';

const dayInMilliseconds = 24 * 60 * 60 * 1000;
const whatsappTextLimit = 4000;
const digestTargetLength = 3600;
const digestMaxItems = 6;

function truncate(value, maxLength) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function cleanMessageValue(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSnippet(value) {
  let text = removeStoredOfficialUrl(value);
  const markerIndex = text.toLowerCase().indexOf(MASTER_NAMES_MARKER.toLowerCase());
  if (markerIndex >= 0) {
    const separatorIndex = text.indexOf('|', markerIndex);
    text = separatorIndex >= 0 ? text.slice(separatorIndex + 1) : '';
  }
  return cleanMessageValue(text);
}

function parseKeywords(value) {
  if (Array.isArray(value)) return value.map(cleanMessageValue).filter(Boolean);

  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(cleanMessageValue).filter(Boolean) : [];
  } catch {
    return String(value ?? '').split(',').map(cleanMessageValue).filter(Boolean);
  }
}

function summarizeList(values, limit = 5) {
  const items = [...new Set(values.map(cleanMessageValue).filter(Boolean))];
  if (items.length <= limit) return items.join('; ');
  return `${items.slice(0, limit).join('; ')}; +${items.length - limit} more`;
}

function normalizeDateText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u064b-\u065f]/g, '')
    .replace(/[\u2018\u2019\u201a\u201b`\u00b4]/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function formatDeadline(date) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(date);
}

function inferProgramType(opportunity, focuses) {
  const text = normalizeDateText(`${opportunity.title ?? ''} ${opportunity.snippet ?? ''}`);
  if (/licence professionnelle|licence professionnalisante|licence pro\b|professional bachelor|\u0627\u0644\u0627\u062c\u0627\u0632\u0629\s+\u0627\u0644\u0645\u0647\u0646\u064a\u0629|\u0627\u062c\u0627\u0632\u0629\s+\u0645\u0647\u0646\u064a\u0629/.test(text)) {
    return 'Licence Professionnelle';
  }
  if (/licence d[' ]excellence|parcours d[' ]excellence|parcours excellence|\u0645\u0633\u0627\u0631\s+\u0627\u0644\u062a\u0645\u064a\u0632/.test(text)) {
    return "Licence d'Excellence";
  }
  if (/\bmasters?\b|\bmastere\b|\u0645\u0627\u0633\u062a\u0631/.test(text)) return 'Master';
  if (focuses.includes('Licence Professionnelle')) return 'Licence Professionnelle';
  return 'English-related programme';
}

function cleanSourceUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function startOfLocalDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function deadlineDetails(opportunity, now = new Date()) {
  const deadline = extractConfirmedDeadline(
    `${opportunity.title ?? ''} ${opportunity.snippet ?? ''}`
  );

  if (!deadline) {
    return {
      deadline: null,
      deadlineText: 'Not confirmed in the announcement text',
      status: 'Check the source page',
      urgency: 'No reliable deadline was found',
      sortGroup: 1,
      sortTime: Number.MAX_SAFE_INTEGER
    };
  }

  const today = startOfLocalDay(now);
  const deadlineDay = startOfLocalDay(deadline);
  const daysRemaining = Math.round((deadlineDay.getTime() - today.getTime()) / dayInMilliseconds);
  const dayWord = Math.abs(daysRemaining) === 1 ? 'day' : 'days';

  if (daysRemaining < 0) {
    return {
      deadline,
      deadlineText: formatDeadline(deadline),
      status: 'Deadline passed',
      urgency: `${Math.abs(daysRemaining)} ${dayWord} ago - check for an official extension`,
      sortGroup: 2,
      sortTime: -deadline.getTime()
    };
  }

  return {
    deadline,
    deadlineText: formatDeadline(deadline),
    status: daysRemaining <= 3 ? 'Open - urgent' : 'Open',
    urgency: daysRemaining === 0
      ? 'Closes today'
      : `${daysRemaining} ${dayWord} remaining`,
    sortGroup: 0,
    sortTime: deadline.getTime()
  };
}

function opportunityMessageDetails(opportunity, now = new Date()) {
  const title = cleanMessageValue(opportunity.title || 'Untitled opportunity');
  const siteName = cleanMessageValue(
    opportunity.site_name || opportunity.site_url || 'Configured website'
  );
  const keywords = parseKeywords(opportunity.matched_keywords);
  const programNames = extractRelevantProgramNames(opportunity);
  const focuses = classifyOpportunityFocuses(opportunity);
  const assessment = assessOpportunityMatch(opportunity);
  const discoveryUrl = cleanSourceUrl(opportunity.url);
  const officialUrl = extractStoredOfficialUrl(opportunity.snippet);

  return {
    opportunity,
    title,
    siteName,
    keywords,
    focuses,
    programName: summarizeList(programNames, 4) || title,
    programType: inferProgramType(opportunity, focuses),
    assessment,
    snippet: truncate(cleanSnippet(opportunity.snippet), 520),
    sourceUrl: officialUrl || discoveryUrl,
    officialUrl,
    discoveryUrl,
    ...deadlineDetails(opportunity, now)
  };
}

function compareMessageDetails(left, right) {
  if (left.sortGroup !== right.sortGroup) return left.sortGroup - right.sortGroup;
  if (left.sortTime !== right.sortTime) return left.sortTime - right.sortTime;
  return left.programName.localeCompare(right.programName, 'en', { sensitivity: 'base' });
}

function renderDigestItem(details, index) {
  return [
    `*${index}. ${truncate(details.programName, 220)}*`,
    `${truncate(details.siteName, 140)} | ${details.programType}`,
    `Status: ${details.status}`,
    `Deadline: ${details.deadlineText}`,
    `Time: ${details.urgency}`,
    `Match: ${details.assessment.level} (${details.assessment.score}/100)`,
    ...(details.focuses.length > 0
      ? [`Focus: ${truncate(summarizeList(details.focuses), 180)}`]
      : []),
    details.sourceUrl ? `Open: ${truncate(details.sourceUrl, 700)}` : 'Open: Use the dashboard source link',
    ...(details.officialUrl && details.discoveryUrl !== details.officialUrl
      ? [`Found via: ${truncate(details.discoveryUrl, 700)}`]
      : [])
  ].join('\n');
}

function renderDigestMessage(items, total, part, partCount) {
  return [
    '*OPPORTUNITY MONITOR - 2026/2027*',
    `*${total} new ${total === 1 ? 'match' : 'matches'}*${partCount > 1 ? ` | Message ${part}/${partCount}` : ''}`,
    'Nearest confirmed deadlines are shown first.',
    '',
    items.map(({ block }) => block).join('\n\n'),
    '',
    '*NEXT STEP*',
    'Open each source and confirm eligibility, required documents, deadline, and the official application form.',
    '',
    '_A missing deadline means the monitor could not verify one from the announcement text._'
  ].join('\n');
}

function cleanRecipient(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function graphVersion() {
  return /^v\d+\.\d+$/.test(config.whatsappGraphVersion)
    ? config.whatsappGraphVersion
    : 'v23.0';
}

export function isWhatsAppConfigured() {
  return Boolean(
    config.whatsappAccessToken &&
    config.whatsappPhoneNumberId &&
    cleanRecipient(config.whatsappRecipient)
  );
}

export function formatWhatsAppOpportunityMessage(opportunity, { now = new Date() } = {}) {
  const details = opportunityMessageDetails(opportunity, now);

  return truncate([
    '*NEW OPPORTUNITY - 2026/2027*',
    '',
    '*PROGRAM*',
    `Name: ${truncate(details.programName, 700)}`,
    `Type: ${details.programType}`,
    ...(details.focuses.length > 0 ? [`Focus: ${summarizeList(details.focuses)}`] : []),
    `Institution / website: ${details.siteName}`,
    '',
    '*APPLICATION*',
    `Status: ${details.status}`,
    `Deadline: ${details.deadlineText}`,
    `Time remaining: ${details.urgency}`,
    `Match confidence: ${details.assessment.level} (${details.assessment.score}/100)`,
    '',
    '*WHAT TO DO*',
    '1. Open the source link below.',
    '2. Confirm eligibility and required documents.',
    '3. Use only the official application form named in the announcement.',
    '',
    '*SOURCE*',
    ...(details.title.toLowerCase() !== details.programName.toLowerCase()
      ? [`Announcement: ${truncate(details.title, 700)}`]
      : []),
    ...(details.keywords.length > 0
      ? [`Matched because: ${summarizeList(details.keywords, 8)}`]
      : []),
    ...(details.officialUrl ? [`Official / application: ${details.officialUrl}`] : []),
    `Discovery page: ${details.discoveryUrl || 'Open the source from the dashboard.'}`,
    ...(details.snippet ? ['', '*SHORT DETAILS*', details.snippet] : []),
    '',
    '_The monitor never guesses a deadline. Confirm all details on the official university announcement before applying._'
  ].join('\n'), whatsappTextLimit);
}

export function buildWhatsAppDigestBatches(opportunities, { now = new Date() } = {}) {
  const details = opportunities
    .map((opportunity) => opportunityMessageDetails(opportunity, now))
    .sort(compareMessageDetails);

  if (details.length === 0) return [];
  if (details.length === 1) {
    return [{
      text: formatWhatsAppOpportunityMessage(details[0].opportunity, { now }),
      opportunities: [details[0].opportunity]
    }];
  }

  const numberedItems = details.map((item, index) => ({
    details: item,
    block: renderDigestItem(item, index + 1)
  }));
  const groups = [];
  let current = [];

  for (const item of numberedItems) {
    const candidate = [...current, item];
    const candidateText = renderDigestMessage(candidate, details.length, 1, 1);
    if (
      current.length > 0 &&
      (candidateText.length > digestTargetLength || candidate.length > digestMaxItems)
    ) {
      groups.push(current);
      current = [item];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) groups.push(current);

  return groups.map((items, index) => ({
    text: truncate(
      renderDigestMessage(items, details.length, index + 1, groups.length),
      whatsappTextLimit
    ),
    opportunities: items.map(({ details: itemDetails }) => itemDetails.opportunity)
  }));
}

async function sendWhatsAppPayload(payload) {
  if (!isWhatsAppConfigured()) {
    throw new Error(
      'WhatsApp is not configured. Add the access token, phone number ID, and recipient number.'
    );
  }

  const endpoint = `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(config.whatsappPhoneNumberId)}/messages`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsappAccessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanRecipient(config.whatsappRecipient),
      ...payload
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`WhatsApp API error ${response.status}: ${body}`);
  }
}

export async function sendWhatsAppMessage(text) {
  await sendWhatsAppPayload({
    type: 'text',
    text: {
      preview_url: true,
      body: truncate(text, 4000)
    }
  });
}

export async function sendWhatsAppTemplate(name, language = 'en_US', parameters = []) {
  const template = {
    name,
    language: { code: language }
  };

  if (parameters.length > 0) {
    template.components = [{
      type: 'body',
      parameters: parameters.map((text) => ({ type: 'text', text: truncate(text, 1000) }))
    }];
  }

  await sendWhatsAppPayload({ type: 'template', template });
}

export async function sendWhatsAppOpportunityAlert(opportunity) {
  if (config.whatsappTemplateName) {
    const siteName = opportunity.site_name || opportunity.site_url || 'Configured website';
    const programNames = extractRelevantProgramNames(opportunity);
    const details = programNames.length > 0
      ? programNames.join('; ')
      : classifyOpportunityFocuses(opportunity).join(', ') || 'English-related opportunity';

    await sendWhatsAppTemplate(
      config.whatsappTemplateName,
      config.whatsappTemplateLanguage,
      [opportunity.title, siteName, details, opportunity.url]
    );
    return;
  }

  await sendWhatsAppMessage(formatWhatsAppOpportunityMessage(opportunity));
}

export async function sendWhatsAppTestMessage() {
  await sendWhatsAppTemplate('hello_world', 'en_US');
}
