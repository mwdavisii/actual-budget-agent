import { signPayload, verifySignature } from '../../../src/webhook/hmac';

const KEY = 'test-secret-key';
const BODY = JSON.stringify({ checkType: 'uncategorized_transactions', triggeredAt: '2026-03-18T10:00:00Z' });

describe('HMAC verification', () => {
  it('verifies a correctly signed payload', () => {
    expect(verifySignature(KEY, BODY, signPayload(KEY, BODY))).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifySignature(KEY, BODY + 'x', signPayload(KEY, BODY))).toBe(false);
  });

  it('rejects a wrong key', () => {
    expect(verifySignature(KEY, BODY, signPayload('wrong-key', BODY))).toBe(false);
  });

  it('rejects malformed signature header', () => {
    expect(verifySignature(KEY, BODY, 'not-a-valid-sig')).toBe(false);
  });
});
