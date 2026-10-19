import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  computeCarryOver,
  matchAuthorizations,
  AuthorizationResolveError,
  type AuthTx,
} from '../../../src/actual/authorizations';
import { actualApi } from '../../../src/actual/client';

vi.mock('../../../src/actual/client', () => ({
  actualApi: {
    getPayees: vi.fn(),
    getAccounts: vi.fn(),
    getCategories: vi.fn(),
    runQuery: vi.fn(),
    updateTransaction: vi.fn(),
    deleteTransaction: vi.fn(),
    q: vi.fn(),
  },
}));

function tx(overrides: Partial<AuthTx> = {}): AuthTx {
  return {
    id: 'tx-1',
    date: '2026-10-01',
    amount: -5000,
    account: 'acc-1',
    accountName: 'Card',
    payee: 'p-1',
    payeeName: 'Diner',
    category: null,
    categoryName: null,
    cleared: false,
    reconciled: false,
    notes: null,
    ...overrides,
  };
}
const pending = (o: Partial<AuthTx> = {}) => tx({ id: 'pend', cleared: false, amount: -5000, ...o });
const final = (o: Partial<AuthTx> = {}) =>
  tx({ id: 'fin', cleared: true, amount: -6000, date: '2026-10-03', ...o });
const opts = { daysWindow: 7, maxTipPercent: 50 };

beforeEach(() => vi.clearAllMocks());

describe('computeCarryOver', () => {
  it('keeps the final category and takes the pending one only when final has none', () => {
    expect(computeCarryOver(pending({ category: 'c1' }), final({ category: null })).category).toBe('c1');
    expect(computeCarryOver(pending({ category: 'c1' }), final({ category: 'c2' })).category).toBe('c2');
    expect(computeCarryOver(pending(), final()).category).toBeNull();
  });

  it('merges notes: final when pending empty or equal, pending when final empty, else "final | pending"', () => {
    expect(computeCarryOver(pending({ notes: null }), final({ notes: 'F' })).notes).toBe('F');
    expect(computeCarryOver(pending({ notes: 'F' }), final({ notes: 'F' })).notes).toBe('F');
    expect(computeCarryOver(pending({ notes: 'P' }), final({ notes: null })).notes).toBe('P');
    expect(computeCarryOver(pending({ notes: 'P' }), final({ notes: 'F' })).notes).toBe('F | P');
  });

  it('reports which fields change on the final row', () => {
    const none = computeCarryOver(pending(), final({ category: 'c', notes: 'n' }));
    expect(none.categoryChanged).toBe(false);
    expect(none.notesChanged).toBe(false);
    const both = computeCarryOver(pending({ category: 'c', notes: 'P' }), final({ notes: 'F' }));
    expect(both.categoryChanged).toBe(true);
    expect(both.notesChanged).toBe(true);
  });

  it('does not report a notes change when only whitespace differs', () => {
    const r = computeCarryOver(pending({ notes: null }), final({ notes: ' F ' }));
    expect(r.notes).toBe(' F ');
    expect(r.notesChanged).toBe(false);
  });
});

describe('matchAuthorizations', () => {
  it('pairs an uncleared bill with a larger cleared final for the same payee/account', () => {
    const pairs = matchAuthorizations([pending(), final()], opts);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].pending.id).toBe('pend');
    expect(pairs[0].final.id).toBe('fin');
    expect(pairs[0].tipAmount).toBe(1000);
    expect(pairs[0].tipPercent).toBe(20);
    expect(pairs[0].daysApart).toBe(2);
    expect(pairs[0].confidence).toBe('unique');
  });

  it('rounds tipPercent to one decimal', () => {
    const pairs = matchAuthorizations([pending({ amount: -3000 }), final({ amount: -3605 })], opts);
    expect(pairs[0].tipAmount).toBe(605);
    expect(pairs[0].tipPercent).toBe(20.2);
  });

  it('requires final strictly larger and at most pending * (1 + maxTipPercent/100)', () => {
    expect(matchAuthorizations([pending(), final({ amount: -5000 })], opts)).toEqual([]); // equal
    expect(matchAuthorizations([pending(), final({ amount: -4999 })], opts)).toEqual([]); // smaller
    expect(matchAuthorizations([pending(), final({ amount: -7500 })], opts)).toHaveLength(1); // exactly +50%
    expect(matchAuthorizations([pending(), final({ amount: -7501 })], opts)).toEqual([]); // just over
  });

  it('honours the date window edges', () => {
    expect(matchAuthorizations([pending(), final({ date: '2026-10-08' })], opts)).toHaveLength(1);
    expect(matchAuthorizations([pending(), final({ date: '2026-10-09' })], opts)).toEqual([]);
    expect(matchAuthorizations([pending(), final({ date: '2026-09-23' })], opts)).toEqual([]); // before, 8 days
  });

  it('requires same account and same non-null payee', () => {
    expect(matchAuthorizations([pending(), final({ account: 'acc-2' })], opts)).toEqual([]);
    expect(matchAuthorizations([pending(), final({ payee: 'p-2' })], opts)).toEqual([]);
    expect(matchAuthorizations([pending({ payee: null }), final({ payee: null })], opts)).toEqual([]);
  });

  it('only matches expenses (negative amounts)', () => {
    expect(matchAuthorizations([pending({ amount: 5000 }), final({ amount: 6000 })], opts)).toEqual([]);
  });

  it('excludes reconciled pending rows, cleared pending rows, and uncleared finals', () => {
    expect(matchAuthorizations([pending({ reconciled: true }), final()], opts)).toEqual([]);
    expect(matchAuthorizations([pending({ cleared: true }), final()], opts)).toEqual([]);
    expect(matchAuthorizations([pending(), final({ cleared: false })], opts)).toEqual([]);
  });

  it('marks ambiguity in both directions', () => {
    const p2 = pending({ id: 'pend2' });
    const f1 = final({ id: 'f1' });
    const f2 = final({ id: 'f2', amount: -6100 });
    // one pending, two finals
    const a = matchAuthorizations([pending(), f1, f2], opts);
    expect(a.map((p) => p.confidence)).toEqual(['ambiguous', 'ambiguous']);
    // two pendings, one final
    const b = matchAuthorizations([pending(), p2, f1], opts);
    expect(b.map((p) => p.confidence)).toEqual(['ambiguous', 'ambiguous']);
  });

  it('sorts by daysApart, then pending date, then pending id', () => {
    const rows = [
      pending({ id: 'pb', payee: 'p-b', date: '2026-10-01' }),
      final({ id: 'fb', payee: 'p-b', date: '2026-10-04' }),
      pending({ id: 'pa', payee: 'p-a', date: '2026-10-01' }),
      final({ id: 'fa', payee: 'p-a', date: '2026-10-02' }),
    ];
    expect(matchAuthorizations(rows, opts).map((p) => p.pending.id)).toEqual(['pa', 'pb']);
  });

  it('includes a carryOver preview', () => {
    const pairs = matchAuthorizations([pending({ category: 'c1', notes: 'P' }), final({ notes: 'F' })], opts);
    expect(pairs[0].carryOver).toEqual({ category: 'c1', notes: 'F | P' });
  });
});
