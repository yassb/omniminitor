import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import cron from 'node-cron';
import { config, saveRuntimeSettings, saveWhatsAppWebSettings } from './config.js';
import { findConfirmedDeadline } from './deadlines.js';
import {
  addSite,
  disableSite,
  getCounts,
  listLatestSiteScanResults,
  listRecentOpportunities,
  listRecentScanRuns,
  listSites,
  markAllPendingNotified,
  markOpportunityApplied,
  openDatabase,
  unmarkOpportunityApplied
} from './db.js';
import { seedDefaultSites } from './defaultSites.js';
import { listKeywordLabels } from './keywords.js';
import {
  classifyOpportunityFocuses,
  classifyProgramFocuses,
  extractRelevantProgramNames
} from './masterNames.js';
import { runChecks, sendPendingNotifications } from './monitor.js';
import {
  assessOpportunityMatch,
  hasTargetYearSignal,
  TARGET_OPPORTUNITY_YEAR
} from './opportunityFilter.js';
import { extractStoredOfficialUrl } from './sourceLinks.js';
import { isTelegramConfigured, sendTelegramTestMessage } from './telegram.js';
import { isWhatsAppConfigured, sendWhatsAppTestMessage } from './whatsapp.js';
import {
  disconnectWhatsAppWeb,
  getWhatsAppWebState,
  isWhatsAppWebReady,
  sendWhatsAppWebTestMessage,
  shutdownWhatsAppWeb,
  startWhatsAppWeb
} from './whatsappWeb.js';

let cronTask;
let runningCheck = false;
let currentCheckStartedAt;
let currentCheckProgress;
let currentCheckId = 0;
let lastSummary;
let lastRunAt;
let lastError;

const lastSummaryPath = path.join(config.rootDir, 'data', 'last-summary.json');
const authSessionSecretPath = path.join(config.rootDir, 'data', 'dashboard-session-secret');
const authCookieName = 'opportunity_monitor_session';
const authSessionTtlMs = 7 * 24 * 60 * 60 * 1000;

function loadAuthSessionSecret() {
  fs.mkdirSync(path.dirname(authSessionSecretPath), { recursive: true });
  if (fs.existsSync(authSessionSecretPath)) {
    const saved = fs.readFileSync(authSessionSecretPath, 'utf8').trim();
    if (saved.length >= 64) return saved;
  }

  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(authSessionSecretPath, generated, { encoding: 'utf8', mode: 0o600 });
  return generated;
}

const authSessionSecret = loadAuthSessionSecret();

function isAuthEnabled() {
  return config.dashboardAuthEnabled && Boolean(config.dashboardPassword);
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signAuthPayload(payload) {
  return crypto
    .createHmac('sha256', authSessionSecret)
    .update(payload)
    .digest('base64url');
}

function createAuthCookie() {
  const payload = base64UrlEncode(JSON.stringify({
    authenticated: true,
    expiresAt: Date.now() + authSessionTtlMs
  }));
  const signature = signAuthPayload(payload);
  return `${authCookieName}=${payload}.${signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(authSessionTtlMs / 1000)}`;
}

function clearAuthCookie() {
  return `${authCookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=');
        if (separator === -1) return [part, ''];
        return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      })
  );
}

function isValidAuthCookie(value) {
  if (!value || !value.includes('.')) return false;

  const [payload, signature] = value.split('.', 2);
  const expectedSignature = signAuthPayload(payload);
  const actual = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return false;
  }

  try {
    const session = JSON.parse(base64UrlDecode(payload));
    return session.authenticated === true && Number(session.expiresAt) > Date.now();
  } catch {
    return false;
  }
}

function isAuthorized(req) {
  if (!isAuthEnabled()) return true;
  const cookies = parseCookies(req);
  return isValidAuthCookie(cookies[authCookieName]);
}

function passwordMatches(value) {
  const expected = crypto.createHash('sha256').update(config.dashboardPassword).digest();
  const actual = crypto.createHash('sha256').update(String(value || '')).digest();
  return crypto.timingSafeEqual(actual, expected);
}

function saveLastSummary() {
  if (!lastSummary) return;
  fs.mkdirSync(path.dirname(lastSummaryPath), { recursive: true });
  fs.writeFileSync(lastSummaryPath, `${JSON.stringify(lastSummary, null, 2)}\n`);
}

function loadLastSummary() {
  if (!fs.existsSync(lastSummaryPath)) return;

  try {
    lastSummary = JSON.parse(fs.readFileSync(lastSummaryPath, 'utf8'));
    lastRunAt = lastSummary.ranAt ? new Date(lastSummary.ranAt) : undefined;
  } catch {
    lastSummary = undefined;
    lastRunAt = undefined;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '#';
  } catch {
    return '#';
  }
}

function send(res, status, body, contentType = 'text/html; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function redirect(res, message, type = 'ok', extraHeaders = {}) {
  const params = new URLSearchParams({ message, type });
  res.writeHead(303, { Location: `/?${params.toString()}`, ...extraHeaders });
  res.end();
}

function redirectTo(res, location, extraHeaders = {}) {
  res.writeHead(303, { Location: location, ...extraHeaders });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(new URLSearchParams(body)));
    req.on('error', reject);
  });
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    exec(`start "" "${url}"`);
  } else if (process.platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

function getNetworkUrls(port) {
  const urls = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) {
        urls.push(`http://${address.address}:${port}/`);
      }
    }
  }
  return urls;
}

function renderThemeBootScript() {
  return `<script>
    (function () {
      try {
        var savedTheme = localStorage.getItem('opportunityMonitorTheme');
        var theme = savedTheme === 'dark' || savedTheme === 'light'
          ? savedTheme
          : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme;
      } catch (error) {}
    })();
  </script>`;
}

function renderThemeToggleScript() {
  return `<script>
    (function () {
      var root = document.documentElement;
      var button = document.querySelector('[data-theme-toggle]');
      var label = document.querySelector('[data-theme-label]');
      if (!button) return;

      function getTheme() {
        return root.dataset.theme === 'dark' ? 'dark' : 'light';
      }

      function applyTheme(theme) {
        root.dataset.theme = theme;
        root.style.colorScheme = theme;
        try {
          localStorage.setItem('opportunityMonitorTheme', theme);
        } catch (error) {}
        if (label) {
          label.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
        }
        button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
        button.setAttribute('title', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      }

      applyTheme(getTheme());
      button.addEventListener('click', function () {
        applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
      });
    })();
  </script>`;
}

function renderScanStatusScript() {
  if (!runningCheck) return '';

  return `<script>
    (function () {
      var panel = document.querySelector('[data-scan-started-at]');
      if (!panel) return;
      var elapsed = panel.querySelector('[data-scan-elapsed]');
      var startedAt = Date.parse(panel.dataset.scanStartedAt || '');
      if (!elapsed || Number.isNaN(startedAt)) return;

      function formatDuration(seconds) {
        var safeSeconds = Math.max(0, Math.floor(seconds));
        var minutes = Math.floor(safeSeconds / 60);
        var remaining = safeSeconds % 60;
        return minutes === 0 ? safeSeconds + 's' : minutes + 'm ' + String(remaining).padStart(2, '0') + 's';
      }

      function updateElapsed() {
        elapsed.textContent = formatDuration((Date.now() - startedAt) / 1000);
      }

      updateElapsed();
      setInterval(updateElapsed, 1000);
    })();
  </script>`;
}

function renderOpportunityFilterScript() {
  return `<script>
    (function () {
      var cards = Array.prototype.slice.call(document.querySelectorAll('[data-opportunity-card]'));
      var search = document.querySelector('[data-filter-search]');
      var status = document.querySelector('[data-filter-status]');
      var type = document.querySelector('[data-filter-type]');
      var source = document.querySelector('[data-filter-source]');
      var reset = document.querySelector('[data-filter-reset]');
      var count = document.querySelector('[data-opportunity-count]');
      var empty = document.querySelector('[data-filter-empty]');
      if (!cards.length || !search || !status || !type || !source) return;

      function normalize(value) {
        return String(value || '')
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
      }

      function restore() {
        try {
          var saved = JSON.parse(localStorage.getItem('opportunityMonitorFilters') || '{}');
          search.value = saved.search || '';
          if ([].some.call(status.options, function (option) { return option.value === saved.status; })) status.value = saved.status;
          if ([].some.call(type.options, function (option) { return option.value === saved.type; })) type.value = saved.type;
          if ([].some.call(source.options, function (option) { return option.value === saved.source; })) source.value = saved.source;
        } catch (error) {}
      }

      function apply() {
        var query = normalize(search.value);
        var visible = 0;
        cards.forEach(function (card) {
          var matches = (!query || normalize(card.dataset.search).indexOf(query) >= 0) &&
            (status.value === 'all' || card.dataset.status === status.value) &&
            (type.value === 'all' || card.dataset.type === type.value) &&
            (source.value === 'all' || card.dataset.source === source.value);
          card.hidden = !matches;
          if (matches) visible += 1;
        });
        if (count) count.textContent = String(visible);
        if (empty) empty.hidden = visible !== 0;
        try {
          localStorage.setItem('opportunityMonitorFilters', JSON.stringify({
            search: search.value,
            status: status.value,
            type: type.value,
            source: source.value
          }));
        } catch (error) {}
      }

      restore();
      [search, status, type, source].forEach(function (control) {
        control.addEventListener(control === search ? 'input' : 'change', apply);
      });
      if (reset) reset.addEventListener('click', function () {
        search.value = '';
        status.value = 'all';
        type.value = 'all';
        source.value = 'all';
        apply();
        search.focus();
      });
      apply();
    })();
  </script>`;
}

function renderLoginPage({ message, type = 'ok' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${renderThemeBootScript()}
  <title>Opportunity Monitor Login</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #eef3f8;
      --panel: #ffffff;
      --panel-soft: #f8fafc;
      --text: #0f172a;
      --muted: #64748b;
      --line: #d4dde8;
      --accent: #0d9488;
      --accent-dark: #0f766e;
      --danger: #dc2626;
      --shadow: 0 24px 60px rgba(15, 23, 42, .14);
    }
    html[data-theme="dark"] {
      color-scheme: dark;
      --bg: #070d14;
      --panel: #101827;
      --panel-soft: #0f172a;
      --text: #eef4fb;
      --muted: #9aa8ba;
      --line: #263244;
      --accent: #14b8a6;
      --accent-dark: #2dd4bf;
      --danger: #f87171;
      --shadow: 0 24px 60px rgba(0, 0, 0, .36);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: var(--bg);
      color: var(--text);
      font-family: "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, Arial, Helvetica, sans-serif;
      padding: 18px;
    }
    html[data-theme="dark"] body {
      background: var(--bg);
    }
    main {
      width: min(420px, 100%);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 24px;
      box-shadow: var(--shadow);
      position: relative;
      overflow: hidden;
    }
    main::before {
      content: "";
      position: absolute;
      inset: 0 0 auto;
      height: 4px;
      background: #14b8a6;
    }
    h1 { margin: 0 0 8px; font-size: 26px; line-height: 1.15; }
    p { margin: 0 0 20px; color: var(--muted); }
    label { display: block; font-weight: 700; margin-bottom: 6px; }
    input {
      width: 100%;
      height: 44px;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 0 12px;
      font: inherit;
      background: var(--panel-soft);
      color: var(--text);
    }
    html[data-theme="dark"] input {
      background: var(--panel-soft);
      color: var(--text);
    }
    input:focus {
      border-color: var(--accent);
      outline: 3px solid rgba(20, 184, 166, .18);
    }
    button {
      width: 100%;
      height: 44px;
      margin-top: 14px;
      border: 0;
      border-radius: 7px;
      background: var(--accent);
      color: white;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 10px 20px rgba(13, 148, 136, .18);
      transition: transform .15s ease, box-shadow .15s ease, background .15s ease;
    }
    button:hover {
      background: var(--accent-dark);
      transform: translateY(-1px);
      box-shadow: 0 14px 28px rgba(13, 148, 136, .22);
    }
    .theme-toggle {
      position: fixed;
      top: 18px;
      right: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: auto;
      min-width: 128px;
      margin: 0;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, .82);
      color: var(--text);
      box-shadow: 0 10px 24px rgba(15, 23, 42, .08);
      backdrop-filter: blur(10px);
    }
    html[data-theme="dark"] .theme-toggle {
      background: rgba(16, 24, 39, .84);
    }
    .theme-toggle:hover {
      background: var(--accent);
      color: #fff;
    }
    .theme-icon {
      position: relative;
      width: 16px;
      height: 16px;
      border: 2px solid currentColor;
      border-radius: 50%;
    }
    .theme-icon::after {
      content: "";
      position: absolute;
      inset: 2px 0 2px 6px;
      border-radius: 50%;
      background: currentColor;
      opacity: .35;
    }
    .notice {
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 14px;
      background: var(--panel-soft);
      border: 1px solid #abefc6;
      border-left: 4px solid #12b76a;
    }
    html[data-theme="dark"] .notice {
      background: rgba(18, 183, 106, .13);
      border-color: rgba(18, 183, 106, .38);
    }
    .notice.error {
      background: #fef3f2;
      border-color: #fecdca;
      color: var(--danger);
    }
    html[data-theme="dark"] .notice.error {
      background: rgba(248, 113, 113, .13);
      border-color: rgba(248, 113, 113, .38);
    }
  </style>
</head>
<body>
  <button type="button" class="theme-toggle" data-theme-toggle aria-pressed="false">
    <span class="theme-icon" aria-hidden="true"></span>
    <span data-theme-label>Dark mode</span>
  </button>
  <main>
    <h1>Opportunity Monitor</h1>
    <p>Enter the dashboard password.</p>
    ${message ? `<div class="notice ${type === 'error' ? 'error' : ''}">${escapeHtml(message)}</div>` : ''}
    <form method="post" action="/login">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
      <button type="submit">Login</button>
    </form>
  </main>
  ${renderThemeToggleScript()}
