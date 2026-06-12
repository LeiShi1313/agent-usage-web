import express from 'express';
import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const execFileAsync = promisify(execFile);

const APP_ROLE = (process.env.APP_ROLE ?? 'web').trim().toLowerCase();
const PORT = Number(process.env.PORT ?? 3000);
const STATIC_DIR = path.resolve(__dirname, '..', 'dist');
const API_CACHE_CONTROL = 'no-store, no-cache, must-revalidate, proxy-revalidate';
const HOME_DIR = process.env.HOME ?? '/home/node';
const XDG_CACHE_HOME = process.env.XDG_CACHE_HOME ?? path.join(HOME_DIR, '.cache');
const XDG_DATA_HOME = process.env.XDG_DATA_HOME ?? path.join(HOME_DIR, '.local', 'share');

const EXPORTER_TOKEN = process.env.EXPORTER_TOKEN ?? '';
const EXPORTER_REFRESH_SECONDS = numberEnv(process.env.EXPORTER_REFRESH_SECONDS, 300);
const EXPORTER_REFRESH_MIN_INTERVAL_SECONDS = numberEnv(process.env.EXPORTER_REFRESH_MIN_INTERVAL_SECONDS, 60);
const EXPORTER_COMMAND_TIMEOUT_MS = numberEnv(process.env.EXPORTER_COMMAND_TIMEOUT_MS, 90_000);
const EXPORTER_SNAPSHOT_CACHE_PATH = process.env.EXPORTER_SNAPSHOT_CACHE_PATH ??
  path.join(XDG_CACHE_HOME, 'agent-usage-web', 'exporter-snapshot.json');
const CLAUDE_CREDENTIALS_PATH = process.env.CLAUDE_CREDENTIALS_PATH ??
  path.join(HOME_DIR, '.claude', '.credentials.json');
const CLAUDE_OAUTH_CLIENT_ID = process.env.CODEXBAR_CLAUDE_OAUTH_CLIENT_ID ??
  '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_REFRESH_WINDOW_MS = 5 * 60 * 1000;

const WEB_ACCOUNT_DISPLAY = normalizeAccountDisplay(process.env.WEB_ACCOUNT_DISPLAY ?? 'hidden');
const WEB_EXPORTER_POLL_SECONDS = numberEnv(process.env.WEB_EXPORTER_POLL_SECONDS, 60);
const WEB_STALE_AFTER_SECONDS = numberEnv(process.env.WEB_STALE_AFTER_SECONDS, 600);
const WEB_EXPIRED_AFTER_SECONDS = numberEnv(process.env.WEB_EXPIRED_AFTER_SECONDS, 86_400);
const WEB_POLL_TIMEOUT_MS = numberEnv(process.env.WEB_POLL_TIMEOUT_MS, 75_000);
const WEB_SQLITE_PATH = process.env.WEB_SQLITE_PATH ??
  path.join(XDG_DATA_HOME, 'agent-usage-web', 'polls.sqlite');
const WEB_PROVIDER_ORDER = parseProviderOrder(process.env.WEB_PROVIDER_ORDER ?? 'codex,antigravity');

let claudeRefreshPromise = null;

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'"
  ].join('; '));
  response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (request.path.startsWith('/api/') || request.path.startsWith('/v1/')) {
    response.setHeader('Cache-Control', API_CACHE_CONTROL);
  }
  next();
});

app.use((request, response, next) => {
  if (isSensitivePath(request)) {
    response.status(404).type('text/plain').send('Not found');
    return;
  }
  next();
});

function numberEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeAccountDisplay(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['label', 'full'].includes(normalized)) return normalized;
  return 'hidden';
}

function parseProviderOrder(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function isSensitivePath(request) {
  const rawPath = request.originalUrl.split('?')[0];
  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return true;
  }

  const candidates = [rawPath, decodedPath].map((value) => value.toLowerCase());
  return candidates.some((value) => (
    value.includes('..') ||
    value.includes('%2e') ||
    /(^|\/)\.[^/]/.test(value) ||
    /(^|\/)(dockerfile|docker-compose\.ya?ml|package(?:-lock)?\.json|server|src|node_modules|home|app)(\/|$)/.test(value) ||
    /(^|\/)(auth|credentials?|secrets?|tokens?|cookies?)(\.|\/|$)/.test(value)
  ));
}

function nowISO() {
  return new Date().toISOString();
}

function isoFromMs(value) {
  return new Date(value).toISOString();
}

function ageMs(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
}

function maxISO(values) {
  let max = 0;
  for (const value of values) {
    const timestamp = value ? new Date(value).getTime() : 0;
    if (Number.isFinite(timestamp) && timestamp > max) max = timestamp;
  }
  return max ? isoFromMs(max) : null;
}

