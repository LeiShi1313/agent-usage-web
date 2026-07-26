import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchDashboard, refreshDashboard } from '../api';
import type { DashboardPayload } from '../types';

export type DashboardState = {
  data: DashboardPayload | null;
  error: string | null;
  /** True only while a user-initiated refresh is in flight (background polls stay silent). */
  manualRefreshing: boolean;
  /** Trigger a manual refresh (POST /api/refresh). */
  refresh: () => void;
};

const POLL_INTERVAL_MS = 30_000;

export function useDashboard(): DashboardState {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);

  // Abort the previous request whenever a new one starts (and on unmount).
  const controllerRef = useRef<AbortController | null>(null);
  // Monotonic sequence numbers: drop responses older than the last applied one.
  const requestSeq = useRef(0);
  const appliedSeq = useRef(0);
  // Ref mirror of manualRefreshing so the poll interval can skip its tick.
  const manualInFlight = useRef(false);

  const load = useCallback(async (manual: boolean) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const seq = ++requestSeq.current;

    if (manual) {
      manualInFlight.current = true;
      setManualRefreshing(true);
    }

    try {
      const next = manual
        ? await refreshDashboard(controller.signal)
        : await fetchDashboard(controller.signal);
      if (seq > appliedSeq.current) {
        appliedSeq.current = seq;
        setData(next);
        setError(null);
      }
    } catch (err) {
      // Aborted requests were superseded (or the component unmounted); ignore.
      if (!controller.signal.aborted && seq > appliedSeq.current) {
        appliedSeq.current = seq;
        setError(err instanceof Error ? err.message : 'Failed to load dashboard');
      }
    } finally {
      if (manual) {
        manualInFlight.current = false;
        setManualRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load(false);
    const timer = window.setInterval(() => {
      if (manualInFlight.current) return;
      void load(false);
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      controllerRef.current?.abort();
    };
  }, [load]);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  return { data, error, manualRefreshing, refresh };
}
