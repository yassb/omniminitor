import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function loadEnvFile() {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

function numberFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function booleanFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function resolveFromRoot(value) {
  if (!value) return path.join(rootDir, 'data', 'opportunities.sqlite');
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

export const config = {
  rootDir,
  databasePath: resolveFromRoot(process.env.DATABASE_PATH),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? '',
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
  whatsappRecipient: process.env.WHATSAPP_RECIPIENT ?? '',
  whatsappGraphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? 'v23.0',
  whatsappTemplateName: process.env.WHATSAPP_TEMPLATE_NAME ?? '',
  whatsappTemplateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? 'en_US',
  whatsappWebEnabled: booleanFromEnv('WHATSAPP_WEB_ENABLED', false),
  notificationsEnabled: booleanFromEnv('NOTIFICATIONS_ENABLED', true),
  cronSchedule: process.env.CRON_SCHEDULE ?? '0 8 * * *',
  cronTimezone: process.env.CRON_TIMEZONE ?? 'Africa/Casablanca',
  runOnStart: booleanFromEnv('RUN_ON_START', true),
  requestTimeoutMs: numberFromEnv('REQUEST_TIMEOUT_MS', 45_000),
  maxCandidatesPerSite: numberFromEnv('MAX_CANDIDATES_PER_SITE', 100),
  maxPagesPerSite: numberFromEnv('MAX_PAGES_PER_SITE', 8),
  crawlerConcurrency: numberFromEnv('CRAWLER_CONCURRENCY', 3),
  childRequestTimeoutMs: numberFromEnv('CHILD_REQUEST_TIMEOUT_MS', 15_000),
  maxHtmlBytes: numberFromEnv('MAX_HTML_BYTES', 4_000_000),
  maxPdfBytes: numberFromEnv('MAX_PDF_BYTES', 10_000_000),
  maxPdfPages: numberFromEnv('MAX_PDF_PAGES', 30),
  aggregatorFeedEntries: numberFromEnv('AGGREGATOR_FEED_ENTRIES', 100),
  webPort: numberFromEnv('WEB_PORT', 3077),
  webHost: process.env.WEB_HOST ?? '127.0.0.1',
  dashboardAuthEnabled: booleanFromEnv('DASHBOARD_AUTH_ENABLED', true),
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? '',
  openBrowser: booleanFromEnv('OPEN_BROWSER', true)
};

function cleanEnvValue(value) {
  return String(value ?? '').replace(/[\r\n]/g, '').trim();
}

function writeEnvValues(updates) {
  const envPath = path.join(rootDir, '.env');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/) : [];
  const handled = new Set();

  const lines = existing.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)\s*=/);
    if (!match || !(match[1] in updates)) return line;

    handled.add(match[1]);
    return `${match[1]}=${cleanEnvValue(updates[match[1]])}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!handled.has(key)) {
      lines.push(`${key}=${cleanEnvValue(value)}`);
    }
  }

  fs.writeFileSync(envPath, `${lines.filter((line) => line !== undefined).join('\n').trim()}\n`);
}

export function saveRuntimeSettings(settings) {
  const updates = {
    TELEGRAM_BOT_TOKEN: settings.telegramBotToken,
    TELEGRAM_CHAT_ID: settings.telegramChatId,
    WHATSAPP_ACCESS_TOKEN: settings.whatsappAccessToken,
    WHATSAPP_PHONE_NUMBER_ID: settings.whatsappPhoneNumberId,
    WHATSAPP_RECIPIENT: settings.whatsappRecipient,
    WHATSAPP_GRAPH_VERSION: settings.whatsappGraphVersion,
    WHATSAPP_TEMPLATE_NAME: settings.whatsappTemplateName,
    WHATSAPP_TEMPLATE_LANGUAGE: settings.whatsappTemplateLanguage,
    WHATSAPP_WEB_ENABLED: settings.whatsappWebEnabled ? 'true' : 'false',
    CRON_SCHEDULE: settings.cronSchedule,
    CRON_TIMEZONE: settings.cronTimezone,
    RUN_ON_START: settings.runOnStart ? 'true' : 'false',
    WEB_PORT: settings.webPort,
    WEB_HOST: settings.webHost,
    DASHBOARD_AUTH_ENABLED: settings.dashboardAuthEnabled ? 'true' : 'false',
    DASHBOARD_PASSWORD: settings.dashboardPassword
  };

  config.telegramBotToken = cleanEnvValue(settings.telegramBotToken);
  config.telegramChatId = cleanEnvValue(settings.telegramChatId);
  config.whatsappAccessToken = cleanEnvValue(settings.whatsappAccessToken);
  config.whatsappPhoneNumberId = cleanEnvValue(settings.whatsappPhoneNumberId);
  config.whatsappRecipient = cleanEnvValue(settings.whatsappRecipient);
  config.whatsappGraphVersion = cleanEnvValue(settings.whatsappGraphVersion) || 'v23.0';
  config.whatsappTemplateName = cleanEnvValue(settings.whatsappTemplateName);
  config.whatsappTemplateLanguage = cleanEnvValue(settings.whatsappTemplateLanguage) || 'en_US';
  config.whatsappWebEnabled = Boolean(settings.whatsappWebEnabled);
  config.cronSchedule = cleanEnvValue(settings.cronSchedule) || '0 8 * * *';
  config.cronTimezone = cleanEnvValue(settings.cronTimezone) || 'Africa/Casablanca';
  config.runOnStart = Boolean(settings.runOnStart);
  config.webPort = Number.parseInt(settings.webPort, 10) || 3077;
  config.webHost = cleanEnvValue(settings.webHost) || '127.0.0.1';
  config.dashboardAuthEnabled = Boolean(settings.dashboardAuthEnabled);
  config.dashboardPassword = cleanEnvValue(settings.dashboardPassword);

  writeEnvValues(updates);
}

export function saveWhatsAppWebSettings({ enabled, recipient = config.whatsappRecipient }) {
  config.whatsappWebEnabled = Boolean(enabled);
  config.whatsappRecipient = cleanEnvValue(recipient);
  writeEnvValues({
    WHATSAPP_WEB_ENABLED: config.whatsappWebEnabled ? 'true' : 'false',
    WHATSAPP_RECIPIENT: config.whatsappRecipient
  });
}
