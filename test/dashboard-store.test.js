import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig, loadWebTargets } from '../server/lib/config.js';
import {
  accountAggregationKey,
  createDashboardBuilder,
  dataUpdatedAt,
  numeric,
  publicTargetName
} from '../server/lib/dashboard.js';
import { createPollStore, openPollDatabase } from '../server/lib/poll-store.js';
import { createSnapshotStore, migrateCachedSnapshot } from '../server/lib/snapshot-store.js';

const HOUR_MS = 3_600_000;

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function makeTarget(n) {
  return { url: `http://exporter-${n}:1`, name: `X${n}`, id: n };
}

function account(key = 'acct_1', email = 'a@b.com') {
  return { key, label: email ?? key, email, organization: null, identitySource: 'codexbar' };
}

function usageRecord({ usedPercent = 20, updatedAt = isoAgo(0), acct = account(), provider = 'codex' } = {}) {
  return {
    kind: 'usage',
    provider,
    source: 'oauth',
    collectedAt: updatedAt,
    account: acct,
    data: {
      usage: {
        primary: { usedPercent },
        updatedAt,
        identity: { accountEmail: acct.email }
      }
    },
    error: null
  };
}

function costRecord({ costUSD = 5, tokens = 100, updatedAt = isoAgo(0), acct = account(), provider = 'codex' } = {}) {
  return {
    kind: 'cost',
    provider,
    source: 'local',
    collectedAt: updatedAt,
    account: acct,
    data: { last30DaysCostUSD: costUSD, last30DaysTokens: tokens, updatedAt },
    error: null
  };
}

function snapshotOf(records, { generatedAt = isoAgo(0), errors = [] } = {}) {
  return {
    schemaVersion: 1,
    generatedAt,
    exporter: { role: 'exporter', hostname: null },
    collection: { status: 'ok', startedAt: generatedAt, finishedAt: generatedAt, recordCount: records.length },
    records,
    errors
  };
}

function cacheFor(entries) {
  const cache = new Map();
  for (const entry of entries) {
    cache.set(entry.target.url, {
      lastSuccessAt: isoAgo(0),
      lastAttemptAt: isoAgo(0),
      lastError: null,
      ...entry
    });
  }
  return cache;
}

function makeBuilder(overrides = {}) {
  return createDashboardBuilder({
    accountDisplay: 'label',
    staleAfterSeconds: 600,
    expiredAfterSeconds: 86_400,
    providerOrder: ['codex', 'antigravity', 'grok'],
    ...overrides
  });
}

test('numeric accepts finite numbers and zeroes everything else', () => {
  assert.equal(numeric(5), 5);
  assert.equal(numeric(0), 0);
  assert.equal(numeric(Number.NaN), 0);
  assert.equal(numeric('5'), 0);
  assert.equal(numeric(undefined), 0);
});

test('publicTargetName prefers name, falls back to origin, then a constant', () => {
  assert.equal(publicTargetName({ name: 'My Box', url: 'http://x:1' }), 'My Box');
  assert.equal(publicTargetName({ url: 'http://x:1/path' }), 'http://x:1');
  assert.equal(publicTargetName({ url: 'not a url' }), 'Exporter');
});

test('dataUpdatedAt takes the older of snapshot generation and poll success time', () => {
  const older = '2026-07-26T00:00:00.000Z';
  const newer = '2026-07-26T01:00:00.000Z';
  // Old snapshot served by a healthy exporter: data age wins over poll age.
  assert.equal(dataUpdatedAt({ snapshot: { generatedAt: older }, lastSuccessAt: newer }), older);
  // Exporter clock skewed into the future: the poll time bounds the claim.
  assert.equal(dataUpdatedAt({ snapshot: { generatedAt: newer }, lastSuccessAt: older }), older);
  assert.equal(dataUpdatedAt({ snapshot: null, lastSuccessAt: newer }), newer);
  assert.equal(dataUpdatedAt({ snapshot: null, lastSuccessAt: null }), null);
});

