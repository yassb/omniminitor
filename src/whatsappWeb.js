import fs from 'node:fs';
import path from 'node:path';
import whatsappWeb from 'whatsapp-web.js';
import QRCode from 'qrcode';
import { config } from './config.js';
import { formatWhatsAppOpportunityMessage } from './whatsapp.js';

const { Client, LocalAuth } = whatsappWeb;

let client;
let initializePromise;
let status = 'disconnected';
let qrDataUrl = '';
let lastError = '';
let connectedNumber = '';
let updatedAt = new Date();
let startupTimer;

const whatsappUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function clearStartupTimer() {
  if (!startupTimer) return;
  clearTimeout(startupTimer);
  startupTimer = undefined;
}

function updateState(nextStatus, updates = {}) {
  status = nextStatus;
  if ('qrDataUrl' in updates) qrDataUrl = updates.qrDataUrl;
  if ('lastError' in updates) lastError = updates.lastError;
  if ('connectedNumber' in updates) connectedNumber = updates.connectedNumber;
  updatedAt = new Date();
}

function browserExecutablePath() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function recipientChatId() {
  const digits = String(config.whatsappRecipient ?? '').replace(/\D/g, '');
  if (!digits) {
    throw new Error('Add your personal WhatsApp recipient number before sending a test.');
  }
  return `${digits}@c.us`;
}

export function getWhatsAppWebState() {
  return {
    enabled: config.whatsappWebEnabled,
    status,
    qrDataUrl,
    lastError,
    connectedNumber,
    updatedAt: updatedAt.toISOString(),
    ready: status === 'ready'
  };
}

export function isWhatsAppWebReady() {
  return status === 'ready' && Boolean(client);
}

export function startWhatsAppWeb() {
  if (initializePromise || isWhatsAppWebReady()) return getWhatsAppWebState();

  const executablePath = browserExecutablePath();
  if (!executablePath) {
    updateState('error', {
      lastError: 'Google Chrome or Microsoft Edge is required for QR WhatsApp.'
    });
    return getWhatsAppWebState();
  }

  updateState('starting', { qrDataUrl: '', lastError: '', connectedNumber: '' });
  client = new Client({
    authTimeoutMs: 60_000,
    userAgent: whatsappUserAgent,
    authStrategy: new LocalAuth({
      clientId: 'opportunity-monitor',
      dataPath: path.join(config.rootDir, 'data', 'whatsapp-web-session')
    }),
    puppeteer: {
      headless: true,
      executablePath,
      args: [
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    }
  });

  client.on('qr', async (qr) => {
    clearStartupTimer();
    try {
      const image = await QRCode.toDataURL(qr, {
        width: 360,
        margin: 1,
        errorCorrectionLevel: 'M'
      });
      updateState('qr', { qrDataUrl: image, lastError: '' });
    } catch (error) {
      updateState('error', { lastError: `Could not render QR code: ${error.message}` });
    }
  });

  client.on('authenticated', () => {
    clearStartupTimer();
    updateState('authenticated', { qrDataUrl: '', lastError: '' });
  });

  client.on('ready', () => {
    clearStartupTimer();
    updateState('ready', {
      qrDataUrl: '',
      lastError: '',
      connectedNumber: client.info?.wid?.user || ''
    });
  });

  client.on('auth_failure', async (message) => {
    clearStartupTimer();
    const failedClient = client;
    client = undefined;
    initializePromise = undefined;
    updateState('error', { qrDataUrl: '', lastError: `Authentication failed: ${message}` });
    if (failedClient) await failedClient.destroy().catch(() => {});
  });

  client.on('disconnected', (reason) => {
    clearStartupTimer();
    updateState('disconnected', {
      qrDataUrl: '',
      lastError: reason ? `Disconnected: ${reason}` : ''
    });
    initializePromise = undefined;
    client = undefined;
  });

  initializePromise = client.initialize().catch((error) => {
    clearStartupTimer();
    const failedClient = client;
    updateState('error', { qrDataUrl: '', lastError: error.message });
    initializePromise = undefined;
    client = undefined;
    if (failedClient) failedClient.destroy().catch(() => {});
  });

  startupTimer = setTimeout(async () => {
    if (!['starting', 'authenticated'].includes(status)) return;
    const stalledClient = client;
    client = undefined;
    initializePromise = undefined;
    updateState('error', {
      qrDataUrl: '',
      lastError: 'WhatsApp QR startup timed out. Click Connect by QR to try again.'
    });
    if (stalledClient) await stalledClient.destroy().catch(() => {});
  }, 75_000);

  return getWhatsAppWebState();
}

export async function disconnectWhatsAppWeb() {
  clearStartupTimer();
  const activeClient = client;
  client = undefined;
  initializePromise = undefined;

  if (activeClient) {
    await activeClient.logout().catch(async () => {
      await activeClient.destroy().catch(() => {});
    });
  }

  updateState('disconnected', { qrDataUrl: '', lastError: '', connectedNumber: '' });
}

export async function shutdownWhatsAppWeb() {
  clearStartupTimer();
  if (!client) return;
  const activeClient = client;
  client = undefined;
  initializePromise = undefined;
  await activeClient.destroy().catch(() => {});
  updateState('disconnected', { qrDataUrl: '', connectedNumber: '' });
}

export async function sendWhatsAppWebMessage(text) {
  if (!isWhatsAppWebReady()) {
    throw new Error('QR WhatsApp is not connected yet. Scan the QR code first.');
  }
  await client.sendMessage(recipientChatId(), String(text));
}

export async function sendWhatsAppWebOpportunityAlert(opportunity) {
  await sendWhatsAppWebMessage(formatWhatsAppOpportunityMessage(opportunity));
}

export async function sendWhatsAppWebTestMessage() {
  await sendWhatsAppWebMessage('Opportunity Monitor test message. QR WhatsApp is working.');
}
