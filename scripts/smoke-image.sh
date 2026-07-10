#!/usr/bin/env bash
set -euo pipefail

image="${1:?Usage: smoke-image.sh <image>}"
suffix="${GITHUB_RUN_ID:-local}-$$"
exporter_name="agent-usage-exporter-smoke-${suffix}"
web_name="agent-usage-web-smoke-${suffix}"

cleanup() {
  docker rm --force "$exporter_name" "$web_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_role() {
  local container="$1"
  local path="$2"
  local role="$3"
  local port response

  port="$(docker port "$container" 3000/tcp | awk -F: 'NR == 1 { print $NF }')"
  for _ in $(seq 1 40); do
    response="$(curl --fail --silent --show-error "http://127.0.0.1:${port}${path}" 2>/dev/null || true)"
    if [[ "$response" == *"\"role\":\"${role}\""* ]]; then
      return 0
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container")" != "true" ]]; then
      break
    fi
    sleep 0.5
  done

  docker logs "$container" >&2 || true
  return 1
}

codexbar_version="$(
  docker image inspect "$image" --format '{{range .Config.Env}}{{println .}}{{end}}' |
    sed -n 's/^CODEXBAR_VERSION=//p'
)"
test -n "$codexbar_version"
test "$(docker run --rm --entrypoint codexbar "$image" --version)" = "CodexBar ${codexbar_version}"
docker run --rm --entrypoint sh "$image" -c 'test -x /bin/ps'

docker run --detach \
  --name "$exporter_name" \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --publish 127.0.0.1::3000 \
  --env APP_ROLE=exporter \
  --env PORT=3000 \
  --env EXPORTER_TOKEN=smoke-test-token \
  --env EXPORTER_REFRESH_SECONDS=0 \
  --env EXPORTER_COMMAND_TIMEOUT_MS=5000 \
  --env EXPORTER_SNAPSHOT_CACHE_PATH=/tmp/exporter-snapshot.json \
  --env HOME=/tmp/home \
  --env XDG_CONFIG_HOME=/tmp/config \
  --env XDG_CACHE_HOME=/tmp/cache \
  --env XDG_DATA_HOME=/tmp/data \
  "$image" >/dev/null

docker run --detach \
  --name "$web_name" \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --publish 127.0.0.1::3000 \
  --env APP_ROLE=web \
  --env PORT=3000 \
  --env 'WEB_EXPORTERS_JSON=[]' \
  --env WEB_EXPORTER_POLL_SECONDS=0 \
  --env WEB_SQLITE_PATH=/tmp/polls.sqlite \
  "$image" >/dev/null

wait_for_role "$exporter_name" /v1/health exporter
wait_for_role "$web_name" /api/health web

printf 'Smoke checks passed for %s (CodexBar %s; exporter + web).\n' "$image" "$codexbar_version"
