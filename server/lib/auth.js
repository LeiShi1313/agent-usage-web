import { createHash, timingSafeEqual } from 'node:crypto';

export function bearerToken(request) {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? '';
}

// Hash both sides so the comparison leaks neither content nor token length.
export function constantTimeTokenEqual(received, expected) {
  if (!received || !expected) return false;
  const receivedDigest = createHash('sha256').update(received).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(receivedDigest, expectedDigest);
}

export function createTokenGuard(expectedToken) {
  return function requireToken(request, response) {
    if (!expectedToken) {
      response.status(500).json({ error: 'Exporter token is not configured.' });
      return false;
    }
    if (!constantTimeTokenEqual(bearerToken(request), expectedToken)) {
      response.status(401).json({ error: 'Unauthorized' });
      return false;
    }
    return true;
  };
}
