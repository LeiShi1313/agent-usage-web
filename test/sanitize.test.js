import assert from 'node:assert/strict';
import test from 'node:test';

import { publicError, publicText, redactText } from '../server/lib/sanitize.js';

test('redactText redacts Bearer tokens', () => {
  const output = redactText('sending Bearer abc.DEF-123_456 upstream');
  assert.equal(output.includes('abc.DEF-123_456'), false);
  assert.match(output, /Bearer <redacted>/);
});

test('redactText redacts Authorization header values entirely', () => {
  const output = redactText('Authorization: Bearer abc.DEF-123_456');
  assert.equal(output.includes('abc.DEF-123_456'), false);
});

test('redactText redacts query-string secrets', () => {
  const output = redactText('GET https://api.example.com/v1?api_key=supersecret123&other=ok&token=tok999');
  assert.equal(output.includes('supersecret123'), false);
  assert.equal(output.includes('tok999'), false);
});

test('redactText redacts JWTs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV';
  const output = redactText(`token=${jwt}`);
  assert.equal(output.includes('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV'), false);
});

test('redactText redacts OpenAI sk- keys', () => {
  const output = redactText('using key sk-abcdefghijklmnopqrstuv for calls');
  assert.equal(output.includes('sk-abcdefghijklmnopqrstuv'), false);
  assert.match(output, /<redacted-openai-key>/);
});

test('redactText redacts Anthropic sk-ant- keys with the anthropic-specific marker', () => {
  // The sk-ant- rule runs before the generic sk- rule, so the specific
  // marker wins even though the generic pattern would also match.
  const output = redactText('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz here');
  assert.match(output, /<redacted-anthropic-token>/);
  assert.doesNotMatch(output, /<redacted-openai-key>/);
  assert.equal(output.includes('abcdefghijklmnopqrstuvwxyz'), false);
});

test('redactText redacts JSON-serialized secrets (closing quote before the colon)', () => {
  const output = redactText('{"refresh_token":"abc123secret","access_token":"xyzTOPSECRET"}');
  assert.equal(output.includes('abc123secret'), false);
  assert.equal(output.includes('xyzTOPSECRET'), false);
  assert.match(output, /refresh_token[^a-z]*<redacted>/i);
});

test('redactText redacts the entire cookie header value including later pairs', () => {
  const output = redactText('cookie: sid=AAA; auth=BBB');
  assert.equal(output.includes('AAA'), false);
  assert.equal(output.includes('BBB'), false);
  assert.match(output, /cookie: <redacted>/i);
});

test('redactText redacts set-cookie headers', () => {
  const output = redactText('Set-Cookie: session=CCC; Path=/; HttpOnly');
  assert.equal(output.includes('CCC'), false);
});

test('redactText redacts bare home directories without trailing paths', () => {
  const output = redactText('saw /home/alice and /Users/bob today');
  assert.equal(output.includes('alice'), false);
  assert.equal(output.includes('bob'), false);
  assert.match(output, /\/home\/<redacted>/);
  assert.match(output, /\/Users\/<redacted>/);
});

test('redactText redacts home directories with trailing paths', () => {
  const output = redactText('config at /home/carol/.config/app.json');
  assert.equal(output.includes('carol'), false);
});

test('redactText redacts email addresses', () => {
  const output = redactText('contact person@example.com for help');
  assert.equal(output.includes('person@example.com'), false);
  assert.match(output, /<redacted-email>/);
});

test('redactText caps huge inputs and returns quickly', () => {
  const input = `leaked person@example.com ${'x'.repeat(100_000)}`;
  const startedAt = Date.now();
  const output = redactText(input);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 1500, `redactText took ${elapsedMs}ms`);
  // Input is sliced to 16384 chars before redaction; replacements may grow
  // the output slightly, but it stays bounded.
  assert.ok(output.length <= 17_000, `output length ${output.length} exceeds cap`);
  assert.match(output, /<redacted-email>/);
});

test('redactText stringifies non-string values', () => {
  assert.equal(redactText(null), '');
  assert.equal(redactText(undefined), '');
  assert.equal(redactText(42), '42');
});

test('publicText strips control characters and collapses whitespace', () => {
  assert.equal(publicText('a\u0000b\u0007c\td\n\n e'), 'a b c d e');
});

test('publicText truncates to 800 characters', () => {
  assert.equal(publicText('a'.repeat(2000)).length, 800);
});

test('publicText falls back on empty or whitespace-only input', () => {
  assert.equal(publicText(''), 'Upstream error');
  assert.equal(publicText('  \n  '), 'Upstream error');
  assert.equal(publicText(null, 'custom fallback'), 'custom fallback');
});

test('publicError on a string wraps it as a message', () => {
  assert.deepEqual(publicError('boom happened'), { message: 'boom happened' });
});

test('publicError on an object keeps message, description and code sanitized', () => {
  const output = publicError({
    message: 'failed for person@example.com',
    description: 'Bearer secret-token here',
    code: 'usage-codex'
  });
  assert.equal(output.code, 'usage-codex');
  assert.equal(output.message.includes('person@example.com'), false);
  assert.equal(output.description.includes('secret-token'), false);
});

test('publicError on an object without a message falls back to the description', () => {
  const output = publicError({ description: 'only description' });
  assert.equal(output.message, 'only description');
});

test('publicError on null and undefined returns null', () => {
  assert.equal(publicError(null), null);
  assert.equal(publicError(undefined), null);
});
