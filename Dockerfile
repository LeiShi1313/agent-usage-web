FROM node:24-trixie-slim AS web-build

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:24-trixie-slim AS runtime

ARG CODEXBAR_VERSION=0.41.0

ENV NODE_ENV=production \
    PORT=3000 \
    HOME=/home/node \
    CODEXBAR_VERSION=${CODEXBAR_VERSION}

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar git libsqlite3-0 procps \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@latest @anthropic-ai/claude-code@latest

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) asset_arch="x86_64"; expected_sha256="422304da56b5011f3c877a36b0bf9b47f9c20cfbbe84c70084f26690a714055d" ;; \
      arm64) asset_arch="aarch64"; expected_sha256="343950f75e05fdb34f262a0b3c1d71ec1e5cfbe752dd2ef3427d40a929af4d1d" ;; \
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
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=web-build /app/dist ./dist
COPY server ./server
COPY docker/entrypoint.sh /entrypoint.sh

RUN mkdir -p /home/node/.cache/agent-usage-web /home/node/.local/share/agent-usage-web \
    && chmod 0755 /entrypoint.sh \
    && chown -R node:node /app /home/node

USER node
EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
