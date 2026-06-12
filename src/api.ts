import type { DashboardPayload } from './types';

export async function fetchDashboard(signal?: AbortSignal): Promise<DashboardPayload> {
  const response = await fetch('/api/dashboard', {
    headers: { Accept: 'application/json' },
    signal
  });

  if (!response.ok) {
    throw new Error(`Dashboard request failed with ${response.status}`);
  }

  return response.json() as Promise<DashboardPayload>;
}

export async function refreshDashboard(signal?: AbortSignal): Promise<DashboardPayload> {
  const response = await fetch('/api/refresh', {
    method: 'POST',
    headers: { Accept: 'application/json' },
    signal
  });

  if (!response.ok) {
    throw new Error(`Refresh request failed with ${response.status}`);
  }

  return response.json() as Promise<DashboardPayload>;
}
