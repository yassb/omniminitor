import {
  finishScanRun,
  getCounts,
  listPendingNotifications,
  listSites,
  markOpportunityNotified,
  openDatabase,
  recordSiteScanResult,
  saveOpportunity,
  startScanRun,
  updateSiteCheck
} from './db.js';
import { hasTargetYearSignal, TARGET_OPPORTUNITY_YEAR } from './opportunityFilter.js';
import { findOpportunitiesForSite } from './scraper.js';
import { isTelegramConfigured, sendOpportunityAlert } from './telegram.js';
import {
  buildWhatsAppDigestBatches,
  isWhatsAppConfigured,
  sendWhatsAppMessage,
  sendWhatsAppOpportunityAlert
} from './whatsapp.js';
import {
  isWhatsAppWebReady,
  sendWhatsAppWebMessage,
  sendWhatsAppWebOpportunityAlert
} from './whatsappWeb.js';
import { config } from './config.js';

async function sendWhatsAppAlert(opportunity) {
  if (isWhatsAppWebReady()) {
    await sendWhatsAppWebOpportunityAlert(opportunity);
    return;
  }
  await sendWhatsAppOpportunityAlert(opportunity);
}

async function sendWhatsAppDigestMessage(text) {
  if (isWhatsAppWebReady()) {
    await sendWhatsAppWebMessage(text);
    return;
  }
  await sendWhatsAppMessage(text);
}

async function sendChannelNotifications({
  database,
  channel,
  configured,
  sendAlert
}) {
  const pending = listPendingNotifications(database, channel);
  const allowedPending = pending.filter(hasTargetYearSignal);
  const ignoredPending = pending.filter((opportunity) => !hasTargetYearSignal(opportunity));

  for (const opportunity of ignoredPending) {
    markOpportunityNotified(database, opportunity.id, channel);
  }

  if (allowedPending.length === 0) {
    return { sent: 0, pending: 0, error: null };
  }

  if (!configured) {
    console.warn(
      `${channel === 'telegram' ? 'Telegram' : 'WhatsApp'} is not configured. ` +
      `${allowedPending.length} notification(s) remain pending for this channel.`
    );
    return { sent: 0, pending: allowedPending.length, error: null };
  }

  let sent = 0;
  let error = null;
  for (const opportunity of allowedPending) {
    try {
      await sendAlert(opportunity);
      markOpportunityNotified(database, opportunity.id, channel);
      sent += 1;
    } catch (sendError) {
      error = sendError.message;
      console.error(`${channel} notification failed: ${error}`);
      break;
    }
  }

  return {
    sent,
    pending: listPendingNotifications(database, channel).filter(hasTargetYearSignal).length,
    error
  };
}

async function sendWhatsAppNotifications(database) {
  const pending = listPendingNotifications(database, 'whatsapp');
  const allowedPending = pending.filter(hasTargetYearSignal);
  const ignoredPending = pending.filter((opportunity) => !hasTargetYearSignal(opportunity));

  for (const opportunity of ignoredPending) {
    markOpportunityNotified(database, opportunity.id, 'whatsapp');
  }

  if (allowedPending.length === 0) {
    return { sent: 0, pending: 0, error: null };
  }

  if (!isWhatsAppWebReady() && !isWhatsAppConfigured()) {
    console.warn(
      `WhatsApp is not configured. ${allowedPending.length} notification(s) remain pending.`
    );
    return { sent: 0, pending: allowedPending.length, error: null };
  }

  // Approved Cloud API templates have a fixed parameter layout, so keep their
  // existing one-opportunity-per-message behavior. QR WhatsApp and Cloud text
  // messages use compact deadline-sorted digests.
  if (!isWhatsAppWebReady() && config.whatsappTemplateName) {
    return sendChannelNotifications({
      database,
      channel: 'whatsapp',
      configured: true,
      sendAlert: sendWhatsAppAlert
    });
  }

  let sent = 0;
  let error = null;
  const batches = buildWhatsAppDigestBatches(allowedPending);

  for (const batch of batches) {
    try {
      await sendWhatsAppDigestMessage(batch.text);
      for (const opportunity of batch.opportunities) {
        markOpportunityNotified(database, opportunity.id, 'whatsapp');
        sent += 1;
      }
    } catch (sendError) {
      error = sendError.message;
      console.error(`whatsapp notification failed: ${error}`);
      break;
    }
  }

  return {
    sent,
    pending: listPendingNotifications(database, 'whatsapp').filter(hasTargetYearSignal).length,
    error
  };
}

