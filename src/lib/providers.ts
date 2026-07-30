import { Server } from 'lucide-react';
import type { CostPayload, ProviderPayload, RateWindow } from '../types';
import { formatRelative } from './format';

/** Humanize any CodexBar provider id without a hardcoded allowlist. */
export function providerLabel(provider: string) {
  return String(provider || 'unknown')
    .trim()
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (['ai', 'api', 'aws', 'gpt', 'llm', 'id', 'cli'].includes(lower)) return lower.toUpperCase();
      if (lower === 'openai') return 'OpenAI';
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/** Stable pastel-ish brand color derived from the provider id. */
export function providerTint(provider: string) {
  const key = String(provider || 'unknown').toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = Math.imul(31, hash) + key.charCodeAt(i);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 38% 44%)`;
}

export function resolveProviderPresentation(provider: string) {
  return {
    label: providerLabel(provider),
    tint: providerTint(provider),
    icon: Server
  };
}

export function providerKey(provider: ProviderPayload) {
  return `${provider.provider}:${provider.accountKey ?? provider.account ?? 'default'}`;
}

export function providerHealth(provider: ProviderPayload) {
  if (provider.error) return 'Needs attention';
  if (provider.stale) return 'Stale data';
  if (provider.status?.indicator && provider.status.indicator !== 'none') {
    return provider.status.description ?? 'Provider incident';
  }
  const relative = formatRelative(provider.usage?.updatedAt);
  if (relative) return `Updated ${relative}`;
  if (provider.credits) return 'Credits only';
  return 'Waiting for data';
}

/**
 * Find the cost row for a usage row. Matches on provider AND accountKey;
 * a usage row without an accountKey may only match a cost row that also
 * has no accountKey. Never borrows another account's cost.
 */
export function costFor(provider: string, costs: CostPayload[], accountKey?: string | null) {
  const wanted = accountKey ?? null;
  return costs.find(
    (item) => item.provider === provider && (item.accountKey ?? null) === wanted && !item.error
  );
}

/**
 * Human label for a rate window derived from its duration.
 * Falls back to the supplied label when the payload omits windowMinutes.
 */
export function windowLabel(window: RateWindow | null | undefined, fallback: string) {
  const minutes = window?.windowMinutes;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes === 10_080) return 'Weekly limit';
  if (minutes % 1_440 === 0) {
    const days = minutes / 1_440;
    if (days === 30 || days === 31) return 'Monthly limit';
    return `${days}-day limit`;
  }
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}
