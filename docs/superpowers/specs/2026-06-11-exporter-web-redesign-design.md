# Agent Usage Exporter/Web Redesign

Date: 2026-06-11

## Summary

Split the current combined agent usage service into two roles:

- **Exporter**: a small HTTP service that runs on each machine with local agent auth/cache mounts. It executes CodexBar, wraps results with a required Provider Account envelope and optional diagnostic exporter metadata, caches snapshots, and exposes token-protected HTTP endpoints.
- **Web aggregator**: the dashboard backend/UI. It stores no agent credentials, polls exporters over HTTP, caches last successful snapshots, aggregates Provider/Account Key records, and controls display privacy.

This is a redesign, not a backward-compatible extension of the current `/api/dashboard` internals or payload shape. The endpoint name may stay if convenient, but the UI-facing contract can change.

## Goals

- Support usage and cost collection from multiple machines using pull-style HTTP exporters.
- Keep provider collection config close to CodexBar's native config so the exporter does not duplicate provider settings.
- Preserve raw CodexBar-shaped provider payloads under an exporter wrapper.
- Include stable Provider Account identity for aggregation while allowing display emails/names to be hidden.
- Keep dashboard data visible when exporters are stale or temporarily unreachable.
- Avoid broad `provider=all` collection by default because it is slow and noisy in the current environment.

## Non-Goals

- No SSH tunnels in the first design.
- No push/ingest endpoint.
- No custom time-series modeling in the first implementation. V1 may store raw exporter snapshots in SQLite for simple history/audit, but the dashboard aggregates from latest snapshots.
- No complex auth handshake; bearer token auth is enough for v1.
- No UI redesign beyond showing freshness/staleness next to the existing last-updated area.

## CodexBar Behavior

CodexBar is the underlying collector.

- **Usage** uses provider APIs or web/API sources. Codex OAuth usage calls ChatGPT/OpenAI usage APIs and reports account quota/rate-limit windows, credits, or remaining allowance. This does not consume model-generation tokens.
- **Cost** is local log-derived token and price estimates for Codex/Claude. It scans native logs and CodexBar caches, such as Codex `sessions` and `archived_sessions`. This does not consume model-generation tokens, but can use local CPU/I/O.
- Same-account Codex quota usage is already server-side/account-wide. Cross-machine aggregation is mainly needed for local log-derived cost.

The exporter may invoke CodexBar through direct CLI commands or through CodexBar's local serve mode. The spec does not require one mechanism. The required behavior is that exporter snapshots are as fresh and correct as practical, refresh requests have clear semantics, and duplicate internal cache layers do not cause stale data to be served unexpectedly.

Local measurements on this machine showed targeted collection is cheap while broad `all` collection is expensive:

- `codexbar usage --provider codex`: about 0.4s.
- `codexbar usage --provider antigravity`: about 2s.
- `codexbar cost --provider codex`: about 0.2-0.3s when warm.
- `codexbar usage --provider all`: about 21s and mostly error rows.

## Runtime Roles

Use one repo and preferably one image with two runtime roles:

```env
APP_ROLE=exporter
APP_ROLE=web
```

Exporter containers mount local agent/CodexBar state. Web containers do not mount agent credentials or caches and do not perform provider credential refresh.

Compose should run:

- `agent-usage-exporter`: mounts `~/.codex`, `~/.codexbar`, `~/.claude`, and other needed local state.
- `agent-usage-web`: mounts no agent auth/cache, polls the local exporter over Docker networking.

Machines that only contribute data can run just the exporter. Exporter defaults should stay consistent across local and remote deployments; host exposure is controlled by deployment configuration.

## Exporter HTTP API

Exporter endpoints:

```http
GET  /v1/health
GET  /v1/snapshot
POST /v1/refresh
```

`/v1/snapshot` and `/v1/refresh` require:

```http
Authorization: Bearer <EXPORTER_TOKEN>
```

`GET /v1/health` may be unauthenticated and returns minimal liveness such as `{ "ok": true }`.

Exporters are backend-to-backend APIs. They do not need CORS support in v1; browsers should call the web backend, not exporters directly.

`GET /v1/snapshot` returns the latest cached snapshot immediately. It must not run CodexBar inline.

`GET /v1/snapshot` returns HTTP 200 when the exporter service is healthy and the request is authorized, even if collection data is stale or the latest collection attempt failed. Staleness and collection failures belong in the snapshot body for the web aggregator to interpret.

