import { publicText } from './sanitize.js';
import { nowISO } from './util.js';

export const ISSUE_OPERATIONS = ['collection', 'config', 'cost', 'poll', 'refresh', 'usage'];

export function makeIssue(message, code, { provider = null, operation = 'collection', details = null, at = nowISO() } = {}) {
  const issue = {
    message: publicText(message),
    code,
    provider,
    operation,
    at
  };
  if (details) issue.details = publicText(details);
  return issue;
}

export function issueCode(value, fallback = 'upstream-error') {
  const normalized = String(value ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(normalized) ? normalized : fallback;
}

export function issueProvider(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(normalized) ? normalized : null;
}

export function issueOperation(value, fallback = 'collection') {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ISSUE_OPERATIONS.includes(normalized) ? normalized : fallback;
}

export function issueTimestamp(value, fallback = null) {
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

/** Sanitize an upstream error into the dashboard's public issue shape. */
export function publicUpstreamIssue(source, error, defaults = {}) {
  const publicDetails = error?.details ? publicText(error.details) : null;
  return {
    source,
    code: issueCode(error?.code, defaults.code),
    message: publicText(error?.message ?? error?.description),
    provider: issueProvider(error?.provider ?? defaults.provider),
    operation: issueOperation(error?.operation, defaults.operation),
    occurredAt: issueTimestamp(error?.at ?? error?.occurredAt, defaults.occurredAt ?? null),
    ...(publicDetails ? { details: publicDetails } : {})
  };
}

export function upstreamIssueKey(issue) {
  return [issue.source, issue.code, issue.provider, issue.operation, issue.message].join('\u0000');
}
