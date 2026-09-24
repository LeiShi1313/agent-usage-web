FROM node:24-trixie-slim AS web-build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-trixie-slim AS runtime

ARG CODEXBAR_VERSION=0.65.0
ARG CODEX_CLI_VERSION=0.156.1
ARG CLAUDE_CODE_VERSION=2.1.281

ENV NODE_ENV=production \
    PORT=3000 \
    HOME=/home/node \
    CODEXBAR_VERSION=${CODEXBAR_VERSION}

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar git libsqlite3-0 procps \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) asset_arch="x86_64"; expected_sha256="fb4fa6c022fa3b3e710f5614e41313db31a025df630ef75910a8a811b71022ca" ;; \
      arm64) asset_arch="aarch64"; expected_sha256="4edca5cb0b44bb14ffd0178773a698768e55b3840cdbd7b52f47ff5cab635a7f" ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    asset="CodexBarCLI-v${CODEXBAR_VERSION}-linux-${asset_arch}.tar.gz"; \
    release_url="https://github.com/steipete/CodexBar/releases/download/v${CODEXBAR_VERSION}"; \
    curl -fsSL "${release_url}/${asset}" -o "/tmp/${asset}"; \
    printf '%s  %s\n' "$expected_sha256" "/tmp/${asset}" | sha256sum -c -; \
    mkdir -p /opt/codexbar; \
    tar -xzf "/tmp/${asset}" -C /opt/codexbar; \
    test -x /opt/codexbar/CodexBarCLI; \
    test -f /opt/codexbar/VERSION; \
    printf '%s\n' '#!/bin/sh' 'exec /opt/codexbar/CodexBarCLI "$@"' > /usr/local/bin/codexbar; \
    chmod 0755 /usr/local/bin/codexbar; \
    test "$(codexbar --version)" = "CodexBar ${CODEXBAR_VERSION}"; \
    rm -f "/tmp/${asset}"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=web-build /app/dist ./dist
COPY server ./server

RUN mkdir -p /home/node/.cache/agent-usage-web /home/node/.local/share/agent-usage-web \
    && chown -R node:node /app /home/node

USER node
EXPOSE 3000

CMD ["node", "server/index.js"]
