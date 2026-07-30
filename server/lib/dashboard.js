import { createHash } from 'node:crypto';

import { issueCode, issueOperation, issueProvider, publicUpstreamIssue, upstreamIssueKey } from './issues.js';
import { publicError, publicText } from './sanitize.js';
import { ageMs, maxISO, minISO, nowISO } from './util.js';

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Aggregation identity: provider + Account Key. Unknown identities are scoped
 * to the scrape target AND the row, so distinct unidentified rows never merge.
 */
function accountAggregationKey(record, target, rowIndex = 0) {
  const provider = record.provider ?? 'unknown';
  const accountKey = record.account?.key ?? 'unknown:local';
  const stableAccountKey = accountKey === 'unknown:local'
    ? `${target.url}:unknown:local:${record.kind ?? 'record'}:${rowIndex}`
    : accountKey;
  return `${provider}\u0000${stableAccountKey}`;
}

function publicTargetName(target) {
  if (target.name) return publicText(target.name, 'Exporter').slice(0, 120);
  try {
    return new URL(target.url).origin;
  } catch {
    return 'Exporter';
  }
}

/**
 * The timestamp the data itself was produced. Staleness must track data age,
 * not merely whether the exporter answered the last poll, so take the older of
 * the snapshot's generation time and the poll success time (also guards
 * against exporter clock skew).
 */
function dataUpdatedAt(targetState) {
  return minISO([targetState.snapshot?.generatedAt, targetState.lastSuccessAt]) ??
    targetState.lastSuccessAt ?? null;
}

