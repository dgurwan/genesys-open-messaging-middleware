import crypto from 'node:crypto';

function timingSafeEqualsString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

export function verifyGenesysSignature({ rawBody, headerValue, secret }) {
  if (!secret) {
    return false;
  }

  const hexDigest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const base64Digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const accepted = [
    `sha256=${hexDigest}`,
    hexDigest,
    base64Digest,
    `sha256=${base64Digest}`
  ];

  return accepted.some((candidate) => timingSafeEqualsString(candidate, headerValue || ''));
}

export function verifySinchSignature({ rawBody, secret, signature, nonce, timestamp, maxSkewSeconds = 300 }) {
  if (!secret || !signature || !nonce || !timestamp) {
    return { ok: false, reason: 'Missing signature headers or secret.' };
  }

  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp)) {
    return { ok: false, reason: 'Invalid signature timestamp.' };
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - numericTimestamp);
  if (ageSeconds > maxSkewSeconds) {
    return { ok: false, reason: 'Signature timestamp outside allowed window.' };
  }

  const signedData = `${rawBody}.${nonce}.${timestamp}`;
  const expected = crypto.createHmac('sha256', secret).update(signedData).digest('base64');

  if (!timingSafeEqualsString(expected, signature)) {
    return { ok: false, reason: 'Signature mismatch.' };
  }

  return { ok: true };
}