</body>
</html>`;
}

async function executeCheck(trigger = 'manual') {
  if (runningCheck) {
    return { skipped: true };
  }

  const checkId = currentCheckId + 1;
  currentCheckId = checkId;
  runningCheck = true;
  currentCheckStartedAt = new Date();
  currentCheckProgress = { phase: 'starting', completedSites: 0, totalSites: 0, currentSiteName: '' };
  lastError = undefined;

  try {
    lastRunAt = new Date();
    lastSummary = {
      ...(await runChecks({
        trigger,
        onProgress(progress) {
          if (currentCheckId === checkId) currentCheckProgress = progress;
        }
      })),
      ranAt: lastRunAt.toISOString()
    };
    saveLastSummary();
    return lastSummary;
  } catch (error) {
    lastError = error.message;
    throw error;
  } finally {
    if (currentCheckId === checkId) {
      runningCheck = false;
      currentCheckStartedAt = undefined;
      currentCheckProgress = undefined;
    }
  }
}

function resetCheckingState() {
  currentCheckId += 1;
  runningCheck = false;
  currentCheckStartedAt = undefined;
  currentCheckProgress = undefined;
}

function scheduleChecks() {
  if (cronTask) {
    cronTask.stop();
    cronTask = undefined;
  }

  if (!cron.validate(config.cronSchedule)) {
    return `Invalid schedule: ${config.cronSchedule}`;
  }

  cronTask = cron.schedule(
    config.cronSchedule,
    async () => {
      try {
        await executeCheck('scheduled');
      } catch (error) {
        console.error(`Scheduled check failed: ${error.message}`);
      }
    },
    { timezone: config.cronTimezone }
  );

  return undefined;
}

function renderSiteRows(sites) {
  if (sites.length === 0) {
    return '<tr><td colspan="5" class="muted">No websites added yet.</td></tr>';
  }

  return sites
    .map((site) => {
      const status = site.enabled ? 'Enabled' : 'Disabled';
      const checked = site.last_checked_at || 'Never';
      const name = site.name || 'Untitled';

      return `
        <tr>
          <td>${site.id}</td>
          <td>
            <strong>${escapeHtml(name)}</strong>
            <span><a href="${escapeAttribute(safeUrl(site.url))}" target="_blank" rel="noreferrer">${escapeHtml(site.url)}</a></span>
          </td>
          <td>${status}</td>
          <td>
            <span>${escapeHtml(checked)}</span>
            <span>${escapeHtml(site.last_status || 'No checks yet')}</span>
            ${site.last_error ? `<span class="error">${escapeHtml(site.last_error)}</span>` : ''}
          </td>
          <td>
            <form method="post" action="/sites/remove">
              <input type="hidden" name="id" value="${site.id}">
              <button type="submit" class="secondary">Disable</button>
            </form>
          </td>
        </tr>
      `;
    })
    .join('');
}

const monthNames = new Map([
  ['janvier', 0],
  ['january', 0],
  ['fevrier', 1],
  ['février', 1],
  ['february', 1],
  ['mars', 2],
  ['march', 2],
  ['avril', 3],
  ['april', 3],
  ['mai', 4],
  ['may', 4],
  ['juin', 5],
  ['june', 5],
  ['juillet', 6],
  ['july', 6],
  ['aout', 7],
  ['août', 7],
  ['august', 7],
  ['septembre', 8],
  ['september', 8],
  ['octobre', 9],
  ['october', 9],
  ['novembre', 10],
  ['november', 10],
  ['decembre', 11],
  ['décembre', 11],
  ['december', 11]
]);

function parseDateCandidate(day, month, year) {
  const numericDay = Number.parseInt(day, 10);
  const numericYear = Number.parseInt(year, 10);
  if (!numericDay || !numericYear) return null;

  let numericMonth;
  if (/^\d+$/.test(month)) {
    numericMonth = Number.parseInt(month, 10) - 1;
  } else {
    numericMonth = monthNames.get(month.toLowerCase());
  }

  if (numericMonth === undefined || numericMonth < 0 || numericMonth > 11) return null;

  const date = new Date(numericYear, numericMonth, numericDay);
  if (
    date.getFullYear() !== numericYear ||
    date.getMonth() !== numericMonth ||
    date.getDate() !== numericDay
  ) {
    return null;
  }

  return date;
}

function extractDeadline(text) {
  const value = String(text ?? '');
  const dates = [];
  const numericPattern = /\b([0-3]?\d)[./-]([01]?\d)[./-]((?:20)?\d{2})\b/g;
  const wordPattern =
    /\b([0-3]?\d)\s+(janvier|january|fevrier|février|february|mars|march|avril|april|mai|may|juin|june|juillet|july|aout|août|august|septembre|september|octobre|october|novembre|november|decembre|décembre|december)\s+((?:20)?\d{2})\b/gi;

  let match;
  while ((match = numericPattern.exec(value))) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    const date = parseDateCandidate(match[1], match[2], year);
    if (date) dates.push(date);
  }

  while ((match = wordPattern.exec(value))) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    const date = parseDateCandidate(match[1], match[2], year);
    if (date) dates.push(date);
  }

  if (dates.length === 0) return null;
  return dates.sort((a, b) => b.getTime() - a.getTime())[0];
}

function formatDate(date) {
  return date.toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit'
  });
}

function formatTimestamp(value) {
  if (!value) return '';
  const parsed = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Number.parseInt(totalSeconds, 10) || 0);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds}s`;
  return `${minutes}m ${String(remainingSeconds).padStart(2, '0')}s`;
}

function inferOpportunityStatus(opportunity) {
  const text = `${opportunity.title} ${opportunity.snippet}`.toLowerCase();
  const deadline = extractDeadline(text);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (deadline) {
    const deadlineOnly = new Date(deadline);
    deadlineOnly.setHours(23, 59, 59, 999);
    return {
      deadline,
      status: deadlineOnly >= today ? 'Open' : 'Closed',
      confidence: 'From deadline'
    };
  }

  if (/not yet|not open|coming soon|soon|bient[oô]t|prochainement|sera annonc|non ouvert|\u0641\u064a\s+\u0627\u0646\u062a\u0638\u0627\u0631|\u0633\u064a\u062a\u0645\s+\u0627\u0644\u0625\u0639\u0644\u0627\u0646|\u0644\u0645\s+\u064a\u0641\u062a\u062d|\u063a\u064a\u0631\s+\u0645\u0641\u062a\u0648\u062d/.test(text)) {
    return { deadline: null, status: 'Not yet', confidence: 'From text' };
  }

  if (/appel|candidature|pre-?inscription|pré-?inscription|ouvert|ouverture|concours|inscription/.test(text)) {
    return { deadline: null, status: 'Open', confidence: 'No deadline found' };
  }

  return { deadline: null, status: 'Unknown', confidence: 'No deadline found' };
}

function parseKeywords(value) {
  try {
    const keywords = JSON.parse(value || '[]');
    return Array.isArray(keywords) ? keywords.join(', ') : '';
  } catch {
    return '';
  }
}

function renderOpportunityRows(opportunities) {
  if (opportunities.length === 0) {
    return '<tr><td colspan="6" class="muted">No saved opportunities yet. Click Check Now.</td></tr>';
  }

  return opportunities
    .map((opportunity) => {
      const meta = inferOpportunityStatus(opportunity);
      const deadline = meta.deadline ? formatDate(meta.deadline) : 'Not found';
      return `
        <tr>
          <td>
            <strong><a href="${escapeAttribute(safeUrl(opportunity.url))}" target="_blank" rel="noreferrer">${escapeHtml(opportunity.title)}</a></strong>
            <span>${escapeHtml(opportunity.snippet)}</span>
          </td>
          <td>
            <strong>${escapeHtml(meta.status)}</strong>
            <span>${escapeHtml(meta.confidence)}</span>
          </td>
          <td>${escapeHtml(deadline)}</td>
          <td>${escapeHtml(parseKeywords(opportunity.matched_keywords))}</td>
          <td>
            <strong>${escapeHtml(opportunity.site_name || 'Source')}</strong>
            <span><a href="${escapeAttribute(safeUrl(opportunity.site_url))}" target="_blank" rel="noreferrer">Open website</a></span>
          </td>
          <td>${escapeHtml(opportunity.first_seen_at || '')}</td>
        </tr>
      `;
    })
    .join('');
}

const strictNotYetPattern =
  /not yet|not open|coming soon|bientot|prochainement|sera annonc|non ouvert|pas encore|a venir|\u0641\u064a\s+\u0627\u0646\u062a\u0638\u0627\u0631|\u0633\u064a\u062a\u0645\s+\u0627\u0644\u0627?\u0639\u0644\u0627\u0646|\u0644\u0645\s+\u064a\u0641\u062a\u062d|\u063a\u064a\u0631\s+\u0645\u0641\u062a\u0648\u062d/;

