# Status — 2026-07-30 v0.2.1 deployed

The dashboard visual refresh is merged and deployed. Pull request
[#5](https://github.com/LeiShi1313/agent-usage-web/pull/5) merged as `2fccf38`
and is tagged `v0.2.1`. It keeps the existing provider-detail layout while
using the approved bolder theme, full-width limit bars, and a single visible
provider identity.

The exporter/web redesign refactor is merged and deployed. The main refactor is
commit `fba45d6` (`refactor!: modularize server and web, fix aggregation and
redaction`); the dashboard follow-up is `ede766a` plus `f026abb`. Pull request
[#2](https://github.com/LeiShi1313/agent-usage-web/pull/2) merged as `d3ab3f9`,
which is tagged `v0.2.0`.

## What was done

A 44-agent design review confirmed 38 defects; all were addressed:

- `server/index.js` (1360-line monolith) split into a ~95-line entry over
  `server/lib/`: `config.js`, `sanitize.js`, `identity.js`, `issues.js`,
  `auth.js`, `collect.js`, `snapshot-store.js`, `poll-store.js`,
  `exporter-client.js`, `web-runtime.js`, `dashboard.js`, `app.js`.
- `src/App.tsx` split into `src/components/`, `src/hooks/useDashboard.ts`,
  `src/lib/format.ts`, `src/lib/providers.ts`.
- Behavior changes (all intentional, documented in README/ADR 0003):
  - Cost aggregation is two-stage per spec: replace within a scrape target,
    sum across targets (was: summed everything, double-counting).
  - Staleness derives from data age `min(snapshot.generatedAt, poll time)`,
    not poll success time.
  - Failed collection scopes carry forward previous good records instead of
    blanking the snapshot.
  - Account Key prefers stable id over email (CONTEXT.md rule).
  - Unknown (`unknown:local`) accounts are row-scoped, never merged.
  - `POST /api/refresh` requires header `x-agent-usage-refresh: 1`
    (CSRF guard), coalesces concurrent refreshes, 30s cooldown
    (`WEB_REFRESH_MIN_INTERVAL_SECONDS`).
  - SQLite poll history pruned after `WEB_POLL_RETENTION_DAYS` (default 30,
    `0` disables); latest successful poll per target always kept.
  - Redaction hardened: JSON-serialized secrets, full cookie values,
    `sk-ant-` before `sk-`, bare `/home/<user>`, 16KB input cap (ReDoS).
  - UI honesty: no fabricated 0%-used bars for missing windows, labels from
    `windowMinutes`, `tertiary` rendered, real relative "Updated Xm ago",
    "No cost data" instead of $0.00, cost matched strictly by accountKey,
    refresh button decoupled from background polls, abort/race handling.
- Ops: Dockerfile uses `npm ci` + pinned CLI ARGs + `CMD` (entrypoint.sh
  deleted); frontend deps moved to devDependencies (runtime image installs
  express only); compose mounts narrowed to enabled providers
  (`~/.codex`, `~/.codexbar`, `~/.gemini`, `~/.grok` — no more `~/.config`,
  `~/.local/share`, `~/.claude`, `~/.cursor`); compose healthchecks added;
  `eslint.config.js` added (flat config, server+test only, src/ ignored).
- The interrupted dashboard adversarial sweep is complete:
  - `freshness.lastUpdatedAt` now uses the data timestamp, consistent with
    stale/expired status, instead of claiming a recent poll refreshed old data.
  - A full payload contract test covers every dashboard field consumed by
    `src/types.ts`, including tertiary/extra windows and nullable fields.
  - Usage and Cost for the same Provider Account are directly verified to emit
    the same privacy-safe public `accountKey`; unknown identities remain scoped
    by both Scrape Target and row.
  - `server/lib/dashboard.js` now exposes only its deep module interface,
    `createDashboardBuilder`; implementation helpers are private and tested
    through observable dashboard output.

## Verified working

- The `v0.2.1` pull request and post-merge CI runs passed tests, production
  dependency audit, TypeScript/Vite build, container build, and exporter/web
  smoke tests.
- The release workflow published and attested the `linux/amd64` and
  `linux/arm64` image at OCI index digest
  `sha256:a831cb4b8cdb7cfa643e1e6c1c42e736e53da526e8a280558f4d619a79ba81aa`.
- The central web service was rolled from `0.2.0` to `0.2.1` with its existing
  SQLite volume preserved. Local and public health checks returned 200 with
  both configured exporters successful.
- Public desktop and 320px browser checks covered both provider tabs and the
  selected Codex view. The deployed page served the release's hashed CSS/JS,
  had no browser errors, and manual refresh completed with HTTP 200.
- This release changes only the web UI, so the healthy local and macOS
  exporters remain on `0.2.0`. The central web rollback image is `0.2.0`; no
  database migration was required.
- `npm test`: 79/79 pass (3 pre-existing integration + dashboard contract and unit tests in
  `test/auth.test.js`, `test/sanitize.test.js`, `test/identity-collect.test.js`,
  `test/dashboard-contract.test.js`, `test/dashboard-store.test.js`).
- `npm run lint`: clean. `npx tsc -p tsconfig.app.json --noEmit`: clean.
- `npm run build`: clean (vite + tsc).
- `node --check server/index.js`: clean.
- `docker compose config --quiet` and `bash -n scripts/smoke-image.sh`: clean.
- `npm audit --omit=dev --audit-level=high`: no high or critical production
  vulnerabilities (one low-severity transitive advisory remains).
- GitHub CI passed on both pull request #2 and the resulting `main` merge.
- The `v0.2.0` release workflow rebuilt, smoke-tested, attested, and published
  the multi-architecture (`linux/amd64`, `linux/arm64`) image. Docker tags
  `0.2.0`, `0.2`, and `latest` resolve to OCI index digest
  `sha256:f292cfddac873cbc76e6b8264a7965baaa83596cc4e03263ff9cee10f77329e1`.
- A live Compose rollout using `leishi1313/agent-usage-web:0.2.0` completed with
  both services healthy and existing named volumes preserved. Desktop and
  mobile browser smoke tests covered both provider tabs and a manual refresh;
  `POST /api/refresh` returned 200 and the dashboard retained cached data while
  a remote exporter was temporarily unavailable.
- The configured macOS exporter was upgraded from v0.1.3 to the arm64 v0.2.0
  image with its cache volume preserved. Its authenticated snapshot returned
  200, and a central dashboard refresh reported both configured exporters
  successful with no unavailable-source warning. The v0.1.3 image remains on
  the Mac as its rollback artifact.
- Rollback image: `leishi1313/agent-usage-web:0.1.4`. No database migration was
  required.

## Remaining operational follow-ups

1. The Mac's OrbStack daemon was stopped before the upgrade and had to be
   started manually. The exporter has `restart: unless-stopped`, but OrbStack
   itself must be configured to start at login if the exporter must survive a
   Mac restart unattended.
2. Any external caller of `POST /api/refresh` must send
   `x-agent-usage-refresh: 1`; old cached frontends will receive 403 until they
   reload the deployed bundle.
3. **Grok cookie fallback mount** is opt-in (commented compose line for
   `~/.config/google-chrome`). If Grok billing via browser cookies is needed,
   uncomment it.

## Known intentional quirks

- `upstreamErrors` (legacy string array) is still emitted alongside
  `upstreamIssues` for compatibility.
- `WEB_EXPORTER_*` single-target env fallback and `WEB_EXPORTERS_JSON` both
  still supported; config file (`WEB_EXPORTERS_CONFIG`) wins.
- `eslint.config.js` deliberately ignores `src/` (no TS/React lint setup yet);
  adding typescript-eslint for src/ is a possible follow-up.
