import { config } from './config.js';
import { classifyOpportunityFocuses, extractRelevantProgramNames } from './masterNames.js';
import { assessOpportunityMatch } from './opportunityFilter.js';
import { extractStoredOfficialUrl, removeStoredOfficialUrl } from './sourceLinks.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(value, maxLength) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

export function isTelegramConfigured() {
  return Boolean(config.telegramBotToken && config.telegramChatId);
}

export function formatOpportunityMessage(opportunity) {
  const siteName = opportunity.site_name || opportunity.site_url || 'Configured website';
  const keywords = JSON.parse(opportunity.matched_keywords || '[]').join(', ');
  const masterNames = extractRelevantProgramNames(opportunity);
  const focuses = classifyOpportunityFocuses(opportunity);
  const assessment = assessOpportunityMatch(opportunity);
  const officialUrl = extractStoredOfficialUrl(opportunity.snippet);
  const snippet = truncate(removeStoredOfficialUrl(opportunity.snippet), 700);

  return [
    '<b>New opportunity found</b>',
    '',
    `<b>Site:</b> ${escapeHtml(siteName)}`,
    `<b>Title:</b> ${escapeHtml(opportunity.title)}`,
    ...(masterNames.length > 0
      ? [`<b>Program Name(s):</b> ${escapeHtml(truncate(masterNames.join('; '), 900))}`]
      : []),
    ...(focuses.length > 0 ? [`<b>Focus:</b> ${escapeHtml(focuses.join(', '))}`] : []),
    `<b>Match confidence:</b> ${escapeHtml(assessment.level)} (${assessment.score}/100)`,
    `<b>Keywords:</b> ${escapeHtml(keywords)}`,
    '',
    escapeHtml(snippet),
    '',
    ...(officialUrl ? [`<b>Official/application link:</b> ${escapeHtml(officialUrl)}`] : []),
    `<b>Discovery page:</b> ${escapeHtml(opportunity.url)}`
  ].join('\n');
}

export async function sendTelegramMessage(text) {
  if (!isTelegramConfigured()) {
    throw new Error('Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.');
  }

  const endpoint = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${body}`);
  }
}

export async function sendOpportunityAlert(opportunity) {
  await sendTelegramMessage(formatOpportunityMessage(opportunity));
}

export async function sendTelegramTestMessage() {
  await sendTelegramMessage('Opportunity Monitor test message. Telegram is working.');
}
