import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachStderrDetails,
  collectorLogDetail,
  costRecordsFromRows,
  createCollector,
  makeSnapshot,
  mergeUsageAccounts,
  usageRecordsFromRows
} from '../server/lib/collect.js';
import { deriveAccount, looksLikeEmail, providerFromRow } from '../server/lib/identity.js';

const COLLECTED_AT = '2026-07-20T10:00:00.000Z';

test('deriveAccount prefers the stable id over email for the Account Key', () => {
  const account = deriveAccount({ accountKey: 'acct_1', email: 'a@b.com' }, 'codex');
  assert.equal(account.key, 'acct_1');
  assert.equal(account.email, 'a@b.com');
  assert.equal(account.identitySource, 'codexbar');
});

test('deriveAccount uses the email as key when it is the only identity', () => {
  const account = deriveAccount({ email: 'a@b.com' }, 'codex');
  assert.equal(account.key, 'a@b.com');
  assert.equal(account.email, 'a@b.com');
  assert.equal(account.identitySource, 'codexbar');
});

test('deriveAccount treats a string account that looks like an email as identity', () => {
  const account = deriveAccount({ account: 'user@x.com' }, 'codex');
  assert.equal(account.key, 'user@x.com');
  assert.equal(account.email, 'user@x.com');
  assert.equal(account.label, 'user@x.com');
});

test('deriveAccount with no identity yields unknown:local', () => {
  const account = deriveAccount({}, 'codex');
  assert.equal(account.key, 'unknown:local');
  assert.equal(account.identitySource, 'unknown');
  assert.equal(account.email, null);
  assert.equal(account.label, null);
});

test('deriveAccount passes fallback account fields through when the row has none', () => {
  const fallback = {
    key: 'acct_9',
    label: 'Fallback Label',
    email: 'f@x.com',
    organization: 'Org',
    identitySource: 'single-local-usage-account'
  };
  const account = deriveAccount({}, 'codex', fallback);
  assert.equal(account.key, 'acct_9');
  assert.equal(account.label, 'Fallback Label');
  assert.equal(account.email, 'f@x.com');
  assert.equal(account.organization, 'Org');
  // NOTE(current behavior): because the fallback key feeds into `key`, the
  // `key ? 'codexbar' : fallback.identitySource` branch always resolves to
  // 'codexbar' for fallback-derived accounts, so the fallback's
  // 'single-local-usage-account' marker never surfaces. The marker written by
  // costRecordsFromRows is therefore effectively unreachable — see report.
  assert.equal(account.identitySource, 'codexbar');
});

test('looksLikeEmail accepts emails and rejects non-emails', () => {
  assert.equal(looksLikeEmail('a@b.com'), true);
  assert.equal(looksLikeEmail('acct_1'), false);
  assert.equal(looksLikeEmail('a b@c.com'), false);
  assert.equal(looksLikeEmail(null), false);
});

test('providerFromRow prefers row.provider, then usage identity, then identity, lowercased', () => {
  assert.equal(providerFromRow({
    provider: 'Codex',
    usage: { identity: { providerID: 'grok' } },
    identity: { providerID: 'claude' }
  }), 'codex');
  assert.equal(providerFromRow({
    usage: { identity: { providerID: 'Grok' } },
    identity: { providerID: 'claude' }
  }), 'grok');
  assert.equal(providerFromRow({ identity: { providerID: 'claude' } }), 'claude');
  assert.equal(providerFromRow({}), 'unknown');
  assert.equal(providerFromRow(null), 'unknown');
});

test('usageRecordsFromRows returns records, provider-coded issues and identified accounts', () => {
  const rows = [
    { provider: 'codex', accountKey: 'acct_1', email: 'a@b.com', usage: { primary: { usedPercent: 20 } } },
    { provider: 'grok', error: { message: 'grok exploded' } },
    { provider: 'antigravity' } // no identity, no error
  ];
  const { records, issues, usageAccountsByProvider } = usageRecordsFromRows(rows, COLLECTED_AT);

  assert.equal(records.length, 3);
  assert.equal(records[0].kind, 'usage');
  assert.equal(records[0].collectedAt, COLLECTED_AT);
  assert.equal(records[0].account.key, 'acct_1');
  assert.equal(records[0].error, null);
  assert.equal(records[1].error.message, 'grok exploded');

  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'usage-grok');
  assert.equal(issues[0].provider, 'grok');
  assert.equal(issues[0].operation, 'usage');

  // Only non-error rows with a real identity land in the accounts map.
  assert.deepEqual([...usageAccountsByProvider.keys()], ['codex']);
  assert.equal(usageAccountsByProvider.get('codex').length, 1);
  assert.equal(usageAccountsByProvider.get('codex')[0].key, 'acct_1');
});