`POST /v1/refresh` starts targeted usage and cost collection in the background, coalesces concurrent refreshes, and returns current refresh state. It must not block until all CodexBar commands finish. In v1 it always refreshes all configured scopes; scope-specific refresh can be added later if needed.

Example refresh response:

```json
{
  "accepted": true,
  "refreshId": "2026-06-11T10:30:00.000Z",
  "status": "running"
}
```

If refresh is already running:

```json
{
  "accepted": true,
  "status": "already_running"
}
```

## Exporter Snapshot Contract

The exporter wraps raw CodexBar-shaped payloads. It adds metadata, Provider Account identity, collection state, and errors, but does not normalize provider data into dashboard-specific structures.

```json
{
  "schemaVersion": "1.0",
  "generatedAt": "2026-06-11T10:30:00.000Z",
  "exporter": {
    "name": "Home Desktop",
    "version": "0.2.0",
    "hostname": "home-desktop",
    "timezone": "Europe/Zurich"
  },
  "collection": {
    "status": "ok",
    "lastSuccessAt": "2026-06-11T10:30:00.000Z",
    "lastAttemptAt": "2026-06-11T10:30:00.000Z",
    "nextRefreshAt": "2026-06-11T10:35:00.000Z"
  },
  "records": [
    {
      "kind": "usage",
      "provider": "codex",
      "source": "codexbar-usage",
      "collectedAt": "2026-06-11T10:30:00.000Z",
      "account": {
        "key": "lei@example.com",
        "label": "Work OpenAI",
        "email": "lei@example.com",
        "organization": null,
        "identitySource": "codexbar"
      },
      "data": {
        "provider": "codex",
        "source": "oauth",
        "usage": {}
      },
      "error": null
    },
    {
      "kind": "cost",
      "provider": "codex",
      "source": "codexbar-cost",
      "collectedAt": "2026-06-11T10:30:00.000Z",
      "account": {
        "key": "lei@example.com",
        "label": "Work OpenAI",
        "email": "lei@example.com",
        "organization": null,
        "identitySource": "single-local-usage-account"
      },
      "data": {
        "provider": "codex",
        "source": "local",
        "daily": [],
        "totals": {}
      },
      "error": null
    }
  ],
  "errors": []
}
```

The `exporter` metadata is optional diagnostic context. The web aggregator must not require it; the configured Scrape Target URL plus optional target `name` is enough for v1.

## Account Identity

Every record must include an account envelope for the Provider Account. The aggregate identity is:

```text
provider + account.key
```

`account.key` is the Account Key: provider-local operational identity. It must not be hidden. Account labels/emails/org names are presentation metadata and may be hidden.

Account Key derivation is provider-specific. Prefer the most stable identity CodexBar exposes for that provider, and preserve distinct accounts when CodexBar reports distinct rows. If a provider can report multiple account modes on one machine, such as subscription OAuth and API usage, v1 should treat CodexBar's row separation as authoritative rather than trying to merge or split beyond what CodexBar reports.

Recommended account display default:

```env
WEB_ACCOUNT_DISPLAY=hidden
```

Web display modes:

- `hidden`: do not show email/organization/label in the UI.
- `label`: show a non-email label when available.
- `full`: show email/organization/label when exporter data includes them.

The exporter reports Provider Account identity for aggregation. The web decides whether to display account names/emails.

If identity is missing, emit a non-null target-scoped key:

```json
{
  "key": "unknown:local",
  "label": "Unknown Codex account",
  "email": null,
  "organization": null,
  "identitySource": "unknown"
}
```

Unknown identities are target-scoped by the web and are not mergeable across Scrape Targets. The exporter does not need a hostname or exporter id to make unknown identities safe.

For local cost rows, the exporter may infer account identity only when exactly one plausible usage account exists for that provider on that exporter:

```json
{
  "identitySource": "single-local-usage-account"
}
```

## Provider Configuration

CodexBar config is the provider configuration. The exporter should read the normal CodexBar config path:

```env
CODEXBAR_CONFIG=/home/node/.codexbar/config.json
```

Example:

```json
{
  "version": 1,
  "providers": [
    {
      "id": "codex",
      "enabled": true,
      "source": "oauth",
      "cookieSource": "off"
    },
    {
      "id": "antigravity",
      "enabled": true,
      "source": "oauth"
    },
    {
      "id": "claude",
      "enabled": true,
      "source": "oauth"
    }
  ]
}
```

