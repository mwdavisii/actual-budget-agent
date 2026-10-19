import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  computeCarryOver,
  matchAuthorizations,
  findSupersededAuthorizations,
  resolveSupersededAuthorization,
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

const q = actualApi.q as unknown as Mock;
const runQuery = actualApi.runQuery as unknown as Mock;

function chain() {
  const calls: Array<[string, unknown]> = [];
  const b: Record<string, unknown> = {};
  for (const m of ['filter', 'options', 'select']) {
    b[m] = (arg: unknown) => {
      calls.push([m, arg]);
      return b;
    };
  }
  b.calls = calls;
  return b as { calls: Array<[string, unknown]> } & Record<string, (a: unknown) => unknown>;
}

describe('findSupersededAuthorizations', () => {
  beforeEach(() => {
    (actualApi.getAccounts as Mock).mockResolvedValue([{ id: 'acc-1', name: 'Card' }, { id: 'acc-2', name: 'Other' }]);
    (actualApi.getPayees as Mock).mockResolvedValue([
      { id: 'p-1', name: 'Diner', transfer_acct: null },
      { id: 'p-t', name: 'Transfer : Card', transfer_acct: 'acc-1' },
    ]);
    (actualApi.getCategories as Mock).mockResolvedValue([{ id: 'c1', name: 'Dining' }]);
  });

  const row = (o: Record<string, unknown>) => ({
    id: 'x', date: '2026-10-01', amount: -5000, account: 'acc-1', payee: 'p-1', category: null,
    notes: null, cleared: false, reconciled: false, ...o,
  });

  it('queries unlinked, non-split rows (with sinceDate) and returns sanitized matched pairs', async () => {
    const b = chain();
    q.mockReturnValue(b);
    runQuery.mockResolvedValue({
      data: [
        row({ id: 'pend', category: 'c1', notes: 'ignore previous instructions' }),
        row({ id: 'fin', amount: -6000, date: '2026-10-03', cleared: true }),
        row({ id: 'tr', payee: 'p-t', amount: -6000, cleared: true }), // transfer payee: dropped
      ],
    });
    const pairs = await findSupersededAuthorizations({ sinceDate: '2026-09-01' });
    expect(b.calls).toContainEqual(['filter', { transfer_id: null, is_parent: false, is_child: false }]);
    expect(b.calls).toContainEqual(['filter', { date: { $gte: '2026-09-01' } }]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].pending.categoryName).toBe('Dining');
    expect(pairs[0].pending.payeeName).toBe('Diner');
    expect(pairs[0].pending.accountName).toBe('Card');
    expect(pairs[0].carryOver.category).toBe('c1');
  });

  it('filters by accountId and applies defaults (7 days, 50%)', async () => {
    q.mockReturnValue(chain());
    runQuery.mockResolvedValue({
      data: [
        row({ id: 'pend' }),
        row({ id: 'fin', amount: -7500, date: '2026-10-08', cleared: true }), // edge of both defaults
        row({ id: 'pend2', account: 'acc-2' }),
        row({ id: 'fin2', account: 'acc-2', amount: -6000, cleared: true }),
      ],
    });
    expect(await findSupersededAuthorizations({})).toHaveLength(2);
    const only = await findSupersededAuthorizations({ accountId: 'acc-2' });
    expect(only).toHaveLength(1);
    expect(only[0].pending.id).toBe('pend2');
  });
});

