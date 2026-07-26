import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createExporterApp, createWebApp } from './lib/app.js';
import { createCollector } from './lib/collect.js';
import { loadConfig, loadWebTargets } from './lib/config.js';
import { createDashboardBuilder } from './lib/dashboard.js';
import { createExporterClient } from './lib/exporter-client.js';
import { createPollStore, openPollDatabase } from './lib/poll-store.js';
import { redactText } from './lib/sanitize.js';
import { createSnapshotStore } from './lib/snapshot-store.js';
import { ensureParentDir } from './lib/util.js';
import { createWebRuntime } from './lib/web-runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(__dirname, '..', 'dist');

const config = loadConfig(process.env);

function logError(error) {
  console.error(redactText(error instanceof Error ? error.message : String(error)));
}

async function startExporter() {
  const collector = createCollector({
    config: config.exporter,
    runCommand: promisify(execFile)
  });
  const store = createSnapshotStore({
    collect: collector.collectSnapshot,
    cachePath: config.exporter.snapshotCachePath,
    minIntervalSeconds: config.exporter.refreshMinIntervalSeconds,
    hostname: config.hostname
  });
  await store.loadCache();
  store.refresh('startup', { force: true });
  if (config.exporter.refreshSeconds > 0) {
    setInterval(() => {
      store.refresh('interval');
    }, config.exporter.refreshSeconds * 1000).unref();
  }
  return createExporterApp({ store, token: config.exporter.token });
}

async function startWeb() {
  await ensureParentDir(config.web.sqlitePath);
  const pollStore = createPollStore(openPollDatabase(config.web.sqlitePath));
  const targets = await loadWebTargets(process.env);
  const { buildDashboard } = createDashboardBuilder(config.web);
  const runtime = createWebRuntime({
    pollStore,
    client: createExporterClient({ timeoutMs: config.web.pollTimeoutMs }),
    targets,
    buildDashboard,
    refreshMinIntervalSeconds: config.web.refreshMinIntervalSeconds
  });

  runtime.pollAll().catch(logError);
  if (config.web.pollSeconds > 0) {
    setInterval(() => {
      runtime.pollAll().catch(logError);
    }, config.web.pollSeconds * 1000).unref();
  }
  if (config.web.pollRetentionDays > 0) {
    const prune = () => {
      try {
        pollStore.prunePolls(config.web.pollRetentionDays);
      } catch (error) {
        logError(error);
      }
    };
    prune();
    setInterval(prune, 6 * 3_600_000).unref();
  }
  return createWebApp({ runtime, staticDir: STATIC_DIR });
}

let app;
if (config.role === 'exporter') {
  app = await startExporter();
} else if (config.role === 'web') {
  app = await startWeb();
} else {
  throw new Error(`Unsupported APP_ROLE: ${config.role}`);
}

app.listen(config.port, '0.0.0.0', () => {
  console.log(`agent-usage-${config.role} listening on http://0.0.0.0:${config.port}`);
});
