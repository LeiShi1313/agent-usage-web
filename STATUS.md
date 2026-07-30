# Status — 2026-07-30 refactor continuation

Snapshot of where the exporter/web redesign refactor stands, so the next
session can resume without re-deriving context. The main refactor is commit
`fba45d6` (`refactor!: modularize server and web, fix aggregation and
redaction`); the dashboard follow-up is `ede766a` plus `f026abb`.

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

- `npm test`: 79/79 pass (3 pre-existing integration + dashboard contract and unit tests in
  `test/auth.test.js`, `test/sanitize.test.js`, `test/identity-collect.test.js`,
  `test/dashboard-contract.test.js`, `test/dashboard-store.test.js`).
- `npm run lint`: clean. `npx tsc -p tsconfig.app.json --noEmit`: clean.
- `npm run build`: clean (vite + tsc).
- `node --check server/index.js`: clean.
- `docker compose config --quiet` and `bash -n scripts/smoke-image.sh`: clean.

## Not yet verified / next steps

1. **No live smoke run.** `docker compose up -d --build` against the real
   exporters (local + `Macbook Pro M1 Max` in `.env`) has not been run since
   the refactor. Verify: dashboard renders, both exporters polled, refresh
   button works (needs the new header — old cached frontends will get 403).
2. **Docker image not rebuilt/pushed.** README still lists tags up to 0.1.3;
   package.json is 0.1.4. A release (`docker build`, smoke script, tag,
   push) is pending — CI (`.github/workflows/ci.yml`) should exercise the
   Dockerfile + smoke test on push to main.
3. **Grok cookie fallback mount** is now opt-in (commented compose line for
   `~/.config/google-chrome`). If Grok billing via browser cookies is needed,
   uncomment it.
4. Deployed remote exporters must be upgraded together with the web role
   eventually (snapshot schema unchanged, so mixed versions do work), and any
   external caller of `POST /api/refresh` must send the new header.

## Known intentional quirks

- `upstreamErrors` (legacy string array) is still emitted alongside
  `upstreamIssues` for compatibility.
- `WEB_EXPORTER_*` single-target env fallback and `WEB_EXPORTERS_JSON` both
  still supported; config file (`WEB_EXPORTERS_CONFIG`) wins.
- `eslint.config.js` deliberately ignores `src/` (no TS/React lint setup yet);
  adding typescript-eslint for src/ is a possible follow-up.
