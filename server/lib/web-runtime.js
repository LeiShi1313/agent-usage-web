import { errorEnvelope } from './exporter-client.js';
import { isoFromMs, nowISO } from './util.js';

/**
 * Owns the web role's per-target poll cache: polling, refresh fan-out with
 * single-flight coalescing, and startup restore from the poll store.
 */
export function createWebRuntime({ pollStore, client, targets, buildDashboard, refreshMinIntervalSeconds = 0 }) {
  const targetsByUrl = new Map();
  const targetsById = new Map();
  for (const target of targets) {
    const id = pollStore.upsertTarget(target);
    const targetWithId = { ...target, id };
    targetsByUrl.set(target.url, targetWithId);
    targetsById.set(id, targetWithId);
  }

  const cache = pollStore.loadLatestSuccessfulPolls(targetsById);
  let refreshPromise = null;
  let lastRefreshStartedAt = 0;

  async function pollTarget(target) {
    const started = Date.now();
    const polledAt = nowISO();
    try {
      const { snapshot, statusCode } = await client.fetchSnapshot(target);
      pollStore.insertPoll(target.id, {
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
      pollStore.insertPoll(target.id, {
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

  /**
   * Fan out refresh to every exporter, then poll. Concurrent callers share one
   * in-flight run; a cooldown bounds how often unauthenticated UI refreshes
   * can trigger exporter collection.
   */
  function refreshAll() {
    if (refreshPromise) {
      return { status: 'already-running', promise: refreshPromise };
    }
    const elapsedSeconds = (Date.now() - lastRefreshStartedAt) / 1000;
    if (lastRefreshStartedAt && elapsedSeconds < refreshMinIntervalSeconds) {
      return {
        status: 'cooldown',
        nextRefreshAt: isoFromMs(lastRefreshStartedAt + refreshMinIntervalSeconds * 1000),
        promise: null
      };
    }
    lastRefreshStartedAt = Date.now();
    refreshPromise = Promise.all([...targetsByUrl.values()].map(async (target) => {
      try {
        await client.requestRefresh(target);
      } catch {
        // The following snapshot poll records the visible failure next to normal polls.
      }
      return pollTarget(target);
    })).finally(() => {
      refreshPromise = null;
    });
    return { status: 'started', promise: refreshPromise };
  }

  return {
    targets: [...targetsByUrl.values()],
    cache,
    pollAll,
    refreshAll,
    buildDashboard: () => buildDashboard([...targetsByUrl.values()], cache)
  };
}
