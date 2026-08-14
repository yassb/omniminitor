import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { config } from './config.js';

let dbPromise;

function persist(database) {
  const data = database.export();
  fs.writeFileSync(config.databasePath, Buffer.from(data));
}

function run(database, sql, params = [], { save = true } = {}) {
  const statement = database.prepare(sql);

  try {
    statement.bind(params);
    statement.step();
  } finally {
    statement.free();
  }

  if (save) persist(database);
  return { changes: database.getRowsModified() };
}

function all(database, sql, params = []) {
  const statement = database.prepare(sql);
  const rows = [];

  try {
    statement.bind(params);
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
  } finally {
    statement.free();
  }

  return rows;
}

function get(database, sql, params = []) {
  return all(database, sql, params)[0];
}

function hasColumn(database, table, column) {
  return all(database, `PRAGMA table_info(${table})`).some((row) => row.name === column);
}

function migrateDatabase(database) {
  if (!hasColumn(database, 'opportunities', 'applied_at')) {
    database.run('ALTER TABLE opportunities ADD COLUMN applied_at TEXT');
  }

  if (!hasColumn(database, 'opportunities', 'whatsapp_notified_at')) {
    database.run('ALTER TABLE opportunities ADD COLUMN whatsapp_notified_at TEXT');
    database.run(`
      UPDATE opportunities
      SET whatsapp_notified_at = COALESCE(notified_at, CURRENT_TIMESTAMP)
    `);
  }

  if (!hasColumn(database, 'opportunities', 'last_seen_at')) {
    database.run('ALTER TABLE opportunities ADD COLUMN last_seen_at TEXT');
    database.run(`
      UPDATE opportunities
      SET last_seen_at = COALESCE(first_seen_at, CURRENT_TIMESTAMP)
    `);
  }

  database.run(`
    CREATE TABLE IF NOT EXISTS scan_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger TEXT NOT NULL DEFAULT 'manual',
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      sites_total INTEGER NOT NULL DEFAULT 0,
      sites_checked INTEGER NOT NULL DEFAULT 0,
      matches_found INTEGER NOT NULL DEFAULT 0,
      new_opportunities INTEGER NOT NULL DEFAULT 0,
      errors_count INTEGER NOT NULL DEFAULT 0,
      telegram_sent INTEGER NOT NULL DEFAULT 0,
      whatsapp_sent INTEGER NOT NULL DEFAULT 0,
      pending_notifications INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS site_scan_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id INTEGER NOT NULL,
      site_id INTEGER NOT NULL,
      checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL,
      matches_found INTEGER NOT NULL DEFAULT 0,
      new_opportunities INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      FOREIGN KEY (scan_id) REFERENCES scan_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
    );
  `);

  database.run('CREATE INDEX IF NOT EXISTS idx_opportunities_applied_at ON opportunities(applied_at)');
  database.run(
    'CREATE INDEX IF NOT EXISTS idx_opportunities_whatsapp_notified_at ON opportunities(whatsapp_notified_at)'
  );
  database.run('CREATE INDEX IF NOT EXISTS idx_opportunities_last_seen_at ON opportunities(last_seen_at)');
  database.run('CREATE INDEX IF NOT EXISTS idx_scan_runs_started_at ON scan_runs(started_at)');
  database.run('CREATE INDEX IF NOT EXISTS idx_site_scan_results_scan_id ON site_scan_results(scan_id)');
  database.run('CREATE INDEX IF NOT EXISTS idx_site_scan_results_site_id ON site_scan_results(site_id)');
  database.run(`
    UPDATE scan_runs
    SET status = 'interrupted',
        completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
    WHERE status = 'running'
      AND datetime(started_at) < datetime('now', '-10 minutes')
  `);
}

export async function openDatabase() {
  if (dbPromise) return dbPromise;

  dbPromise = (async () => {
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

    const SQL = await initSqlJs({
      locateFile: (file) => path.join(config.rootDir, 'node_modules', 'sql.js', 'dist', file)
    });
    const database = fs.existsSync(config.databasePath)
      ? new SQL.Database(fs.readFileSync(config.databasePath))
      : new SQL.Database();

    database.run('PRAGMA foreign_keys = ON');

    database.run(`
      CREATE TABLE IF NOT EXISTS sites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        name TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_checked_at TEXT,
        last_status TEXT,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS opportunities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        snippet TEXT,
        matched_keywords TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        notified_at TEXT,
        FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_opportunities_site_id ON opportunities(site_id);
      CREATE INDEX IF NOT EXISTS idx_opportunities_notified_at ON opportunities(notified_at);
    `);
    migrateDatabase(database);
    persist(database);

    return database;
  })();

  return dbPromise;
}

