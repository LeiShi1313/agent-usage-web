import fs from 'node:fs/promises';
import path from 'node:path';

export function nowISO() {
  return new Date().toISOString();
}

export function isoFromMs(value) {
  return new Date(value).toISOString();
}

export function ageMs(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
}

export function maxISO(values) {
  let max = 0;
  for (const value of values) {
    const timestamp = value ? new Date(value).getTime() : 0;
    if (Number.isFinite(timestamp) && timestamp > max) max = timestamp;
  }
  return max ? isoFromMs(max) : null;
}

export function minISO(values) {
  let min = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const timestamp = value ? new Date(value).getTime() : Number.NaN;
    if (Number.isFinite(timestamp) && timestamp < min) min = timestamp;
  }
  return Number.isFinite(min) ? isoFromMs(min) : null;
}

export function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.providers)) return value.providers;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

export function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function cloneJSON(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}