test('usageRecordsFromRows excludes error rows even when they carry an identity', () => {
  const rows = [{ provider: 'codex', accountKey: 'acct_1', error: { message: 'nope' } }];
  const { usageAccountsByProvider } = usageRecordsFromRows(rows, COLLECTED_AT);
  assert.equal(usageAccountsByProvider.size, 0);
});

test('costRecordsFromRows applies the single-local-usage-account fallback', () => {
  const usage = usageRecordsFromRows(
    [{ provider: 'codex', accountKey: 'acct_1', email: 'a@b.com' }],
    COLLECTED_AT
  );
  const { records, issues } = costRecordsFromRows(
    [{ provider: 'codex', last30DaysCostUSD: 5 }],
    COLLECTED_AT,
    usage.usageAccountsByProvider
  );
  assert.equal(issues.length, 0);
  assert.equal(records[0].kind, 'cost');
  assert.equal(records[0].account.key, 'acct_1');
  assert.equal(records[0].account.email, 'a@b.com');
  // NOTE(current behavior): collect.js tags the fallback with identitySource
  // 'single-local-usage-account', but deriveAccount overrides it back to
  // 'codexbar' because the merged key is truthy. See report.
  assert.equal(records[0].account.identitySource, 'codexbar');
});

test('costRecordsFromRows does not apply a fallback when multiple usage accounts exist', () => {
  const usage = usageRecordsFromRows([
    { provider: 'codex', accountKey: 'acct_1' },
    { provider: 'codex', accountKey: 'acct_2' }
  ], COLLECTED_AT);
  const { records } = costRecordsFromRows(
    [{ provider: 'codex', last30DaysCostUSD: 5 }],
    COLLECTED_AT,
    usage.usageAccountsByProvider
  );
  assert.equal(records[0].account.key, 'unknown:local');
});

test('costRecordsFromRows reports error rows as cost-<provider> issues', () => {
  const { records, issues } = costRecordsFromRows(
    [{ provider: 'codex', error: { message: 'cost blew up' } }],
    COLLECTED_AT,
    new Map()
  );
  assert.equal(records.length, 1);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'cost-codex');
  assert.equal(issues[0].operation, 'cost');
  assert.match(issues[0].message, /cost blew up/);
});

test('mergeUsageAccounts merges without duplicating account keys', () => {
  const target = new Map([['codex', [{ key: 'acct_1' }]]]);
  mergeUsageAccounts(target, new Map([
    ['codex', [{ key: 'acct_1' }, { key: 'acct_2' }]],
    ['grok', [{ key: 'g_1' }]]
  ]));
  assert.deepEqual(target.get('codex').map((a) => a.key), ['acct_1', 'acct_2']);
  assert.deepEqual(target.get('grok').map((a) => a.key), ['g_1']);
});

test('attachStderrDetails folds stderr into the matching provider issue', () => {
  const issues = usageRecordsFromRows(
    [{ provider: 'codex', error: { message: 'bad' } }],
    COLLECTED_AT
  ).issues;
  const result = attachStderrDetails(issues, 'raw stderr text', { provider: 'codex', operation: 'usage' });
  assert.equal(result, issues); // same array, mutated in place
  assert.equal(result.length, 1);
  assert.equal(result[0].details, 'raw stderr text');
});

test('attachStderrDetails creates a standalone stderr issue when none matches', () => {
  const result = attachStderrDetails([], 'lonely stderr', { provider: 'grok', operation: 'usage' });
  assert.equal(result.length, 1);
  assert.equal(result[0].code, 'codexbar-grok-usage-stderr');
  assert.equal(result[0].provider, 'grok');
  assert.equal(result[0].operation, 'usage');
  assert.match(result[0].message, /lonely stderr/);
});

test('attachStderrDetails returns issues unchanged when commandError is null', () => {
  const issues = [];
  assert.equal(attachStderrDetails(issues, null, { provider: 'codex', operation: 'usage' }), issues);
});

test('collectorLogDetail parses JSON log lines, dedupes and joins with a separator', () => {
  const raw = [
    JSON.stringify({ level: 'error', message: 'first failure' }),
    JSON.stringify({ level: 'error', message: 'first failure' }),
    JSON.stringify({ description: 'second failure' }),
    'plain text line'
  ].join('\n');
  assert.equal(collectorLogDetail(raw), 'first failure · second failure · plain text line');
});

