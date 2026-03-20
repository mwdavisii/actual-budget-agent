import { sanitize, sanitizeObject } from '../../src/sanitize';

describe('sanitize', () => {
  it('strips control characters', () => {
    expect(sanitize('hello\x00world\x1f')).toBe('helloworld');
  });

  it('truncates strings over 500 characters', () => {
    const long = 'a'.repeat(600);
    expect(sanitize(long)).toHaveLength(500);
  });

  it('escapes angle brackets', () => {
    expect(sanitize('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('handles empty string', () => {
    expect(sanitize('')).toBe('');
  });

  it('leaves normal text unchanged', () => {
    expect(sanitize('Walmart $42.50')).toBe('Walmart $42.50');
  });
});

describe('sanitizeObject', () => {
  it('sanitizes all string fields in an object', () => {
    const input = { payee: '<evil>', amount: 42, memo: 'normal' };
    const result = sanitizeObject(input);
    expect(result.payee).toBe('&lt;evil&gt;');
    expect(result.amount).toBe(42);
    expect(result.memo).toBe('normal');
  });
});
