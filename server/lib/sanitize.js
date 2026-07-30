// Sanitization for anything that leaves the process: API payloads, cached
// snapshots, logs. Over-redaction is preferred to under-redaction.

// Redaction runs several regexes over untrusted text (collector stderr can be
// megabytes); the cap bounds worst-case backtracking cost and output size.
const REDACT_INPUT_LIMIT = 16_384;

export function redactText(value) {
  if (typeof value !== 'string') return value == null ? '' : String(value);
  return value
    .slice(0, REDACT_INPUT_LIMIT)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\b(set-cookie|cookie)\b["']?\s*[:=]\s*[^\n"']+/gi, '$1: <redacted>')
    .replace(/\b((?:access|refresh|id|session)[_-]?token|api[_-]?key|client[_-]?secret|password|authorization)\b["']?\s*[:=]\s*["']?[^"',\s}]+/gi, '$1: <redacted>')
    .replace(/([?&](?:api[_-]?key|token|secret|password|authorization)=)[^&#\s]+/gi, '$1<redacted>')
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, '<redacted-anthropic-token>')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '<redacted-openai-key>')
    .replace(/eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}/g, '<redacted-jwt>')
    .replace(/[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}/gi, '<redacted-email>')
    .replace(/\/home\/[^/\s"',)]+(?:\/[^\s"',)]*)?/g, '/home/<redacted>')
    .replace(/\/Users\/[^/\s"',)]+(?:\/[^\s"',)]*)?/g, '/Users/<redacted>')
    .replace(/[A-Z]:\\Users\\[^\\\s"',)]+(?:\\[^\s"',)]*)?/gi, 'C:\\Users\\<redacted>');
}

export function publicText(value, fallback = 'Upstream error') {
  const normalized = redactText(value)
    // eslint-disable-next-line no-control-regex -- strip control chars from untrusted text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || fallback).slice(0, 800);
}

export function publicError(error) {
  if (!error) return null;
  if (typeof error === 'string') return { message: publicText(error) };
  return {
    message: publicText(error.message ?? error.description),
    description: error.description ? publicText(error.description) : undefined,
    code: error.code
  };
}
