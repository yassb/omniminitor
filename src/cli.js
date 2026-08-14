import cron from 'node-cron';
import { config } from './config.js';
import {
  addSite,
  disableSite,
  getCounts,
  listSites,
  openDatabase
} from './db.js';
import { seedDefaultSites } from './defaultSites.js';
import { listKeywordLabels } from './keywords.js';
import { runChecks, sendPendingNotifications } from './monitor.js';
import { startWebDashboard } from './web.js';

function printHelp() {
  console.log(`
Opportunity Monitor

Commands:
  start                         Start the daily scheduler
  web                           Start the local browser dashboard
  check                         Run one website check now
  add <url> [name]              Add or re-enable a website
  seed                          Add the built-in starter website list
  list                          List configured websites
  remove <id>                   Disable a website
  notify                        Send pending Telegram and WhatsApp notifications
  keywords                      Print monitored keywords
  help                          Show this help
`);
}

function parseUrl(value) {
  try {
    const url = new URL(value);
    return url.toString();
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }
}

function printSummary(summary) {
  console.log('');
  console.log('Summary');
  console.log(`Sites checked: ${summary.sitesChecked}`);
  console.log(`Matches found: ${summary.matchesFound}`);
  console.log(`New opportunities: ${summary.newOpportunities}`);
  console.log(`Telegram messages sent: ${summary.telegramSent || 0}`);
  console.log(`WhatsApp messages sent: ${summary.whatsappSent || 0}`);
  console.log(`Pending notifications: ${summary.notificationsPending || 0}`);

  if (summary.errors.length > 0) {
    console.log(`Errors: ${summary.errors.length}`);
  }
}

async function startScheduler() {
  const database = await openDatabase();

  if (!cron.validate(config.cronSchedule)) {
    throw new Error(`Invalid CRON_SCHEDULE: ${config.cronSchedule}`);
  }

  const counts = getCounts(database);
  console.log(`Database: ${config.databasePath}`);
  console.log(`Enabled websites: ${counts.sites}`);
  console.log(`Schedule: ${config.cronSchedule} (${config.cronTimezone})`);

  if (config.runOnStart) {
    printSummary(await runChecks({ trigger: 'startup' }));
  } else {
    await sendPendingNotifications(database);
  }

  cron.schedule(
    config.cronSchedule,
    async () => {
      try {
        console.log(`\nScheduled check started at ${new Date().toISOString()}`);
        printSummary(await runChecks({ trigger: 'scheduled' }));
      } catch (error) {
        console.error(`Scheduled check failed: ${error.message}`);
      }
    },
    {
      timezone: config.cronTimezone
    }
  );

  console.log('Scheduler is running. Press Ctrl+C to stop.');
}

export async function dispatch(argv) {
  const [command = 'help', ...args] = argv;

  switch (command) {
    case 'start':
      await startScheduler();
      break;

    case 'web':
      await startWebDashboard();
      break;

    case 'check':
      printSummary(await runChecks({ trigger: 'manual' }));
      break;

    case 'add': {
      const database = await openDatabase();
      if (!args[0]) {
        throw new Error('Usage: npm run add -- <url> [name]');
      }

      const url = parseUrl(args[0]);
      const name = args.slice(1).join(' ').trim();
      const site = addSite(database, { url, name });
      console.log(`Website saved: #${site.id} ${site.name || site.url}`);
      break;
    }

    case 'seed': {
      const database = await openDatabase();
      const result = seedDefaultSites(database);
      console.log(`Starter websites ready: ${result.total}`);
      console.log(`New websites added: ${result.added}`);
      break;
    }

    case 'list': {
      const database = await openDatabase();
      const sites = listSites(database);
      if (sites.length === 0) {
        console.log('No websites configured.');
        break;
      }

      for (const site of sites) {
        const enabled = site.enabled ? 'enabled' : 'disabled';
        const checked = site.last_checked_at || 'never';
        const name = site.name ? ` - ${site.name}` : '';
        console.log(`#${site.id} [${enabled}] ${site.url}${name}`);
        console.log(`   last checked: ${checked}; status: ${site.last_status || 'none'}`);
        if (site.last_error) console.log(`   error: ${site.last_error}`);
      }
      break;
    }

    case 'remove': {
      const database = await openDatabase();
      const id = Number.parseInt(args[0] ?? '', 10);
      if (!Number.isInteger(id)) {
        throw new Error('Usage: npm run remove -- <id>');
      }

      const removed = disableSite(database, id);
      console.log(removed ? `Website #${id} disabled.` : `Website #${id} was not found.`);
      break;
    }

    case 'notify': {
      const database = await openDatabase();
      const result = await sendPendingNotifications(database);
      console.log(`Telegram messages sent: ${result.telegramSent}`);
      console.log(`WhatsApp messages sent: ${result.whatsappSent}`);
      console.log(`Pending notifications: ${result.pending}`);
      break;
    }

    case 'keywords':
      console.log(listKeywordLabels().join('\n'));
      break;

    case 'help':
    default:
      printHelp();
      break;
  }
}
