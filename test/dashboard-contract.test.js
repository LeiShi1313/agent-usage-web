import assert from 'node:assert/strict';
import test from 'node:test';

import { createDashboardBuilder } from '../server/lib/dashboard.js';

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function makeTarget(n) {
  return { url: `http://exporter-${n}:1`, name: `X${n}`, id: n };
}

function account(key = 'acct_1', email = 'a@b.com') {
  return { key, label: email ?? key, email, organization: null, identitySource: 'codexbar' };
}

function usageRecord({ updatedAt, acct, provider = 'codex' }) {
  return {
    kind: 'usage',
    provider,
    source: 'oauth',
    collectedAt: updatedAt,
    account: acct,
    data: {},
    error: null
  };
}

function costRecord({ updatedAt, acct, provider = 'codex' }) {
  return {
    kind: 'cost',
    provider,
    source: 'local',
    collectedAt: updatedAt,
    account: acct,
    data: {},
    error: null
  };
}

function snapshotOf(records, generatedAt) {
  return {
    schemaVersion: 1,
    generatedAt,
    exporter: { role: 'exporter', hostname: null },
    collection: {
      status: 'ok',
      startedAt: generatedAt,
      finishedAt: generatedAt,
      recordCount: records.length
    },
    records,
    errors: []
  };
}

function cacheFor(target, snapshot, timestamp) {
  return new Map([[
    target.url,
    {
      target,
      snapshot,
      lastSuccessAt: timestamp,
      lastAttemptAt: timestamp,
      lastError: null
    }
  ]]);
}

function makeBuilder() {
  return createDashboardBuilder({
    accountDisplay: 'full',
    staleAfterSeconds: 600,
    expiredAfterSeconds: 86_400,
    providerOrder: ['codex', 'antigravity', 'grok']
  });
}

test('dashboard payload matches the frontend contract for complete usage and cost rows', () => {
  const timestamp = isoAgo(1_000);
  const target = makeTarget(1);
  const providerAccount = {
    ...account('stable-provider-id', 'display@example.com'),
    organization: 'Example Org'
  };
  const usage = usageRecord({ updatedAt: timestamp, acct: providerAccount });
  usage.data = {
    version: '1.2.3',
    status: {
      indicator: 'none',
      description: 'All systems operational',
      updatedAt: timestamp,
      url: 'https://status.example.com'
    },
    usage: {
      primary: {
        usedPercent: 20,
        windowMinutes: 300,
        resetsAt: timestamp,
        resetDescription: 'Soon',
        nextRegenPercent: 5
      },
      secondary: { usedPercent: 30, windowMinutes: 10_080 },
      tertiary: { usedPercent: 40, windowMinutes: 43_200 },
      extraRateWindows: [{
        id: 'bonus',
        title: 'Bonus limit',
        window: { usedPercent: 50, windowMinutes: 60 }
      }],
      updatedAt: timestamp,
      identity: {
        providerID: 'provider-account-id',
        accountEmail: 'display@example.com',
        accountOrganization: 'Example Org',
        loginMethod: 'oauth'
      }
    },
    credits: { remaining: 12, updatedAt: timestamp },
    openaiDashboard: {
      codeReviewRemainingPercent: 75,
      dailyBreakdown: [{ day: '2026-07-30', totalCreditsUsed: 2 }]
    }
  };
  const cost = costRecord({ updatedAt: timestamp, acct: providerAccount });
  cost.data = {
    updatedAt: timestamp,
    sessionTokens: 10,
    sessionCostUSD: 0.1,
    last30DaysTokens: 100,
    last30DaysCostUSD: 1
  };
  const cache = cacheFor(target, snapshotOf([usage, cost], timestamp), timestamp);

  const dashboard = makeBuilder().buildDashboard([target], cache);
  const publicAccountKey = dashboard.usage[0].accountKey;

  assert.match(dashboard.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(dashboard, {
    mode: 'live',
    generatedAt: dashboard.generatedAt,
    privacy: { accountDisplay: 'full' },
    freshness: {
      lastUpdatedAt: timestamp,
      stale: false,
      expired: false,
      staleAfterSeconds: 600,
      expiredAfterSeconds: 86_400,
      sourceCount: 1,
      successfulSourceCount: 1,
      failedSourceCount: 0,
      warning: null
    },
    usage: [{
      provider: 'codex',
      account: 'display@example.com',
      accountKey: publicAccountKey,
      version: '1.2.3',
      source: 'oauth',
      status: {
        indicator: 'none',
        description: 'All systems operational',
        updatedAt: timestamp,
        url: 'https://status.example.com'
      },
      usage: {
        primary: {
          usedPercent: 20,
          windowMinutes: 300,
          resetsAt: timestamp,
          resetDescription: 'Soon',
          nextRegenPercent: 5
        },
        secondary: {
          usedPercent: 30,
          windowMinutes: 10_080,
          resetsAt: null,
          resetDescription: null,
          nextRegenPercent: null
        },
        tertiary: {
          usedPercent: 40,
          windowMinutes: 43_200,
          resetsAt: null,
          resetDescription: null,
          nextRegenPercent: null
        },
        extraRateWindows: [{
          id: 'bonus',
          title: 'Bonus limit',
          window: {
            usedPercent: 50,
            windowMinutes: 60,
            resetsAt: null,
            resetDescription: null,
            nextRegenPercent: null
          }
        }],
        updatedAt: timestamp,
        identity: {
          providerID: 'provider-account-id',
          accountEmail: 'display@example.com',
          accountOrganization: 'Example Org',
          loginMethod: 'oauth'
        }
      },
      credits: { remaining: 12, updatedAt: timestamp },
      openaiDashboard: {
        codeReviewRemainingPercent: 75,
        dailyBreakdown: [{ day: '2026-07-30', totalCreditsUsed: 2 }]
      },
      stale: false,
      error: null
    }],
    cost: [{
      provider: 'codex',
      account: 'display@example.com',
      accountKey: publicAccountKey,
      source: 'local',
      updatedAt: timestamp,
      sessionTokens: 10,
      sessionCostUSD: 0.1,
      last30DaysTokens: 100,
      last30DaysCostUSD: 1,
      stale: false,
      error: null,
      targetCount: 1
    }],
    upstreamIssues: [],
    upstreamErrors: []
  });
});
