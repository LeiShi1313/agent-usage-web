import type { DashboardPayload } from './types';

/**
 * Build an Error from a non-OK response. Prefers the JSON body's `error`
 * field when present; falls back to the HTTP status code.
 */
async function responseError(response: Response, action: string): Promise<Error> {
  let detail: string | null = null;
  try {
    const body = (await response.json()) as { error?: unknown } | null;
    if (body && typeof body.error === 'string' && body.error.length > 0) {
      detail = body.error;
    }
  } catch {
    // Body was not JSON; fall back to the status code.
  }
  if (detail) return new Error(`${action} failed: ${detail}`);
  return new Error(`${action} failed with ${response.status}`);
}

export async function fetchDashboard(signal?: AbortSignal): Promise<DashboardPayload> {
  const response = await fetch('/api/dashboard', {
    headers: { Accept: 'application/json' },
    signal
  });

  if (!response.ok) {
    throw await responseError(response, 'Dashboard request');
  }

  return response.json() as Promise<DashboardPayload>;
}

export async function refreshDashboard(signal?: AbortSignal): Promise<DashboardPayload> {
  const response = await fetch('/api/refresh', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'x-agent-usage-refresh': '1'
    },
    signal
  });

  if (!response.ok) {
    throw await responseError(response, 'Refresh request');
  }

  return response.json() as Promise<DashboardPayload>;
}
