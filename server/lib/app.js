import express from 'express';
import path from 'node:path';

import { createTokenGuard } from './auth.js';

const API_CACHE_CONTROL = 'no-store, no-cache, must-revalidate, proxy-revalidate';

function applySecurityHeaders(app, { browserApp }) {
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (browserApp) {
      response.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "img-src 'self' data:",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self'"
      ].join('; '));
    }
    if (request.path.startsWith('/api/') || request.path.startsWith('/v1/')) {
      response.setHeader('Cache-Control', API_CACHE_CONTROL);
    }
    next();
  });
}

export function isSensitivePath(request) {
  const rawPath = request.originalUrl.split('?')[0];
  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return true;
  }

  const candidates = [rawPath, decodedPath].map((value) => value.toLowerCase());
  return candidates.some((value) => (
    value.includes('..') ||
    value.includes('%2e') ||
    /(^|\/)\.[^/]/.test(value) ||
    /(^|\/)(dockerfile|docker-compose\.ya?ml|package(?:-lock)?\.json|server|src|node_modules|home|app)(\/|$)/.test(value) ||
    /(^|\/)(auth|credentials?|secrets?|tokens?|cookies?)(\.|\/|$)/.test(value)
  ));
}

export function createExporterApp({ store, token }) {
  const app = express();
  applySecurityHeaders(app, { browserApp: false });
  const requireToken = createTokenGuard(token);

  app.get('/v1/health', (_request, response) => {
    response.json({
      ok: true,
      role: 'exporter',
      collection: store.current.collection,
      generatedAt: store.current.generatedAt
    });
  });

  app.get('/v1/snapshot', (request, response) => {
    if (!requireToken(request, response)) return;
    response.json(store.current);
  });

  app.post('/v1/refresh', async (request, response) => {
    if (!requireToken(request, response)) return;
    const wait = request.query.wait === '1' || request.query.wait === 'true';
    const result = store.refresh('manual');
    if (wait && result.promise) {
      await result.promise.catch(() => null);
    }
    response.json({
      accepted: true,
      status: result.status,
      generatedAt: store.current.generatedAt,
      collection: store.current.collection
    });
  });

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found' });
  });

  return app;
}

export function createWebApp({ runtime, staticDir }) {
  const app = express();
  applySecurityHeaders(app, { browserApp: true });

  app.use((request, response, next) => {
    if (isSensitivePath(request)) {
      response.status(404).type('text/plain').send('Not found');
      return;
    }
    next();
  });

  app.get('/api/health', (_request, response) => {
    const dashboard = runtime.buildDashboard();
    response.json({
      ok: true,
      role: 'web',
      exporters: runtime.targets.length,
      freshness: dashboard.freshness
    });
  });

  app.get('/api/dashboard', (_request, response) => {
    response.json(runtime.buildDashboard());
  });

  app.get('/api/usage', (_request, response) => {
    response.json(runtime.buildDashboard().usage);
  });

  app.get('/api/cost', (_request, response) => {
    response.json(runtime.buildDashboard().cost);
  });

  app.post('/api/refresh', async (request, response) => {
    // Cross-origin pages cannot attach custom headers without a CORS
    // preflight (which this server never grants), so requiring one blocks
    // CSRF-style auto-submitting forms from triggering exporter collection.
    if (request.headers['x-agent-usage-refresh'] !== '1') {
      response.status(403).json({ error: 'Missing refresh confirmation header.' });
      return;
    }
    const result = runtime.refreshAll();
    if (result.promise) {
      await result.promise;
    }
    const dashboard = runtime.buildDashboard();
    dashboard.refresh = { status: result.status };
    response.json(dashboard);
  });

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'Not found' });
  });

  app.use(express.static(staticDir, {
    fallthrough: true,
    maxAge: '1h'
  }));

  app.use((_request, response) => {
    response.sendFile(path.join(staticDir, 'index.html'));
  });

  return app;
}