export async function sendPendingNotifications(database = openDatabase()) {
  database = await database;
  const telegram = await sendChannelNotifications({
    database,
    channel: 'telegram',
    configured: isTelegramConfigured(),
    sendAlert: sendOpportunityAlert
  });
  const whatsapp = await sendWhatsAppNotifications(database);

  return {
    sent: telegram.sent + whatsapp.sent,
    pending: telegram.pending + whatsapp.pending,
    telegramSent: telegram.sent,
    telegramPending: telegram.pending,
    whatsappSent: whatsapp.sent,
    whatsappPending: whatsapp.pending,
    errors: [
      ...(telegram.error ? [{ channel: 'Telegram', error: telegram.error }] : []),
      ...(whatsapp.error ? [{ channel: 'WhatsApp', error: whatsapp.error }] : [])
    ]
  };
}

export async function runChecks({
  notify = config.notificationsEnabled,
  onProgress,
  trigger = 'manual'
} = {}) {
  const startedAt = Date.now();
  const database = await openDatabase();
  const sites = listSites(database, { enabledOnly: true });
  const scanId = startScanRun(database, { trigger, sitesTotal: sites.length });
  let completedSites = 0;
  const summary = {
    sitesChecked: 0,
    matchesFound: 0,
    newOpportunities: 0,
    errors: []
  };

  function reportProgress(update) {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({
        phase: 'checking',
        completedSites,
        totalSites: sites.length,
        currentSiteName: '',
        matchesFound: summary.matchesFound,
        newOpportunities: summary.newOpportunities,
        errorsCount: summary.errors.length,
        ...update
      });
    } catch {
      // UI progress reporting must never interrupt a scheduled scan.
    }
  }

  reportProgress({ phase: 'starting' });

  if (sites.length === 0) {
    console.log('No enabled websites yet. Add one with: npm run add -- https://example.com "Name"');
  }

  for (const site of sites) {
    const siteStartedAt = Date.now();
    console.log(`Checking ${site.name || site.url}...`);
    reportProgress({ currentSiteName: site.name || site.url });

    try {
      const opportunities = await findOpportunitiesForSite(site);
      const targetYearOpportunities = opportunities.filter(hasTargetYearSignal);
      summary.matchesFound += targetYearOpportunities.length;

      let newForSite = 0;
      for (const opportunity of targetYearOpportunities) {
        const result = saveOpportunity(database, opportunity);
        if (result.isNew) {
          summary.newOpportunities += 1;
          newForSite += 1;
        }
      }

      updateSiteCheck(database, site.id, {
        status: `ok: ${targetYearOpportunities.length} ${TARGET_OPPORTUNITY_YEAR} match(es), ${newForSite} new`
      });
      recordSiteScanResult(database, {
        scanId,
        siteId: site.id,
        status: 'ok',
        matchesFound: targetYearOpportunities.length,
        newOpportunities: newForSite,
        durationMs: Date.now() - siteStartedAt
      });

      console.log(
        `Found ${targetYearOpportunities.length} ${TARGET_OPPORTUNITY_YEAR} matching item(s), ${newForSite} new.`
      );
    } catch (error) {
      const message = error.response?.status
        ? `HTTP ${error.response.status}`
        : error.message;

      summary.errors.push({ site: site.url, error: message });
      updateSiteCheck(database, site.id, { status: 'error', error: message });
      recordSiteScanResult(database, {
        scanId,
        siteId: site.id,
        status: 'error',
        durationMs: Date.now() - siteStartedAt,
        error: message
      });
      console.error(`Failed to check ${site.url}: ${message}`);
    } finally {
      completedSites += 1;
      summary.sitesChecked = completedSites;
      reportProgress({
        currentSiteName: site.name || site.url,
        matchesFound: summary.matchesFound,
        newOpportunities: summary.newOpportunities,
        errorsCount: summary.errors.length
      });
    }
  }

  const counts = getCounts(database);
  let notificationSummary = {
    sent: 0,
    pending: counts.pendingTelegram + counts.pendingWhatsapp,
    telegramSent: 0,
    telegramPending: counts.pendingTelegram,
    whatsappSent: 0,
    whatsappPending: counts.pendingWhatsapp,
    errors: []
  };
  if (notify) {
    reportProgress({ phase: 'notifying', currentSiteName: '' });
    notificationSummary = await sendPendingNotifications(database);
  }

  const durationMs = Date.now() - startedAt;
  const completedSummary = {
    ...summary,
    notificationsSent: notificationSummary.sent,
    notificationsPending: notificationSummary.pending,
    telegramSent: notificationSummary.telegramSent,
    telegramPending: notificationSummary.telegramPending,
    whatsappSent: notificationSummary.whatsappSent,
    whatsappPending: notificationSummary.whatsappPending,
    notificationErrors: notificationSummary.errors,
    durationMs,
    scanId
  };

  finishScanRun(database, scanId, completedSummary);
  reportProgress({
    phase: 'complete',
    currentSiteName: '',
    matchesFound: summary.matchesFound,
    newOpportunities: summary.newOpportunities,
    errorsCount: summary.errors.length
  });

  return completedSummary;
}