function normalizeStrictDateText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u201a\u201b`\u00b4]/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function extractStrictConfirmedDeadline(text) {
  return findConfirmedDeadline(text);
}

function inferStrictOpportunityStatus(opportunity) {
  const text = `${opportunity.title} ${opportunity.snippet}`;
  const normalizedText = normalizeStrictDateText(text);
  const deadlineInfo = extractStrictConfirmedDeadline(text);
  const deadline = deadlineInfo?.date || null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (opportunity.applied_at) {
    return {
      deadline,
      status: 'Done',
      detail: `Marked applied ${formatTimestamp(opportunity.applied_at)}`,
      sortGroup: 5,
      targetYear: true
    };
  }

  if (deadline) {
    const deadlineOnly = new Date(deadline);
    deadlineOnly.setHours(23, 59, 59, 999);
    if (deadline.getFullYear() !== TARGET_OPPORTUNITY_YEAR || !hasTargetYearSignal(opportunity)) {
      return {
        deadline: null,
        status: 'Not yet',
        detail: `No relevant ${TARGET_OPPORTUNITY_YEAR} English/Licence Professionnelle opportunity found`,
        sortGroup: 3,
        targetYear: false
      };
    }

    const isOpen = deadlineOnly >= today;
    const daysRemaining = Math.round(
      (new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate()).getTime() - today.getTime()) /
      (24 * 60 * 60 * 1000)
    );

    return {
      deadline,
      status: isOpen ? 'Open' : 'Closed',
      detail: isOpen
        ? daysRemaining === 0
          ? 'Closes today'
          : `${daysRemaining} day${daysRemaining === 1 ? '' : 's'} remaining`
        : 'Confirmed deadline passed',
      sortGroup: isOpen ? 0 : 1,
      targetYear: true
    };
  }

  const targetYear = hasTargetYearSignal(opportunity);
  if (targetYear && !strictNotYetPattern.test(normalizedText)) {
    return {
      deadline: null,
      status: 'Deadline unknown',
      detail: `Current ${TARGET_OPPORTUNITY_YEAR} call found; confirm the deadline on the source page`,
      sortGroup: 2,
      targetYear: true
    };
  }

  return {
    deadline: null,
    status: 'Not yet',
    detail: strictNotYetPattern.test(normalizedText)
      ? 'Website text says not yet'
      : `No confirmed ${TARGET_OPPORTUNITY_YEAR} opportunity found`,
    sortGroup: 3,
    targetYear
  };
}

function parseSavedDate(value) {
  const time = Date.parse(String(value || '').replace(' ', 'T'));
  return Number.isFinite(time) ? time : 0;
}

function sourceTypeForSite(site) {
  try {
    const host = new URL(String(site.url || '')).hostname.toLowerCase().replace(/^www\./, '');
    if (/^(?:.+\.)?(?:almaster-maroc|licence-professionnelle-maroc)\.com$/.test(host)) {
      return 'Aggregator';
    }
    if (
      host.endsWith('.ac.ma') ||
      /^(?:.+\.)?(?:uca|ump|uiz|umi|um5|usmba|uae|uit|uh1)\.ma$/.test(host) ||
      host === 'ens-umi-inscription.com' ||
      host === 'esrft.ma' ||
      host === 'fpbm.ma'
    ) {
      return 'Official';
    }
  } catch {
    // Keep unknown URLs visibly unclassified.
  }
  return 'Source';
}

function sourceBadgeClass(type) {
  return type === 'Aggregator' ? 'aggregator' : type === 'Official' ? 'official' : 'default';
}

function renderSourceBadge(site) {
  const type = sourceTypeForSite(site);
  return `<span class="source-badge ${sourceBadgeClass(type)}">${escapeHtml(type)}</span>`;
}

function fallbackMetaForSite(site) {
  if (site.last_error) {
    return {
      deadline: null,
      status: 'Check error',
      detail: 'Could not check this website',
      sortGroup: 4,
      targetYear: false
    };
  }

  return {
    deadline: null,
    status: 'Not yet',
    detail: `No confirmed ${TARGET_OPPORTUNITY_YEAR} opportunity found yet`,
    sortGroup: 3,
    targetYear: false
  };
}

function rowMeta(row) {
  return row.bestMatch?.meta || fallbackMetaForSite(row.site);
}

function buildConfiguredWebsiteRows(sites, opportunities, siteScanResults = []) {
  const opportunitiesBySite = new Map();
  const healthBySite = new Map(siteScanResults.map((result) => [Number(result.site_id), result]));

  for (const opportunity of opportunities) {
    const list = opportunitiesBySite.get(opportunity.site_id) || [];
    const meta = inferStrictOpportunityStatus(opportunity);
    if (!meta.targetYear) continue;

    list.push({
      opportunity,
      meta,
      assessment: assessmentForOpportunity(opportunity),
      officialUrl: extractStoredOfficialUrl(opportunity.snippet)
    });
    opportunitiesBySite.set(opportunity.site_id, list);
  }

  return sites
    .map((site) => {
      const matches = (opportunitiesBySite.get(site.id) || []).sort((a, b) => {
        if (a.meta.sortGroup !== b.meta.sortGroup) return a.meta.sortGroup - b.meta.sortGroup;
        if (a.meta.deadline && b.meta.deadline) {
          return a.meta.sortGroup === 0
            ? a.meta.deadline.getTime() - b.meta.deadline.getTime()
            : b.meta.deadline.getTime() - a.meta.deadline.getTime();
        }
        return parseSavedDate(b.opportunity.first_seen_at) - parseSavedDate(a.opportunity.first_seen_at);
      });

      return {
        site,
        matches,
        bestMatch: matches[0],
        health: healthBySite.get(Number(site.id))
      };
    })
    .sort((a, b) => {
      const aMeta = rowMeta(a);
      const bMeta = rowMeta(b);
      if (aMeta.sortGroup !== bMeta.sortGroup) return aMeta.sortGroup - bMeta.sortGroup;
      if (aMeta.deadline && bMeta.deadline) {
        return aMeta.sortGroup === 0
          ? aMeta.deadline.getTime() - bMeta.deadline.getTime()
          : bMeta.deadline.getTime() - aMeta.deadline.getTime();
      }
      return a.site.id - b.site.id;
    });
}

function normalizeOpportunityUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(?:fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(value || '').trim().toLowerCase();
  }
}

function programTypeForOpportunity(opportunity) {
  const text = normalizeStrictDateText([
    opportunity.title,
    ...extractRelevantProgramNames(opportunity)
  ].join(' '));
  if (/\bmasters?\b|\bmastere\b|\u0645\u0627\u0633\u062a\u0631/.test(text)) return 'master';
  if (
    /\blicence\b|professional bachelor/.test(text) ||
    /licence d[' ]excellence|parcours d[' ]excellence|parcours excellence/.test(text)
  ) {
    return 'licence';
  }
  return 'master';
}

function opportunityCandidateRank(match) {
  return (
    (match.opportunity.applied_at ? 1000 : 0) +
    (match.officialUrl ? 200 : 0) +
    (match.sourceType === 'Official' ? 100 : 0) +
    match.assessment.score
  );
}

function assessmentForOpportunity(opportunity) {
  const assessment = assessOpportunityMatch(opportunity);
  if (opportunity.applied_at && assessment.level === 'Rejected') {
    return {
      score: null,
      level: 'Saved',
      reasons: ['Kept because it was marked Done'],
      sourceType: assessment.sourceType
    };
  }
  return assessment;
}

function buildOpportunityMatches(opportunities) {
  const deduplicated = new Map();

  for (const opportunity of opportunities) {
    const currentMatch = hasTargetYearSignal(opportunity);
    const savedRelevantMatch = Boolean(
      opportunity.applied_at && extractRelevantProgramNames(opportunity).length > 0
    );
    if (!currentMatch && !savedRelevantMatch) continue;
    const assessment = assessmentForOpportunity(opportunity);
    if (assessment.level === 'Rejected') continue;

    const officialUrl = extractStoredOfficialUrl(opportunity.snippet);
    const sourceType = sourceTypeForSite({ url: opportunity.site_url || opportunity.url });
    const match = {
      opportunity,
      meta: inferStrictOpportunityStatus(opportunity),
      assessment,
      officialUrl,
      sourceType,
      programType: programTypeForOpportunity(opportunity)
    };
    // One application portal can serve many programmes. Deduplicate by the
    // announcement URL so separate opportunities are never collapsed merely
    // because they share an official registration portal.
    const key = normalizeOpportunityUrl(opportunity.url) || `opportunity-${opportunity.id}`;
    const existing = deduplicated.get(key);
    if (!existing || opportunityCandidateRank(match) > opportunityCandidateRank(existing)) {
      deduplicated.set(key, match);
    }
  }

  return [...deduplicated.values()].sort((left, right) => {
    if (left.meta.sortGroup !== right.meta.sortGroup) return left.meta.sortGroup - right.meta.sortGroup;
    if (left.meta.deadline && right.meta.deadline) {
      return left.meta.sortGroup === 0
        ? left.meta.deadline.getTime() - right.meta.deadline.getTime()
        : right.meta.deadline.getTime() - left.meta.deadline.getTime();
    }
    if (left.assessment.score !== right.assessment.score) {
      return right.assessment.score - left.assessment.score;
    }
    return parseSavedDate(right.opportunity.first_seen_at) - parseSavedDate(left.opportunity.first_seen_at);
  });
}

function buildDashboardStats(configuredRows, counts, opportunityMatches) {
  const openRows = opportunityMatches.filter((match) => match.meta.status === 'Open');
  const closedRows = opportunityMatches.filter((match) => match.meta.status === 'Closed');
  const doneRows = opportunityMatches.filter((match) => match.meta.status === 'Done');
  const errorRows = configuredRows.filter((row) => rowMeta(row).status === 'Check error');
  const unmatchedRows = configuredRows.filter((row) => !row.bestMatch);
  const nextOpen = openRows
    .filter(({ meta }) => meta.deadline)
    .sort((a, b) => a.meta.deadline.getTime() - b.meta.deadline.getTime())[0];
  const focusLabels = new Set();

  for (const match of opportunityMatches) {
    for (const label of classifyOpportunityFocuses(match.opportunity)) {
      focusLabels.add(label);
    }
  }

  return {
    open: openRows.length,
    closed: closedRows.length,
    done: doneRows.length,
    errors: errorRows.length,
    unmatched: unmatchedRows.length,
    enabledSites: counts.sites,
    aggregators: configuredRows.filter((row) => sourceTypeForSite(row.site) === 'Aggregator').length,
    pendingAlerts: (counts.pendingTelegram || 0) + (counts.pendingWhatsapp || 0),
    pendingTelegram: counts.pendingTelegram || 0,
    pendingWhatsapp: counts.pendingWhatsapp || 0,
    applied: counts.applied || 0,
    nextOpen,
    focusLabels: [...focusLabels],
    opportunities: opportunityMatches.length
  };
}

function renderFocusChips(labels, variant = 'default') {
  if (!labels.length) return '<span class="muted">No focus match yet.</span>';
  return labels
    .map((label) => `<span class="focus-chip ${variant}">${escapeHtml(label)}</span>`)
    .join('');
}

function renderDashboardOverview(stats, telegramStatus, whatsappStatus, whatsappReady) {
  const nextProgramName = stats.nextOpen
    ? extractRelevantProgramNames(stats.nextOpen.opportunity)[0] || stats.nextOpen.opportunity.title
    : '';
  const nextDeadline = stats.nextOpen
    ? `${formatDate(stats.nextOpen.meta.deadline)} - ${nextProgramName || 'Opportunity'}`
    : 'No open deadline found';
  const focusLabels = stats.focusLabels.length
    ? stats.focusLabels
    : ['English Studies', 'Linguistics', 'Translation', 'Teaching / Didactics', 'Licence Professionnelle'];

  return `
    <section class="overview">
      <div class="overview-main">
        <div>
          <p class="eyebrow">English studies + licence professionnelle monitor</p>
          <h2>Opportunity dashboard</h2>
          <div class="focus-strip">${renderFocusChips(focusLabels, 'large')}</div>
        </div>
        <div class="stat-grid">
          <div class="stat-card primary">
            <span class="stat-label">Open now</span>
            <strong>${stats.open}</strong>
            <span>${escapeHtml(nextDeadline)}</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">Tracked sites</span>
            <strong>${stats.enabledSites}</strong>
            <span>${stats.unmatched} waiting${stats.errors ? `, ${stats.errors} check error(s)` : ''}</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">Alert channels</span>
            <strong>${Number(telegramStatus === 'Configured') + Number(whatsappReady)}/2 ready</strong>
            <span>Telegram: ${escapeHtml(telegramStatus)} | WhatsApp: ${escapeHtml(whatsappStatus)}</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">Done / closed</span>
            <strong>${stats.done + stats.closed}</strong>
            <span>${stats.done} applied, ${stats.closed} deadline passed</span>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderPriorityCard(match) {
  const meta = match.meta;
  const names = extractRelevantProgramNames(match.opportunity);
  const title = match.opportunity.title || 'Untitled opportunity';
  const programName = names[0] || title;
  const additionalNames = names.slice(1, 3);
  const discoveryUrl = safeUrl(match.opportunity.url);
  const officialUrl = safeUrl(match.officialUrl);
  const primaryUrl = officialUrl !== '#' ? officialUrl : discoveryUrl;
  const sourceName = match.opportunity.site_name || 'Configured website';
  const deadline = meta.deadline
    ? formatDate(meta.deadline)
    : meta.status === 'Deadline unknown'
      ? 'Not confirmed'
      : 'Not yet';
  const labels = classifyOpportunityFocuses(match.opportunity);
  const filterStatus = meta.status === 'Deadline unknown'
    ? 'no-deadline'
    : meta.status === 'Not yet'
      ? 'not-yet'
      : meta.status.toLowerCase();
  const filterText = normalizeStrictDateText([
    programName,
    additionalNames.join(' '),
    title,
    sourceName,
    labels.join(' ')
  ].join(' '));
  const confidenceClass = match.assessment.level.toLowerCase();
  const confidenceLabel = match.assessment.score === null
    ? match.assessment.level
    : `${match.assessment.level} ${match.assessment.score}`;

  return `
    <article
      class="opportunity-card ${meta.status === 'Open' ? 'open' : ''} ${meta.status === 'Done' ? 'applied' : ''}"
      data-opportunity-card
      data-status="${escapeAttribute(filterStatus)}"
      data-type="${escapeAttribute(match.programType)}"
      data-source="${escapeAttribute(match.sourceType.toLowerCase())}"
      data-search="${escapeAttribute(filterText)}"
    >
      <div class="card-topline">
        <div class="card-badges">
          ${renderCompactStatusBadge(meta)}
          <span class="confidence-badge ${escapeAttribute(confidenceClass)}">${escapeHtml(confidenceLabel)}</span>
        </div>
        ${renderSourceBadge({ url: match.opportunity.site_url || match.opportunity.url })}
      </div>
      <div class="opportunity-card-body">
        <p class="opportunity-source">${escapeHtml(sourceName)}</p>
        <h3><a href="${escapeAttribute(primaryUrl)}" target="_blank" rel="noreferrer">${escapeHtml(programName)}</a></h3>
        ${additionalNames.length ? `<p class="additional-programs">Also listed: ${escapeHtml(additionalNames.join('; '))}</p>` : ''}
        ${normalizeStrictDateText(title) !== normalizeStrictDateText(programName)
          ? `<p class="announcement-title">${escapeHtml(title)}</p>`
          : ''}
      </div>
      <div class="focus-list">${renderFocusChips(labels)}</div>
      <div class="deadline-block ${meta.status === 'Open' ? 'open' : ''}">
        <span>Deadline</span>
        <strong>${escapeHtml(deadline)}</strong>
        <small>${escapeHtml(meta.detail)}</small>
      </div>
      <div class="card-actions">
        ${primaryUrl !== '#'
          ? `<a class="action-link primary-link" href="${escapeAttribute(primaryUrl)}" target="_blank" rel="noreferrer">${officialUrl !== '#' ? 'Open official page' : 'Open opportunity'}</a>`
          : ''}
        ${officialUrl !== '#' && discoveryUrl !== '#' && officialUrl !== discoveryUrl
          ? `<a class="action-link" href="${escapeAttribute(discoveryUrl)}" target="_blank" rel="noreferrer">Discovery page</a>`
          : ''}
        ${renderDoneAction(match)}
      </div>
    </article>
  `;
}

function renderPriorityOpportunities(matches) {
  if (matches.length === 0) {
    return `
      <section class="priority-section">
        <div class="priority-header">
          <div>
            <p class="eyebrow">Priority view</p>
            <h2>Opportunities to watch</h2>
          </div>
        </div>
        <div class="empty-panel">No confirmed ${TARGET_OPPORTUNITY_YEAR} English-related opportunity is saved yet.</div>
      </section>
    `;
  }

  return `
    <section class="priority-section opportunity-workspace">
      <div class="priority-header">
        <div>
          <p class="eyebrow">Priority view</p>
          <h2>Opportunities to watch</h2>
        </div>
        <span class="result-count"><strong data-opportunity-count>${matches.length}</strong> shown</span>
      </div>
      <div class="opportunity-filters" data-opportunity-filters>
        <div class="filter-search">
          <label for="opportunitySearch">Search</label>
          <input id="opportunitySearch" type="search" placeholder="Programme or university" autocomplete="off" data-filter-search>
        </div>
        <div class="filter-field">
          <label for="statusFilter">Status</label>
          <select id="statusFilter" data-filter-status>
            <option value="all">All statuses</option>
            <option value="open">Open</option>
            <option value="no-deadline">Deadline unknown</option>
            <option value="not-yet">Not yet</option>
            <option value="closed">Closed</option>
            <option value="done">Done</option>
          </select>
        </div>
        <div class="filter-field">
          <label for="typeFilter">Programme</label>
          <select id="typeFilter" data-filter-type>
            <option value="all">Master and Licence</option>
            <option value="master">Master</option>
            <option value="licence">Licence</option>
          </select>
        </div>
        <div class="filter-field">
          <label for="sourceFilter">Source</label>
          <select id="sourceFilter" data-filter-source>
            <option value="all">All sources</option>
            <option value="official">Official</option>
            <option value="aggregator">Aggregator</option>
          </select>
        </div>
        <button type="button" class="secondary filter-reset" data-filter-reset>Clear</button>
      </div>
      <div class="priority-grid professional-grid" data-opportunity-grid>
        ${matches.map((match) => renderPriorityCard(match)).join('')}
      </div>
      <div class="empty-panel" data-filter-empty hidden>No opportunities match these filters.</div>
    </section>
  `;
}

