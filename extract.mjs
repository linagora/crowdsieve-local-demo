#!/usr/bin/env node
/**
 * Runs INSIDE the CrowdSieve pod (copied there by export.sh).
 *
 * Reads the CrowdSieve PostgreSQL database (POSTGRES_* env vars of the pod)
 * and writes a standalone SQLite database with the exact schema CrowdSieve
 * uses with STORAGE_TYPE=sqlite. Ids are preserved, so relations stay valid.
 * Everything is read from a single REPEATABLE READ snapshot.
 *
 * Alerts matching the exclusion predicate (default: LemonLDAP::NG
 * BAD_CREDENTIALS) are dropped, together with their decisions and events.
 *
 * Usage:
 *   node extract.mjs --output /tmp/x/crowdsieve.db [--exclude-where SQL | --no-exclude]
 *   node extract.mjs --inspect [--exclude-where SQL]
 *
 * The `pg` and `better-sqlite3` modules are loaded from the CrowdSieve app
 * directory (CROWDSIEVE_APP_DIR, default /app).
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const appDir = process.env.CROWDSIEVE_APP_DIR || '/app';
const require = createRequire(path.join(appDir, 'package.json'));
const pg = require('pg');
const Database = require('better-sqlite3');

const DEFAULT_EXCLUDE_WHERE = `
  (a.scenario ~* '(lemon|llng)' OR a.message ~* '(lemon|llng)'
    OR a.machine_id ~* '(lemon|llng)' OR a.raw_json ~* '(lemonldap|llng)')
  AND (a.scenario ~* 'bad[_ -]?credential' OR a.message ~* 'bad[_ -]?credential'
    OR a.raw_json ~* 'bad[_ -]?credential')`;

// Insertion order: parents before children
const TABLES = [
  'alerts',
  'decisions',
  'events',
  'validated_clients',
  'analyzer_runs',
  'analyzer_results',
  'bouncers',
  'bouncer_metrics',
];

const BATCH_SIZE = 2000;

// Same schema as runSQLiteMigrations() in crowdsieve src/db/index.ts
const createTablesSql = `
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT,
  machine_id TEXT,
  scenario TEXT NOT NULL,
  scenario_hash TEXT,
  scenario_version TEXT,
  message TEXT,
  events_count INTEGER,
  capacity INTEGER,
  leakspeed TEXT,
  start_at TEXT,
  stop_at TEXT,
  created_at TEXT,
  received_at TEXT NOT NULL,
  simulated INTEGER DEFAULT 0,
  remediation INTEGER DEFAULT 0,
  has_decisions INTEGER DEFAULT 0,
  replicated INTEGER DEFAULT 0,
  source_scope TEXT,
  source_value TEXT,
  source_ip TEXT,
  source_range TEXT,
  source_as_number TEXT,
  source_as_name TEXT,
  source_cn TEXT,
  geo_country_code TEXT,
  geo_country_name TEXT,
  geo_city TEXT,
  geo_region TEXT,
  geo_latitude REAL,
  geo_longitude REAL,
  geo_timezone TEXT,
  geo_isp TEXT,
  geo_org TEXT,
  filtered INTEGER DEFAULT 0,
  filter_reasons TEXT,
  forwarded_to_capi INTEGER DEFAULT 0,
  forwarded_at TEXT,
  local_audit INTEGER DEFAULT 0,
  actor TEXT,
  raw_json TEXT
);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE CASCADE,
  uuid TEXT,
  origin TEXT,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  value TEXT NOT NULL,
  duration TEXT,
  scenario TEXT,
  simulated INTEGER DEFAULT 0,
  until TEXT,
  created_at TEXT
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE CASCADE,
  timestamp TEXT,
  meta TEXT
);

CREATE TABLE validated_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  machine_id TEXT,
  validated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  access_count INTEGER DEFAULT 1
);

CREATE TABLE analyzer_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analyzer_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  logs_fetched INTEGER DEFAULT 0,
  alerts_generated INTEGER DEFAULT 0,
  decisions_pushed INTEGER DEFAULT 0,
  error_message TEXT,
  results_json TEXT,
  push_results_json TEXT
);

CREATE TABLE analyzer_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES analyzer_runs(id) ON DELETE CASCADE,
  source_ip TEXT NOT NULL,
  distinct_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  first_seen TEXT,
  last_seen TEXT,
  decision_pushed INTEGER DEFAULT 0,
  decision_id TEXT
);

CREATE TABLE bouncers (
  lapi_server_name TEXT NOT NULL,
  bouncer_name TEXT NOT NULL,
  component_kind TEXT NOT NULL,
  bouncer_type TEXT,
  os_name TEXT,
  os_version TEXT,
  version TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (lapi_server_name, bouncer_name, component_kind)
);

CREATE TABLE bouncer_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lapi_server_name TEXT NOT NULL,
  component_kind TEXT NOT NULL,
  bouncer_name TEXT NOT NULL,
  active_decisions INTEGER,
  processed_items INTEGER,
  dropped_items INTEGER,
  bytes_processed INTEGER,
  collected_at INTEGER NOT NULL,
  metrics_json TEXT NOT NULL
);
`;

// Created after the bulk load (much faster)
const createIndexesSql = `
CREATE INDEX idx_scenario ON alerts(scenario);
CREATE INDEX idx_source_ip ON alerts(source_ip);
CREATE INDEX idx_received_at ON alerts(received_at);
CREATE INDEX idx_country_code ON alerts(geo_country_code);
CREATE INDEX idx_filtered ON alerts(filtered);
CREATE INDEX idx_machine_id ON alerts(machine_id);
CREATE INDEX idx_local_audit ON alerts(local_audit);
CREATE UNIQUE INDEX idx_alerts_uuid ON alerts(uuid) WHERE uuid IS NOT NULL;
CREATE INDEX idx_decision_alert ON decisions(alert_id);
CREATE INDEX idx_decision_value ON decisions(value);
CREATE INDEX idx_decision_type ON decisions(type);
CREATE INDEX idx_event_alert ON events(alert_id);
CREATE INDEX idx_vc_expires_at ON validated_clients(expires_at);
CREATE INDEX idx_analyzer_runs_analyzer_id ON analyzer_runs(analyzer_id);
CREATE INDEX idx_analyzer_runs_started_at ON analyzer_runs(started_at);
CREATE INDEX idx_analyzer_results_run_id ON analyzer_results(run_id);
CREATE INDEX idx_analyzer_results_source_ip ON analyzer_results(source_ip);
CREATE INDEX idx_bouncer_metrics_server_collected ON bouncer_metrics(lapi_server_name, collected_at);
CREATE INDEX idx_bouncer_metrics_bouncer_collected ON bouncer_metrics(bouncer_name, collected_at);
CREATE UNIQUE INDEX bouncer_metrics_unique
  ON bouncer_metrics(lapi_server_name, bouncer_name, component_kind, collected_at);
`;

function parseArgs(argv) {
  const opts = { output: null, excludeWhere: DEFAULT_EXCLUDE_WHERE, inspect: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`Missing value for ${arg}`);
      return argv[++i];
    };
    if (arg === '--output') opts.output = next();
    else if (arg === '--exclude-where') opts.excludeWhere = next();
    else if (arg === '--no-exclude') opts.excludeWhere = 'FALSE';
    else if (arg === '--inspect') opts.inspect = true;
    else fail(`Unexpected argument: ${arg}`);
  }
  if (!opts.inspect && !opts.output) fail('Missing --output');
  return opts;
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));
// IS TRUE / IS NOT TRUE: a NULL predicate (NULL columns) means "keep"
const EXCLUDED = `(${opts.excludeWhere}) IS TRUE`;
const KEPT = `(${opts.excludeWhere}) IS NOT TRUE`;
const notExcludedAlert = (col) =>
  `NOT EXISTS (SELECT 1 FROM alerts a WHERE a.id = ${col} AND ${EXCLUDED})`;

const client = new pg.Client({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DATABASE,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  ssl:
    process.env.POSTGRES_SSL === 'true'
      ? { rejectUnauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : false,
});

async function tableExists(name) {
  const res = await client.query('SELECT to_regclass($1) AS t', [name]);
  return res.rows[0].t !== null;
}

async function inspect() {
  const totals = {};
  for (const t of TABLES) {
    if (await tableExists(t)) {
      totals[t] = (await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    }
  }
  console.log('Row counts in PostgreSQL:');
  for (const [t, n] of Object.entries(totals)) console.log(`  ${t.padEnd(18)} ${n}`);

  const scenarios = await client.query(
    `SELECT a.scenario, count(*)::int AS total,
            count(*) FILTER (WHERE ${EXCLUDED})::int AS excluded
       FROM alerts a GROUP BY a.scenario ORDER BY total DESC`
  );
  console.log('\nAlerts per scenario (total / excluded):');
  let excluded = 0;
  for (const s of scenarios.rows) {
    excluded += s.excluded;
    const mark = s.excluded > 0 ? '  <-- excluded' : '';
    console.log(
      `  ${String(s.total).padStart(8)} / ${String(s.excluded).padStart(8)}  ${s.scenario}${mark}`
    );
  }

  const samples = await client.query(
    `SELECT a.id, a.scenario, a.machine_id, a.message, a.received_at
       FROM alerts a WHERE ${EXCLUDED} ORDER BY a.id DESC LIMIT 10`
  );
  console.log(`\n${excluded} alert(s) would be excluded. Latest samples:`);
  for (const s of samples.rows) {
    console.log(`  #${s.id} ${s.received_at} [${s.machine_id}] ${s.scenario}: ${s.message}`);
  }
}

function toSqliteValue(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

async function exportDb() {
  const tmpPath = `${opts.output}.tmp`;
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.rmSync(tmpPath, { force: true });

  const sqlite = new Database(tmpPath);
  sqlite.pragma('journal_mode = OFF');
  sqlite.pragma('synchronous = OFF');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(createTablesSql);

  const counts = {};

  // Copy one table, page by page (keyset pagination on id when available)
  async function copyTable(table, where, alias = 'x') {
    const cols = sqlite
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name);
    const insert = sqlite.prepare(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    );
    const insertMany = sqlite.transaction((rows) => {
      for (const r of rows) insert.run(cols.map((c) => toSqliteValue(r[c] ?? null)));
    });

    counts[table] = 0;
    if (!cols.includes('id')) {
      const res = await client.query(`SELECT ${alias}.* FROM ${table} ${alias} WHERE ${where}`);
      insertMany(res.rows);
      counts[table] = res.rows.length;
    } else {
      let lastId = 0;
      for (;;) {
        const res = await client.query(
          `SELECT ${alias}.* FROM ${table} ${alias}
            WHERE ${alias}.id > $1 AND ${where}
            ORDER BY ${alias}.id LIMIT ${BATCH_SIZE}`,
          [lastId]
        );
        if (res.rows.length === 0) break;
        insertMany(res.rows);
        lastId = res.rows[res.rows.length - 1].id;
        counts[table] += res.rows.length;
        if (counts[table] % 50000 === 0) console.error(`  ${table}: ${counts[table]} rows...`);
      }
    }
    console.error(`  ${table}: ${counts[table]} rows`);
  }

  try {
    for (const t of TABLES) {
      if (!(await tableExists(t))) {
        console.error(`  ${t}: table not found in PostgreSQL, left empty`);
        continue;
      }
      if (t === 'alerts') await copyTable(t, KEPT, 'a');
      else if (t === 'decisions' || t === 'events') await copyTable(t, notExcludedAlert('x.alert_id'));
      else await copyTable(t, 'TRUE');
    }

    console.error('Creating indexes...');
    sqlite.exec(createIndexesSql);
    const fkErrors = sqlite.prepare('PRAGMA foreign_key_check').all();
    if (fkErrors.length > 0) throw new Error(`${fkErrors.length} foreign key violation(s)`);
    console.error('Compacting...');
    sqlite.exec('VACUUM');
    sqlite.pragma('journal_mode = DELETE');
    sqlite.close();
  } catch (err) {
    sqlite.close();
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }

  fs.renameSync(tmpPath, opts.output);
  console.error('Exported rows:');
  for (const [t, n] of Object.entries(counts)) console.error(`  ${t.padEnd(18)} ${n}`);
}

try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await (opts.inspect ? inspect() : exportDb());
  await client.query('COMMIT');
  await client.end();
} catch (err) {
  console.error(`Extraction failed: ${err.message}`);
  process.exit(1);
}