function redactText(value) {
  if (typeof value !== 'string') return value == null ? '' : String(value);
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\b((?:access|refresh|id)[_-]?token)\b\s*[:=]\s*["']?[^"',\s}]+/gi, '$1: <redacted>')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '<redacted-openai-key>')
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, '<redacted-anthropic-token>')
    .replace(/eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}/g, '<redacted-jwt>')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<redacted-email>')
    .replace(/\/home\/(?:node|lei)\/[^\s"',)]+/g, '/home/<redacted>');
}

function publicError(error) {
  if (!error) return null;
  if (typeof error === 'string') return { message: redactText(error) };
  return {
    message: redactText(error.message ?? error.description ?? 'Upstream error'),
    description: error.description ? redactText(error.description) : undefined,
    code: error.code
  };
}

function bearerToken(request) {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? '';
}

function constantTimeTokenEqual(received, expected) {
  if (!received || !expected) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(receivedBuffer, expectedBuffer);
}

function requireExporterToken(request, response) {
  if (!EXPORTER_TOKEN) {
    response.status(500).json({ error: 'Exporter token is not configured.' });
    return false;
  }
  if (!constantTimeTokenEqual(bearerToken(request), EXPORTER_TOKEN)) {
    response.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.providers)) return value.providers;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function looksLikeEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function providerFromRow(row) {
  return firstString(row?.provider, row?.usage?.identity?.providerID, row?.identity?.providerID, 'unknown').toLowerCase();
}

function deriveAccount(row, provider, fallback) {
  const accountObject = typeof row?.account === 'object' && row.account ? row.account : null;
  const identity = row?.usage?.identity ?? row?.identity ?? {};
  const rawAccount = typeof row?.account === 'string' ? row.account : null;
  const email = firstString(
    row?.accountEmail,
    row?.email,
    accountObject?.email,
    identity?.accountEmail,
    identity?.email
  ) ?? (looksLikeEmail(rawAccount) ? rawAccount : null);
  const rawId = firstString(
    row?.accountKey,
    row?.accountId,
    row?.accountID,
    row?.providerAccountId,
    accountObject?.key,
    accountObject?.id,
    accountObject?.accountId,
    identity?.accountKey,
    identity?.accountId,
    identity?.accountID,
    identity?.providerAccountId
  );
  const label = firstString(
    rawAccount,
    row?.accountName,
    row?.label,
    accountObject?.label,
    accountObject?.name,
    identity?.accountName,
    email,
    rawId,
    fallback?.label
  );
  const organization = firstString(
    row?.accountOrganization,
    row?.organization,
    accountObject?.organization,
    identity?.accountOrganization,
    identity?.organization,
    fallback?.organization
  );
  const key = firstString(email, rawId, rawAccount, fallback?.key);

  return {
    key: key ?? 'unknown:local',
    label: label ?? (key ? `${provider} account` : null),
    email: email ?? fallback?.email ?? null,
    organization: organization ?? fallback?.organization ?? null,
    identitySource: key ? 'codexbar' : (fallback?.identitySource ?? 'unknown')
  };
}

function cloneJSON(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function snapshotError(message, code) {
  return {
    message: redactText(message),
    code,
    at: nowISO()
  };
}

async function runCodexBarJSON(args, timeoutMs = EXPORTER_COMMAND_TIMEOUT_MS) {
  let stdout = '';
  let stderr = '';
  try {
    ({ stdout, stderr } = await execFileAsync('codexbar', args, {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: process.env
    }));
  } catch (error) {
    stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    if (!stdout.trim()) {
      const detail = redactText(error instanceof Error ? error.message : String(error));
      throw new Error(detail || `codexbar ${args[0] ?? ''} failed.`);
    }
  }

  try {
    const data = JSON.parse(stdout);
    return {
      data,
      commandError: stderr.trim() ? redactText(stderr.trim()) : null
    };
  } catch {
    throw new Error(`codexbar ${args[0] ?? ''} returned non-JSON output.`);
  }
}

async function refreshClaudeOAuthCredentialsCore() {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(CLAUDE_CREDENTIALS_PATH, 'utf8'));
  } catch {
    return { refreshed: false, reason: 'missing' };
  }

  const oauth = raw?.claudeAiOauth;
  const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : 0;
  const refreshToken = typeof oauth?.refreshToken === 'string' ? oauth.refreshToken.trim() : '';
  if (!refreshToken) return { refreshed: false, reason: 'no-refresh-token' };
  if (expiresAt > Date.now() + CLAUDE_REFRESH_WINDOW_MS) {
    return { refreshed: false, reason: 'fresh' };
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID
  });
  const response = await fetch('https://platform.claude.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json || typeof json.access_token !== 'string') {
    const code = typeof json?.error === 'string' ? json.error : `HTTP ${response.status}`;
    return { refreshed: false, reason: `refresh-failed:${redactText(code)}` };
  }

  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  raw.claudeAiOauth = {
    ...oauth,
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scopes: typeof json.scope === 'string' ? json.scope.split(/\s+/).filter(Boolean) : oauth.scopes,
    rateLimitTier: json.rate_limit_tier ?? oauth.rateLimitTier,
    subscriptionType: json.subscription_type ?? oauth.subscriptionType
  };

  await fs.writeFile(CLAUDE_CREDENTIALS_PATH, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(CLAUDE_CREDENTIALS_PATH, 0o600).catch(() => {});
  return { refreshed: true, reason: 'refreshed' };
}