function renderScanHistory(scanRuns = []) {
  if (scanRuns.length === 0) {
    return `
      <section class="scan-history-section">
        <div class="table-heading">
          <div><p class="eyebrow">Audit trail</p><h2>Scan history</h2></div>
        </div>
        <div class="empty-panel">Scan history will appear after the next check.</div>
      </section>
    `;
  }

  return `
    <section class="scan-history-section">
      <div class="table-heading">
        <div><p class="eyebrow">Audit trail</p><h2>Scan history</h2></div>
        <span class="muted">Latest ${scanRuns.length} runs</span>
      </div>
      <div class="scan-run-list">
        ${scanRuns.map((run) => {
          const complete = run.status === 'completed';
          const statusLabel = run.status === 'running'
            ? 'Running'
            : complete
              ? 'Complete'
              : 'Completed with errors';
          const duration = Number(run.duration_ms) > 0
            ? formatDuration(Math.round(Number(run.duration_ms) / 1000))
            : 'In progress';
          return `
            <article class="scan-run ${complete ? 'healthy' : run.status === 'running' ? 'running' : 'warning'}">
              <div class="scan-run-title">
                <strong>${escapeHtml(statusLabel)}</strong>
                <span>${escapeHtml(formatTimestamp(run.started_at))}</span>
              </div>
              <dl>
                <div><dt>Trigger</dt><dd>${escapeHtml(run.trigger)}</dd></div>
                <div><dt>Sites</dt><dd>${run.sites_checked}/${run.sites_total}</dd></div>
                <div><dt>Matches</dt><dd>${run.matches_found}</dd></div>
                <div><dt>New</dt><dd>${run.new_opportunities}</dd></div>
                <div><dt>Errors</dt><dd>${run.errors_count}</dd></div>
                <div><dt>Time</dt><dd>${escapeHtml(duration)}</dd></div>
              </dl>
            </article>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

function statusClassFor(meta) {
  return (
    meta.status === 'Open'
      ? 'open'
      : meta.status === 'Done'
        ? 'applied'
      : meta.status === 'Closed'
        ? 'closed'
        : meta.status === 'Deadline unknown'
          ? 'unknown'
        : meta.status === 'Check error'
          ? 'check-error'
          : 'not-yet'
  );
}

function statusMarkFor(meta) {
  if (meta.status === 'Done') return '&#10003;';
  if (meta.status === 'Deadline unknown') return '?';
  return meta.status === 'Open' ? '&#10003;' : meta.status === 'Not yet' ? 'X' : '!';
}

function renderCompactStatusBadge(meta) {
  return `
    <span class="status-badge ${statusClassFor(meta)}">
      <span class="status-mark">${statusMarkFor(meta)}</span>
      ${escapeHtml(meta.status)}
    </span>
  `;
}

function renderStrictStatusBadge(meta) {
  return `
    ${renderCompactStatusBadge(meta)}
    <span>${escapeHtml(meta.detail)}</span>
  `;
}

function renderStrictDeadline(meta) {
  if (meta.status === 'Check error') return '<span class="deadline-missing">Check failed</span>';
  if (meta.status === 'Deadline unknown') return '<span class="deadline-unknown">Not confirmed</span>';
  if (!meta.deadline) return '<span class="deadline-missing">Not yet</span>';
  const date = formatDate(meta.deadline);
  if (meta.status === 'Closed') {
    return `<span class="deadline-passed">${escapeHtml(date)} passed</span>`;
  }
  return `<strong class="deadline-open">${escapeHtml(date)}</strong>`;
}

function renderConfiguredOpportunityCell(match) {
  if (!match) {
    return `<span class="muted">No confirmed ${TARGET_OPPORTUNITY_YEAR} opportunity found yet.</span>`;
  }

  const { opportunity } = match;
  const url = safeUrl(opportunity.url);
  const officialUrl = safeUrl(match.officialUrl || extractStoredOfficialUrl(opportunity.snippet));
  const title = escapeHtml(opportunity.title || 'Untitled opportunity');
  const titleHtml = url === '#'
    ? `<strong>${title}</strong>`
    : `<strong><a href="${escapeAttribute(url)}" target="_blank" rel="noreferrer">${title}</a></strong>`;
  const confidenceLabel = match.assessment?.score === null
    ? match.assessment?.level
    : `${match.assessment?.level || 'Review'} ${match.assessment?.score ?? ''}`.trim();

  return `
    ${titleHtml}
    <span class="confidence-line">Match confidence: <strong>${escapeHtml(confidenceLabel)}</strong></span>
    ${officialUrl !== '#' && officialUrl !== url
      ? `<span><a href="${escapeAttribute(officialUrl)}" target="_blank" rel="noreferrer">Official / application page</a></span>`
      : ''}
    <div class="keyword-line">${escapeHtml(parseKeywords(opportunity.matched_keywords))}</div>
    <span>First seen: ${escapeHtml(formatTimestamp(opportunity.first_seen_at) || 'Unknown')}</span>
    ${opportunity.applied_at ? `<span class="applied-note">Applied: ${escapeHtml(formatTimestamp(opportunity.applied_at))}</span>` : ''}
  `;
}

function renderMasterNamesCell(match) {
  if (!match) {
    return `<span class="muted">No relevant ${TARGET_OPPORTUNITY_YEAR} program found yet.</span>`;
  }

  const names = extractRelevantProgramNames(match.opportunity);
  if (names.length === 0) {
    return '<span class="muted">No relevant program found.</span>';
  }

  return `
    <ul class="master-list">
      ${names.map((name) => `
        <li>
          <span class="program-name">${escapeHtml(name)}</span>
          <span class="program-focuses">${renderFocusChips(classifyProgramFocuses(name))}</span>
        </li>
      `).join('')}
    </ul>
  `;
}

function renderDoneAction(bestMatch) {
  if (!bestMatch) {
    return '<span class="muted">No opportunity yet</span>';
  }

  const id = Number.parseInt(bestMatch.opportunity.id, 10);
  if (!Number.isFinite(id)) {
    return '<span class="muted">No action</span>';
  }

  if (bestMatch.opportunity.applied_at) {
    return `
      <span class="done-label">Done</span>
      <form method="post" action="/opportunities/undo">
        <input type="hidden" name="id" value="${id}">
        <button type="submit" class="secondary small-button">Undo</button>
      </form>
    `;
  }

  return `
    <form method="post" action="/opportunities/done">
      <input type="hidden" name="id" value="${id}">
      <button type="submit" class="done-button">Done</button>
    </form>
  `;
}

function renderConfiguredSiteRows(configuredRows) {
  if (configuredRows.length === 0) {
    return '<tr><td colspan="7" class="muted">No websites added yet.</td></tr>';
  }

  return configuredRows
    .map(({ site, matches, bestMatch, health }) => {
      const checked = site.last_checked_at ? formatTimestamp(site.last_checked_at) : 'Never';
      const name = site.name || 'Untitled';
      const meta = bestMatch?.meta || fallbackMetaForSite(site);
      const rowClass = [
        'result-row',
        meta.status === 'Open' ? 'open-row' : '',
        meta.status === 'Done' ? 'applied-row' : ''
      ].filter(Boolean).join(' ');

      return `
        <tr class="${rowClass}">
          <td data-label="Website">
            <strong>${escapeHtml(name)}</strong>
            ${renderSourceBadge(site)}
            <span><a href="${escapeAttribute(safeUrl(site.url))}" target="_blank" rel="noreferrer">${escapeHtml(site.url)}</a></span>
            <span>${site.enabled ? 'Enabled' : 'Disabled'} | ${matches.length} current match${matches.length === 1 ? '' : 'es'}</span>
          </td>
          <td data-label="Best Match">${renderConfiguredOpportunityCell(bestMatch)}</td>
          <td data-label="Program Name(s)">${renderMasterNamesCell(bestMatch)}</td>
          <td data-label="Status">${renderStrictStatusBadge(meta)}</td>
          <td data-label="Deadline">${renderStrictDeadline(meta)}</td>
          <td data-label="Last Check">
            <span class="source-health ${health?.status === 'ok' ? 'healthy' : health?.status === 'error' ? 'unhealthy' : ''}">
              <i aria-hidden="true"></i>${health?.status === 'ok' ? 'Healthy' : health?.status === 'error' ? 'Check failed' : 'Waiting for scan'}
            </span>
            <span>${escapeHtml(checked)}${health ? ` | ${escapeHtml(formatDuration(Math.round(Number(health.duration_ms || 0) / 1000)))}` : ''}</span>
            <span>${health ? `${health.matches_found} match(es), ${health.new_opportunities} new` : escapeHtml(site.last_status || 'No checks yet')}</span>
            ${health?.error || site.last_error ? `<span class="error">${escapeHtml(health?.error || site.last_error)}</span>` : ''}
          </td>
          <td data-label="Action">
            <div class="row-actions">
              ${renderDoneAction(bestMatch)}
              <form method="post" action="/sites/remove">
                <input type="hidden" name="id" value="${site.id}">
                <button type="submit" class="secondary small-button">Disable</button>
              </form>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

function renderSummary() {
  if (!lastSummary) return '<p class="muted">No check has run in this dashboard session.</p>';

  return `
    <dl class="summary">
      <div><dt>Last run</dt><dd>${escapeHtml(lastRunAt?.toLocaleString() || 'Unknown')}</dd></div>
      <div><dt>Sites checked</dt><dd>${lastSummary.sitesChecked}</dd></div>
      <div><dt>Matches</dt><dd>${lastSummary.matchesFound}</dd></div>
      <div><dt>New</dt><dd>${lastSummary.newOpportunities}</dd></div>
      <div><dt>Sent</dt><dd>${lastSummary.notificationsSent}</dd></div>
      <div><dt>Pending</dt><dd>${lastSummary.notificationsPending}</dd></div>
      <div><dt>Duration</dt><dd>${lastSummary.durationMs
        ? escapeHtml(formatDuration(Math.round(Number(lastSummary.durationMs) / 1000)))
        : 'Not recorded'}</dd></div>
    </dl>
  `;
}

function renderCurrentState() {
  if (!runningCheck) {
    return '<p><strong>Current state:</strong> Idle</p>';
  }

  const elapsedSeconds = currentCheckStartedAt
    ? Math.max(0, Math.round((Date.now() - currentCheckStartedAt.getTime()) / 1000))
    : 0;

  return `
    <p><strong>Current state:</strong> Scan running.</p>
    <p class="muted">Elapsed: ${elapsedSeconds} seconds. A full check can take 1-3 minutes because some university websites are slow.</p>
  `;
}

function renderScanProgress(siteCount) {
  if (!runningCheck) return '';

  const elapsedSeconds = currentCheckStartedAt
    ? Math.max(0, Math.round((Date.now() - currentCheckStartedAt.getTime()) / 1000))
    : 0;
  const startedAt = currentCheckStartedAt ? currentCheckStartedAt.toISOString() : '';
  const totalSites = currentCheckProgress?.totalSites || siteCount;
  const completedSites = Math.min(currentCheckProgress?.completedSites || 0, totalSites);
  const percent = totalSites > 0 ? Math.round((completedSites / totalSites) * 100) : 0;
  const phase = currentCheckProgress?.phase || 'starting';
  const currentSiteName = currentCheckProgress?.currentSiteName || '';
  const matchesFound = currentCheckProgress?.matchesFound || 0;
  const newOpportunities = currentCheckProgress?.newOpportunities || 0;
  const errorsCount = currentCheckProgress?.errorsCount || 0;
  const statusLabel = phase === 'notifying'
    ? 'Sending alerts'
    : phase === 'starting'
      ? 'Starting'
      : 'Scanning';

  return `
    <section class="scan-status" data-scan-started-at="${escapeAttribute(startedAt)}" aria-live="polite">
      <div class="scan-status-grid">
        <div>
          <p class="eyebrow">Scan in progress</p>
          <h2>${completedSites} of ${totalSites} websites checked</h2>
          <p class="muted">${currentSiteName ? `Current source: ${escapeHtml(currentSiteName)}` : `Preparing ${TARGET_OPPORTUNITY_YEAR} opportunity results.`}</p>
        </div>
        <div class="scan-metrics">
          <span>Elapsed <strong data-scan-elapsed>${escapeHtml(formatDuration(elapsedSeconds))}</strong></span>
          <span>Progress <strong>${percent}%</strong></span>
          <span>Status <strong>${escapeHtml(statusLabel)}</strong></span>
          <span>Matches <strong>${matchesFound}</strong></span>
          <span>New <strong>${newOpportunities}</strong></span>
          <span>Errors <strong>${errorsCount}</strong></span>
        </div>
      </div>
      <div class="scan-progress" role="progressbar" aria-label="Website scan running" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
        <span style="width:${percent}%"></span>
      </div>
    </section>
  `;
}

function whatsappWebStatusLabel(state) {
  const labels = {
    disconnected: 'Not connected',
    starting: 'Starting',
    qr: 'Waiting for QR scan',
    authenticated: 'Signing in',
    ready: 'Connected',
    error: 'Connection error'
  };
  return labels[state.status] || 'Not connected';
}

function friendlyWhatsAppError(value) {
  const message = String(value || '').trim();
  if (!message) return '';
  if (/failed to launch the browser process|puppeteer|troubleshooting/i.test(message)) {
    return 'WhatsApp QR could not start. Use Connect by QR to retry the connection.';
  }
  return message.length > 220 ? `${message.slice(0, 217)}...` : message;
}

function renderWhatsAppWebPanel(state) {
  const statusLabel = whatsappWebStatusLabel(state);
  const isBusy = ['starting', 'qr', 'authenticated'].includes(state.status);

  return `
    <section class="whatsapp-web-panel ${state.ready ? 'connected' : ''}" aria-live="polite">
      <div class="whatsapp-web-copy">
        <p class="eyebrow">WhatsApp QR sender</p>
        <h2>WhatsApp alert connection</h2>
        <div class="connection-status ${state.ready ? 'ready' : ''}">
          <span class="connection-dot" aria-hidden="true"></span>
          ${escapeHtml(statusLabel)}
          ${state.connectedNumber ? ` | +${escapeHtml(state.connectedNumber)}` : ''}
        </div>
        ${state.lastError ? `<p class="error">${escapeHtml(friendlyWhatsAppError(state.lastError))}</p>` : ''}
        <form method="post" action="/whatsapp-web/connect" class="whatsapp-connect-form">
          <div class="field">
            <label for="whatsappWebRecipient">Your personal WhatsApp number</label>
            <input id="whatsappWebRecipient" name="recipient" inputmode="tel" placeholder="212600000000" value="${escapeHtml(config.whatsappRecipient)}" required>
          </div>
          <button type="submit" ${isBusy ? 'disabled' : ''}>${state.ready ? 'Save Number' : isBusy ? '<span class="button-spinner" aria-hidden="true"></span>Connecting' : 'Connect by QR'}</button>
        </form>
        ${state.ready ? `
          <div class="whatsapp-panel-actions">
            <form method="post" action="/whatsapp-web/test">
              <button type="submit" class="secondary">Send Test Notification</button>
            </form>
            <form method="post" action="/whatsapp-web/disconnect">
              <button type="submit" class="danger">Disconnect</button>
            </form>
          </div>
        ` : ''}
      </div>
      <div class="whatsapp-qr-area">
        ${state.qrDataUrl
          ? `<img src="${escapeAttribute(state.qrDataUrl)}" alt="WhatsApp linked-device QR code" width="260" height="260"><strong>Scan in WhatsApp Linked devices</strong>`
          : `<div class="qr-placeholder ${isBusy ? 'loading' : ''}"><span>${state.ready ? 'Connected' : 'QR'}</span></div>`}
      </div>
    </section>
  `;
}

function renderLastCheckResult() {
  if (!lastSummary) return '';

  const telegramSent = lastSummary.telegramSent ?? lastSummary.notificationsSent ?? 0;
  const telegramPending = lastSummary.telegramPending ?? lastSummary.notificationsPending ?? 0;
  const whatsappSent = lastSummary.whatsappSent ?? 0;
  const whatsappPending = lastSummary.whatsappPending ?? 0;
  const deliveryText = [
    `Telegram: ${telegramSent} sent, ${telegramPending} pending.`,
    `WhatsApp: ${whatsappSent} sent, ${whatsappPending} pending.`
  ].join(' ');

  return `
    <div class="notice" style="display:block">
      <strong>Last check result:</strong>
      ${lastSummary.newOpportunities} new ${lastSummary.newOpportunities === 1 ? 'opportunity' : 'opportunities'} found.
      ${deliveryText}
      ${lastSummary.errors.length > 0 ? `${lastSummary.errors.length} website(s) had connection errors.` : ''}
    </div>
  `;
}

function renderPage({
  sites,
  opportunities,
  counts,
  scanRuns,
  siteScanResults,
  message,
  type,
  scheduleError
}) {
  const keywords = listKeywordLabels().join(', ');
  const telegramStatus = isTelegramConfigured() ? 'Configured' : 'Missing bot token or chat ID';
  const whatsappWebState = getWhatsAppWebState();
  const whatsappReady = isWhatsAppWebReady() || isWhatsAppConfigured();
  const whatsappStatus = isWhatsAppWebReady()
    ? 'QR connected'
    : isWhatsAppConfigured()
      ? 'Cloud configured'
      : whatsappWebState.enabled
        ? `QR ${whatsappWebStatusLabel(whatsappWebState).toLowerCase()}`
        : 'Setup needed';
  const autoRefresh = runningCheck || ['starting', 'qr', 'authenticated'].includes(whatsappWebState.status);
  const disabled = runningCheck ? 'disabled' : '';
  const activeSites = sites.filter((site) => site.enabled);
  const configuredRows = buildConfiguredWebsiteRows(activeSites, opportunities, siteScanResults);
  const opportunityMatches = buildOpportunityMatches(opportunities);
  const dashboardStats = buildDashboardStats(configuredRows, counts, opportunityMatches);
  const visibleMessage =
    !runningCheck && type !== 'error' && String(message || '').startsWith('Check started.')
      ? ''
      : message;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${renderThemeBootScript()}
  ${autoRefresh ? '<meta http-equiv="refresh" content="5">' : ''}
  <title>Opportunity Monitor</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #eef3f8;
      --panel: #ffffff;
      --panel-soft: #f8fafc;
      --text: #0f172a;
      --muted: #64748b;
      --line: #d4dde8;
      --accent: #0d9488;
      --accent-dark: #0f766e;
      --accent-soft: #e7f8f5;
      --blue: #2563eb;
      --blue-soft: #eef4ff;
      --ink: #0f172a;
      --violet: #7c3aed;
      --violet-soft: #f3efff;
      --gold: #b45309;
      --gold-soft: #fff7ed;
      --danger: #dc2626;
      --danger-soft: #fef3f2;
      --green: #059669;
      --green-soft: #ecfdf5;
      --surface: rgba(255, 255, 255, .88);
      --shadow: 0 24px 58px rgba(15, 23, 42, .12);
      --soft-shadow: 0 12px 32px rgba(15, 23, 42, .06);
    }
    html[data-theme="dark"] {
      color-scheme: dark;
      --bg: #070d14;
      --panel: #101827;
      --panel-soft: #0f172a;
      --text: #eef4fb;
      --muted: #9aa8ba;
      --line: #263244;
      --accent: #14b8a6;
      --accent-dark: #2dd4bf;
      --accent-soft: rgba(20, 184, 166, .14);
      --blue: #60a5fa;
      --blue-soft: rgba(37, 99, 235, .16);
      --ink: #f8fafc;
      --violet: #a78bfa;
      --violet-soft: rgba(124, 58, 237, .16);
      --gold: #fbbf24;
      --gold-soft: rgba(245, 158, 11, .14);
      --danger: #f87171;
      --danger-soft: rgba(248, 113, 113, .13);
      --green: #34d399;
      --green-soft: rgba(18, 183, 106, .14);
      --surface: rgba(17, 24, 39, .84);
      --shadow: 0 24px 58px rgba(0, 0, 0, .38);
      --soft-shadow: 0 14px 32px rgba(0, 0, 0, .22);
    }
    * { box-sizing: border-box; }
    html, body {
      max-width: 100%;
      overflow-x: hidden;
    }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, Arial, Helvetica, sans-serif;
      font-size: 15px;
      line-height: 1.45;
      overflow-wrap: break-word;
      text-rendering: optimizeLegibility;
    }
    html[data-theme="dark"] body {
      background: var(--bg);
    }
    main {
      width: min(1460px, calc(100% - 32px));
      margin: 0 auto;
      padding: 16px 0 54px;
    }
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 20px;
    }
    .topbar {
      position: relative;
      overflow: hidden;
      align-items: stretch;
      padding: 18px 20px;
      border: 1px solid #30464a;
      border-left: 5px solid #14b8a6;
      border-radius: 8px;
      background: #172529;
      box-shadow: 0 10px 28px rgba(15, 23, 42, .16);
      color: #fff;
    }
    .topbar::after {
      display: none;
    }
    .topbar > * {
      position: relative;
      z-index: 1;
    }
    .brand-kicker {
      margin: 0 0 6px;
      color: #99f6e4;
      font-size: 12px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .header-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
      align-content: flex-start;
      padding-top: 2px;
    }
    .header-actions form {
      margin: 0;
    }
    .header-actions button {
      min-height: 42px;
    }
    .theme-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-width: 128px;
      background: rgba(255, 255, 255, .13);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, .24);
      box-shadow: none;
    }
    .theme-toggle:hover {
      background: rgba(255, 255, 255, .2);
    }
    .theme-icon {
      position: relative;
      width: 16px;
      height: 16px;
      border: 2px solid currentColor;
      border-radius: 50%;
      flex: 0 0 auto;
    }
    .theme-icon::after {
      content: "";
      position: absolute;
      inset: 2px 0 2px 6px;
      border-radius: 50%;
      background: currentColor;
      opacity: .35;
    }
    .header-pills {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .mini-pill {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      border: 1px solid rgba(255, 255, 255, .22);
      border-radius: 7px;
      padding: 5px 10px;
      background: rgba(255, 255, 255, .12);
      color: #f8fafc;
      font-size: 12px;
      font-weight: 800;
    }
    h1, h2 { margin: 0; line-height: 1.2; }
    h1 { font-size: 30px; letter-spacing: 0; color: var(--ink); }
    .topbar h1 { color: #fff; }
    .topbar .muted {
      max-width: 760px;
      color: #e0f2fe;
      font-weight: 500;
    }
    h2 { font-size: 18px; margin-bottom: 14px; }
    header p { margin-bottom: 0; }
    .muted, small, td span { color: var(--muted); }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 380px;
      gap: 16px;
      align-items: start;
    }
    .grid > *,
    .secondary-grid > * {
      min-width: 0;
    }
    .secondary-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(280px, 380px);
      gap: 16px;
      align-items: start;
    }
    .overview {
      padding: 0;
      overflow: hidden;
      border: 0;
      background: transparent;
    }
    .overview-main {
      display: grid;
      grid-template-columns: minmax(250px, .48fr) minmax(0, 1.52fr);
      gap: 18px;
      align-items: stretch;
      padding: 4px 0;
      border: 0;
      background: transparent;
    }
    .overview-main::before {
      display: none;
    }
    .overview-main > div:first-child {
      display: flex;
      min-width: 0;
      flex-direction: column;
      justify-content: space-between;
      padding: 4px 8px 4px 0;
    }
    html[data-theme="dark"] .overview-main {
      background: transparent;
    }
    .eyebrow {
      margin: 0 0 8px;
      color: var(--accent-dark);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    html[data-theme="dark"] .eyebrow {
      color: #99f6e4;
    }
    .focus-strip,
    .focus-list,
    .program-focuses {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .focus-strip {
      margin-top: 18px;
    }
    .card-actions {
      margin-top: auto;
      padding-top: 12px;
    }
    .card-actions .row-actions {
      gap: 6px;
    }
    .card-actions button {
      width: 100%;
    }
    .focus-chip {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border: 1px solid #c6d6ef;
      border-radius: 7px;
      padding: 3px 8px;
      background: var(--blue-soft);
      color: #173f8a;
      font-size: 12px;
      font-weight: 700;
      line-height: 1.2;
    }
    html[data-theme="dark"] .focus-chip {
      border-color: rgba(96, 165, 250, .34);
      background: rgba(37, 99, 235, .16);
      color: #bfdbfe;
    }
    .focus-chip.large {
      min-height: 28px;
      padding: 5px 10px;
      background: var(--panel-soft);
      border-color: #bcd7d2;
      color: var(--accent-dark);
    }
    html[data-theme="dark"] .focus-chip.large {
      background: rgba(20, 184, 166, .12);
      border-color: rgba(45, 212, 191, .36);
      color: #99f6e4;
    }
    .source-badge {
      display: inline-flex;
      align-items: center;
      min-height: 23px;
      width: fit-content;
      border-radius: 6px;
      padding: 3px 8px;
      margin-top: 7px;
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .source-badge.official {
      background: #ecfdf3;
      border: 1px solid #abefc6;
      color: #027a48;
    }
    html[data-theme="dark"] .source-badge.official {
      background: rgba(18, 183, 106, .14);
      border-color: rgba(18, 183, 106, .38);
      color: #7dd3a8;
    }
    .source-badge.aggregator {
      background: var(--violet-soft);
      border: 1px solid #d8d0ff;
      color: #4f35c8;
    }
    html[data-theme="dark"] .source-badge.aggregator {
      background: rgba(124, 58, 237, .18);
      border-color: rgba(167, 139, 250, .4);
      color: #c4b5fd;
    }
    .source-badge.default {
      background: #f2f4f7;
      border: 1px solid #d0d5dd;
      color: #475467;
    }
    html[data-theme="dark"] .source-badge.default {
      background: rgba(148, 163, 184, .14);
      border-color: rgba(148, 163, 184, .34);
      color: #cbd5e1;
    }
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    .stat-card {
      position: relative;
      overflow: hidden;
      min-height: 112px;
      border: 1px solid rgba(203, 213, 225, .9);
      border-radius: 8px;
      padding: 16px;
      background: var(--panel-soft);
      box-shadow: 0 5px 16px rgba(15, 23, 42, .05);
      transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease;
    }
    .stat-card::before {
      content: "";
      position: absolute;
      inset: 0 0 auto;
      height: 3px;
      background: #94a3b8;
    }
    .stat-card:nth-child(2)::before { background: #2563eb; }
    .stat-card:nth-child(3)::before { background: #7c3aed; }
    .stat-card:nth-child(4)::before { background: #f59e0b; }
    .stat-card.primary::before { background: #14b8a6; }
    .stat-card:hover {
      transform: translateY(-1px);
      box-shadow: 0 16px 34px rgba(15, 23, 42, .09);
    }
    html[data-theme="dark"] .stat-card {
      border-color: rgba(71, 85, 105, .78);
      box-shadow: var(--soft-shadow);
      background: var(--panel-soft);
    }
    .stat-card.primary {
      border-color: #99e6d8;
      background: var(--accent-soft);
    }
    html[data-theme="dark"] .stat-card.primary {
      border-color: rgba(45, 212, 191, .42);
      background: rgba(20, 184, 166, .13);
    }
    .stat-card strong {
      display: block;
      margin: 8px 0 6px;
      font-size: 25px;
      line-height: 1.05;
      overflow-wrap: normal;
    }
    .stat-card span:last-child {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.35;
    }
    .stat-label {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    section {
      background: var(--panel);
      border: 1px solid rgba(203, 213, 225, .92);
      border-radius: 8px;
      padding: 18px;
      margin-bottom: 16px;
      overflow: hidden;
      box-shadow: var(--soft-shadow);
    }
    html[data-theme="dark"] section {
      background: var(--panel);
      border-color: rgba(71, 85, 105, .78);
      box-shadow: var(--soft-shadow);
    }
    .scan-status {
      position: relative;
      padding: 18px;
      border-color: rgba(20, 184, 166, .46);
      background: var(--panel);
    }
    html[data-theme="dark"] .scan-status {
      border-color: rgba(45, 212, 191, .46);
      background: var(--panel);
    }
    .scan-status-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(300px, 460px);
      gap: 16px;
      align-items: center;
    }
    .scan-status h2 {
      margin-bottom: 8px;
      font-size: 22px;
    }
    .scan-status p:last-child {
      margin: 0;
    }
    .scan-metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .scan-metrics span {
      display: block;
      min-height: 74px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-soft);
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .scan-metrics strong {
      display: block;
      margin-top: 6px;
      color: var(--text);
      font-size: 20px;
      line-height: 1.1;
      text-transform: none;
    }
    .scan-progress {
      position: relative;
      height: 12px;
      margin-top: 16px;
      overflow: hidden;
      border: 1px solid rgba(20, 184, 166, .34);
      border-radius: 999px;
      background: rgba(15, 23, 42, .08);
    }
    html[data-theme="dark"] .scan-progress {
      background: rgba(148, 163, 184, .12);
    }
    .scan-progress span {
      position: absolute;
      inset: 2px auto 2px 2px;
      border-radius: 999px;
      background: #14b8a6;
      transition: width .3s ease;
    }
    .whatsapp-web-panel {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 286px;
      gap: 24px;
      align-items: center;
      border-color: rgba(5, 150, 105, .38);
      background: var(--panel);
    }
    .whatsapp-web-panel.connected {
      border-color: rgba(16, 185, 129, .68);
    }
    html[data-theme="dark"] .whatsapp-web-panel {
      background: var(--panel);
    }
    .whatsapp-web-copy h2 {
      margin-bottom: 10px;
    }
    .connection-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
      color: var(--muted);
      font-weight: 800;
    }
    .connection-status.ready {
      color: #047857;
    }
    html[data-theme="dark"] .connection-status.ready {
      color: #6ee7b7;
    }
    .connection-dot {
      width: 10px;
      height: 10px;
      flex: 0 0 auto;
      border-radius: 50%;
      background: #94a3b8;
      box-shadow: 0 0 0 4px rgba(148, 163, 184, .15);
    }
    .connection-status.ready .connection-dot {
      background: #10b981;
      box-shadow: 0 0 0 4px rgba(16, 185, 129, .16);
    }
    .whatsapp-connect-form {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: end;
      max-width: 680px;
    }
    .whatsapp-connect-form .field {
      margin-bottom: 0;
    }
    .whatsapp-connect-form button {
      min-height: 46px;
      white-space: nowrap;
    }
    .whatsapp-panel-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .whatsapp-panel-actions form {
      margin: 0;
    }
    .whatsapp-qr-area {
      display: grid;
      place-items: center;
      gap: 9px;
      min-height: 286px;
      text-align: center;
      color: var(--muted);
      font-size: 13px;
    }
    .whatsapp-qr-area img {
      width: min(260px, 100%);
      height: auto;
      aspect-ratio: 1;
      border: 10px solid #fff;
      border-radius: 8px;
      box-shadow: 0 14px 32px rgba(15, 23, 42, .14);
    }
    .qr-placeholder {
      display: grid;
      place-items: center;
      width: 220px;
      max-width: 100%;
      aspect-ratio: 1;
      border: 1px dashed rgba(100, 116, 139, .55);
      border-radius: 8px;
      color: var(--muted);
      background: var(--panel-soft);
      font-size: 24px;
      font-weight: 900;
    }
    .qr-placeholder.loading span {
      animation: qr-pulse 1.1s ease-in-out infinite alternate;
    }
    @keyframes qr-pulse {
      to { opacity: .35; }
    }
    @keyframes scan-progress-slide {
      0% { transform: translateX(-110%); }
      55% { transform: translateX(95%); }
      100% { transform: translateX(245%); }
    }
    .priority-section {
      padding: 0;
      border: 0;
      background: transparent;
      box-shadow: none;
      overflow: visible;
    }
    .priority-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: end;
      margin: 22px 2px 12px;
    }
    .priority-header h2 {
      margin-bottom: 0;
      font-size: 21px;
    }
    .priority-header.compact {
      margin-top: 6px;
      margin-bottom: 10px;
    }
    .priority-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 20px;
      align-items: stretch;
    }
    .done-priority-block {
      margin-top: 4px;
    }
    .done-grid {
      margin-bottom: 0;
    }
    .opportunity-card {
      position: relative;
      overflow: hidden;
      min-height: 226px;
      border: 1px solid rgba(203, 213, 225, .92);
      border-radius: 8px;
      padding: 16px;
      background: var(--panel);
      box-shadow: var(--soft-shadow);
      display: flex;
      flex-direction: column;
      transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease;
    }
    .opportunity-card::before {
      content: "";
      position: absolute;
      inset: 0 0 auto;
      height: 4px;
      background: #94a3b8;
    }
    .opportunity-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 18px 38px rgba(15, 23, 42, .10);
    }
    html[data-theme="dark"] .opportunity-card {
      background: var(--panel);
      border-color: rgba(71, 85, 105, .78);
      box-shadow: var(--soft-shadow);
    }
    .opportunity-card.open {
      border-color: #87d4bf;
      background: #ffffff;
    }
    .opportunity-card.open::before {
      background: #12b76a;
    }
    html[data-theme="dark"] .opportunity-card.open {
      border-color: rgba(45, 212, 191, .5);
      background: var(--panel);
    }
    .opportunity-card.applied {
      border-color: #b2ddff;
      background: #ffffff;
    }
    .opportunity-card.applied::before {
      background: #2563eb;
    }
    html[data-theme="dark"] .opportunity-card.applied {
      border-color: rgba(96, 165, 250, .44);
      background: var(--panel);
    }
    .opportunity-card h3 {
      margin: 12px 0 8px;
      font-size: 17px;
      line-height: 1.3;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .opportunity-card p {
      margin: 0 0 10px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .card-topline {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }
    .card-topline > span:last-child:not(.deadline-pill) {
      display: none;
    }
    .deadline-pill {
      display: inline-flex;
      align-items: center;
      min-height: 25px;
      border-radius: 7px;
      padding: 3px 8px;
      background: #fff7ed;
      border: 1px solid #fed7aa;
      color: #9a3412;
      font-size: 12px;
      font-weight: 800;
      white-space: nowrap;
    }
    html[data-theme="dark"] .deadline-pill {
      background: rgba(245, 158, 11, .14);
      border-color: rgba(251, 191, 36, .38);
      color: #fde68a;
    }
    .empty-panel {
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 18px;
      background: rgba(255, 255, 255, .75);
      color: var(--muted);
      margin-bottom: 18px;
    }
    html[data-theme="dark"] .empty-panel {
      background: rgba(15, 23, 42, .7);
    }
    .table-section {
      padding: 0;
    }
    .table-heading {
      padding: 18px 18px 14px;
      border-bottom: 1px solid var(--line);
      background: var(--panel-soft);
    }
    .table-heading h2 {
      margin-bottom: 6px;
    }
    .table-scroll {
      overflow-x: auto;
    }
    label {
      display: block;
      font-weight: 700;
      margin-bottom: 6px;
    }
    input {
      width: 100%;
      height: 42px;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 0 12px;
      font: inherit;
      background: var(--panel-soft);
      color: var(--text);
    }
    html[data-theme="dark"] input {
      background: var(--panel-soft);
      color: var(--text);
    }
    input:focus {
      border-color: var(--accent);
      outline: 3px solid rgba(20, 184, 166, .18);
    }
    .field { margin-bottom: 12px; }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 7px;
      background: var(--accent);
      color: white;
      min-height: 40px;
      padding: 0 14px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      white-space: normal;
      box-shadow: 0 6px 14px rgba(15, 118, 110, .16);
      transition: transform .15s ease, box-shadow .15s ease, background .15s ease, border-color .15s ease;
      text-align: center;
    }
    button:hover {
      background: var(--accent-dark);
      transform: translateY(-1px);
      box-shadow: 0 10px 22px rgba(15, 118, 110, .20);
    }
    button.secondary {
      background: var(--panel-soft);
      color: var(--text);
      border: 1px solid var(--line);
      box-shadow: 0 6px 14px rgba(15, 23, 42, .04);
    }
    button.secondary:hover {
      background: #e9eef5;
      border-color: #b9c5d5;
      box-shadow: 0 10px 20px rgba(15, 23, 42, .06);
    }
    html[data-theme="dark"] button.secondary {
      background: var(--panel-soft);
      color: var(--text);
      border-color: rgba(71, 85, 105, .86);
    }
    html[data-theme="dark"] button.secondary:hover {
      background: #162033;
      border-color: rgba(100, 116, 139, .9);
    }
    .topbar button.secondary {
      background: rgba(255, 255, 255, .95);
      color: #111827;
      border-color: rgba(255, 255, 255, .72);
    }
    html[data-theme="dark"] .topbar button.secondary {
      background: rgba(255, 255, 255, .14);
      color: #fff;
      border-color: rgba(255, 255, 255, .24);
    }
    button.danger {
      background: var(--danger);
      box-shadow: 0 6px 14px rgba(180, 35, 24, .16);
    }
    button.danger:hover {
      background: #b91c1c;
    }
    .done-button {
      background: #059669;
      box-shadow: 0 6px 14px rgba(5, 150, 105, .16);
    }
    .done-button:hover {
      background: #047857;
    }
    html[data-theme="dark"] .done-button {
      background: #12b76a;
      color: #04130c;
    }
    html[data-theme="dark"] .done-button:hover {
      background: #32d583;
    }
    .small-button {
      width: 100%;
      min-width: 74px;
      padding: 0 10px;
      font-size: 13px;
    }
    button:disabled { opacity: .55; cursor: wait; }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .actions form {
      flex: 1 1 148px;
      margin: 0;
    }
    .actions button {
      width: 100%;
    }
    .button-spinner {
      width: 16px;
      height: 16px;
      margin-right: 8px;
      border: 2px solid rgba(255, 255, 255, .42);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin .7s linear infinite;
      flex: 0 0 auto;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 1160px;
      table-layout: fixed;
    }
    th, td {
      padding: 14px 12px;
      text-align: left;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      line-height: 1.35;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      font-size: 12px;
      color: var(--muted);
      background: var(--panel-soft);
      text-transform: uppercase;
      letter-spacing: 0;
    }
    html[data-theme="dark"] th {
      background: var(--panel-soft);
    }
    tbody tr:hover td { background: #fbfcfe; }
    html[data-theme="dark"] tbody tr:hover td {
      background: rgba(30, 41, 59, .66);
    }
    .open-row td:first-child {
      border-left: 4px solid #12b76a;
      padding-left: 8px;
    }
    .applied-row td:first-child {
      border-left: 4px solid var(--blue);
      padding-left: 8px;
    }
    td span { display: block; margin-top: 3px; overflow-wrap: anywhere; }
    td strong { overflow-wrap: anywhere; }
    .applied-note,
    .done-label {
      color: #027a48;
      font-weight: 800;
    }
    html[data-theme="dark"] .applied-note,
    html[data-theme="dark"] .done-label {
      color: #7dd3a8;
    }
    .row-actions {
      display: grid;
      gap: 7px;
      align-items: start;
    }
    .master-list {
      margin: 0;
      padding-left: 18px;
    }
    .master-list li {
      margin-bottom: 6px;
      overflow-wrap: anywhere;
    }
    .program-name {
      display: block;
      color: var(--text);
      margin-bottom: 5px;
    }
    .program-focuses {
      margin-top: 2px;
    }
    .keyword-line {
      margin-top: 5px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.4;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 27px;
      border-radius: 7px;
      padding: 4px 9px;
      font-weight: 700;
      font-size: 13px;
      border: 1px solid transparent;
      white-space: nowrap;
      margin-bottom: 4px;
    }
    .status-badge.open {
      background: #ecfdf3;
      border-color: #abefc6;
      color: #027a48;
    }
    html[data-theme="dark"] .status-badge.open {
      background: rgba(18, 183, 106, .14);
      border-color: rgba(18, 183, 106, .38);
      color: #7dd3a8;
    }
    .status-badge.applied {
      background: #eff8ff;
      border-color: #b2ddff;
      color: #175cd3;
    }
    html[data-theme="dark"] .status-badge.applied {
      background: rgba(37, 99, 235, .16);
      border-color: rgba(96, 165, 250, .38);
      color: #93c5fd;
    }
    .status-badge.not-yet {
      background: #fef3f2;
      border-color: #fecdca;
      color: var(--danger);
    }
    html[data-theme="dark"] .status-badge.not-yet {
      background: rgba(248, 113, 113, .13);
      border-color: rgba(248, 113, 113, .38);
      color: #fca5a5;
    }
    .status-badge.unknown {
      background: #eff6ff;
      border-color: #bfdbfe;
      color: #1d4ed8;
    }
    html[data-theme="dark"] .status-badge.unknown {
      background: rgba(37, 99, 235, .16);
      border-color: rgba(96, 165, 250, .38);
      color: #93c5fd;
    }
    .status-badge.check-error {
      background: #f4f6f8;
      border-color: #cfd6e2;
      color: #475467;
    }
    html[data-theme="dark"] .status-badge.check-error {
      background: rgba(148, 163, 184, .13);
      border-color: rgba(148, 163, 184, .34);
      color: #cbd5e1;
    }
    .status-badge.closed {
      background: var(--gold-soft);
      border-color: #f6d98b;
      color: var(--gold);
    }
    html[data-theme="dark"] .status-badge.closed {
      background: rgba(245, 158, 11, .14);
      border-color: rgba(251, 191, 36, .38);
      color: #fbbf24;
    }
    .status-mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 17px;
      height: 17px;
      border-radius: 50%;
      border: 1px solid currentColor;
      font-size: 11px;
      line-height: 1;
    }
    .deadline-open { color: #027a48; }
    html[data-theme="dark"] .deadline-open { color: #7dd3a8; }
    .deadline-missing,
    .deadline-passed {
      color: var(--danger);
      font-weight: 700;
    }
    .deadline-unknown {
      color: var(--blue);
      font-weight: 700;
    }
    .status-note {
      margin: 0;
      font-size: 13px;
    }
    .notice {
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 16px;
      background: var(--panel);
      border: 1px solid #abefc6;
      border-left: 4px solid #12b76a;
      box-shadow: var(--soft-shadow);
    }
    html[data-theme="dark"] .notice {
      background: var(--panel);
      border-color: rgba(18, 183, 106, .38);
      border-left-color: #34d399;
      box-shadow: var(--soft-shadow);
    }
    .notice.error {
      background: var(--panel);
      border-color: #fecdca;
      border-left-color: var(--danger);
      color: var(--danger);
    }
    html[data-theme="dark"] .notice.error {
      background: var(--panel);
      border-color: rgba(248, 113, 113, .38);
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      margin: 0;
    }
    .summary div {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 10px;
      background: var(--panel-soft);
    }
    dt { color: var(--muted); font-size: 12px; }
    dd { margin: 4px 0 0; font-weight: 700; }
    .error { color: var(--danger); }
    a { color: #0f5fbd; text-decoration: none; overflow-wrap: anywhere; }
    html[data-theme="dark"] a { color: #7dd3fc; }
    a:hover { text-decoration: underline; }
    .keyword-box {
      line-height: 1.55;
      color: var(--muted);
    }
    .opportunity-workspace {
      margin-top: 24px;
    }
    .result-count {
      display: inline-flex;
      align-items: center;
      min-height: 32px;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 5px 10px;
      background: var(--panel);
      color: var(--muted);
      font-size: 13px;
    }
    .result-count strong {
      margin-right: 4px;
      color: var(--text);
      font-size: 15px;
    }
    .opportunity-filters {
      display: grid;
      grid-template-columns: minmax(260px, 2fr) repeat(3, minmax(145px, 1fr)) auto;
      gap: 10px;
      align-items: end;
      margin-bottom: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      background: var(--panel);
      box-shadow: var(--soft-shadow);
    }
    .opportunity-filters label {
      margin-bottom: 5px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    select {
      width: 100%;
      height: 42px;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 0 34px 0 11px;
      background: var(--panel-soft);
      color: var(--text);
      font: inherit;
    }
    select:focus {
      border-color: var(--accent);
      outline: 3px solid rgba(20, 184, 166, .18);
    }
    .filter-reset {
      min-height: 42px;
    }
    .professional-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }
    .professional-grid .opportunity-card {
      min-height: 390px;
      padding: 17px;
    }
    .card-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .card-topline .source-badge {
      flex: 0 0 auto;
      margin-top: 0;
    }
    .confidence-badge {
      display: inline-flex;
      align-items: center;
      min-height: 25px;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      padding: 3px 8px;
      background: #f8fafc;
      color: #475569;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .confidence-badge.strong {
      border-color: #86efac;
      background: #f0fdf4;
      color: #166534;
    }
    .confidence-badge.good {
      border-color: #93c5fd;
      background: #eff6ff;
      color: #1d4ed8;
    }
    .confidence-badge.saved {
      border-color: #c4b5fd;
      background: #f5f3ff;
      color: #6d28d9;
    }
    html[data-theme="dark"] .confidence-badge {
      border-color: #475569;
      background: #172033;
      color: #cbd5e1;
    }
    html[data-theme="dark"] .confidence-badge.strong {
      border-color: rgba(52, 211, 153, .45);
      background: rgba(5, 150, 105, .16);
      color: #86efac;
    }
    html[data-theme="dark"] .confidence-badge.good {
      border-color: rgba(96, 165, 250, .45);
      background: rgba(37, 99, 235, .16);
      color: #93c5fd;
    }
    html[data-theme="dark"] .confidence-badge.saved {
      border-color: rgba(167, 139, 250, .45);
      background: rgba(124, 58, 237, .16);
      color: #c4b5fd;
    }
    .opportunity-card-body {
      min-height: 132px;
    }
    .opportunity-card .opportunity-source {
      margin: 14px 0 4px;
      color: var(--accent-dark);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .professional-grid .opportunity-card h3 {
      display: block;
      margin: 0 0 8px;
      overflow: visible;
      font-size: 18px;
      line-height: 1.35;
    }
    .professional-grid .opportunity-card .additional-programs,
    .professional-grid .opportunity-card .announcement-title {
      display: block;
      margin: 0 0 7px;
      overflow: visible;
      font-size: 12px;
      -webkit-line-clamp: unset;
    }
    .professional-grid .focus-list {
      min-height: 30px;
      margin: 4px 0 12px;
    }
    .deadline-block {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 2px 10px;
      align-items: baseline;
      margin-top: auto;
      border: 1px solid var(--line);
      border-left: 4px solid #94a3b8;
      border-radius: 7px;
      padding: 10px 11px;
      background: var(--panel-soft);
    }
    .deadline-block.open {
      border-left-color: var(--green);
      background: var(--green-soft);
    }
    .deadline-block > span {
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .deadline-block > strong {
      justify-self: end;
      color: var(--text);
    }
    .deadline-block > small {
      grid-column: 1 / -1;
      color: var(--muted);
      font-size: 11px;
    }
    .professional-grid .card-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      align-items: center;
      margin-top: 0;
      padding-top: 12px;
    }
    .professional-grid .card-actions form {
      margin: 0;
    }
    .professional-grid .card-actions button {
      width: auto;
      min-height: 36px;
      padding: 7px 11px;
    }
    .action-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 7px 11px;
      background: var(--panel-soft);
      color: var(--text);
      font-size: 12px;
      font-weight: 800;
    }
    .action-link.primary-link {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }
    .action-link:hover {
      text-decoration: none;
      border-color: var(--accent);
    }
    .scan-history-section {
      padding: 0;
      overflow: hidden;
    }
    .scan-history-section .table-heading {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 12px;
    }
    .scan-run-list {
      padding: 0 18px;
    }
    .scan-run {
      display: grid;
      grid-template-columns: minmax(190px, .7fr) minmax(0, 2fr);
      gap: 18px;
      align-items: center;
      border-bottom: 1px solid var(--line);
      padding: 13px 0 13px 13px;
      border-left: 3px solid var(--green);
    }
    .scan-run:last-child {
      border-bottom: 0;
    }
    .scan-run.warning {
      border-left-color: var(--gold);
    }
    .scan-run.running {
      border-left-color: var(--blue);
    }
    .scan-run-title {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .scan-run-title span {
      color: var(--muted);
      font-size: 12px;
    }
    .scan-run dl {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 8px;
      margin: 0;
    }
    .scan-run dl div {
      min-width: 0;
    }
    .scan-run dd {
      margin-top: 2px;
      overflow-wrap: anywhere;
    }
    .source-health {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      width: fit-content;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
    }
    .source-health i {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #94a3b8;
    }
    .source-health.healthy i { background: var(--green); }
    .source-health.unhealthy i { background: var(--danger); }
    .confidence-line {
      margin-top: 5px;
      font-size: 12px;
    }
    [hidden] { display: none !important; }
    @media (max-width: 900px) {
      header, .grid, .secondary-grid { display: block; }
      .header-actions {
        justify-content: flex-start;
        margin-top: 14px;
      }
      .header-actions form,
      .header-actions button,
      .theme-toggle {
        flex: 1 1 150px;
      }
      .row { grid-template-columns: 1fr; }
      main { width: calc(100% - 20px); padding-top: 18px; }
      h1 { font-size: 24px; }
      .topbar { padding: 18px; }
      section { padding: 14px; }
      .notice,
      .status-note,
      .keyword-box,
      p {
        overflow-wrap: anywhere;
      }
      .summary {
        grid-template-columns: 1fr;
      }
      .overview-main {
        grid-template-columns: 1fr;
        padding: 14px;
      }
      .scan-status-grid {
        grid-template-columns: 1fr;
      }
      .whatsapp-web-panel {
        grid-template-columns: 1fr;
      }
      .whatsapp-qr-area {
        min-height: 0;
      }
      .scan-metrics {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .stat-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .priority-header {
        display: block;
        margin-top: 18px;
      }
      .priority-header .muted {
        display: block;
        margin-top: 4px;
      }
      .priority-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .opportunity-filters {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .filter-search {
        grid-column: 1 / -1;
      }
      .scan-run {
        grid-template-columns: 1fr;
        gap: 8px;
      }
      .scan-run dl {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .table-section {
        padding: 0;
        overflow: visible;
      }
      .table-heading { padding: 14px; }
      .table-scroll { overflow: visible; }
      table {
        display: block;
        min-width: 0;
        max-width: 100%;
        font-size: 14px;
      }
      colgroup,
      thead {
        display: none;
      }
      tbody {
        display: block;
        width: 100%;
        padding: 10px;
        background: var(--panel-soft);
        max-width: 100%;
        min-width: 0;
      }
      html[data-theme="dark"] tbody {
        background: var(--panel-soft);
      }
      tr.result-row {
        display: block;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        overflow: hidden;
        max-width: 100%;
        min-width: 0;
        box-shadow: var(--soft-shadow);
      }
      html[data-theme="dark"] tr.result-row {
        background: rgba(17, 24, 39, .9);
      }
      tr.result-row + tr.result-row {
        margin-top: 10px;
      }
      tr.result-row.open-row {
        border-left: 4px solid #12b76a;
      }
      tbody tr:hover td { background: transparent; }
      td {
        display: block;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        border-bottom: 0;
        padding: 9px 12px;
        overflow-wrap: anywhere;
      }
      td * {
        max-width: 100%;
      }
      td > strong,
      td a {
        display: block;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .status-badge {
        display: inline-flex;
      }
      td + td {
        border-top: 1px solid #eef2f6;
      }
      html[data-theme="dark"] td + td {
        border-top-color: rgba(71, 85, 105, .7);
      }
      td::before {
        content: attr(data-label);
        display: block;
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        margin-bottom: 3px;
        text-transform: uppercase;
      }
      td[data-label="Action"]::before {
        display: none;
      }
      td[data-label="Action"] button {
        width: 100%;
      }
      .open-row td:first-child {
        border-left: 0;
        padding-left: 12px;
      }
      .applied-row td:first-child {
        border-left: 0;
        padding-left: 12px;
      }
      .master-list {
        padding-left: 16px;
      }
    }
    @media (max-width: 520px) {
      .stat-grid {
        grid-template-columns: 1fr;
      }
      .priority-grid {
        grid-template-columns: 1fr;
      }
      .opportunity-filters,
      .scan-run dl {
        grid-template-columns: 1fr;
      }
      .filter-search {
        grid-column: auto;
      }
      .filter-reset {
        width: 100%;
      }
      .scan-metrics {
        grid-template-columns: 1fr;
      }
      .whatsapp-connect-form {
        grid-template-columns: 1fr;
      }
      .whatsapp-connect-form button,
      .whatsapp-panel-actions form,
      .whatsapp-panel-actions button {
        width: 100%;
      }
      .opportunity-card {
        min-height: 0;
      }
    }
  </style>
</head>
<body>
  <main>
    <header class="topbar">
      <div>
        <p class="brand-kicker">Morocco academic watchlist</p>
        <h1>English Studies Opportunities</h1>
        <p class="muted">Daily monitor for the ${TARGET_OPPORTUNITY_YEAR}-${TARGET_OPPORTUNITY_YEAR + 1} cycle: English-related Masters, Licences Professionnelles and Licences d'Excellence.</p>
        <div class="header-pills">
          <span class="mini-pill">Schedule ${escapeHtml(config.cronSchedule)}</span>
          <span class="mini-pill">${escapeHtml(config.cronTimezone)}</span>
          <span class="mini-pill">${dashboardStats.enabledSites} active sources</span>
          <span class="mini-pill">${dashboardStats.aggregators} aggregator feeds</span>
        </div>
      </div>
      <div class="header-actions">
        <form method="post" action="/check">
          <button type="submit" ${disabled}>${runningCheck ? '<span class="button-spinner" aria-hidden="true"></span>Scanning' : 'Scan Now'}</button>
        </form>
        <button type="button" class="theme-toggle" data-theme-toggle aria-pressed="false">
          <span class="theme-icon" aria-hidden="true"></span>
          <span data-theme-label>Dark mode</span>
        </button>
        ${isAuthEnabled() ? `
          <form method="post" action="/logout">
            <button type="submit" class="secondary">Logout</button>
          </form>
        ` : ''}
        <form method="post" action="/shutdown">
          <button type="submit" class="danger">Stop Monitor</button>
        </form>
      </div>
    </header>

    ${visibleMessage ? `<div class="notice ${type === 'error' ? 'error' : ''}">${escapeHtml(visibleMessage)}</div>` : ''}
    ${scheduleError ? `<div class="notice error">${escapeHtml(scheduleError)}</div>` : ''}
    ${lastError ? `<div class="notice error">${escapeHtml(lastError)}</div>` : ''}
    ${renderScanProgress(dashboardStats.enabledSites)}
    ${renderLastCheckResult()}
    ${renderDashboardOverview(dashboardStats, telegramStatus, whatsappStatus, whatsappReady)}
    ${renderPriorityOpportunities(opportunityMatches)}
    ${renderScanHistory(scanRuns)}
    ${renderWhatsAppWebPanel(whatsappWebState)}

    <div class="grid">
      <div>
        <section>
          <h2>Websites</h2>
          <form method="post" action="/sites">
            <div class="row">
              <div class="field">
                <label for="url">Website URL</label>
                <input id="url" name="url" type="url" placeholder="https://example.com" required>
              </div>
              <div class="field">
                <label for="name">Name</label>
                <input id="name" name="name" placeholder="University or source name">
              </div>
            </div>
            <button type="submit">Add Website</button>
          </form>
          <form method="post" action="/sites/seed" style="margin-top:10px">
            <button type="submit" class="secondary">Add Starter Websites</button>
          </form>
        </section>

      </div>

      <aside>
        <section>
          <h2>Actions</h2>
          <div class="actions">
            <form method="post" action="/check/reset">
              <button type="submit" class="secondary">Reset Checking State</button>
            </form>
            <form method="post" action="/notify">
              <button type="submit" class="secondary">Send Pending Alerts</button>
            </form>
            <form method="post" action="/telegram/test">
              <button type="submit" class="secondary">Test Telegram</button>
            </form>
            <form method="post" action="/whatsapp/test">
              <button type="submit" class="secondary">Test Meta WhatsApp</button>
            </form>
            <form method="post" action="/whatsapp-web/test">
              <button type="submit" class="secondary" ${isWhatsAppWebReady() ? '' : 'disabled'}>Test QR WhatsApp</button>
            </form>
            <form method="post" action="/notifications/clear">
              <button type="submit" class="secondary">Clear Old Alerts</button>
            </form>
          </div>
        </section>

        <section>
          <h2>Status</h2>
          <p><strong>Telegram:</strong> ${escapeHtml(telegramStatus)}</p>
          <p><strong>WhatsApp:</strong> ${escapeHtml(whatsappStatus)}</p>
          <p><strong>QR sender:</strong> ${escapeHtml(whatsappWebStatusLabel(whatsappWebState))}</p>
          <p><strong>Enabled websites:</strong> ${counts.sites}</p>
          <p><strong>Saved keyword matches:</strong> ${counts.opportunities}</p>
          <p><strong>Year filter:</strong> ${TARGET_OPPORTUNITY_YEAR} only</p>
          <p><strong>Dashboard access:</strong> ${config.webHost === '0.0.0.0' ? 'Network' : 'This PC only'}</p>
          <p><strong>Password:</strong> ${isAuthEnabled() ? 'Enabled' : 'Disabled'}</p>
          <p><strong>Telegram pending:</strong> ${counts.pendingTelegram || 0}</p>
          <p><strong>WhatsApp pending:</strong> ${counts.pendingWhatsapp || 0}</p>
          <p><strong>Applied / done:</strong> ${counts.applied || 0}</p>
          ${renderCurrentState()}
          ${renderSummary()}
        </section>
      </aside>
    </div>

    <section class="table-section">
      <div class="table-heading">
        <h2>Configured Websites</h2>
        <p class="muted status-note">Only ${TARGET_OPPORTUNITY_YEAR} English-related Master, Licence Professionnelle or Licence d'Excellence opportunities are shown here. Open means a future ${TARGET_OPPORTUNITY_YEAR} deadline date was found.</p>
      </div>
      <div class="table-scroll">
        <table>
          <colgroup>
            <col style="width:18%">
            <col style="width:16%">
            <col style="width:23%">
            <col style="width:12%">
            <col style="width:9%">
            <col style="width:10%">
            <col style="width:12%">
          </colgroup>
          <thead>
            <tr><th>Website</th><th>Best Match</th><th>Program Name(s)</th><th>Status</th><th>Deadline</th><th>Last Check</th><th></th></tr>
          </thead>
          <tbody>${renderConfiguredSiteRows(configuredRows)}</tbody>
        </table>
      </div>
    </section>

    <div class="secondary-grid">
      <section>
        <h2>Settings</h2>
        <form method="post" action="/settings">
          <p class="eyebrow">Telegram</p>
          <div class="row">
            <div class="field">
              <label for="telegramBotToken">Telegram Bot Token</label>
              <input id="telegramBotToken" name="telegramBotToken" type="password" placeholder="${isTelegramConfigured() ? 'Saved - leave blank to keep' : 'Paste bot token'}" value="">
            </div>
            <div class="field">
              <label for="telegramChatId">Telegram Chat ID</label>
              <input id="telegramChatId" name="telegramChatId" value="${escapeHtml(config.telegramChatId)}">
            </div>
          </div>
          <p class="eyebrow">WhatsApp Cloud API</p>
          <div class="row">
            <div class="field">
              <label for="whatsappAccessToken">WhatsApp Access Token</label>
              <input id="whatsappAccessToken" name="whatsappAccessToken" type="password" placeholder="${config.whatsappAccessToken ? 'Saved - leave blank to keep' : 'Paste Meta access token'}" value="">
            </div>
            <div class="field">
              <label for="whatsappPhoneNumberId">WhatsApp Phone Number ID</label>
              <input id="whatsappPhoneNumberId" name="whatsappPhoneNumberId" value="${escapeHtml(config.whatsappPhoneNumberId)}">
            </div>
          </div>
          <div class="row">
            <div class="field">
              <label for="whatsappRecipient">Recipient Number (Cloud or QR)</label>
              <input id="whatsappRecipient" name="whatsappRecipient" inputmode="tel" placeholder="212600000000" value="${escapeHtml(config.whatsappRecipient)}">
            </div>
            <div class="field">
              <label for="whatsappGraphVersion">Meta API Version</label>
              <input id="whatsappGraphVersion" name="whatsappGraphVersion" value="${escapeHtml(config.whatsappGraphVersion)}">
            </div>
          </div>
          <div class="row">
            <div class="field">
              <label for="whatsappTemplateName">Approved Alert Template</label>
              <input id="whatsappTemplateName" name="whatsappTemplateName" placeholder="opportunity_alert" value="${escapeHtml(config.whatsappTemplateName)}">
            </div>
            <div class="field">
              <label for="whatsappTemplateLanguage">Template Language</label>
              <input id="whatsappTemplateLanguage" name="whatsappTemplateLanguage" value="${escapeHtml(config.whatsappTemplateLanguage)}">
            </div>
          </div>
          <div class="row">
            <div class="field">
              <label for="cronSchedule">Daily Schedule</label>
              <input id="cronSchedule" name="cronSchedule" value="${escapeHtml(config.cronSchedule)}">
            </div>
            <div class="field">
              <label for="cronTimezone">Timezone</label>
              <input id="cronTimezone" name="cronTimezone" value="${escapeHtml(config.cronTimezone)}">
            </div>
          </div>
          <div class="field">
            <label for="webPort">Dashboard Port</label>
            <input id="webPort" name="webPort" value="${escapeHtml(config.webPort)}">
          </div>
          <div class="field">
            <label for="webHost">Dashboard Host</label>
            <input id="webHost" name="webHost" value="${escapeHtml(config.webHost)}">
          </div>
          <div class="field">
            <label for="dashboardPassword">Dashboard Password</label>
            <input id="dashboardPassword" name="dashboardPassword" type="password" placeholder="${isAuthEnabled() ? 'Saved - leave blank to keep' : 'Set a password before network access'}" value="">
          </div>
          <label><input name="dashboardAuthEnabled" type="checkbox" ${config.dashboardAuthEnabled ? 'checked' : ''} style="width:auto;height:auto;"> Require password to open dashboard</label>
          <label><input name="runOnStart" type="checkbox" ${config.runOnStart ? 'checked' : ''} style="width:auto;height:auto;"> Run check when dashboard starts</label>
          <div style="height:12px"></div>
          <button type="submit">Save Settings</button>
        </form>
      </section>

      <section>
        <h2>Keywords</h2>
        <p class="keyword-box">${escapeHtml(keywords)}</p>
      </section>
    </div>
  </main>
  ${renderThemeToggleScript()}
  ${renderOpportunityFilterScript()}
  ${renderScanStatusScript()}
</body>
</html>`;
}

async function handleGetHome(req, res, scheduleError) {
  const database = await openDatabase();
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const message = requestUrl.searchParams.get('message');
  const type = requestUrl.searchParams.get('type') || 'ok';

  send(
    res,
    200,
    renderPage({
      sites: listSites(database),
      opportunities: listRecentOpportunities(database, 500),
      counts: getCounts(database),
      scanRuns: listRecentScanRuns(database, 8),
      siteScanResults: listLatestSiteScanResults(database),
      message,
      type,
      scheduleError
    })
  );
}

async function handlePost(req, res, server, setScheduleError) {
  const database = await openDatabase();
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const form = await readBody(req);

  if (requestUrl.pathname === '/sites') {
    const url = form.get('url');
    const name = form.get('name');
    addSite(database, { url: new URL(url).toString(), name });
    redirect(res, 'Website saved.');
    return;
  }

  if (requestUrl.pathname === '/sites/remove') {
    const id = Number.parseInt(form.get('id'), 10);
    disableSite(database, id);
    redirect(res, 'Website disabled.');
    return;
  }

  if (requestUrl.pathname === '/sites/seed') {
    const result = seedDefaultSites(database);
    redirect(res, `Starter websites added. ${result.added} new, ${result.total} total.`);
    return;
  }

  if (requestUrl.pathname === '/check') {
    if (runningCheck) {
      redirect(res, 'A check is already running.', 'error');
      return;
    }

    executeCheck().catch((error) => {
      console.error(`Manual check failed: ${error.message}`);
    });
    redirect(res, 'Check started. When it finishes, the result will appear under Last check result.');
    return;
  }

  if (requestUrl.pathname === '/check/reset') {
    resetCheckingState();
    redirect(res, 'Checking state reset. You can click Check Now again if needed.');
    return;
  }

  if (requestUrl.pathname === '/notify') {
    const result = await sendPendingNotifications(database);
    redirect(
      res,
      `Telegram: ${result.telegramSent} sent, ${result.telegramPending} pending. ` +
      `WhatsApp: ${result.whatsappSent} sent, ${result.whatsappPending} pending.`
    );
    return;
  }

  if (requestUrl.pathname === '/telegram/test') {
    await sendTelegramTestMessage();
    redirect(res, 'Telegram test message sent.');
    return;
  }

  if (requestUrl.pathname === '/whatsapp/test') {
    await sendWhatsAppTestMessage();
    redirect(res, 'Meta WhatsApp test message sent.');
    return;
  }

  if (requestUrl.pathname === '/whatsapp-web/connect') {
    const recipient = String(form.get('recipient') || '').replace(/\D/g, '');
    if (recipient.length < 8 || recipient.length > 15) {
      redirect(res, 'Enter your personal WhatsApp number with country code, using digits only.', 'error');
      return;
    }

    saveWhatsAppWebSettings({ enabled: true, recipient });
    startWhatsAppWeb();
    redirect(res, 'WhatsApp QR connection started. The QR code will appear in a few seconds.');
    return;
  }

  if (requestUrl.pathname === '/whatsapp-web/test') {
    await sendWhatsAppWebTestMessage();
    redirect(res, 'QR WhatsApp test notification sent.');
    return;
  }

  if (requestUrl.pathname === '/whatsapp-web/disconnect') {
    await disconnectWhatsAppWeb();
    saveWhatsAppWebSettings({ enabled: false });
    redirect(res, 'QR WhatsApp disconnected.');
    return;
  }

  if (requestUrl.pathname === '/notifications/clear') {
    const cleared = markAllPendingNotified(database);
    redirect(res, `${cleared} old pending alert(s) cleared.`);
    return;
  }

  if (requestUrl.pathname === '/opportunities/done') {
    const id = Number.parseInt(form.get('id'), 10);
    if (!Number.isFinite(id)) {
      redirect(res, 'Opportunity not found.', 'error');
      return;
    }

    const marked = markOpportunityApplied(database, id);
    redirect(
      res,
      marked ? 'Opportunity marked done. It will not stay pending for Telegram or WhatsApp.' : 'Opportunity not found.',
      marked ? 'ok' : 'error'
    );
    return;
  }

  if (requestUrl.pathname === '/opportunities/undo') {
    const id = Number.parseInt(form.get('id'), 10);
    if (!Number.isFinite(id)) {
      redirect(res, 'Opportunity not found.', 'error');
      return;
    }

    const unmarked = unmarkOpportunityApplied(database, id);
    redirect(res, unmarked ? 'Done status removed.' : 'Opportunity not found.', unmarked ? 'ok' : 'error');
    return;
  }

  if (requestUrl.pathname === '/settings') {
    const submittedToken = String(form.get('telegramBotToken') || '').trim();
    const submittedWhatsAppToken = String(form.get('whatsappAccessToken') || '').trim();
    const submittedPassword = String(form.get('dashboardPassword') || '').trim();

    saveRuntimeSettings({
      telegramBotToken: submittedToken || config.telegramBotToken,
      telegramChatId: form.get('telegramChatId'),
      whatsappAccessToken: submittedWhatsAppToken || config.whatsappAccessToken,
      whatsappPhoneNumberId: form.get('whatsappPhoneNumberId'),
      whatsappRecipient: form.get('whatsappRecipient'),
      whatsappGraphVersion: form.get('whatsappGraphVersion'),
      whatsappTemplateName: form.get('whatsappTemplateName'),
      whatsappTemplateLanguage: form.get('whatsappTemplateLanguage'),
      whatsappWebEnabled: config.whatsappWebEnabled,
      cronSchedule: form.get('cronSchedule'),
      cronTimezone: form.get('cronTimezone'),
      webPort: form.get('webPort'),
      webHost: form.get('webHost'),
      dashboardAuthEnabled: form.get('dashboardAuthEnabled') === 'on',
      dashboardPassword: submittedPassword || config.dashboardPassword,
      runOnStart: form.get('runOnStart') === 'on'
    });

    const newScheduleError = scheduleChecks();
    setScheduleError(newScheduleError);
    redirect(res, newScheduleError || 'Settings saved.', newScheduleError ? 'error' : 'ok');
    return;
  }

  if (requestUrl.pathname === '/shutdown') {
    send(res, 200, '<!doctype html><title>Stopped</title><p>Monitor stopped. You can close this tab.</p>');
    setTimeout(async () => {
      cronTask?.stop();
      await shutdownWhatsAppWeb();
      server.close(() => process.exit(0));
    }, 250);
    return;
  }

  send(res, 404, 'Not found', 'text/plain; charset=utf-8');
}

export async function startWebDashboard() {
  loadLastSummary();
  const database = await openDatabase();
  if (listSites(database).length === 0) {
    const result = seedDefaultSites(database);
    console.log(`Auto-added ${result.added} starter websites.`);
  }
  let scheduleError = scheduleChecks();
  const host = config.webHost || '127.0.0.1';
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host}`);

      if (isAuthEnabled()) {
        if (req.method === 'GET' && requestUrl.pathname === '/login') {
          send(
            res,
            200,
            renderLoginPage({
              message: requestUrl.searchParams.get('message'),
              type: requestUrl.searchParams.get('type') || 'ok'
            })
          );
          return;
        }

        if (req.method === 'POST' && requestUrl.pathname === '/login') {
          const form = await readBody(req);
          if (passwordMatches(form.get('password'))) {
            redirectTo(res, '/', { 'Set-Cookie': createAuthCookie() });
          } else {
            redirectTo(res, '/login?message=Wrong%20password&type=error');
          }
          return;
        }

        if (req.method === 'POST' && requestUrl.pathname === '/logout') {
          redirectTo(res, '/login?message=Logged%20out', { 'Set-Cookie': clearAuthCookie() });
          return;
        }

        if (!isAuthorized(req)) {
          redirectTo(res, '/login');
          return;
        }
      } else if (requestUrl.pathname === '/login') {
        redirectTo(res, '/');
        return;
      }

      if (req.method === 'GET' && req.url.startsWith('/')) {
        await handleGetHome(req, res, scheduleError);
        return;
      }

      if (req.method === 'POST') {
        await handlePost(req, res, server, (value) => {
          scheduleError = value;
        });
        return;
      }

      send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
    } catch (error) {
      send(res, 500, error.message, 'text/plain; charset=utf-8');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.webPort, host, resolve);
  });

  const localUrl = `http://127.0.0.1:${config.webPort}/`;
  console.log(`Dashboard: ${localUrl}`);
  if (host === '0.0.0.0') {
    for (const networkUrl of getNetworkUrls(config.webPort)) {
      console.log(`Network dashboard: ${networkUrl}`);
    }
  }
  if (config.openBrowser) {
    openBrowser(localUrl);
  }

  if (config.whatsappWebEnabled) {
    startWhatsAppWeb();
  }

  if (config.runOnStart) {
    setTimeout(() => {
      executeCheck().catch((error) => {
        console.error(`Startup check failed: ${error.message}`);
      });
    }, 500);
  }
}
