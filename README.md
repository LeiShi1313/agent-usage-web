# Agent Usage Web

Usage and cost dashboard for local AI agents. The app is split into two roles:

- `exporter`: collects Codex and Antigravity through CodexBar and serves a token-protected usage snapshot.
- `web`: polls one or more exporters, stores raw poll history in SQLite, aggregates by provider account, and serves the dashboard.

The Docker image is published at:

```text
leishi1313/agent-usage-web:latest
leishi1313/agent-usage-web:0.2.1
leishi1313/agent-usage-web:0.2.0
leishi1313/agent-usage-web:0.2
leishi1313/agent-usage-web:0.1.4
leishi1313/agent-usage-web:0.1.3
leishi1313/agent-usage-web:0.1.2
leishi1313/agent-usage-web:0.1.1
leishi1313/agent-usage-web:0.1.0
```

The same image runs both services. Compose selects the `exporter` or `web` process with `APP_ROLE`.

## Run

Create `.env` from the example and set a real token:

```bash
cp .env.example .env
sed -i "s/^EXPORTER_TOKEN=.*/EXPORTER_TOKEN=$(openssl rand -hex 32)/" .env
```

Start the stack:

```bash
docker compose up -d
```

Open:

```text
http://127.0.0.1:39173
```

The exporter is also bound to localhost by default:

```text
http://127.0.0.1:39174
```

## Configuration

The exporter uses CodexBar's native config for provider-specific settings:

```text
~/.codexbar/config.json -> /home/node/.codexbar/config.json:ro
```

The default compose stack mounts only the state the enabled providers need into the exporter:

```text
~/.codex                  -> /home/node/.codex:rw
~/.codexbar               -> /home/node/.codexbar:ro
~/.codexbar/antigravity   -> /home/node/.codexbar/antigravity:rw
~/.gemini                 -> /home/node/.gemini:ro  # Antigravity state uses this upstream path
~/.grok                   -> /home/node/.grok:rw
```

When you enable another provider in `~/.codexbar/config.json`, add its state directory as a mount in `docker-compose.yml` (for example `~/.claude` for Claude) rather than mounting whole config trees.

Enable providers in `~/.codexbar/config.json` (for example `"id": "grok", "enabled": true`). Grok needs a SuperGrok login (`grok login`) so `~/.grok/auth.json` exists; the exporter puts `~/.grok/bin` on `PATH` for the Grok CLI billing path and sets `CODEXBAR_ALLOW_BROWSER_COOKIE_IMPORT=1` so CodexBar can fall back to grok.com via Chrome cookies when needed.

The web role does not mount agent auth or cache directories. It only has a writable Docker volume for SQLite poll history.

Useful `.env` options:

```env
AGENT_USAGE_WEB_PORT=39173
AGENT_USAGE_EXPORTER_PORT=39174
EXPORTER_TOKEN=replace-me
WEB_ACCOUNT_DISPLAY=hidden
WEB_PROVIDER_ORDER=codex,antigravity,grok
WEB_EXPORTER_POLL_SECONDS=60
WEB_POLL_RETENTION_DAYS=30
WEB_REFRESH_MIN_INTERVAL_SECONDS=30
EXPORTER_REFRESH_SECONDS=300
EXPORTER_CODEX_USAGE_SOURCE=oauth
```

Exporter traffic carries the bearer token and usage data in plain HTTP. Keep exporters on localhost, a private network, or an encrypted overlay (Tailscale, WireGuard); put a TLS reverse proxy in front of any exporter exposed beyond that.

`WEB_PROVIDER_ORDER` controls the physical display order of provider rows/tabs in the web UI. Providers listed first appear first; unlisted providers fall back to alphabetical order after the listed providers.

To aggregate multiple exporters, set `WEB_EXPORTERS_JSON` in `.env`:

```env
WEB_EXPORTERS_JSON=[{"url":"http://agent-usage-exporter:3000","token":"same-as-exporter-token","name":"Local"},{"url":"http://example-host:39174","token":"remote-exporter-token","name":"Remote"}]
```

`WEB_ACCOUNT_DISPLAY=hidden` is the default. In that mode, public API responses do not include account emails or raw account IDs; the UI receives opaque per-account keys for selection and cost matching.

`EXPORTER_CODEX_USAGE_SOURCE=oauth` applies only to the Codex probe. By default the exporter scrapes every **enabled** provider in `~/.codexbar/config.json` (one `codexbar usage --provider <id>` call each). Override with `EXPORTER_USAGE_PROVIDERS=codex,antigravity,grok` if you want a fixed allowlist. Cost collection defaults to Codex (`EXPORTER_COST_PROVIDER`).

## API

Exporter:

```text
GET  /v1/health
GET  /v1/snapshot   Authorization: Bearer <EXPORTER_TOKEN>
POST /v1/refresh    Authorization: Bearer <EXPORTER_TOKEN>
```

Web:

```text
GET  /api/health
GET  /api/dashboard
POST /api/refresh
```

The web service stores every exporter poll attempt in SQLite, including both successful snapshots and failure records; rows older than `WEB_POLL_RETENTION_DAYS` (default 30 days, `0` keeps forever) are pruned while the latest successful poll per exporter is always retained. `/api/dashboard` includes structured, sanitized `upstreamIssues` for the expandable error disclosure and retains `upstreamErrors` as legacy summary strings. There is no fake or demo data path.

`POST /api/refresh` requires the request header `x-agent-usage-refresh: 1` (the dashboard sends it automatically); cross-origin pages cannot attach it without a CORS preflight, which blocks CSRF-style refresh triggering. Refreshes are also coalesced and rate-limited (`WEB_REFRESH_MIN_INTERVAL_SECONDS`, default 30).

## Development

The server is split into an entry point (`server/index.js`) and role modules under `server/lib/`: `config.js` (env parsing), `sanitize.js` (redaction), `identity.js` (account derivation), `collect.js` (CodexBar collection), `snapshot-store.js` (exporter snapshot cache/refresh), `poll-store.js` (SQLite), `exporter-client.js`, `web-runtime.js` (poll cache + refresh fan-out), `dashboard.js` (aggregation), and `app.js` (Express apps for both roles). Pure logic is unit-tested directly; the tests in `test/exporter-issues.test.js` exercise both roles end to end.

```bash
npm install
npm test
npm run lint
npm run build
node --check server/index.js
docker compose up -d --build
```
