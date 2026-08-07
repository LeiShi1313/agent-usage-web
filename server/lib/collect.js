import fs from 'node:fs/promises';

import { deriveAccount, providerFromRow } from './identity.js';
import { makeIssue } from './issues.js';
import { publicError, publicText, redactText } from './sanitize.js';
import { asArray, cloneJSON, nowISO } from './util.js';

export const CODEX_USAGE_SOURCES = new Set(['auto', 'web', 'cli', 'oauth', 'api']);

export function collectorLogDetail(value) {
  const messages = String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const entry = JSON.parse(line);
        return entry?.message ?? entry?.description ?? line;
      } catch {
        return line;
      }
    });
  return publicText([...new Set(messages)].join(' · '), 'Collector command reported an error.');
}

export function makeSnapshot({ status = 'initializing', records = [], errors = [], startedAt = null, finishedAt = null, reason, hostname = null } = {}) {
  const snapshot = {
    schemaVersion: 1,
    generatedAt: nowISO(),
    exporter: {
      role: 'exporter',
      hostname
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
  if (reason) snapshot.collection.reason = reason;
  return snapshot;
}

export function usageRecordsFromRows(rows, collectedAt) {
  const usageAccountsByProvider = new Map();
  const records = [];
  const issues = [];

  for (const row of rows) {
    const provider = providerFromRow(row);
    const account = deriveAccount(row, provider);
    const error = publicError(row?.error);
    records.push({
      kind: 'usage',
      provider,
      source: row?.source ?? null,
      collectedAt,
      account,
      data: cloneJSON(row),
      error
    });

    if (account.key !== 'unknown:local' && !error) {
      const accounts = usageAccountsByProvider.get(provider) ?? [];
      if (!accounts.some((item) => item.key === account.key)) accounts.push(account);
      usageAccountsByProvider.set(provider, accounts);
    }
    if (error) {
      issues.push(makeIssue(
        `${provider} usage: ${error.message ?? 'provider error'}`,
        `usage-${provider}`,
        { provider, operation: 'usage' }
      ));
    }
  }

  return { records, issues, usageAccountsByProvider };
}

export function costRecordsFromRows(rows, collectedAt, usageAccountsByProvider) {
  const records = [];
  const issues = [];
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
      issues.push(makeIssue(
        `${provider} cost: ${error.message ?? 'provider error'}`,
        `cost-${provider}`,
        { provider, operation: 'cost' }
      ));
    }
  }
  return { records, issues };
}

export function mergeUsageAccounts(target, source) {
  for (const [provider, accounts] of source) {
    const existing = target.get(provider) ?? [];
    for (const account of accounts) {
      if (!existing.some((item) => item.key === account.key)) existing.push(account);
    }
    target.set(provider, existing);
  }
}

/**
 * Fold collector stderr into the provider issue when one exists, otherwise
 * surface the stderr as its own issue. Shared by the usage and cost paths.
 */
export function attachStderrDetails(issues, commandError, { provider, operation }) {
  if (!commandError) return issues;
  const details = collectorLogDetail(commandError);
  const providerIssue = issues.find((issue) => issue.provider === provider && issue.operation === operation);
  if (providerIssue) {
    providerIssue.details = details;
    return issues;
  }
  return [
    ...issues,
    makeIssue(details, `codexbar-${provider}-${operation}-stderr`, { provider, operation })
  ];
}

