import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function startApp(t, env) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
  });
  return { child, output: () => output };
}

async function waitForJSON(url, options, predicate, diagnostics) {
  let lastError = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const body = await response.json();
      if (response.ok && predicate(body)) return body;
      lastError = new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? 'unknown error'}\n${diagnostics()}`);
}

test('exporter collects only Codex and Antigravity usage and publishes one structured provider issue', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'agent-usage-exporter-test-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const callsPath = path.join(temporaryDirectory, 'calls.jsonl');
  const fakeCodexBarPath = path.join(temporaryDirectory, 'codexbar');
  await writeFile(fakeCodexBarPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const command = args[0];
const providerIndex = args.indexOf('--provider');
const provider = providerIndex === -1 ? 'all' : args[providerIndex + 1];
appendFileSync(process.env.FAKE_CODEXBAR_CALLS, JSON.stringify({ command, provider, args }) + '\\n');
const delayMs = Number(process.env.FAKE_CODEXBAR_DELAY_MS ?? 0);
if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

const codexUsage = {
  provider: 'codex',
  source: 'oauth',
  account: 'codex-test',
  usage: { updatedAt: '2026-07-10T09:00:00Z', primary: { usedPercent: 20 } }
};
const antigravityError = {
  provider: 'cli',
  source: 'auto',
  error: {
    code: 1,
    message: "Missing CLI '/bin/ps'. Contact person@example.com; cache /home/node/.gemini; Bearer secret-token-value"
  }
};
const geminiError = {
  provider: 'gemini',
  source: 'auto',
  error: { code: 1, message: 'Deprecated Gemini probe ran' }
};
const codexCost = {
  provider: 'codex',
  source: 'local',
  account: 'codex-test',
  last30DaysTokens: 1200,
  last30DaysCostUSD: 1.25
};

if (command === 'usage' && provider === 'codex') {
  process.stdout.write(JSON.stringify([codexUsage]));
} else if (command === 'usage' && provider === 'antigravity') {
  process.stdout.write(JSON.stringify([antigravityError]));
  process.stderr.write(JSON.stringify({
    level: 'error',
    label: 'com.steipete.codexbar.antigravity-probe',
    message: "Missing CLI '/bin/ps'. Contact person@example.com; cache /home/node/.gemini"
  }) + '\\n');
  process.exitCode = 1;
} else if (command === 'cost' && provider === 'codex') {
  process.stdout.write(JSON.stringify([codexCost]));
} else {
  process.stdout.write(JSON.stringify(command === 'cost' ? [codexCost] : [codexUsage, antigravityError, geminiError]));
  process.stderr.write(JSON.stringify({ level: 'error', message: 'Deprecated Gemini probe ran' }) + '\\n');
  process.exitCode = 1;
}
`);
  await chmod(fakeCodexBarPath, 0o755);

  const port = await reservePort();
  const token = 'test-exporter-token';
  const snapshotPath = path.join(temporaryDirectory, 'snapshot.json');
  await writeFile(snapshotPath, JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-07-10T08:00:00.000Z',
    exporter: { role: 'exporter', hostname: 'old-exporter' },
    collection: { status: 'partial', startedAt: null, finishedAt: '2026-07-10T08:00:00.000Z', recordCount: 1 },
    records: [{ kind: 'usage', provider: 'gemini', error: { message: 'Deprecated Gemini probe ran' } }],
    errors: [{ code: 'usage-gemini', provider: 'gemini', message: 'Deprecated Gemini probe ran' }]
  }));
  const app = startApp(t, {
    APP_ROLE: 'exporter',
    PORT: String(port),
    EXPORTER_TOKEN: token,
    EXPORTER_REFRESH_SECONDS: '0',
    EXPORTER_COMMAND_TIMEOUT_MS: '5000',
    EXPORTER_SNAPSHOT_CACHE_PATH: snapshotPath,
    FAKE_CODEXBAR_CALLS: callsPath,
    FAKE_CODEXBAR_DELAY_MS: '150',
    HOME: temporaryDirectory,
    PATH: `${temporaryDirectory}:${process.env.PATH ?? ''}`
  });

  const refreshingSnapshot = await waitForJSON(
    `http://127.0.0.1:${port}/v1/snapshot`,
    { headers: { Authorization: `Bearer ${token}` } },
    (body) => body.collection?.status === 'refreshing',
    app.output
  );
  assert.equal(refreshingSnapshot.records.some((record) => record.provider === 'gemini'), false);
  assert.equal(refreshingSnapshot.errors.some((error) => error.provider === 'gemini'), false);

  const snapshot = await waitForJSON(
    `http://127.0.0.1:${port}/v1/snapshot`,
    { headers: { Authorization: `Bearer ${token}` } },
    (body) => body.collection?.status !== 'refreshing' && body.collection?.status !== 'initializing',
    app.output
  );
  const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  assert.deepEqual(calls.map(({ command, provider }) => `${command}:${provider}`), [
    'usage:codex',
    'usage:antigravity',
    'cost:codex'
  ]);
  assert.deepEqual([...new Set(snapshot.records.map((record) => record.provider))].sort(), ['antigravity', 'codex']);
  assert.equal(snapshot.records.some((record) => record.provider === 'gemini'), false);
  assert.equal(snapshot.collection.status, 'partial');
  assert.equal(snapshot.errors.length, 1);
  assert.deepEqual(
    {
      code: snapshot.errors[0].code,
      provider: snapshot.errors[0].provider,
      operation: snapshot.errors[0].operation
    },
    { code: 'usage-antigravity', provider: 'antigravity', operation: 'usage' }
  );
  assert.match(snapshot.errors[0].message, /Missing CLI '\/bin\/ps'/);
  assert.match(snapshot.errors[0].details, /Missing CLI '\/bin\/ps'/);
  assert.doesNotMatch(JSON.stringify(snapshot.errors[0]), /person@example\.com|secret-token-value|\/home\/node/);
});