export function addSite(database, { url, name }) {
  const existing = get(database, 'SELECT * FROM sites WHERE url = ?', [url]);
  if (existing) {
    run(database, 'UPDATE sites SET enabled = 1, name = COALESCE(?, name) WHERE id = ?', [
      name || null,
      existing.id
    ]);
    return get(database, 'SELECT * FROM sites WHERE id = ?', [existing.id]);
  }

  run(database, 'INSERT INTO sites (url, name) VALUES (?, ?)', [url, name || null]);
  return get(database, 'SELECT * FROM sites WHERE url = ?', [url]);
}

export function listSites(database, { enabledOnly = false } = {}) {
  const sql = enabledOnly
    ? 'SELECT * FROM sites WHERE enabled = 1 ORDER BY id'
    : 'SELECT * FROM sites ORDER BY id';
  return all(database, sql);
}

export function disableSite(database, id) {
  const info = run(database, 'UPDATE sites SET enabled = 0 WHERE id = ?', [id]);
  return info.changes > 0;
}

export function updateSiteCheck(database, id, { status, error = null }) {
  run(
    database,
    `UPDATE sites
     SET last_checked_at = CURRENT_TIMESTAMP,
         last_status = ?,
         last_error = ?
     WHERE id = ?`,
    [status, error, id]
  );
}

export function saveOpportunity(database, opportunity) {
  const existingByUrl = get(
    database,
    `SELECT * FROM opportunities
     WHERE url = ?
     ORDER BY first_seen_at DESC
     LIMIT 1`,
    [opportunity.url]
  );

  if (existingByUrl) {
    run(
      database,
      `UPDATE opportunities
       SET title = ?,
           snippet = ?,
           matched_keywords = ?,
           last_seen_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        opportunity.title,
        opportunity.snippet,
        opportunity.matchedKeywords,
        existingByUrl.id
      ]
    );

    return {
      isNew: false,
      opportunity: get(database, 'SELECT * FROM opportunities WHERE id = ?', [existingByUrl.id])
    };
  }

  try {
    run(
      database,
      `INSERT INTO opportunities
        (site_id, title, url, snippet, matched_keywords, fingerprint, last_seen_at)
       VALUES
        (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        opportunity.siteId,
        opportunity.title,
        opportunity.url,
        opportunity.snippet,
        opportunity.matchedKeywords,
        opportunity.fingerprint
      ]
    );

    return {
      isNew: true,
      opportunity: get(database, 'SELECT * FROM opportunities WHERE fingerprint = ?', [
        opportunity.fingerprint
      ])
    };
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(error.message)) {
      run(
        database,
        `UPDATE opportunities
         SET title = ?,
             url = ?,
             snippet = ?,
             matched_keywords = ?,
             last_seen_at = CURRENT_TIMESTAMP
         WHERE fingerprint = ?`,
        [
          opportunity.title,
          opportunity.url,
          opportunity.snippet,
          opportunity.matchedKeywords,
          opportunity.fingerprint
        ]
      );

      return {
        isNew: false,
        opportunity: get(database, 'SELECT * FROM opportunities WHERE fingerprint = ?', [
          opportunity.fingerprint
        ])
      };
    }
    throw error;
  }
}

function notificationColumn(channel) {
  if (channel === 'telegram') return 'notified_at';
  if (channel === 'whatsapp') return 'whatsapp_notified_at';
  throw new Error(`Unknown notification channel: ${channel}`);
}

export function listPendingNotifications(database, channel = 'telegram', limit = 50) {
  const column = notificationColumn(channel);
  return all(
    database,
    `SELECT
       opportunities.*,
       sites.name AS site_name,
       sites.url AS site_url
     FROM opportunities
     JOIN sites ON sites.id = opportunities.site_id
     WHERE opportunities.${column} IS NULL
       AND opportunities.applied_at IS NULL
     ORDER BY opportunities.first_seen_at ASC
     LIMIT ?`,
    [limit]
  );
}

export function listRecentOpportunities(database, limit = 80) {
  return all(
    database,
    `SELECT
       opportunities.*,
       sites.name AS site_name,
       sites.url AS site_url
     FROM opportunities
     JOIN sites ON sites.id = opportunities.site_id
     ORDER BY opportunities.first_seen_at DESC
     LIMIT ?`,
    [limit]
  );
}