test('accountAggregationKey scopes unknown identities to target and row', () => {
  const target = makeTarget(1);
  const known = { provider: 'codex', kind: 'usage', account: { key: 'acct_1' } };
  const unknown = { provider: 'codex', kind: 'usage', account: { key: 'unknown:local' } };
  assert.equal(accountAggregationKey(known, target, 0), accountAggregationKey(known, target, 1));
  assert.notEqual(accountAggregationKey(unknown, target, 0), accountAggregationKey(unknown, target, 1));
  assert.notEqual(accountAggregationKey(unknown, target, 0), accountAggregationKey(unknown, makeTarget(2), 0));
});

test('cost aggregation stage 1 replaces within a target: freshest record wins, never summed', () => {
  const target = makeTarget(1);
  const fresh = costRecord({ costUSD: 9, tokens: 900, updatedAt: isoAgo(1_000) });
  const old = costRecord({ costUSD: 4, tokens: 400, updatedAt: isoAgo(HOUR_MS) });
  // Fresh row first so replacement is decided by timestamp, not array order.
  const cache = cacheFor([{ target, snapshot: snapshotOf([fresh, old]) }]);

  const dashboard = makeBuilder().buildDashboard([target], cache);
  assert.equal(dashboard.cost.length, 1);
  assert.equal(dashboard.cost[0].last30DaysCostUSD, 9);
  assert.equal(dashboard.cost[0].last30DaysTokens, 900);
  assert.equal(dashboard.cost[0].targetCount, 1);
});

test('cost aggregation stage 2 sums the same account across targets', () => {
  const targetA = makeTarget(1);
  const targetB = makeTarget(2);
  const cache = cacheFor([
    { target: targetA, snapshot: snapshotOf([costRecord({ costUSD: 5, tokens: 100 })]) },
    { target: targetB, snapshot: snapshotOf([costRecord({ costUSD: 7, tokens: 200 })]) }
  ]);

  const dashboard = makeBuilder().buildDashboard([targetA, targetB], cache);
  assert.equal(dashboard.cost.length, 1);
  assert.equal(dashboard.cost[0].last30DaysCostUSD, 12);
  assert.equal(dashboard.cost[0].last30DaysTokens, 300);
  assert.equal(dashboard.cost[0].targetCount, 2);
});

test('usage dedup keeps the freshest record for the same account across targets', () => {
  const targetA = makeTarget(1);
  const targetB = makeTarget(2);
  // Fresher record lives in the FIRST target so a later, older record must
  // not displace it.
  const cache = cacheFor([
    { target: targetA, snapshot: snapshotOf([usageRecord({ usedPercent: 55, updatedAt: isoAgo(1_000) })]) },
    { target: targetB, snapshot: snapshotOf([usageRecord({ usedPercent: 11, updatedAt: isoAgo(HOUR_MS) })]) }
  ]);

  const dashboard = makeBuilder().buildDashboard([targetA, targetB], cache);
  assert.equal(dashboard.usage.length, 1);
  assert.equal(dashboard.usage[0].usage.primary.usedPercent, 55);
});

test('two unknown-identity usage rows in one snapshot both appear', () => {
  const target = makeTarget(1);
  const unknownAccount = { key: 'unknown:local', label: null, email: null, organization: null, identitySource: 'unknown' };
  const cache = cacheFor([{
    target,
    snapshot: snapshotOf([
      usageRecord({ usedPercent: 10, acct: unknownAccount }),
      usageRecord({ usedPercent: 30, acct: unknownAccount })
    ])
  }]);

  const dashboard = makeBuilder().buildDashboard([target], cache);
  assert.equal(dashboard.usage.length, 2);
  assert.deepEqual(
    dashboard.usage.map((row) => row.usage.primary.usedPercent).sort((a, b) => a - b),
    [10, 30]
  );
});

test('staleness follows data age, not poll success time', () => {
  const target = makeTarget(1);
  const cache = cacheFor([{
    target,
    snapshot: snapshotOf([usageRecord()], { generatedAt: isoAgo(2 * HOUR_MS) }),
    lastSuccessAt: isoAgo(0),
    lastAttemptAt: isoAgo(0)
  }]);

  const dashboard = makeBuilder({ staleAfterSeconds: 600 }).buildDashboard([target], cache);
  assert.equal(dashboard.usage[0].stale, true);
  assert.equal(dashboard.freshness.stale, true);
  assert.equal(dashboard.freshness.expired, false);
  assert.equal(dashboard.freshness.warning, 'Data is stale');
});

