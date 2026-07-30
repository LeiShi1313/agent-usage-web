import assert from 'node:assert/strict';
import test from 'node:test';

import { bearerToken, constantTimeTokenEqual, createTokenGuard } from '../server/lib/auth.js';

function fakeRequest(authorization) {
  return { headers: authorization ? { authorization } : {} };
}

function fakeResponse() {
  const response = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
  return response;
}

test('bearerToken extracts the token from an Authorization header', () => {
  assert.equal(bearerToken(fakeRequest('Bearer abc123')), 'abc123');
  assert.equal(bearerToken(fakeRequest('bearer xyz')), 'xyz');
  assert.equal(bearerToken(fakeRequest('Basic abc')), '');
  assert.equal(bearerToken(fakeRequest(null)), '');
});

test('constantTimeTokenEqual compares tokens of differing lengths without throwing', () => {
  assert.equal(constantTimeTokenEqual('short', 'a-much-longer-token'), false);
  assert.equal(constantTimeTokenEqual('same-token', 'same-token'), true);
  assert.equal(constantTimeTokenEqual('', 'expected'), false);
  assert.equal(constantTimeTokenEqual('received', ''), false);
});

test('createTokenGuard rejects missing configuration with 500', () => {
  const guard = createTokenGuard('');
  const response = fakeResponse();
  assert.equal(guard(fakeRequest('Bearer anything'), response), false);
  assert.equal(response.statusCode, 500);
});

test('createTokenGuard rejects wrong or absent tokens with 401 and accepts the right one', () => {
  const guard = createTokenGuard('expected-token');

  const wrong = fakeResponse();
  assert.equal(guard(fakeRequest('Bearer nope'), wrong), false);
  assert.equal(wrong.statusCode, 401);

  const absent = fakeResponse();
  assert.equal(guard(fakeRequest(null), absent), false);
  assert.equal(absent.statusCode, 401);

  const right = fakeResponse();
  assert.equal(guard(fakeRequest('Bearer expected-token'), right), true);
  assert.equal(right.statusCode, null);
});