Exporter default behavior:

- Do not define a separate provider DSL.
- Do not duplicate CodexBar fields such as `source`, `cookieSource`, `tokenAccounts`, API keys, regions, or workspace IDs.
- Invoke CodexBar without a provider override so CodexBar uses `enabled: true` providers from its config.
- If `CODEXBAR_CONFIG` is missing, the exporter reports a collection error and serves an empty or stale snapshot. It must not create fake data.

## Exporter Snapshot Cache

The exporter persists the last successful snapshot to a small disk cache, for example under the exporter cache directory. This cache contains the same JSON shape returned by `/v1/snapshot`; it does not copy auth files or agent session logs.

Startup behavior:

- Load the cached snapshot if it exists.
- Serve that cached snapshot immediately with collection state marked stale until a refresh succeeds.
- Start a background refresh after startup.
- If no cache exists, serve an initializing snapshot with `records: []` until the first collection succeeds.

## Collection Cadence

The exporter owns provider collection cadence. The web polls cached snapshots.

Recommended defaults:

```env
WEB_EXPORTER_POLL_SECONDS=60
EXPORTER_REFRESH_SECONDS=300
EXPORTER_REFRESH_MIN_INTERVAL_SECONDS=60
WEB_STALE_AFTER_SECONDS=600
WEB_EXPIRED_AFTER_SECONDS=86400
```

Behavior:

- Web polls `/v1/snapshot` every 60s. This does not trigger CodexBar.
- Exporter refreshes configured usage and cost every 5 minutes.
- Exporter collection may run usage, cost, and provider tasks concurrently with a small bounded limit. Provider failures are independent so partial successful records still update the snapshot.
- Manual refresh from the web calls `POST /v1/refresh` to refresh all configured scopes and is rate-limited by the exporter.
- Failed refresh keeps the previous good snapshot and records errors.
- Provider failures do not block the entire exporter.
- `/v1/health` never triggers collection.

## Web Aggregation

The web maintains an in-memory cache per scrape target. A scrape target is a configured exporter URL plus token, with an optional display name.

```json
{
  "url": "http://agent-usage-exporter:39180",
  "name": "Local Desktop",
  "lastSuccessAt": "2026-06-11T10:30:00.000Z",
  "lastAttemptAt": "2026-06-11T10:31:00.000Z",
  "snapshot": {},
  "error": null
}
```

Polling behavior:

- On web startup, load the latest successful poll per scrape target from SQLite into the in-memory cache, then mark freshness from stored timestamps.
- Poll scrape targets concurrently with per-target timeouts. One slow or unreachable exporter must not block other targets.
- A UI manual refresh calls `POST /api/refresh` on the web backend. The web starts refresh on every configured scrape target by calling `POST /v1/refresh` on each exporter, then manually polls current snapshots. Because exporter refresh is background work, fresh data may arrive on a later poll if collection is still running.
- If an exporter poll succeeds, replace that exporter's cached snapshot.
- If an exporter poll fails, keep the last successful snapshot and attach the latest error.
- Store every poll attempt in SQLite for simple history/audit, successful or failed.
- Successful rows store the raw exporter snapshot. Failed rows store the poll error next to the same target metadata.
- Do not deduplicate by content in v1.
- V1 keeps SQLite history indefinitely and does not run automatic cleanup.
- V1 does not expose history through the web API. History is stored for later use/audit only.
- Use two SQLite tables in v1:
  - `scrape_targets`: one row per configured exporter URL, with an internal database id, URL, optional display name, and timestamps.
  - `exporter_polls`: one row per poll attempt, linked to `scrape_targets`, with success/failure status, timing, snapshot JSON for success, and error JSON for failure.
- The SQLite internal id is not a required exporter id in the user-facing config. Minimum web config remains URL plus token.
- Bearer tokens must not be stored in SQLite. Tokens stay in the web config/env only.
- If no exporter has ever succeeded, show an empty/error state.
- Remove the existing server mock/demo fallback. Do not show mock, demo, or fake provider data in live mode. If no exporter has ever succeeded, the dashboard must show an empty/error state.

Merge behavior:

