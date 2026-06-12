# Exporter/Web Redesign Implementation Plan

Date: 2026-06-11

Source spec: `docs/superpowers/specs/2026-06-11-exporter-web-redesign-design.md`

## Goal

Split the current combined dashboard into:

- `APP_ROLE=exporter`: local CodexBar collector with token-protected HTTP snapshot/refresh endpoints and a tiny disk snapshot cache.
- `APP_ROLE=web`: usage/cost aggregator that polls configured exporters, stores every poll attempt in SQLite, and serves the UI without mounting agent credentials.

## Guiding Constraints

- Keep CodexBar config as provider config.
- Keep exporter payloads raw-shaped under `record.data`.
- Use raw provider-local `account.key` for aggregation.
- Web hides account display with `WEB_ACCOUNT_DISPLAY`; exporter does not hide account identity.
- No mock/demo/fake data in live mode.
- No history or source-detail API in v1.
- Web config minimum is exporter `url` plus `token`; optional `name`.

## Phase 1: Split Server Entrypoints

Create role-based server startup.

Tasks:

- Add a small role switch that starts exporter or web based on `APP_ROLE`.
- Keep current static React serving only in `web` role.
- Remove combined behavior where the web server directly invokes CodexBar for dashboard requests.
- Keep a clear failure if `APP_ROLE` is unknown.

Verification:

- `APP_ROLE=web npm run server` starts the web API/static server.
- `APP_ROLE=exporter npm run server` starts only exporter endpoints.
- Web role does not require CodexBar/auth mounts to boot.

## Phase 2: Exporter Snapshot Collector

Build the exporter as the only role that talks to CodexBar.

Tasks:

- Read CodexBar config from `CODEXBAR_CONFIG`.
- Use CodexBar enabled providers by default.
- Collect usage and cost with the chosen CodexBar invocation path.
- Wrap each CodexBar row in a `records[]` entry:
  - `kind`
  - `provider`
  - `source`
  - `collectedAt`
  - `account`
  - `data`
  - `error`
- Derive provider-local `account.key`.
- Infer cost account from a single usage account for the same provider when available.
- Use target-scoped `unknown:*` keys when identity is unavailable.

Verification:

- Exporter can produce Codex usage records.
- Exporter can produce Codex cost records.
- `record.data` preserves CodexBar-shaped payloads.
- `provider + account.key` is present for every record.

## Phase 3: Exporter HTTP And Cache

Expose the exporter contract.

Tasks:

- Implement:
  - `GET /v1/health`
  - `GET /v1/snapshot`
  - `POST /v1/refresh`
- Require bearer auth for snapshot and refresh.
- Keep health minimal.
- Make snapshot return cached data without running CodexBar inline.
- Make refresh start background collection and coalesce concurrent refreshes.
- Add disk cache for the last successful snapshot.
- Start one background refresh on exporter startup.
- Use one refresh interval:
  - `EXPORTER_REFRESH_SECONDS=300`
  - `EXPORTER_REFRESH_MIN_INTERVAL_SECONDS=60`

Verification:

- Unauthorized snapshot/refresh requests fail.
- Authorized snapshot returns HTTP 200 with stale/initializing data when collection is unavailable.
- Refresh returns `running` or `already_running`.
- Restarting exporter reloads cached snapshot before fresh collection finishes.

## Phase 4: Web Scrape Target Config

Teach web role how to find exporters.

Tasks:

- Support config file and env JSON.
- Config file wins when both are present.
- Minimum target shape:
  - `url`
  - `token`
  - optional `name`
- Do not require exporter ids.
- Do not store tokens in SQLite.

Verification:

- Web boots with `WEB_EXPORTERS_JSON`.
- Web boots with mounted config file.
- Invalid target config produces a clear startup/runtime error.

## Phase 5: SQLite Poll History

Add raw poll history storage.

Tasks:

- Add SQLite dependency and DB initialization.
- Create tables:
  - `scrape_targets`
  - `exporter_polls`