test('web exposes structured sanitized upstream issues while retaining the legacy summary strings', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'agent-usage-web-test-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const exporterToken = 'fake-upstream-token';
  const exporterSnapshot = {
    schemaVersion: 1,
    generatedAt: '2026-07-10T09:05:00.000Z',
    exporter: { role: 'exporter', hostname: 'private-hostname' },
    collection: {
      status: 'partial',
      startedAt: '2026-07-10T09:04:59.000Z',
      finishedAt: '2026-07-10T09:05:00.000Z',
      recordCount: 0
    },
    records: [],
    errors: [{
      code: 'usage-antigravity',
      provider: 'antigravity',
      operation: 'usage',
      message: "Missing CLI '/bin/ps' for person@example.com at /Users/lei/.gemini",
      details: 'Collector could not inspect the process list. Bearer secret-token-value api_key=another-secret',
      at: '2026-07-10T09:05:00.000Z'
    }]
  };

  const fakeExporter = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${exporterToken}`) {
      response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    if (request.url === '/v1/snapshot') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(exporterSnapshot));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
  });
  await new Promise((resolve, reject) => {
    fakeExporter.once('error', reject);
    fakeExporter.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => fakeExporter.close(resolve)));
  const exporterAddress = fakeExporter.address();
  const exporterPort = typeof exporterAddress === 'object' && exporterAddress ? exporterAddress.port : 0;

  const webPort = await reservePort();
  const app = startApp(t, {
    APP_ROLE: 'web',
    PORT: String(webPort),
    WEB_EXPORTER_POLL_SECONDS: '0',
    WEB_SQLITE_PATH: path.join(temporaryDirectory, 'polls.sqlite'),
    WEB_EXPORTERS_JSON: JSON.stringify([{
      url: `http://127.0.0.1:${exporterPort}`,
      token: exporterToken,
      name: 'Macbook Pro M1 Max'
    }])
  });

  const dashboard = await waitForJSON(
    `http://127.0.0.1:${webPort}/api/dashboard`,
    {},
    (body) => body.freshness?.successfulSourceCount === 1,
    app.output
  );

  assert.equal(dashboard.upstreamIssues.length, 1);
  assert.deepEqual(
    {
      source: dashboard.upstreamIssues[0].source,
      code: dashboard.upstreamIssues[0].code,
      provider: dashboard.upstreamIssues[0].provider,
      operation: dashboard.upstreamIssues[0].operation,
      occurredAt: dashboard.upstreamIssues[0].occurredAt
    },
    {
      source: 'Macbook Pro M1 Max',
      code: 'usage-antigravity',
      provider: 'antigravity',
      operation: 'usage',
      occurredAt: '2026-07-10T09:05:00.000Z'
    }
  );
  assert.match(dashboard.upstreamIssues[0].message, /Missing CLI '\/bin\/ps'/);
  assert.match(dashboard.upstreamIssues[0].details, /Collector could not inspect the process list/);
  assert.doesNotMatch(JSON.stringify(dashboard.upstreamIssues), /person@example\.com|secret-token-value|another-secret|\/Users\/lei/);
  assert.deepEqual(dashboard.upstreamErrors, [
    `Macbook Pro M1 Max: ${dashboard.upstreamIssues[0].message}`
  ]);
});