- Usage key: `provider + account.key`.
- Usage is provider-reported account state, not additive. For duplicate usage rows, keep the freshest successful row. Do not sum quota percentages.
- Multiple Provider Accounts under the same Provider remain separate for Usage. Do not combine quota windows across accounts.
- Cost key: `scrape target + provider + account.key` for per-target replacement.
- Aggregate cost across exporters by `provider + account.key`. Exported reports are trusted inputs; if the exporter supplies a Provider Account/Account Key, the web uses it for aggregation.
- Preserve per-target cost rows internally for aggregation/history, but do not expose per-machine/source details in v1.
- Unknown account keys stay target-scoped and are not cross-merged.
- Display labels/emails are optional and never required for merging.

Internal fields such as scrape target URL/name and record source may be used for polling, storage, and aggregation. They are not exposed as source-detail UI/API in v1.

Staleness behavior:

- Data older than `WEB_STALE_AFTER_SECONDS` is marked stale.
- Data older than `WEB_EXPIRED_AFTER_SECONDS` is marked expired, but remains included in aggregate totals.
- Cached data remains visible and included when stale or expired.
- The UI should show small text near last update time, such as `Updated 12m ago - stale` or `Laptop exporter unreachable, showing data from 42m ago`.
- Do not expose per-machine/source details in v1.
- Compact source availability text is allowed, such as `Some sources unreachable; showing last known data`.

## Error Shape

Use compact structured snapshot-level and row-level errors. The main user-facing need is exporter availability and stale data.

```json
{
  "code": "CODEXBAR_TIMEOUT",
  "message": "CodexBar cost command timed out.",
  "scope": "cost",
  "provider": "codex",
  "accountKey": "lei@example.com",
  "retryable": true,
  "occurredAt": "2026-06-11T10:30:00.000Z"
}
```

Rules:

- Snapshot-level `errors[]` are for exporter runtime or collection failures.
- Row-level `error` is for degraded provider/account rows.
- Preserve CodexBar-shaped provider payloads under `record.data`, including original error fields when present. Also copy a small summary into `record.error` so the web aggregator does not need to parse provider-specific error shapes.
- Do not drop partial data because one provider failed.
- UI should keep errors compact, such as small unreachable/stale/provider issue text near freshness metadata, not a large error dashboard in v1.

## Docker And Deployment

Compose should define separate services:

- `agent-usage-exporter`
- `agent-usage-web`

Exporter service:

- Mounts agent/CodexBar state.
- Has `EXPORTER_TOKEN`.
- Binds to `0.0.0.0` inside the container.
- Can be bound to localhost, private network, or public host by deployment choice.
- Should run read-only where possible, with narrow writable mounts for caches or token refresh files that require writes.

Web service:

- Does not mount agent auth/cache state.
- Does not perform provider credential refresh. Any local credential refresh needed by CodexBar belongs in the exporter role.
- Reads exporter URLs and per-exporter bearer tokens from config.
- Polls exporters over HTTP.

Web exporter configuration supports both a mounted config file and env JSON. If both are present, the config file wins.

Minimum web exporter config is `url` plus `token`. `name` is optional display text. Example config file:

```json
{
  "exporters": [
    {
      "name": "Local Desktop",
      "url": "http://agent-usage-exporter:39180",
      "token": "..."
    },
    {
      "name": "Laptop",
      "url": "http://laptop.local:39180",
      "token": "..."
    }
  ]
}
```

Example env fallback:

```env
WEB_EXPORTERS_JSON=[{"url":"http://agent-usage-exporter:39180","token":"...","name":"Local Desktop"}]
```

## Testing And Verification

Implementation should be verified with:

- Unit tests for account key derivation, display hiding, unknown identity fallback, and merge behavior.
- Unit tests for stale/expired exporter cache state.
- Endpoint tests for token auth on `/v1/snapshot` and `/v1/refresh`.
- Integration test or manual probe showing web can aggregate local exporter data without mounting agent credentials.
- Docker compose run showing two local services and successful dashboard data.
- Regression check that raw account display can be hidden in the web even when exporters send full labels.

## Open Implementation Notes

- Prefer one image with `APP_ROLE=exporter|web` for the first implementation.
- Keep exporter implementation small. It should not know dashboard UI concepts.
- Keep CodexBar raw payloads under `record.data` so aggregator behavior can evolve without changing the exporter contract.
- Persist a tiny exporter snapshot cache so exporter restarts do not blank data before the next collection succeeds.
- Choose direct CodexBar CLI or CodexBar serve mode during implementation based on measured freshness and correctness. The exporter contract should not expose that internal choice.
