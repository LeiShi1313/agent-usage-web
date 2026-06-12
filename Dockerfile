FROM node:24-trixie-slim AS web-build

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:24-trixie-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOME=/home/node

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar git libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@latest @anthropic-ai/claude-code@latest

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) asset_arch="x86_64" ;; \
      arm64) asset_arch="aarch64" ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    url="$(node -e "const https=require('https'); const arch=process.argv[1]; https.get('https://api.github.com/repos/steipete/CodexBar/releases/latest',{headers:{'User-Agent':'agent-usage-web'}},res=>{let data=''; res.on('data',d=>data+=d); res.on('end',()=>{const release=JSON.parse(data); const asset=(release.assets||[]).find(a=>a.name.includes('linux-'+arch) && a.name.endsWith('.tar.gz')); if(!asset){console.error('No CodexBar Linux asset for '+arch); process.exit(1);} console.log(asset.browser_download_url);});}).on('error',err=>{console.error(err); process.exit(1);});" "$asset_arch")"; \
    mkdir -p /tmp/codexbar; \
    curl -fsSL "$url" -o /tmp/codexbar.tar.gz; \
    tar -xzf /tmp/codexbar.tar.gz -C /tmp/codexbar; \
    binary="$(find /tmp/codexbar -type f \( -name codexbar -o -name CodexBarCLI \) -perm /111 | head -n 1)"; \
    test -n "$binary"; \
    install -m 0755 "$binary" /usr/local/bin/codexbar; \
    rm -rf /tmp/codexbar /tmp/codexbar.tar.gz; \
    codexbar --version

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=web-build /app/dist ./dist
COPY server ./server
COPY docker/entrypoint.sh /entrypoint.sh

RUN mkdir -p /home/node/.cache/agent-usage-web /home/node/.local/share/agent-usage-web \
    && chmod +x /entrypoint.sh \
    && chown -R node:node /app /home/node

USER node
EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
