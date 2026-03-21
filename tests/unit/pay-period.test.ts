import { isPayday, nextPayday, getPaydayOrdinalInMonth } from '../../src/pay-period';

// Use UTC noon to avoid timezone issues with date-only strings
function utcDate(iso: string): Date {
  return new Date(iso + 'T12:00:00Z');
}

const anchor = utcDate('2026-03-20'); // Known payday (Friday)

describe('isPayday', () => {
  it('returns true on the anchor date', () => {
    expect(isPayday(utcDate('2026-03-20'), anchor, 14)).toBe(true);
  });

  it('returns true 14 days after anchor', () => {
    expect(isPayday(utcDate('2026-04-03'), anchor, 14)).toBe(true);
  });

  it('returns false on non-payday', () => {
    expect(isPayday(utcDate('2026-03-21'), anchor, 14)).toBe(false);
  });

  it('returns false before anchor', () => {
    expect(isPayday(utcDate('2026-03-06'), anchor, 14)).toBe(false);
  });
});

describe('nextPayday', () => {
  it('returns the next payday after today', () => {
    const next = nextPayday(utcDate('2026-03-20'), anchor, 14);
    expect(next.toISOString().slice(0, 10)).toBe('2026-04-03');
  });

  it('returns next payday from mid-period', () => {
    const next = nextPayday(utcDate('2026-03-25'), anchor, 14);
    expect(next.toISOString().slice(0, 10)).toBe('2026-04-03');
  });
});

describe('getPaydayOrdinalInMonth', () => {
  it('returns 1 for first payday of month', () => {
    // April 3 is the first payday in April (prev payday Mar 20 is in March)
    expect(getPaydayOrdinalInMonth(utcDate('2026-04-03'), anchor, 14)).toBe(1);
  });

  it('returns 2 for second payday of month', () => {
    // April 17 is the second payday in April
    expect(getPaydayOrdinalInMonth(utcDate('2026-04-17'), anchor, 14)).toBe(2);
  });

  it('returns 3 for third payday of month (rare)', () => {
    // May 2026 has May 1, May 15, May 29
    expect(getPaydayOrdinalInMonth(utcDate('2026-05-29'), anchor, 14)).toBe(3);
  });

  it('returns 1 when payday falls on the 1st', () => {
    // May 1 is a payday (14 days after April 17)
    expect(getPaydayOrdinalInMonth(utcDate('2026-05-01'), anchor, 14)).toBe(1);
  });
});
