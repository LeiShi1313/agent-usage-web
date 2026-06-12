# Agent Usage Web

Usage and cost dashboard for local AI agents. The app is split into two roles:

- `exporter`: runs CodexBar against local agent state and serves a token-protected usage snapshot.
- `web`: polls one or more exporters, stores raw poll history in SQLite, aggregates by provider account, and serves the dashboard.

The Docker image is published at:

```text
leishi1313/agent-usage-web:latest
leishi1313/agent-usage-web:0.1.2
leishi1313/agent-usage-web:0.1.1
leishi1313/agent-usage-web:0.1.0
```

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

The exporter uses CodexBar's native config:

```text
~/.codexbar/config.json -> /home/node/.codexbar/config.json:ro
```

Provider selection should be declared there. The default compose stack mounts local agent state into the exporter only:

```text
~/.codex                  -> /home/node/.codex:ro
~/.codexbar               -> /home/node/.codexbar:ro
~/.codexbar/antigravity   -> /home/node/.codexbar/antigravity:rw
~/.claude                 -> /home/node/.claude:ro
~/.claude/.credentials.json -> /home/node/.claude/.credentials.json:rw
~/.cursor                 -> /home/node/.cursor:ro
~/.gemini                 -> /home/node/.gemini:ro
~/.config                 -> /home/node/.config:ro
~/.local/share            -> /home/node/.local/share:ro
```

The web role does not mount agent auth or cache directories. It only has a writable Docker volume for SQLite poll history.

Useful `.env` options:

```env
AGENT_USAGE_WEB_PORT=39173
AGENT_USAGE_EXPORTER_PORT=39174
EXPORTER_TOKEN=replace-me
WEB_ACCOUNT_DISPLAY=hidden
WEB_PROVIDER_ORDER=codex,antigravity
WEB_EXPORTER_POLL_SECONDS=60
EXPORTER_REFRESH_SECONDS=300
```

`WEB_PROVIDER_ORDER` controls the physical display order of provider rows/tabs in the web UI. Providers listed first appear first; unlisted providers fall back to alphabetical order after the listed providers.

To aggregate multiple exporters, set `WEB_EXPORTERS_JSON` in `.env`:

```env
WEB_EXPORTERS_JSON=[{"url":"http://agent-usage-exporter:3000","token":"same-as-exporter-token","name":"Local"},{"url":"http://example-host:39174","token":"remote-exporter-token","name":"Remote"}]
```

`WEB_ACCOUNT_DISPLAY=hidden` is the default. In that mode, public API responses do not include account emails or raw account IDs; the UI receives opaque per-account keys for selection and cost matching.

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

The web service stores every exporter poll attempt in SQLite, including both successful snapshots and failure records. There is no fake or demo data path.

## Development

```bash
npm install
npm run build
node --check server/index.js
docker compose up -d --build
```

The current `npm run lint` script requires an ESLint 9 flat config that has not been added yet.