test('fresh data is not stale and produces no warning', () => {
  const target = makeTarget(1);
  const cache = cacheFor([{ target, snapshot: snapshotOf([usageRecord()]) }]);
  const dashboard = makeBuilder().buildDashboard([target], cache);
  assert.equal(dashboard.usage[0].stale, false);
  assert.equal(dashboard.freshness.warning, null);
});

test('a failed target outranks staleness in the freshness warning', () => {
  const target = makeTarget(1);
  const cache = cacheFor([{
    target,
    snapshot: snapshotOf([usageRecord()], { generatedAt: isoAgo(2 * HOUR_MS) }),
    lastSuccessAt: isoAgo(2 * HOUR_MS),
    lastAttemptAt: isoAgo(0),
    lastError: { message: 'connect ECONNREFUSED' }
  }]);

  const dashboard = makeBuilder().buildDashboard([target], cache);
  assert.equal(dashboard.freshness.warning, 'Some exporters are unavailable');
  assert.equal(dashboard.freshness.failedSourceCount, 1);
  // The poll failure is also surfaced as an upstream issue.
  assert.ok(dashboard.upstreamIssues.some((issue) => issue.code === 'fetch-failed'));
});

test('stderr issues are suppressed when a structured sibling exists for the same scope', () => {
  const target = makeTarget(1);
  const cache = cacheFor([{
    target,
    snapshot: snapshotOf([], {
      errors: [
        { code: 'codexbar-grok-usage-stderr', provider: 'grok', operation: 'usage', message: 'raw stderr noise' },
        { code: 'usage-grok', provider: 'grok', operation: 'usage', message: 'grok usage: provider error' }
      ]
    })
  }]);

  const dashboard = makeBuilder().buildDashboard([target], cache);
  assert.equal(dashboard.upstreamIssues.length, 1);
  assert.equal(dashboard.upstreamIssues[0].code, 'usage-grok');
});

test('a lone stderr issue without a structured sibling still appears', () => {
  const target = makeTarget(1);
  const cache = cacheFor([{
    target,
    snapshot: snapshotOf([], {
      errors: [{ code: 'codexbar-grok-usage-stderr', provider: 'grok', operation: 'usage', message: 'raw stderr noise' }]
    })
  }]);

  const dashboard = makeBuilder().buildDashboard([target], cache);
  assert.equal(dashboard.upstreamIssues.length, 1);
  assert.equal(dashboard.upstreamIssues[0].code, 'codexbar-grok-usage-stderr');
});

test('accountDisplay hidden nulls the account and identity email', () => {
  const target = makeTarget(1);
  const cache = cacheFor([{ target, snapshot: snapshotOf([usageRecord(), costRecord()]) }]);
  const dashboard = makeBuilder({ accountDisplay: 'hidden' }).buildDashboard([target], cache);

  assert.equal(dashboard.privacy.accountDisplay, 'hidden');
  assert.equal(dashboard.usage[0].account, null);
  assert.equal(dashboard.usage[0].usage.identity.accountEmail, null);
  assert.equal(dashboard.cost[0].account, null);
  assert.doesNotMatch(JSON.stringify(dashboard), /a@b\.com/);
});

test('accountDisplay full exposes the account email', () => {
  const target = makeTarget(1);
  const cache = cacheFor([{ target, snapshot: snapshotOf([usageRecord()]) }]);
  const dashboard = makeBuilder({ accountDisplay: 'full' }).buildDashboard([target], cache);
  assert.equal(dashboard.usage[0].account, 'a@b.com');
  assert.equal(dashboard.usage[0].usage.identity.accountEmail, 'a@b.com');
});