test('collectorLogDetail falls back on empty input', () => {
  assert.equal(collectorLogDetail(''), 'Collector command reported an error.');
  assert.equal(collectorLogDetail(null), 'Collector command reported an error.');
});

test('makeSnapshot produces the exporter snapshot envelope', () => {
  const snapshot = makeSnapshot({ status: 'ok', records: [{}, {}], errors: [], hostname: 'box' });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.exporter.role, 'exporter');
  assert.equal(snapshot.exporter.hostname, 'box');
  assert.equal(snapshot.collection.status, 'ok');
  assert.equal(snapshot.collection.recordCount, 2);
  assert.equal('reason' in snapshot.collection, false);
  const withReason = makeSnapshot({ reason: 'manual' });
  assert.equal(withReason.collection.reason, 'manual');
  assert.equal(withReason.collection.status, 'initializing');
});

function collectorConfig(overrides = {}) {
  return {
    commandTimeoutMs: 5000,
    usageProviders: ['codex'],
    usageProvidersFallback: [],
    costProvider: 'codex',
    codexUsageSource: '',
    codexbarConfigPath: null,
    ...overrides
  };
}

function previousSnapshotWithGoodCodexRecords() {
  return makeSnapshot({
    status: 'ok',
    records: [
      {
        kind: 'usage',
        provider: 'codex',
        source: 'oauth',
        collectedAt: '2026-07-19T00:00:00.000Z',
        account: { key: 'acct_1', label: 'a@b.com', email: 'a@b.com', organization: null, identitySource: 'codexbar' },
        data: { usage: { primary: { usedPercent: 20 } } },
        error: null
      },
      {
        kind: 'cost',
        provider: 'codex',
        source: 'local',
        collectedAt: '2026-07-19T00:00:00.000Z',
        account: { key: 'acct_1', label: 'a@b.com', email: 'a@b.com', organization: null, identitySource: 'codexbar' },
        data: { last30DaysCostUSD: 5, last30DaysTokens: 100 },
        error: null
      }
    ]
  });
}

test('createCollector carries forward previous records when scopes fail outright', async () => {
  const collector = createCollector({
    config: collectorConfig(),
    runCommand: async () => {
      throw new Error('codexbar unavailable');
    }
  });

  const snapshot = await collector.collectSnapshot({
    reason: 'test',
    previous: previousSnapshotWithGoodCodexRecords()
  });

  assert.equal(snapshot.collection.status, 'partial');
  const kinds = snapshot.records.map((record) => `${record.kind}:${record.provider}`).sort();
  assert.deepEqual(kinds, ['cost:codex', 'usage:codex']);
  assert.equal(snapshot.records.every((record) => record.account.key === 'acct_1'), true);

  const codes = snapshot.errors.map((issue) => issue.code).sort();
  assert.deepEqual(codes, ['cost-codex-failed', 'usage-codex-failed']);
  const usageIssue = snapshot.errors.find((issue) => issue.code === 'usage-codex-failed');
  assert.equal(usageIssue.operation, 'usage');
  assert.match(usageIssue.message, /codex usage collection failed/);
});

test('createCollector does not carry forward records that had errors', async () => {
  const previous = previousSnapshotWithGoodCodexRecords();
  previous.records[0].error = { message: 'was already broken' };

  const collector = createCollector({
    config: collectorConfig(),
    runCommand: async () => {
      throw new Error('codexbar unavailable');
    }
  });
  const snapshot = await collector.collectSnapshot({ previous });
  assert.deepEqual(snapshot.records.map((record) => record.kind), ['cost']);
});

test('createCollector uses the configured cost provider in the failure code', async () => {
  const collector = createCollector({
    config: collectorConfig({ costProvider: 'claude' }),
    runCommand: async (_command, args) => {
      if (args[0] === 'usage') {
        return { stdout: JSON.stringify([{ provider: 'codex', accountKey: 'acct_1' }]), stderr: '' };
      }
      throw new Error('cost scrape broke');
    }
  });

  const snapshot = await collector.collectSnapshot({});
  const costIssue = snapshot.errors.find((issue) => issue.operation === 'cost');
  assert.equal(costIssue.code, 'cost-claude-failed');
  assert.equal(costIssue.provider, 'claude');
  assert.equal(snapshot.collection.status, 'partial');
  assert.deepEqual(snapshot.records.map((record) => record.kind), ['usage']);
});