async function refreshClaudeOAuthCredentialsIfPresent() {
  claudeRefreshPromise ??= refreshClaudeOAuthCredentialsCore().finally(() => {
    claudeRefreshPromise = null;
  });
  return claudeRefreshPromise;
}

function makeSnapshot({ status = 'initializing', records = [], errors = [], startedAt = null, finishedAt = null } = {}) {
  const generatedAt = nowISO();
  return {
    schemaVersion: 1,
    generatedAt,
    exporter: {
      role: 'exporter',
      hostname: process.env.HOSTNAME ?? null
    },
    collection: {
      status,
      startedAt,
      finishedAt,
      recordCount: records.length
    },
    records,
    errors
  };
}

let exporterSnapshot = makeSnapshot();
let exporterRefreshPromise = null;
let exporterLastRefreshStartedAt = 0;

async function loadExporterSnapshotCache() {
  try {
    const raw = JSON.parse(await fs.readFile(EXPORTER_SNAPSHOT_CACHE_PATH, 'utf8'));
    if (raw && raw.schemaVersion === 1 && Array.isArray(raw.records)) {
      exporterSnapshot = raw;
    }
  } catch {
    // A missing exporter cache is normal on first boot.
  }
}

async function writeExporterSnapshotCache(snapshot) {
  await ensureParentDir(EXPORTER_SNAPSHOT_CACHE_PATH);
  await fs.writeFile(EXPORTER_SNAPSHOT_CACHE_PATH, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
}

async function validateCodexBarConfig(errors) {
  const configPath = process.env.CODEXBAR_CONFIG;
  if (!configPath) return true;
  try {
    const stat = await fs.stat(configPath);
    if (stat.isFile()) return true;
  } catch {
    errors.push(snapshotError(`CODEXBAR_CONFIG does not exist: ${configPath}`, 'codexbar-config-missing'));
    return false;
  }
  errors.push(snapshotError(`CODEXBAR_CONFIG is not a file: ${configPath}`, 'codexbar-config-invalid'));
  return false;
}

function usageRecordsFromRows(rows, collectedAt, errors) {
  const usageAccountsByProvider = new Map();
  const records = [];

  for (const row of rows) {
    const provider = providerFromRow(row);
    const account = deriveAccount(row, provider);
    const error = publicError(row?.error);
    const record = {
      kind: 'usage',
      provider,
      source: row?.source ?? null,
      collectedAt,
      account,
      data: cloneJSON(row),
      error
    };
    records.push(record);

    if (account.key !== 'unknown:local' && !error) {
      const accounts = usageAccountsByProvider.get(provider) ?? [];
      if (!accounts.some((item) => item.key === account.key)) accounts.push(account);
      usageAccountsByProvider.set(provider, accounts);
    }
    if (error) {
      errors.push(snapshotError(`${provider} usage: ${error.message ?? 'provider error'}`, `usage-${provider}`));
    }
  }

  return { records, usageAccountsByProvider };
}

function costRecordsFromRows(rows, collectedAt, usageAccountsByProvider, errors) {
  const records = [];
  for (const row of rows) {
    const provider = providerFromRow(row);
    const providerUsageAccounts = usageAccountsByProvider.get(provider) ?? [];
    const fallback = providerUsageAccounts.length === 1
      ? { ...providerUsageAccounts[0], identitySource: 'single-local-usage-account' }
      : null;
    const account = deriveAccount(row, provider, fallback);
    const error = publicError(row?.error);
    records.push({
      kind: 'cost',
      provider,
      source: row?.source ?? null,
      collectedAt,
      account,
      data: cloneJSON(row),
      error
    });
    if (error) {
      errors.push(snapshotError(`${provider} cost: ${error.message ?? 'provider error'}`, `cost-${provider}`));
    }
  }
  return records;
}

async function collectExporterSnapshot(reason) {
  const startedAt = nowISO();
  const errors = [];
  const records = [];

  const hasConfig = await validateCodexBarConfig(errors);
  if (!hasConfig) {
    const snapshot = makeSnapshot({ status: 'error', records, errors, startedAt, finishedAt: nowISO() });
    exporterSnapshot = snapshot;
    await writeExporterSnapshotCache(snapshot);
    return snapshot;
  }

  const claudeRefresh = await refreshClaudeOAuthCredentialsIfPresent();
  if (claudeRefresh.reason?.startsWith('refresh-failed:')) {
    errors.push(snapshotError(`Claude OAuth refresh failed: ${claudeRefresh.reason.slice('refresh-failed:'.length)}`, 'claude-refresh-failed'));
  }

  let usageAccountsByProvider = new Map();
  try {
    const result = await runCodexBarJSON(['usage', '--format', 'json', '--json-only']);
    if (result.commandError) errors.push(snapshotError(result.commandError, 'codexbar-usage-stderr'));
    const usage = usageRecordsFromRows(asArray(result.data), nowISO(), errors);
    records.push(...usage.records);
    usageAccountsByProvider = usage.usageAccountsByProvider;
  } catch (error) {
    errors.push(snapshotError(error instanceof Error ? error.message : String(error), 'codexbar-usage-failed'));
  }

  try {
    const result = await runCodexBarJSON(['cost', '--format', 'json', '--json-only']);
    if (result.commandError) errors.push(snapshotError(result.commandError, 'codexbar-cost-stderr'));
    records.push(...costRecordsFromRows(asArray(result.data), nowISO(), usageAccountsByProvider, errors));
  } catch (error) {
    errors.push(snapshotError(error instanceof Error ? error.message : String(error), 'codexbar-cost-failed'));
  }

  const finishedAt = nowISO();
  const status = records.length && errors.length ? 'partial' : records.length ? 'ok' : 'error';
  const snapshot = makeSnapshot({ status, records, errors, startedAt, finishedAt });
  snapshot.collection.reason = reason;
  exporterSnapshot = snapshot;
  await writeExporterSnapshotCache(snapshot);
  return snapshot;
}

function triggerExporterRefresh(reason, { force = false } = {}) {
  if (exporterRefreshPromise) {
    return { status: 'already-running', promise: exporterRefreshPromise };
  }

  const elapsedSeconds = (Date.now() - exporterLastRefreshStartedAt) / 1000;
  if (!force && exporterLastRefreshStartedAt && elapsedSeconds < EXPORTER_REFRESH_MIN_INTERVAL_SECONDS) {
    return {
      status: 'cooldown',
      nextRefreshAt: isoFromMs(exporterLastRefreshStartedAt + EXPORTER_REFRESH_MIN_INTERVAL_SECONDS * 1000),
      promise: null
    };
  }

  exporterLastRefreshStartedAt = Date.now();
  exporterSnapshot = {
    ...exporterSnapshot,
    collection: {
      status: 'refreshing',
      startedAt: nowISO(),
      finishedAt: null,
      recordCount: exporterSnapshot.records?.length ?? 0,
      reason
    }
  };
  exporterRefreshPromise = collectExporterSnapshot(reason).finally(() => {
    exporterRefreshPromise = null;
  });
  return { status: 'started', promise: exporterRefreshPromise };
}

function registerExporterRoutes() {
  app.get('/v1/health', (_request, response) => {
    response.json({
      ok: true,
      role: 'exporter',
      collection: exporterSnapshot.collection,
      generatedAt: exporterSnapshot.generatedAt
    });
  });

  app.get('/v1/snapshot', (request, response) => {
    if (!requireExporterToken(request, response)) return;
    response.json(exporterSnapshot);
  });

  app.post('/v1/refresh', async (request, response) => {
    if (!requireExporterToken(request, response)) return;
    const wait = request.query.wait === '1' || request.query.wait === 'true';
    const result = triggerExporterRefresh('manual');
    if (wait && result.promise) {
      await result.promise.catch(() => null);
    }
    response.json({
      accepted: true,
      status: result.status,
      generatedAt: exporterSnapshot.generatedAt,
      collection: exporterSnapshot.collection
    });
  });
}

async function initExporter() {
  await loadExporterSnapshotCache();
  registerExporterRoutes();
  triggerExporterRefresh('startup', { force: true });
  if (EXPORTER_REFRESH_SECONDS > 0) {
    setInterval(() => {
      triggerExporterRefresh('interval');
    }, EXPORTER_REFRESH_SECONDS * 1000).unref();
  }
}

function readTargetConfigFromEnv() {
  const rawJSON = process.env.WEB_EXPORTERS_JSON;
  if (rawJSON?.trim()) return JSON.parse(rawJSON);

  const singleUrl = process.env.WEB_EXPORTER_URL;
  const singleToken = process.env.WEB_EXPORTER_TOKEN;
  if (singleUrl && singleToken) {
    return [{ url: singleUrl, token: singleToken, name: process.env.WEB_EXPORTER_NAME ?? null }];
  }
  return null;
}

async function loadWebTargets() {
  let raw = null;
  const configPath = process.env.WEB_EXPORTERS_CONFIG ?? process.env.WEB_EXPORTERS_FILE;
  if (configPath) {
    raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } else {
    raw = readTargetConfigFromEnv();
  }

  const list = Array.isArray(raw) ? raw : raw?.exporters;
  if (!Array.isArray(list)) return [];

  const targets = [];
  for (const item of list) {
    const url = firstString(item?.url)?.replace(/\/+$/, '');
    const token = firstString(item?.token);
    if (!url || !token) continue;
    targets.push({
      url,
      token,
      name: firstString(item?.name)
    });
  }
  return targets;
}

function openPollDatabase() {
  const db = new DatabaseSync(WEB_SQLITE_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS scrape_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exporter_polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER NOT NULL REFERENCES scrape_targets(id),
      ok INTEGER NOT NULL,
      polled_at TEXT NOT NULL,
      status_code INTEGER,
      duration_ms INTEGER,
      snapshot_json TEXT,
      error_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_exporter_polls_target_id_id ON exporter_polls(target_id, id);
    CREATE INDEX IF NOT EXISTS idx_exporter_polls_polled_at ON exporter_polls(polled_at);
  `);
  return db;
}

function upsertTarget(db, target) {
  const existing = db.prepare('SELECT id FROM scrape_targets WHERE url = ?').get(target.url);
  const timestamp = nowISO();
  if (existing) {
    db.prepare('UPDATE scrape_targets SET name = ?, updated_at = ? WHERE id = ?').run(target.name, timestamp, existing.id);
    return existing.id;
  }
  const result = db.prepare('INSERT INTO scrape_targets (url, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    target.url,
    target.name,
    timestamp,
    timestamp
  );
  return Number(result.lastInsertRowid);
}

function insertPoll(db, targetId, poll) {
  db.prepare(`
    INSERT INTO exporter_polls (target_id, ok, polled_at, status_code, duration_ms, snapshot_json, error_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    targetId,
    poll.ok ? 1 : 0,
    poll.polledAt,
    poll.statusCode ?? null,
    poll.durationMs ?? null,
    poll.snapshot ? JSON.stringify(poll.snapshot) : null,
    poll.error ? JSON.stringify(poll.error) : null
  );
}

function loadLatestSuccessfulPolls(db, targetsById) {
  const rows = db.prepare(`
    SELECT p.target_id, p.polled_at, p.snapshot_json
    FROM exporter_polls p
    JOIN (
      SELECT target_id, MAX(id) AS id
      FROM exporter_polls
      WHERE ok = 1 AND snapshot_json IS NOT NULL
      GROUP BY target_id
    ) latest ON latest.id = p.id
  `).all();

  const cache = new Map();
  for (const row of rows) {
    const target = targetsById.get(row.target_id);
    if (!target) continue;
    try {
      cache.set(target.url, {
        target,
        snapshot: JSON.parse(row.snapshot_json),
        lastSuccessAt: row.polled_at,
        lastAttemptAt: row.polled_at,
        lastError: null
      });
    } catch {
      // Ignore malformed legacy rows; future polls will replace them.
    }
  }
  return cache;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = WEB_POLL_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function errorEnvelope(error, code = 'fetch-failed') {
  return {
    message: redactText(error instanceof Error ? error.message : String(error)),
    code,
    at: nowISO()
  };
}

async function fetchSnapshot(target) {
  const response = await fetchWithTimeout(`${target.url}/v1/snapshot`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${target.token}`
    }
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw Object.assign(new Error(`Exporter returned non-JSON from ${target.url}`), { statusCode: response.status });
  }
  if (!response.ok) {
    throw Object.assign(new Error(body?.error ?? `Exporter returned HTTP ${response.status}`), { statusCode: response.status });
  }
  if (!body || body.schemaVersion !== 1 || !Array.isArray(body.records)) {
    throw Object.assign(new Error('Exporter snapshot schema is invalid.'), { statusCode: response.status });
  }
  return { snapshot: body, statusCode: response.status };
}

async function requestExporterRefresh(target) {
  const response = await fetchWithTimeout(`${target.url}/v1/refresh?wait=1`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${target.token}`
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw Object.assign(new Error(body?.error ?? `Exporter refresh returned HTTP ${response.status}`), { statusCode: response.status });
  }
}

function createWebRuntime(db, targets) {
  const targetsByUrl = new Map();
  const targetsById = new Map();
  for (const target of targets) {
    const id = upsertTarget(db, target);
    const targetWithId = { ...target, id };
    targetsByUrl.set(target.url, targetWithId);
    targetsById.set(id, targetWithId);
  }

  const cache = loadLatestSuccessfulPolls(db, targetsById);

  async function pollTarget(target) {
    const started = Date.now();
    const polledAt = nowISO();
    try {
      const { snapshot, statusCode } = await fetchSnapshot(target);
      insertPoll(db, target.id, {
        ok: true,
        polledAt,
        statusCode,
        durationMs: Date.now() - started,
        snapshot
      });
      cache.set(target.url, {
        target,
        snapshot,
        lastSuccessAt: polledAt,
        lastAttemptAt: polledAt,
        lastError: null
      });
      return { target, ok: true };
    } catch (error) {
      const envelope = errorEnvelope(error);
      insertPoll(db, target.id, {
        ok: false,
        polledAt,
        statusCode: error?.statusCode ?? null,
        durationMs: Date.now() - started,
        error: envelope
      });
      const previous = cache.get(target.url);
      cache.set(target.url, {
        target,
        snapshot: previous?.snapshot ?? null,
        lastSuccessAt: previous?.lastSuccessAt ?? null,
        lastAttemptAt: polledAt,
        lastError: envelope
      });
      return { target, ok: false, error: envelope };
    }
  }

  async function pollAll() {
    await Promise.all([...targetsByUrl.values()].map((target) => pollTarget(target)));
  }

  async function refreshAll() {
    await Promise.all([...targetsByUrl.values()].map(async (target) => {
      try {
        await requestExporterRefresh(target);
      } catch {
        // The following snapshot poll records the visible failure next to normal polls.
      }
      return pollTarget(target);
    }));
  }

  return {
    targets: [...targetsByUrl.values()],
    cache,
    pollAll,
    refreshAll,
    buildDashboard: () => buildDashboard([...targetsByUrl.values()], cache)
  };
}

function accountAggregationKey(record, target) {
  const provider = record.provider ?? 'unknown';
  const accountKey = record.account?.key ?? 'unknown:local';
  const stableAccountKey = accountKey === 'unknown:local' ? `${target.url}:unknown:local` : accountKey;
  return `${provider}\u0000${stableAccountKey}`;
}

function publicAccount(account) {
  if (!account || WEB_ACCOUNT_DISPLAY === 'hidden') return null;
  if (WEB_ACCOUNT_DISPLAY === 'full') {
    return account.email ?? account.label ?? account.key ?? null;
  }
  return account.label ?? null;
}

function publicAccountKey(record, targetState) {
  const rawKey = accountAggregationKey(record, targetState.target);
  const digest = createHash('sha256').update(rawKey).digest('base64url').slice(0, 18);
  return `${record.provider}:${digest}`;
}

function publicUsageIdentity(identity, account) {
  if (!identity && !account) return null;
  return {
    providerID: WEB_ACCOUNT_DISPLAY === 'hidden' ? null : identity?.providerID ?? null,
    accountEmail: WEB_ACCOUNT_DISPLAY === 'full' ? (account?.email ?? identity?.accountEmail ?? null) : null,
    accountOrganization: WEB_ACCOUNT_DISPLAY === 'full' ? (account?.organization ?? identity?.accountOrganization ?? null) : null,
    loginMethod: identity?.loginMethod ?? null
  };
}

function publicRateWindow(window) {
  if (!window) return null;
  return {
    usedPercent: window.usedPercent,
    windowMinutes: window.windowMinutes ?? null,
    resetsAt: window.resetsAt ?? null,
    resetDescription: window.resetDescription ?? null,
    nextRegenPercent: window.nextRegenPercent ?? null
  };
}

function publicUsage(record, targetState) {
  const data = record.data ?? {};
  const usage = data.usage ?? null;
  return {
    provider: record.provider,
    account: publicAccount(record.account),
    accountKey: publicAccountKey(record, targetState),
    version: data.version ?? null,
    source: record.source ?? data.source ?? 'codexbar',
    status: data.status ? {
      indicator: data.status.indicator ?? 'unknown',
      description: data.status.description ?? null,
      updatedAt: data.status.updatedAt ?? null,
      url: data.status.url ?? null
    } : null,
    usage: usage ? {
      primary: publicRateWindow(usage.primary),
      secondary: publicRateWindow(usage.secondary),
      tertiary: publicRateWindow(usage.tertiary),
      extraRateWindows: (usage.extraRateWindows ?? []).map((entry) => ({
        id: entry.id,
        title: entry.title,
        window: publicRateWindow(entry.window)
      })).filter((entry) => entry.window),
      updatedAt: usage.updatedAt ?? record.collectedAt ?? targetState.lastSuccessAt ?? null,
      identity: publicUsageIdentity(usage.identity, record.account)
    } : null,
    credits: data.credits && typeof data.credits.remaining === 'number' ? {
      remaining: data.credits.remaining,
      updatedAt: data.credits.updatedAt ?? record.collectedAt ?? null
    } : null,
    openaiDashboard: data.openaiDashboard ? {
      codeReviewRemainingPercent: data.openaiDashboard.codeReviewRemainingPercent ?? null,
      dailyBreakdown: data.openaiDashboard.dailyBreakdown ?? null
    } : null,
    stale: ageMs(targetState.lastSuccessAt) > WEB_STALE_AFTER_SECONDS * 1000,
    error: publicError(record.error)
  };
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function publicCostFromRecord(record, targetState) {
  const data = record.data ?? {};
  return {
    provider: record.provider,
    account: publicAccount(record.account),
    accountKey: publicAccountKey(record, targetState),
    source: record.source ?? data.source ?? 'codexbar',
    updatedAt: data.updatedAt ?? record.collectedAt ?? null,
    sessionTokens: numeric(data.sessionTokens),
    sessionCostUSD: numeric(data.sessionCostUSD),
    last30DaysTokens: numeric(data.last30DaysTokens ?? data.totals?.last30DaysTokens ?? data.totals?.totalTokens),
    last30DaysCostUSD: numeric(data.last30DaysCostUSD ?? data.totals?.last30DaysCostUSD ?? data.totals?.totalCost),
    error: publicError(record.error)
  };
}

function mergeCost(target, record, existing) {
  const next = publicCostFromRecord(record, target);
  if (!existing) {
    return {
      ...next,
      stale: ageMs(target.lastSuccessAt) > WEB_STALE_AFTER_SECONDS * 1000,
      targetCount: 1
    };
  }
  return {
    ...existing,
    updatedAt: maxISO([existing.updatedAt, next.updatedAt]),
    sessionTokens: numeric(existing.sessionTokens) + numeric(next.sessionTokens),
    sessionCostUSD: numeric(existing.sessionCostUSD) + numeric(next.sessionCostUSD),
    last30DaysTokens: numeric(existing.last30DaysTokens) + numeric(next.last30DaysTokens),
    last30DaysCostUSD: numeric(existing.last30DaysCostUSD) + numeric(next.last30DaysCostUSD),
    stale: existing.stale || ageMs(target.lastSuccessAt) > WEB_STALE_AFTER_SECONDS * 1000,
    targetCount: existing.targetCount + 1
  };
}

function recordSortValue(record, targetState) {
  return new Date(record.data?.updatedAt ?? record.data?.usage?.updatedAt ?? record.collectedAt ?? targetState.lastSuccessAt ?? 0).getTime();
}

function providerDisplayRank(provider) {
  const index = WEB_PROVIDER_ORDER.indexOf(String(provider ?? '').toLowerCase());
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function compareProviderDisplayOrder(a, b) {
  const rankDelta = providerDisplayRank(a.provider) - providerDisplayRank(b.provider);
  if (rankDelta) return rankDelta;
  const providerDelta = String(a.provider ?? '').localeCompare(String(b.provider ?? ''));
  if (providerDelta) return providerDelta;
  return String(a.accountKey ?? a.account ?? '').localeCompare(String(b.accountKey ?? b.account ?? ''));
}

function buildDashboard(targets, cache) {
  const usageByAccount = new Map();
  const costByAccount = new Map();
  const upstreamErrors = [];
  const sourceStates = [];

  for (const target of targets) {
    const targetState = cache.get(target.url) ?? {
      target,
      snapshot: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null
    };
    const stale = ageMs(targetState.lastSuccessAt) > WEB_STALE_AFTER_SECONDS * 1000;
    const expired = ageMs(targetState.lastSuccessAt) > WEB_EXPIRED_AFTER_SECONDS * 1000;
    sourceStates.push({
      name: target.name ?? target.url,
      lastSuccessAt: targetState.lastSuccessAt,
      lastAttemptAt: targetState.lastAttemptAt,
      stale,
      expired,
      ok: Boolean(targetState.snapshot && !targetState.lastError),
      error: publicError(targetState.lastError)
    });

    if (targetState.lastError) {
      upstreamErrors.push(`${target.name ?? target.url}: ${targetState.lastError.message}`);
    }
    for (const error of targetState.snapshot?.errors ?? []) {
      upstreamErrors.push(`${target.name ?? target.url}: ${error.message ?? 'exporter collection error'}`);
    }

    for (const record of targetState.snapshot?.records ?? []) {
      const key = accountAggregationKey(record, target);
      if (record.kind === 'usage') {
        const previous = usageByAccount.get(key);
        if (!previous || recordSortValue(record, targetState) >= recordSortValue(previous.record, previous.targetState)) {
          usageByAccount.set(key, { record, targetState });
        }
      } else if (record.kind === 'cost') {
        costByAccount.set(key, mergeCost(targetState, record, costByAccount.get(key)));
      }
    }
  }

  const lastUpdatedAt = maxISO(sourceStates.map((source) => source.lastSuccessAt));
  const failedSources = sourceStates.filter((source) => source.error).length;
  const staleSources = sourceStates.filter((source) => source.stale && source.lastSuccessAt).length;
  const expiredSources = sourceStates.filter((source) => source.expired && source.lastSuccessAt).length;
  const configuredSources = targets.length;
  if (!configuredSources) upstreamErrors.push('No exporters configured.');

  return {
    mode: 'live',
    generatedAt: nowISO(),
    privacy: {
      accountDisplay: WEB_ACCOUNT_DISPLAY
    },
    freshness: {
      lastUpdatedAt,
      stale: staleSources > 0,
      expired: expiredSources > 0,
      staleAfterSeconds: WEB_STALE_AFTER_SECONDS,
      expiredAfterSeconds: WEB_EXPIRED_AFTER_SECONDS,
      sourceCount: configuredSources,
      successfulSourceCount: sourceStates.filter((source) => source.lastSuccessAt).length,
      failedSourceCount: failedSources,
      warning: staleSources > 0 ? 'Data is stale' : failedSources > 0 ? 'Some exporters are unavailable' : null
    },
    usage: [...usageByAccount.values()]
      .map(({ record, targetState }) => publicUsage(record, targetState))
      .sort(compareProviderDisplayOrder),
    cost: [...costByAccount.values()].sort(compareProviderDisplayOrder),
    upstreamErrors: [...new Set(upstreamErrors.filter(Boolean))]
  };
}

function registerWebRoutes(runtime) {
  app.get('/api/health', (_request, response) => {
    const dashboard = runtime.buildDashboard();
    response.json({
      ok: true,
      role: 'web',
      exporters: runtime.targets.length,
      freshness: dashboard.freshness
    });
  });

  app.get('/api/dashboard', (_request, response) => {
    response.json(runtime.buildDashboard());
  });

  app.get('/api/usage', (_request, response) => {
    response.json(runtime.buildDashboard().usage);
  });

  app.get('/api/cost', (_request, response) => {
    response.json(runtime.buildDashboard().cost);
  });

  app.post('/api/refresh', async (_request, response) => {
    await runtime.refreshAll();
    response.json(runtime.buildDashboard());
  });
}

async function initWeb() {
  await ensureParentDir(WEB_SQLITE_PATH);
  const db = openPollDatabase();
  const targets = await loadWebTargets();
  const runtime = createWebRuntime(db, targets);
  registerWebRoutes(runtime);
  runtime.pollAll().catch((error) => {
    console.error(redactText(error instanceof Error ? error.message : String(error)));
  });
  if (WEB_EXPORTER_POLL_SECONDS > 0) {
    setInterval(() => {
      runtime.pollAll().catch((error) => {
        console.error(redactText(error instanceof Error ? error.message : String(error)));
      });
    }, WEB_EXPORTER_POLL_SECONDS * 1000).unref();
  }
}

function registerStaticRoutes() {
  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'Not found' });
  });

  if (APP_ROLE !== 'web') {
    app.use((_request, response) => {
      response.status(404).json({ error: 'Not found' });
    });
    return;
  }

  app.use(express.static(STATIC_DIR, {
    fallthrough: true,
    maxAge: '1h'
  }));

  app.use((_request, response) => {
    response.sendFile(path.join(STATIC_DIR, 'index.html'));
  });
}

if (APP_ROLE === 'exporter') {
  await initExporter();
} else if (APP_ROLE === 'web') {
  await initWeb();
} else {
  throw new Error(`Unsupported APP_ROLE: ${APP_ROLE}`);
}

registerStaticRoutes();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`agent-usage-${APP_ROLE} listening on http://0.0.0.0:${PORT}`);
});
