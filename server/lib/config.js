import fs from 'node:fs/promises';
import path from 'node:path';

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

export function loadConfig(env) {
  const homeDir = env.HOME ?? '/home/node';
  const xdgCacheHome = env.XDG_CACHE_HOME ?? path.join(homeDir, '.cache');
  const xdgDataHome = env.XDG_DATA_HOME ?? path.join(homeDir, '.local', 'share');

  return Object.freeze({
    role: (env.APP_ROLE ?? 'web').trim().toLowerCase(),
    port: Number(env.PORT ?? 3000),
    hostname: env.HOSTNAME ?? null,
    exporter: Object.freeze({
      token: env.EXPORTER_TOKEN ?? '',
      refreshSeconds: numberEnv(env.EXPORTER_REFRESH_SECONDS, 300),
      refreshMinIntervalSeconds: numberEnv(env.EXPORTER_REFRESH_MIN_INTERVAL_SECONDS, 60),
      commandTimeoutMs: numberEnv(env.EXPORTER_COMMAND_TIMEOUT_MS, 90_000),
      snapshotCachePath: env.EXPORTER_SNAPSHOT_CACHE_PATH ??
        path.join(xdgCacheHome, 'agent-usage-web', 'exporter-snapshot.json'),
      // Optional allowlist override. When unset, enabled providers come from CodexBar config.
      usageProviders: parseProviderOrder(env.EXPORTER_USAGE_PROVIDERS ?? ''),
      usageProvidersFallback: ['codex', 'antigravity'],
      costProvider: env.EXPORTER_COST_PROVIDER?.trim().toLowerCase() || 'codex',
      codexUsageSource: String(env.EXPORTER_CODEX_USAGE_SOURCE ?? '').trim().toLowerCase(),
      codexbarConfigPath: env.CODEXBAR_CONFIG ?? null
    }),
    web: Object.freeze({
      accountDisplay: normalizeAccountDisplay(env.WEB_ACCOUNT_DISPLAY ?? 'hidden'),
      pollSeconds: numberEnv(env.WEB_EXPORTER_POLL_SECONDS, 60),
      staleAfterSeconds: numberEnv(env.WEB_STALE_AFTER_SECONDS, 600),
      expiredAfterSeconds: numberEnv(env.WEB_EXPIRED_AFTER_SECONDS, 86_400),
      pollTimeoutMs: numberEnv(env.WEB_POLL_TIMEOUT_MS, 75_000),
      refreshMinIntervalSeconds: numberEnv(env.WEB_REFRESH_MIN_INTERVAL_SECONDS, 30),
      pollRetentionDays: numberEnv(env.WEB_POLL_RETENTION_DAYS, 30),
      sqlitePath: env.WEB_SQLITE_PATH ??
        path.join(xdgDataHome, 'agent-usage-web', 'polls.sqlite'),
      providerOrder: parseProviderOrder(env.WEB_PROVIDER_ORDER ?? 'codex,antigravity,grok')
    })
  });
}

function firstString(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function readTargetConfigFromEnv(env) {
  const rawJSON = env.WEB_EXPORTERS_JSON;
  if (rawJSON?.trim()) return JSON.parse(rawJSON);

  const singleUrl = env.WEB_EXPORTER_URL;
  const singleToken = env.WEB_EXPORTER_TOKEN;
  if (singleUrl && singleToken) {
    return [{ url: singleUrl, token: singleToken, name: env.WEB_EXPORTER_NAME ?? null }];
  }
  return null;
}

export async function loadWebTargets(env) {
  let raw = null;
  const configPath = env.WEB_EXPORTERS_CONFIG ?? env.WEB_EXPORTERS_FILE;
  if (configPath) {
    raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } else {
    raw = readTargetConfigFromEnv(env);
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
