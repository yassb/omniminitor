# Free cloud website

The `cloud/` folder is a public, read-only edition of the opportunity monitor.
GitHub Pages hosts the dashboard and GitHub Actions runs the scanner every day
at 08:17 in the `Africa/Casablanca` timezone.

## Included

- Public dashboard that works while the local PC is off
- Daily Arabic, French, and English opportunity scan
- Official and discovery links
- Search, status, programme, and source filters
- Device-local Done tracking and dark mode
- Source health and scan history
- Telegram alerts for newly discovered opportunities

## Local-only features

WhatsApp QR needs a persistent browser session and cannot run inside a GitHub
Actions job. The local dashboard can continue providing WhatsApp QR alerts.
Website settings and source editing are also kept local so a public visitor
cannot change the monitor or consume the free runner allowance.

## GitHub setup

1. Create a public GitHub repository and push this project.
2. In repository **Settings > Pages**, select **GitHub Actions** as the source.
3. In **Settings > Secrets and variables > Actions**, add:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
4. Open **Actions**, choose **Scan opportunities and publish website**, and run it.

No `.env`, local database, WhatsApp session, phone number, or dashboard secret
is committed because those paths are excluded by `.gitignore`.
