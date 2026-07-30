import { redactText } from './sanitize.js';
import { fetchWithTimeout, nowISO } from './util.js';

export function errorEnvelope(error, code = 'fetch-failed') {
  return {
    message: redactText(error instanceof Error ? error.message : String(error)),
    code,
    at: nowISO()
  };
}

export function createExporterClient({ timeoutMs }) {
  async function fetchSnapshot(target) {
    const response = await fetchWithTimeout(`${target.url}/v1/snapshot`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${target.token}`
      }
    }, timeoutMs);
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw Object.assign(new Error(`Exporter returned non-JSON from ${target.url}`), { statusCode: response.status });
    }
    if (!response.ok) {
      throw Object.assign(new Error(body?.error ?? `Exporter returned HTTP ${response.status}`), { statusCode: response.status });
    }
    if (!body || body.schemaVersion !== 1 || !Array.isArray(body.records)) {
      throw Object.assign(new Error('Exporter snapshot schema is invalid.'), { statusCode: response.status });
    }
    return { snapshot: body, statusCode: response.status };
  }

  async function requestRefresh(target) {
    const response = await fetchWithTimeout(`${target.url}/v1/refresh?wait=1`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${target.token}`
      }
    }, timeoutMs);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw Object.assign(new Error(body?.error ?? `Exporter refresh returned HTTP ${response.status}`), { statusCode: response.status });
    }
  }

  return { fetchSnapshot, requestRefresh };
}