- Store every poll attempt, success or failure.
- Successful polls store raw snapshot JSON.
- Failed polls store error JSON.
- Keep history forever; no cleanup in v1.
- On web startup, load latest successful poll per scrape target into memory.

Verification:

- Successful poll inserts `exporter_polls` row.
- Failed poll inserts `exporter_polls` row.
- Tokens are not persisted.
- Web restart restores latest successful snapshots from SQLite.

## Phase 6: Web Polling And Aggregation

Implement runtime aggregation.

Tasks:

- Poll scrape targets every `WEB_EXPORTER_POLL_SECONDS=60`.
- Poll targets concurrently with per-target timeout.
- Keep last successful snapshot visible when a poll fails.
- Implement global `POST /api/refresh`:
  - fan out `POST /v1/refresh` to every target
  - then manually poll current snapshots
  - allow fresh data to arrive on a later poll if exporter collection is still running
- Aggregate usage:
  - key: `provider + account.key`
  - keep freshest successful row
  - do not sum quota windows
- Aggregate cost:
  - per-target replacement key: `scrape target + provider + account.key`
  - aggregate by `provider + account.key`
  - include stale/expired rows
- Do not expose history or source details in v1.

Verification:

- One unreachable target does not block others.
- Manual refresh polls all exporters.
- Usage duplicate rows keep freshest data.
- Cost rows from multiple scrape targets sum by Provider Account.
- Unknown account keys stay target-scoped.

## Phase 7: UI Contract And Cleanup

Adapt React to the new web API.

Tasks:

- Replace old `/api/dashboard` payload handling with the new aggregate payload.
- Add small refresh button near last-updated text.
- Show compact stale/unreachable text.
- Hide account display by default with `WEB_ACCOUNT_DISPLAY=hidden`.
- Remove server mock/demo fallback functions and live fake data behavior.
- Do not add per-source or history UI in v1.

Verification:

- Dashboard renders real aggregate data.
- No data state shows empty/error, not fake data.
- Refresh button triggers `POST /api/refresh`.
- Account email/name is hidden by default and shown only when configured.

## Phase 8: Docker Compose

Split compose deployment into exporter and web services.

Tasks:

- Update Docker entrypoint for role-based startup.
- Define `agent-usage-exporter`.
- Define `agent-usage-web`.
- Mount agent/CodexBar state only into exporter.
- Mount SQLite/cache storage into web.
- Keep exporter bind behavior consistent; deployment controls host exposure.
- Keep read-only/rootless hardening where practical.

Verification:

- `docker compose up --build` starts both services.
- Web has no agent credential mounts.
- Exporter can read mounted CodexBar/agent state.
- Web polls exporter over Docker network.
- Public host port remains the higher dashboard port.

## Suggested Test Order

Use vertical TDD-style slices:

1. Exporter auth and cached snapshot endpoint.
2. Exporter collection wrapper for a fixture CodexBar payload.
3. Web scrape target config parsing.
4. SQLite poll storage.
5. Aggregation logic for usage and cost.
6. Web refresh fanout.
7. End-to-end Docker smoke test.

## Manual Smoke Checks

- `curl /v1/health` on exporter returns minimal liveness.
- `curl /v1/snapshot` without token fails.
- `curl /v1/snapshot` with token returns records.
- `curl /api/dashboard` on web returns aggregate data.
- `curl -X POST /api/refresh` starts exporter refresh and records a manual snapshot poll; fresh data may arrive on a later poll if collection is still running.
- Stop exporter; web keeps last data and shows stale/unreachable text.
- Restart web; it restores latest data from SQLite.

## Deferred

- Historical API and charts.
- Per-source detail UI.
- Scope-specific refresh.
- Provider override env vars for discovery/debugging, if still useful.
- Provider-specific account key investigations beyond CodexBar row identity.
- Cleanup/retention job for SQLite history.
