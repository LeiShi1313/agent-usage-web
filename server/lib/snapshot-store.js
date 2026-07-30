import fs from 'node:fs/promises';

import { makeSnapshot } from './collect.js';
import { providerFromRow } from './identity.js';
import { asArray, ensureParentDir, isoFromMs, nowISO } from './util.js';

/**
 * One-time migration for caches written before providers became config-driven:
 * drop rows from the retired Gemini probe. Fresh collections never produce them.
 */
export function migrateCachedSnapshot(raw) {
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.records)) return null;
  return {
    ...raw,
    records: raw.records.filter((record) => providerFromRow(record) !== 'gemini'),
    errors: asArray(raw.errors).filter((error) => String(error?.provider ?? '').toLowerCase() !== 'gemini')
  };
}

/**
 * Owns the exporter's current snapshot: cache load/persist, refresh
 * single-flight, and the refresh cooldown.
 */
export function createSnapshotStore({ collect, cachePath, minIntervalSeconds, hostname = null }) {
  let snapshot = makeSnapshot({ hostname });
  let refreshPromise = null;
  let lastRefreshStartedAt = 0;

  async function loadCache() {
    try {
      const raw = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      const migrated = migrateCachedSnapshot(raw);
      if (migrated) snapshot = migrated;
    } catch {
      // A missing exporter cache is normal on first boot.
    }
  }

  async function persist(next) {
    await ensureParentDir(cachePath);
    await fs.writeFile(cachePath, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  }

  function refresh(reason, { force = false } = {}) {
    if (refreshPromise) {
      return { status: 'already-running', promise: refreshPromise };
    }

    const elapsedSeconds = (Date.now() - lastRefreshStartedAt) / 1000;
    if (!force && lastRefreshStartedAt && elapsedSeconds < minIntervalSeconds) {
      return {
        status: 'cooldown',
        nextRefreshAt: isoFromMs(lastRefreshStartedAt + minIntervalSeconds * 1000),
        promise: null
      };
    }

    lastRefreshStartedAt = Date.now();
    const previous = snapshot;
    snapshot = {
      ...previous,
      collection: {
        status: 'refreshing',
        startedAt: nowISO(),
        finishedAt: null,
        recordCount: previous.records?.length ?? 0,
        reason
      }
    };
    refreshPromise = collect({ reason, previous, hostname })
      .then(async (next) => {
        snapshot = next;
        // A cache write failure must not discard the fresh snapshot.
        await persist(next).catch(() => null);
        return next;
      })
      .catch(() => {
        // collect() reports failures inside the snapshot; a rejection here
        // means something unexpected — restore the previous snapshot.
        snapshot = previous;
        return previous;
      })
      .finally(() => {
        refreshPromise = null;
      });
    return { status: 'started', promise: refreshPromise };
  }

  return {
    get current() {
      return snapshot;
    },
    loadCache,
    refresh
  };
}
