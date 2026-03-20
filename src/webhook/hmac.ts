import crypto from 'crypto';

export function signPayload(key: string, body: string): string {
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(body, 'utf-8');
  return `sha256=${hmac.digest('hex')}`;
}

export function verifySignature(key: string, body: string, signature: string): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const expected = signPayload(key, body);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