test('poll store round-trips targets and polls in a real database', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-usage-poll-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = openPollDatabase(path.join(dir, 'polls.sqlite'));
  t.after(() => db.close());
  const store = createPollStore(db);

  const firstId = store.upsertTarget({ url: 'http://exporter-1:1', name: 'First Name' });
  const secondId = store.upsertTarget({ url: 'http://exporter-1:1', name: 'Renamed' });
  assert.equal(firstId, secondId);
  assert.equal(
    db.prepare('SELECT name FROM scrape_targets WHERE id = ?').get(firstId).name,
    'Renamed'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scrape_targets').get().n, 1);

  store.insertPoll(firstId, {
    ok: true,
    polledAt: '2026-07-20T10:00:00.000Z',
    statusCode: 200,
    durationMs: 12,
    snapshot: snapshotOf([], { generatedAt: '2026-07-20T10:00:00.000Z' })
  });
  const latestSnapshot = snapshotOf([usageRecord({ usedPercent: 33 })], { generatedAt: '2026-07-20T11:00:00.000Z' });
  store.insertPoll(firstId, {
    ok: true,
    polledAt: '2026-07-20T11:00:00.000Z',
    statusCode: 200,
    durationMs: 15,
    snapshot: latestSnapshot
  });
  store.insertPoll(firstId, {
    ok: false,
    polledAt: '2026-07-20T12:00:00.000Z',
    statusCode: 500,
    error: { message: 'exporter down' }
  });

  const target = { url: 'http://exporter-1:1', name: 'Renamed', id: firstId };
  const cache = store.loadLatestSuccessfulPolls(new Map([[firstId, target]]));
  assert.equal(cache.size, 1);
  const entry = cache.get(target.url);
  assert.equal(entry.lastSuccessAt, '2026-07-20T11:00:00.000Z');
  assert.equal(entry.lastError, null);
  assert.deepEqual(entry.snapshot, latestSnapshot);
});

test('prunePolls deletes old rows but always keeps the latest successful poll per target', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-usage-poll-prune-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = openPollDatabase(path.join(dir, 'polls.sqlite'));
  t.after(() => db.close());
  const store = createPollStore(db);

  const targetId = store.upsertTarget({ url: 'http://exporter-1:1', name: 'X' });
  const tenDaysAgo = isoAgo(10 * 24 * HOUR_MS);
  // The ONLY success is far outside the retention window.
  store.insertPoll(targetId, { ok: true, polledAt: tenDaysAgo, snapshot: snapshotOf([]) });
  store.insertPoll(targetId, { ok: false, polledAt: tenDaysAgo, error: { message: 'old failure' } });

  const deleted = store.prunePolls(1);
  assert.equal(deleted, 1); // only the old failure goes

  const remaining = db.prepare('SELECT ok FROM exporter_polls').all();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].ok, 1);

  const cache = store.loadLatestSuccessfulPolls(new Map([[targetId, { url: 'http://exporter-1:1', name: 'X', id: targetId }]]));
  assert.equal(cache.size, 1);
});

test('prunePolls is a no-op for non-positive retention', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-usage-poll-noop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = openPollDatabase(path.join(dir, 'polls.sqlite'));
  t.after(() => db.close());
  const store = createPollStore(db);
  const targetId = store.upsertTarget({ url: 'http://exporter-1:1', name: 'X' });
  store.insertPoll(targetId, { ok: false, polledAt: isoAgo(10 * 24 * HOUR_MS), error: { message: 'old' } });
  assert.equal(store.prunePolls(0), 0);
  assert.equal(store.prunePolls(Number.NaN), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exporter_polls').get().n, 1);
});

test('migrateCachedSnapshot drops gemini records and errors', () => {
  const migrated = migrateCachedSnapshot({
    schemaVersion: 1,
    generatedAt: '2026-07-10T00:00:00.000Z',
    records: [
      { kind: 'usage', provider: 'gemini', data: {} },
      { kind: 'usage', provider: 'codex', data: {} }
    ],
    errors: [
      { code: 'usage-gemini', provider: 'Gemini', message: 'gone' },
      { code: 'usage-codex', provider: 'codex', message: 'kept' }
    ]
  });
  assert.deepEqual(migrated.records.map((record) => record.provider), ['codex']);
  assert.deepEqual(migrated.errors.map((error) => error.code), ['usage-codex']);
});

test('migrateCachedSnapshot rejects wrong schema versions and malformed caches', () => {
  assert.equal(migrateCachedSnapshot({ schemaVersion: 2, records: [] }), null);
  assert.equal(migrateCachedSnapshot({ schemaVersion: 1, records: 'nope' }), null);
  assert.equal(migrateCachedSnapshot(null), null);
});