export function markOpportunityNotified(database, id, channel = 'telegram') {
  const column = notificationColumn(channel);
  run(database, `UPDATE opportunities SET ${column} = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
}

export function markOpportunityApplied(database, id) {
  run(
    database,
    `UPDATE opportunities
     SET applied_at = CURRENT_TIMESTAMP,
         notified_at = COALESCE(notified_at, CURRENT_TIMESTAMP),
         whatsapp_notified_at = COALESCE(whatsapp_notified_at, CURRENT_TIMESTAMP)
     WHERE id = ?`,
    [id]
  );
  return Boolean(get(
    database,
    'SELECT id FROM opportunities WHERE id = ? AND applied_at IS NOT NULL',
    [id]
  ));
}

export function unmarkOpportunityApplied(database, id) {
  const exists = Boolean(get(database, 'SELECT id FROM opportunities WHERE id = ?', [id]));
  if (!exists) return false;

  run(
    database,
    `UPDATE opportunities
     SET notified_at = CASE
           WHEN notified_at = applied_at THEN NULL
           ELSE notified_at
         END,
         whatsapp_notified_at = CASE
           WHEN whatsapp_notified_at = applied_at THEN NULL
           ELSE whatsapp_notified_at
         END,
         applied_at = NULL
     WHERE id = ?`,
    [id]
  );
  return true;
}

export function markAllPendingNotified(database) {
  const info = run(
    database,
    `UPDATE opportunities
     SET notified_at = COALESCE(notified_at, CURRENT_TIMESTAMP),
         whatsapp_notified_at = COALESCE(whatsapp_notified_at, CURRENT_TIMESTAMP)
     WHERE applied_at IS NULL
       AND (notified_at IS NULL OR whatsapp_notified_at IS NULL)`
  );
  return info.changes;
}

export function getCounts(database) {
  const sites = get(database, 'SELECT COUNT(*) AS count FROM sites WHERE enabled = 1').count;
  const opportunities = get(database, 'SELECT COUNT(*) AS count FROM opportunities').count;
  const pendingTelegram = get(
    database,
    'SELECT COUNT(*) AS count FROM opportunities WHERE notified_at IS NULL AND applied_at IS NULL'
  ).count;
  const pendingWhatsapp = get(
    database,
    'SELECT COUNT(*) AS count FROM opportunities WHERE whatsapp_notified_at IS NULL AND applied_at IS NULL'
  ).count;
  const applied = get(
    database,
    'SELECT COUNT(*) AS count FROM opportunities WHERE applied_at IS NOT NULL'
  ).count;
  return {
    sites,
    opportunities,
    pending: pendingTelegram,
    pendingTelegram,
    pendingWhatsapp,
    applied
  };
}

export function startScanRun(database, { trigger = 'manual', sitesTotal = 0 } = {}) {
  run(
    database,
    `INSERT INTO scan_runs (trigger, sites_total)
     VALUES (?, ?)`,
    [trigger, sitesTotal],
    { save: false }
  );
  const id = Number(get(database, 'SELECT last_insert_rowid() AS id').id);
  persist(database);
  return id;
}

export function recordSiteScanResult(database, {
  scanId,
  siteId,
  status,
  matchesFound = 0,
  newOpportunities = 0,
  durationMs = 0,
  error = null
}) {
  run(
    database,
    `INSERT INTO site_scan_results
       (scan_id, site_id, status, matches_found, new_opportunities, duration_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [scanId, siteId, status, matchesFound, newOpportunities, durationMs, error]
  );
}

export function finishScanRun(database, scanId, summary) {
  run(
    database,
    `UPDATE scan_runs
     SET completed_at = CURRENT_TIMESTAMP,
         status = ?,
         sites_checked = ?,
         matches_found = ?,
         new_opportunities = ?,
         errors_count = ?,
         telegram_sent = ?,
         whatsapp_sent = ?,
         pending_notifications = ?,
         duration_ms = ?
     WHERE id = ?`,
    [
      summary.status || (summary.errors?.length ? 'completed_with_errors' : 'completed'),
      summary.sitesChecked || 0,
      summary.matchesFound || 0,
      summary.newOpportunities || 0,
      summary.errors?.length || 0,
      summary.telegramSent || 0,
      summary.whatsappSent || 0,
      summary.notificationsPending || 0,
      summary.durationMs || 0,
      scanId
    ]
  );
}

export function listRecentScanRuns(database, limit = 8) {
  return all(
    database,
    `SELECT *
     FROM scan_runs
     ORDER BY started_at DESC, id DESC
     LIMIT ?`,
    [limit]
  );
}

export function listLatestSiteScanResults(database) {
  return all(
    database,
    `SELECT
       latest.*,
       sites.name AS site_name,
       sites.url AS site_url
     FROM site_scan_results AS latest
     JOIN sites ON sites.id = latest.site_id
     WHERE latest.id = (
       SELECT result.id
       FROM site_scan_results AS result
       WHERE result.site_id = latest.site_id
       ORDER BY result.checked_at DESC, result.id DESC
       LIMIT 1
     )
     ORDER BY sites.id`
  );
}
