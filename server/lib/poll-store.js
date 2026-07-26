import { DatabaseSync } from 'node:sqlite';

import { nowISO } from './util.js';

export function openPollDatabase(sqlitePath) {
  const db = new DatabaseSync(sqlitePath);
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

export function createPollStore(db) {
  function upsertTarget(target) {
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

  function insertPoll(targetId, poll) {
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

  function loadLatestSuccessfulPolls(targetsById) {
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

  /**
   * Delete poll rows older than the retention window, always keeping the
   * latest successful poll per target so startup can restore snapshots.
   */
  function prunePolls(retentionDays) {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const result = db.prepare(`
      DELETE FROM exporter_polls
      WHERE polled_at < ?
        AND id NOT IN (
          SELECT MAX(id)
          FROM exporter_polls
          WHERE ok = 1 AND snapshot_json IS NOT NULL
          GROUP BY target_id
        )
    `).run(cutoff);
    return Number(result.changes ?? 0);
  }

  return { upsertTarget, insertPoll, loadLatestSuccessfulPolls, prunePolls };
}