test('snapshot store single-flights refreshes and persists the result', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-usage-snapshot-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, 'cache', 'snapshot.json');

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const collected = snapshotOf([usageRecord({ usedPercent: 42 })]);
  const store = createSnapshotStore({
    collect: async () => {
      await gate;
      return collected;
    },
    cachePath,
    minIntervalSeconds: 60
  });

  const first = store.refresh('test');
  assert.equal(first.status, 'started');
  assert.equal(store.current.collection.status, 'refreshing');

  const second = store.refresh('test');
  assert.equal(second.status, 'already-running');
  assert.equal(second.promise, first.promise);

  release();
  const result = await first.promise;
  assert.equal(result, collected);
  assert.equal(store.current, collected);

  const persisted = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.deepEqual(persisted, collected);
});

test('snapshot store enforces the refresh cooldown unless forced', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-usage-snapshot-cooldown-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createSnapshotStore({
    collect: async () => snapshotOf([]),
    cachePath: path.join(dir, 'snapshot.json'),
    minIntervalSeconds: 60
  });

  const first = store.refresh('initial');
  assert.equal(first.status, 'started');
  await first.promise;

  const cooled = store.refresh('again');
  assert.equal(cooled.status, 'cooldown');
  assert.equal(cooled.promise, null);
  assert.ok(new Date(cooled.nextRefreshAt).getTime() > Date.now());

  const forced = store.refresh('forced', { force: true });
  assert.equal(forced.status, 'started');
  await forced.promise;
});

test('snapshot store restores the previous snapshot when collect rejects', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-usage-snapshot-reject-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createSnapshotStore({
    collect: async () => {
      throw new Error('unexpected crash');
    },
    cachePath: path.join(dir, 'snapshot.json'),
    minIntervalSeconds: 0
  });

  const previous = store.current;
  const refresh = store.refresh('test');
  assert.equal(refresh.status, 'started');
  const result = await refresh.promise;
  assert.equal(result, previous);
  assert.equal(store.current, previous);
});

test('loadConfig applies web defaults', () => {
  const config = loadConfig({});
  assert.equal(config.role, 'web');
  assert.equal(config.web.accountDisplay, 'hidden');
  assert.equal(config.web.pollRetentionDays, 30);
  assert.equal(config.web.staleAfterSeconds, 600);
  assert.equal(config.web.expiredAfterSeconds, 86_400);
  assert.deepEqual(config.web.providerOrder, ['codex', 'antigravity', 'grok']);
});

test('loadConfig honors explicit poll retention values including zero', () => {
  assert.equal(loadConfig({ WEB_POLL_RETENTION_DAYS: '0' }).web.pollRetentionDays, 0);
  assert.equal(loadConfig({ WEB_POLL_RETENTION_DAYS: '7' }).web.pollRetentionDays, 7);
  assert.equal(loadConfig({ WEB_POLL_RETENTION_DAYS: 'not-a-number' }).web.pollRetentionDays, 30);
});

test('loadConfig normalizes accountDisplay and role', () => {
  assert.equal(loadConfig({ WEB_ACCOUNT_DISPLAY: 'FULL' }).web.accountDisplay, 'full');
  assert.equal(loadConfig({ WEB_ACCOUNT_DISPLAY: 'bogus' }).web.accountDisplay, 'hidden');
  assert.equal(loadConfig({ APP_ROLE: ' Exporter ' }).role, 'exporter');
});

test('loadWebTargets parses WEB_EXPORTERS_JSON and normalizes entries', async () => {
  const targets = await loadWebTargets({
    WEB_EXPORTERS_JSON: JSON.stringify([
      { url: 'http://exporter-1:1///', token: 'tok-1', name: 'One' },
      { url: 'http://exporter-2:1', token: 'tok-2' },
      { url: 'http://exporter-3:1' }, // no token → skipped
      { token: 'tok-4' } // no url → skipped
    ])
  });
  assert.deepEqual(targets, [
    { url: 'http://exporter-1:1', token: 'tok-1', name: 'One' },
    { url: 'http://exporter-2:1', token: 'tok-2', name: null }
  ]);
});

test('loadWebTargets returns an empty list when nothing is configured', async () => {
  assert.deepEqual(await loadWebTargets({}), []);
});
