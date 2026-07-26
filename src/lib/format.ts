import type { RateWindow } from '../types';

export function clampPercent(value: number | undefined | null) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function remainingPercent(window?: RateWindow | null) {
  return 100 - clampPercent(window?.usedPercent);
}

export function usageColor(usedPercent: number | undefined | null) {
  const used = clampPercent(usedPercent);
  if (used >= 85) return '#d94b3d';
  if (used >= 60) return '#d9a441';
  return '#37a66a';
}

export function formatPercent(value: number | undefined | null) {
  return `${Math.round(clampPercent(value))}%`;
}

export function formatReset(value?: string | null) {
  if (!value) return 'Reset pending';
  const reset = new Date(value);
  if (Number.isNaN(reset.getTime())) return 'Reset pending';
  const diffMs = reset.getTime() - Date.now();
  if (diffMs <= 0) return 'Resets soon';
  const hours = Math.floor(diffMs / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `Resets in ${days}d ${hours % 24}h`;
  if (hours > 0) return `Resets in ${hours}h ${minutes}m`;
  return `Resets in ${Math.max(1, minutes)}m`;
}

export function formatTime(value?: string | null) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric'
  }).format(date);
}

/**
 * Relative age of a timestamp: "just now" (<90s), "Nm ago" (<1h),
 * "Nh ago" (<24h), otherwise "Nd ago". Returns null when the
 * timestamp is missing or unparsable so callers can render an
 * honest fallback instead of a fabricated freshness claim.
 */
export function formatRelative(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const ageSeconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (ageSeconds < 90) return 'just now';
  if (ageSeconds < 3_600) return `${Math.max(1, Math.floor(ageSeconds / 60))}m ago`;
  if (ageSeconds < 86_400) return `${Math.max(1, Math.floor(ageSeconds / 3_600))}h ago`;
  return `${Math.max(1, Math.floor(ageSeconds / 86_400))}d ago`;
}

export function formatTokens(tokens?: number | null) {
  if (!tokens) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${tokens}`;
}

export function formatMoney(value?: number | null) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  }).format(value ?? 0);
}