export function createDashboardBuilder({ accountDisplay, staleAfterSeconds, expiredAfterSeconds, providerOrder }) {
  const staleMs = staleAfterSeconds * 1000;
  const expiredMs = expiredAfterSeconds * 1000;

  function isStale(targetState) {
    return ageMs(dataUpdatedAt(targetState)) > staleMs;
  }

  function publicAccount(account) {
    if (!account || accountDisplay === 'hidden') return null;
    if (accountDisplay === 'full') {
      return account.email ?? account.label ?? account.key ?? null;
    }
    return account.label ?? null;
  }

  function publicAccountKey(aggregationKey, provider) {
    const digest = createHash('sha256').update(aggregationKey).digest('base64url').slice(0, 18);
    return `${provider}:${digest}`;
  }

  function publicUsageIdentity(identity, account) {
    if (!identity && !account) return null;
    return {
      providerID: accountDisplay === 'hidden' ? null : identity?.providerID ?? null,
      accountEmail: accountDisplay === 'full' ? (account?.email ?? identity?.accountEmail ?? null) : null,
      accountOrganization: accountDisplay === 'full' ? (account?.organization ?? identity?.accountOrganization ?? null) : null,
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

  function publicUsage({ record, targetState, aggregationKey }) {
    const data = record.data ?? {};
    const usage = data.usage ?? null;
    return {
      provider: record.provider,
      account: publicAccount(record.account),
      accountKey: publicAccountKey(aggregationKey, record.provider),
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
      stale: isStale(targetState),
      error: publicError(record.error)
    };
  }

  function publicCostFromRecord({ record, targetState, aggregationKey }) {
    const data = record.data ?? {};
    return {
      provider: record.provider,
      account: publicAccount(record.account),
      accountKey: publicAccountKey(aggregationKey, record.provider),
      source: record.source ?? data.source ?? 'codexbar',
      updatedAt: data.updatedAt ?? record.collectedAt ?? null,
      sessionTokens: numeric(data.sessionTokens),
      sessionCostUSD: numeric(data.sessionCostUSD),
      last30DaysTokens: numeric(data.last30DaysTokens ?? data.totals?.last30DaysTokens ?? data.totals?.totalTokens),
      last30DaysCostUSD: numeric(data.last30DaysCostUSD ?? data.totals?.last30DaysCostUSD ?? data.totals?.totalCost),
      stale: isStale(targetState),
      error: publicError(record.error)
    };
  }

  function recordSortValue(record, targetState) {
    return new Date(record.data?.updatedAt ?? record.data?.usage?.updatedAt ?? record.collectedAt ?? targetState.lastSuccessAt ?? 0).getTime();
  }

  function providerDisplayRank(provider) {
    const index = providerOrder.indexOf(String(provider ?? '').toLowerCase());
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  }

  function compareProviderDisplayOrder(a, b) {
    const rankDelta = providerDisplayRank(a.provider) - providerDisplayRank(b.provider);
    if (rankDelta) return rankDelta;
    const providerDelta = String(a.provider ?? '').localeCompare(String(b.provider ?? ''));
    if (providerDelta) return providerDelta;
    return String(a.accountKey ?? a.account ?? '').localeCompare(String(b.accountKey ?? b.account ?? ''));
  }

  function deriveSourceState(target, targetState) {
    const updatedAt = dataUpdatedAt(targetState);
    return {
      name: publicTargetName(target),
      updatedAt,
      lastSuccessAt: targetState.lastSuccessAt,
      lastAttemptAt: targetState.lastAttemptAt,
      stale: ageMs(updatedAt) > staleMs,
      expired: ageMs(updatedAt) > expiredMs,
      ok: Boolean(targetState.snapshot && !targetState.lastError),
      error: publicError(targetState.lastError)
    };
  }

  /**
   * Raw collector stderr issues are redundant when a structured issue exists
   * for the same provider and operation (the exporter folds stderr into
   * `details`). Covers both current per-provider codes and the legacy code.
   */
  function isRedundantStderrIssue(error, snapshotErrors) {
    const code = String(error?.code ?? '');
    const match = /^codexbar(?:-([a-z0-9-]+))?-(usage|cost)-stderr$/.exec(code);
    if (!match) return false;
    const [, provider, operation] = match;
    return snapshotErrors.some((other) => {
      const otherCode = String(other?.code ?? '');
      if (provider) return otherCode === `${operation}-${provider}` || otherCode === `${operation}-${provider}-failed`;
      return new RegExp(`^${operation}-[a-z0-9-]+$`).test(otherCode);
    });
  }

  function buildDashboard(targets, cache) {
    const usageByAccount = new Map();
    const costByTargetAccount = new Map();
    const upstreamIssues = [];
    const upstreamIssueKeys = new Set();
    const reportedRecordCodes = new Set();
    const sourceStates = [];

    function addUpstreamIssue(issue) {
      const key = upstreamIssueKey(issue);
      if (upstreamIssueKeys.has(key)) return;
      upstreamIssueKeys.add(key);
      upstreamIssues.push(issue);
    }

    for (const target of targets) {
      const targetState = cache.get(target.url) ?? {
        target,
        snapshot: null,
        lastSuccessAt: null,
        lastAttemptAt: null,
        lastError: null
      };
      const source = publicTargetName(target);
      sourceStates.push(deriveSourceState(target, targetState));

      if (targetState.lastError) {
        addUpstreamIssue(publicUpstreamIssue(source, targetState.lastError, {
          code: 'fetch-failed',
          operation: 'poll',
          occurredAt: targetState.lastAttemptAt
        }));
      }

      const snapshotErrors = targetState.snapshot?.errors ?? [];
      for (const error of snapshotErrors) {
        if (isRedundantStderrIssue(error, snapshotErrors)) continue;
        addUpstreamIssue(publicUpstreamIssue(source, error, {
          code: 'exporter-collection-error',
          operation: 'collection',
          occurredAt: targetState.snapshot?.generatedAt ?? targetState.lastSuccessAt
        }));
      }

      const records = targetState.snapshot?.records ?? [];
      records.forEach((record, rowIndex) => {
        if (record.error) {
          const provider = issueProvider(record.provider);
          const operation = issueOperation(record.kind);
          const code = issueCode(`${operation}-${provider ?? 'unknown'}`);
          const recordCodeKey = `${source}\u0000${code}`;
          if (!reportedRecordCodes.has(recordCodeKey)) {
            reportedRecordCodes.add(recordCodeKey);
            addUpstreamIssue(publicUpstreamIssue(source, record.error, {
              code,
              provider,
              operation,
              occurredAt: record.collectedAt ?? targetState.lastSuccessAt
            }));
          }
          return;
        }

        const aggregationKey = accountAggregationKey(record, target, rowIndex);
        if (record.kind === 'usage') {
          const previous = usageByAccount.get(aggregationKey);
          if (!previous || recordSortValue(record, targetState) >= recordSortValue(previous.record, previous.targetState)) {
            usageByAccount.set(aggregationKey, { record, targetState, aggregationKey });
          }
        } else if (record.kind === 'cost') {
          // Stage 1 (spec: per-target replacement): within one target the
          // freshest row per provider+account wins; rows are never summed.
          const targetKey = `${target.url}\u0000${aggregationKey}`;
          const previous = costByTargetAccount.get(targetKey);
          if (!previous || recordSortValue(record, targetState) >= recordSortValue(previous.record, previous.targetState)) {
            costByTargetAccount.set(targetKey, { record, targetState, aggregationKey });
          }
        }
      });
    }

    // Stage 2 (spec: aggregate across exporters): sum per-target rows by
    // provider + account key, counting each contributing target once.
    const costByAccount = new Map();
    for (const entry of costByTargetAccount.values()) {
      const next = publicCostFromRecord(entry);
      const existing = costByAccount.get(entry.aggregationKey);
      if (!existing) {
        costByAccount.set(entry.aggregationKey, { ...next, targetCount: 1 });
      } else {
        costByAccount.set(entry.aggregationKey, {
          ...existing,
          updatedAt: maxISO([existing.updatedAt, next.updatedAt]),
          sessionTokens: existing.sessionTokens + next.sessionTokens,
          sessionCostUSD: existing.sessionCostUSD + next.sessionCostUSD,
          last30DaysTokens: existing.last30DaysTokens + next.last30DaysTokens,
          last30DaysCostUSD: existing.last30DaysCostUSD + next.last30DaysCostUSD,
          stale: existing.stale || next.stale,
          targetCount: existing.targetCount + 1
        });
      }
    }

    const lastUpdatedAt = maxISO(sourceStates.map((source) => source.updatedAt));
    const failedSources = sourceStates.filter((source) => source.error).length;
    const staleSources = sourceStates.filter((source) => source.stale && source.lastSuccessAt).length;
    const expiredSources = sourceStates.filter((source) => source.expired && source.lastSuccessAt).length;
    const configuredSources = targets.length;
    if (!configuredSources) {
      addUpstreamIssue(publicUpstreamIssue('Web aggregator', {
        code: 'no-exporters-configured',
        message: 'No exporters configured.',
        operation: 'config'
      }));
    }

    const warning = failedSources > 0
      ? 'Some exporters are unavailable'
      : expiredSources > 0
        ? 'Data has expired'
        : staleSources > 0
          ? 'Data is stale'
          : null;

    return {
      mode: 'live',
      generatedAt: nowISO(),
      privacy: {
        accountDisplay
      },
      freshness: {
        lastUpdatedAt,
        stale: staleSources > 0,
        expired: expiredSources > 0,
        staleAfterSeconds,
        expiredAfterSeconds,
        sourceCount: configuredSources,
        successfulSourceCount: sourceStates.filter((source) => source.lastSuccessAt).length,
        failedSourceCount: failedSources,
        warning
      },
      usage: [...usageByAccount.values()]
        .map(publicUsage)
        .sort(compareProviderDisplayOrder),
      cost: [...costByAccount.values()].sort(compareProviderDisplayOrder),
      upstreamIssues,
      upstreamErrors: upstreamIssues.map((issue) => `${issue.source}: ${issue.message}`)
    };
  }

  return { buildDashboard };
}
