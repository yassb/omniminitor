# Opportunity Monitor

A small Node.js service that checks configured websites every day, stores seen opportunities in SQLite, and sends Telegram or WhatsApp alerts for new matches.

## Free Cloud Website

The `cloud/` dashboard is designed for GitHub Pages. A GitHub Actions workflow
scans all configured sources every morning, refreshes the public opportunity
data, and sends Telegram alerts for genuinely new matches. It continues working
when the local PC is off.

See [CLOUD-DEPLOYMENT.md](CLOUD-DEPLOYMENT.md) for the deployment details.
WhatsApp QR alerts remain local because they require a continuously connected
browser session.

## Setup

```powershell
cd "C:\Users\dell\Codex Projects\opportunity-monitor"
npm install
Copy-Item .env.example .env
```

Edit `.env` and add:

- `TELEGRAM_BOT_TOKEN`: token from BotFather.
- `TELEGRAM_CHAT_ID`: your Telegram chat ID.
- `WHATSAPP_ACCESS_TOKEN`: access token from Meta's WhatsApp Cloud API setup.
- `WHATSAPP_PHONE_NUMBER_ID`: sending phone number ID from Meta.
- `WHATSAPP_RECIPIENT`: destination WhatsApp number with country code and digits only.
- `WHATSAPP_GRAPH_VERSION`: Meta Graph API version. Default is `v23.0`.
- `WHATSAPP_TEMPLATE_NAME`: optional approved alert template with four body variables: title, site, program details, and URL.
- `WHATSAPP_TEMPLATE_LANGUAGE`: approved template language. Default is `en_US`.
- `WHATSAPP_WEB_ENABLED`: restores a locally saved QR-linked WhatsApp Web session on startup.
- `CRON_SCHEDULE`: cron expression for the daily run. Default is `0 8 * * *`.
- `CRON_TIMEZONE`: default is `Africa/Casablanca`.
- `WEB_HOST`: use `127.0.0.1` for this PC only, or `0.0.0.0` for access from other devices on the same Wi-Fi.
- `DASHBOARD_PASSWORD`: password required before anyone can use the dashboard.

The local scheduler only runs while this Node process is running. The GitHub
Actions cloud scanner is the always-on option.

## Commands

## No Terminal

Double-click `Start Monitor Dashboard Hidden.vbs` to start the monitor and open the browser dashboard without a terminal window.

Use `Open Dashboard.url` if the monitor is already running.

If the dashboard does not open after a few seconds, check `logs\dashboard.log`.

The dashboard lets you add websites, save Telegram and WhatsApp settings, run a check now, send pending alerts, and stop the monitor.

## WhatsApp QR Sender

Enter your personal recipient number in the WhatsApp QR Sender panel and click `Connect by QR`. Scan the displayed code using the second sender account under WhatsApp `Linked devices`. The linked session is stored locally under `data/whatsapp-web-session` and is restored when the monitor starts.

The QR sender uses the unofficial `whatsapp-web.js` library. WhatsApp updates can occasionally require pairing the account again. The monitor and this PC must remain running to send QR-based alerts.

If no websites are configured, the dashboard automatically adds a starter list of Moroccan university and admission pages. You can also click `Add Starter Websites`.

## Access From Another Device

Set `WEB_HOST=0.0.0.0` and set `DASHBOARD_PASSWORD` in `.env`, then restart the dashboard. On the same Wi-Fi, open:

```text
http://YOUR_PC_IP:3077/
```

For access from outside your Wi-Fi, use a tunnel service or router port forwarding. Keep the dashboard password enabled before exposing it.

## Terminal Commands

Add a website:

```powershell
npm run add -- https://www.example.ma "Example University"
```

List websites:

```powershell
npm run list
```

Run one manual check:

```powershell
npm run check
```

Start the daily scheduler:

```powershell
npm start
```

Remove a website by ID:

```powershell
npm run remove -- 1
```

Show monitored keywords:

```powershell
npm run keywords
```

## Keywords

The app searches for:

`Master`, `Licence Professionnelle`, `Licence d'Excellence`, `English Studies`, `Linguistics`, `Translation`, `Communication`, `Didactics`, `Tourism`, `Culture`, `Media`.

Matching is case-insensitive and tolerant of accents and curly apostrophes.