export function createCollector({ config, runCommand }) {
  const {
    commandTimeoutMs,
    usageProviders: usageProvidersOverride,
    usageProvidersFallback,
    costProvider,
    codexUsageSource,
    codexbarConfigPath
  } = config;

  async function runCodexBarJSON(args, timeoutMs = commandTimeoutMs) {
    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await runCommand('codexbar', args, {
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

  async function validateCodexBarConfig(errors) {
    if (!codexbarConfigPath) return true;
    try {
      const stat = await fs.stat(codexbarConfigPath);
      if (stat.isFile()) return true;
    } catch {
      errors.push(makeIssue(`CODEXBAR_CONFIG does not exist: ${codexbarConfigPath}`, 'codexbar-config-missing'));
      return false;
    }
    errors.push(makeIssue(`CODEXBAR_CONFIG is not a file: ${codexbarConfigPath}`, 'codexbar-config-invalid'));
    return false;
  }

  async function readCodexBarConfig() {
    if (!codexbarConfigPath) return null;
    const raw = JSON.parse(await fs.readFile(codexbarConfigPath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  }

  /**
   * Resolve which providers the exporter should scrape.
   * Preference: EXPORTER_USAGE_PROVIDERS env → enabled entries in CodexBar config → fallback.
   */
  async function resolveUsageProviders(errors) {
    if (usageProvidersOverride.length) return usageProvidersOverride;

    try {
      const codexbarConfig = await readCodexBarConfig();
      const fromConfig = asArray(codexbarConfig?.providers)
        .filter((entry) => entry && entry.id != null && entry.enabled !== false)
        .map((entry) => String(entry.id).trim().toLowerCase())
        .filter(Boolean);
      const unique = [...new Set(fromConfig)];
      if (unique.length) return unique;
    } catch (error) {
      if (codexbarConfigPath) {
        errors.push(makeIssue(
          `Failed to read usage providers from CodexBar config: ${error instanceof Error ? error.message : String(error)}`,
          'codexbar-providers-unreadable',
          { operation: 'config' }
        ));
      }
    }

    return [...usageProvidersFallback];
  }

  function configuredCodexUsageSource(errors) {
    if (!codexUsageSource) return null;
    if (CODEX_USAGE_SOURCES.has(codexUsageSource)) return codexUsageSource;
    errors.push(makeIssue(
      `EXPORTER_CODEX_USAGE_SOURCE must be one of: ${[...CODEX_USAGE_SOURCES].join(', ')}`,
      'codex-usage-source-invalid',
      { provider: 'codex', operation: 'config' }
    ));
    return null;
  }

  async function collectUsageProvider(provider, errors) {
    const args = ['usage', '--format', 'json', '--json-only', '--provider', provider];
    if (provider === 'codex') {
      const source = configuredCodexUsageSource(errors);
      if (source) args.push('--source', source);
    }

    const result = await runCodexBarJSON(args);
    const rows = asArray(result.data).map((row) => ({ ...row, provider }));
    const usage = usageRecordsFromRows(rows, nowISO());
    let issues = attachStderrDetails(usage.issues, result.commandError, { provider, operation: 'usage' });

    if (!rows.length && !issues.length) {
      issues = [makeIssue(`${provider} usage returned no data.`, `usage-${provider}-empty`, {
        provider,
        operation: 'usage'
      })];
    }

    return { records: usage.records, issues, usageAccountsByProvider: usage.usageAccountsByProvider };
  }

  async function collectCostProvider(provider, usageAccountsByProvider) {
    const result = await runCodexBarJSON([
      'cost', '--refresh', '--format', 'json', '--json-only', '--provider', provider
    ]);
    const rows = asArray(result.data).map((row) => ({ ...row, provider }));
    if (rows.some((row) => row.historyCoverageIsEstablished === false)) {
      throw new Error(`${provider} cost history is still indexing.`);
    }
    if (provider === 'codex' && rows.some((row) => row.historyCoverageIsEstablished !== true)) {
      throw new Error(`${provider} cost history completion marker is missing.`);
    }
    const cost = costRecordsFromRows(rows, nowISO(), usageAccountsByProvider);
    const issues = attachStderrDetails(cost.issues, result.commandError, { provider, operation: 'cost' });
    return { records: cost.records, issues };
  }

  /**
   * Run a full collection. `previous` is the prior snapshot; scopes that fail
   * carry forward their previous records so a bad refresh never blanks data
   * (spec: "Failed refresh keeps the previous good snapshot and records errors").
   */
  async function collectSnapshot({ reason, previous = null, hostname = null } = {}) {
    const startedAt = nowISO();
    const errors = [];
    const records = [];

    const hasConfig = await validateCodexBarConfig(errors);
    if (!hasConfig) {
      const carried = previous?.records ?? [];
      return makeSnapshot({
        status: carried.length ? 'partial' : 'error',
        records: carried,
        errors,
        startedAt,
        finishedAt: nowISO(),
        reason,
        hostname
      });
    }

    const usageAccountsByProvider = new Map();
    const usageProviders = await resolveUsageProviders(errors);
    const failedScopes = [];
    for (const provider of usageProviders) {
      try {
        const usage = await collectUsageProvider(provider, errors);
        records.push(...usage.records);
        errors.push(...usage.issues);
        mergeUsageAccounts(usageAccountsByProvider, usage.usageAccountsByProvider);
      } catch (error) {
        failedScopes.push({ kind: 'usage', provider });
        errors.push(makeIssue(
          `${provider} usage collection failed: ${error instanceof Error ? error.message : String(error)}`,
          `usage-${provider}-failed`,
          { provider, operation: 'usage' }
        ));
      }
    }

    try {
      const cost = await collectCostProvider(costProvider, usageAccountsByProvider);
      records.push(...cost.records);
      errors.push(...cost.issues);
    } catch (error) {
      failedScopes.push({ kind: 'cost', provider: costProvider });
      errors.push(makeIssue(
        `${costProvider} cost collection failed: ${error instanceof Error ? error.message : String(error)}`,
        `cost-${costProvider}-failed`,
        { provider: costProvider, operation: 'cost' }
      ));
    }

    // Carry forward the previous snapshot's records for scopes that failed
    // outright, so a transient collector failure does not blank the data.
    for (const scope of failedScopes) {
      const carried = (previous?.records ?? []).filter((record) => (
        record.kind === scope.kind && record.provider === scope.provider && !record.error
      ));
      records.push(...carried);
    }

    const finishedAt = nowISO();
    const status = errors.length ? (records.length ? 'partial' : 'error') : (records.length ? 'ok' : 'error');
    return makeSnapshot({ status, records, errors, startedAt, finishedAt, reason, hostname });
  }

  return { collectSnapshot };
}