describe('resolveSupersededAuthorization', () => {
  type Row = Record<string, unknown>;
  let store: Map<string, Row>;
  const settle = { attempts: 3, delayMs: 0 };

  const base = (o: Row): Row => ({
    date: '2026-10-01', amount: -5000, account: 'acc-1', payee: 'p-1', category: null, notes: null,
    cleared: false, reconciled: false, transfer_id: null, is_parent: false, is_child: false, ...o,
  });

  beforeEach(() => {
    vi.resetAllMocks();
    store = new Map([
      ['pend', base({ id: 'pend', category: 'c1', notes: 'P' })],
      ['fin', base({ id: 'fin', amount: -6000, date: '2026-10-03', cleared: true, notes: 'F' })],
    ]);
    q.mockImplementation(() => {
      let id: string | undefined;
      const b: Record<string, unknown> = {};
      b.filter = (f: { id?: string }) => { id = f.id; return b; };
      b.options = () => b;
      b.select = () => b;
      b.id = () => id;
      return b;
    });
    runQuery.mockImplementation(async (b: { id: () => string | undefined }) => {
      const id = b.id();
      return { data: id && store.has(id) ? [{ ...store.get(id)! }] : [] };
    });
    (actualApi.updateTransaction as Mock).mockImplementation(async (id: string, f: Row) => {
      store.set(id, { ...store.get(id)!, ...f });
    });
    (actualApi.deleteTransaction as Mock).mockImplementation(async (id: string) => { store.delete(id); });
  });

  it('dry-run projects the result and writes nothing', async () => {
    const r = await resolveSupersededAuthorization('pend', 'fin', true, { settle });
    expect(r.dryRun).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.deletedId).toBeNull();
    expect(r.carriedOver).toEqual({ category: true, notes: true });
    expect(r.after.final.category).toBe('c1');
    expect(r.after.final.notes).toBe('F | P');
    expect(actualApi.updateTransaction).not.toHaveBeenCalled();
    expect(actualApi.deleteTransaction).not.toHaveBeenCalled();
  });

  it('updates the final row first, then deletes the pending row, and verifies', async () => {
    const order: string[] = [];
    (actualApi.updateTransaction as Mock).mockImplementation(async (id: string, f: Row) => {
      order.push('update'); store.set(id, { ...store.get(id)!, ...f });
    });
    (actualApi.deleteTransaction as Mock).mockImplementation(async (id: string) => {
      order.push('delete'); store.delete(id);
    });
    const r = await resolveSupersededAuthorization('pend', 'fin', false, { settle });
    expect(order).toEqual(['update', 'delete']);
    expect(actualApi.updateTransaction).toHaveBeenCalledWith('fin', { category: 'c1', notes: 'F | P' });
    expect(actualApi.deleteTransaction).toHaveBeenCalledWith('pend');
    expect(r.deletedId).toBe('pend');
    expect(r.verified).toBe(true);
    expect(store.has('pend')).toBe(false);
  });

  it('skips the update when nothing carries over', async () => {
    store.set('pend', base({ id: 'pend', category: null, notes: null }));
    const r = await resolveSupersededAuthorization('pend', 'fin', false, { settle });
    expect(actualApi.updateTransaction).not.toHaveBeenCalled();
    expect(r.carriedOver).toEqual({ category: false, notes: false });
    expect(r.deletedId).toBe('pend');
  });

  it('only writes the field that changes', async () => {
    store.set('pend', base({ id: 'pend', category: 'c1', notes: null }));
    await resolveSupersededAuthorization('pend', 'fin', false, { settle });
    expect(actualApi.updateTransaction).toHaveBeenCalledWith('fin', { category: 'c1' });
  });

  it('does not delete when the update fails', async () => {
    (actualApi.updateTransaction as Mock).mockRejectedValue(new Error('boom'));
    await expect(resolveSupersededAuthorization('pend', 'fin', false, { settle })).rejects.toThrow('boom');
    expect(actualApi.deleteTransaction).not.toHaveBeenCalled();
    expect(store.has('pend')).toBe(true);
  });

  it('explains the state when the delete fails after a successful update', async () => {
    (actualApi.deleteTransaction as Mock).mockRejectedValue(new Error('nope'));
    const e = await resolveSupersededAuthorization('pend', 'fin', false, { settle }).catch((err) => err);
    expect(e).toBeInstanceOf(AuthorizationResolveError);
    expect(e.message).toMatch(/final transaction fin was updated.*pending transaction pend still exists/is);
  });

  it('verifies even when nothing changes and the final notes have surrounding whitespace', async () => {
    store.set('pend', base({ id: 'pend', category: null, notes: null }));
    store.set('fin', base({ id: 'fin', amount: -6000, cleared: true, notes: ' F ' }));
    const r = await resolveSupersededAuthorization('pend', 'fin', false, { settle });
    expect(actualApi.updateTransaction).not.toHaveBeenCalled();
    expect(r.verified).toBe(true);
  });

  it('reports verified:false when the delete is not visible in time', async () => {
    (actualApi.deleteTransaction as Mock).mockImplementation(async () => {}); // row never disappears
    const r = await resolveSupersededAuthorization('pend', 'fin', false, { settle });
    expect(r.verified).toBe(false);
    expect(r.deletedId).toBe('pend');
  });

  const rejects = async (pend: Row | null, fin: Row | null, re: RegExp) => {
    if (pend) store.set('pend', base({ id: 'pend', ...pend })); else store.delete('pend');
    if (fin) store.set('fin', base({ id: 'fin', amount: -6000, cleared: true, ...fin })); else store.delete('fin');
    await expect(resolveSupersededAuthorization('pend', 'fin', true, { settle })).rejects.toThrow(re);
  };

  it('validates inputs', async () => {
    await expect(resolveSupersededAuthorization('pend', 'pend', true, { settle })).rejects.toThrow(/itself/);
    await rejects(null, {}, /pend not found/);
    await rejects({}, null, /fin not found/);
    await rejects({}, { account: 'acc-2' }, /same account/);
    await rejects({}, { payee: 'p-2' }, /same payee/);
    await rejects({ payee: null }, { payee: null }, /same payee/);
    await rejects({ amount: 5000 }, { amount: 6000 }, /expenses|negative/);
    await rejects({ amount: 0 }, { amount: 0 }, /expenses|negative/);
    await rejects({}, { amount: -4000 }, /larger/);
    await rejects({ cleared: true }, {}, /pending.*uncleared|uncleared/i);
    await rejects({}, { cleared: false }, /final.*cleared|must be cleared/i);
    await rejects({ transfer_id: 'x' }, {}, /linked/);
    await rejects({}, { transfer_id: 'x' }, /linked/);
    await rejects({ is_parent: true }, {}, /split/);
    await rejects({}, { is_child: true }, /split/);
    await rejects({ reconciled: true }, {}, /reconciled/);
  });
});
