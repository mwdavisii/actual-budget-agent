import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  matchTransferPairs,
  findTransferCandidates,
  linkTransfer,
  TransferLinkError,
  type TransferTx,
} from '../../../src/actual/transfers';
import { actualApi } from '../../../src/actual/client';

vi.mock('../../../src/actual/client', () => ({
  actualApi: {
    getPayees: vi.fn(),
    getAccounts: vi.fn(),
    runQuery: vi.fn(),
    updateTransaction: vi.fn(),
    batchBudgetUpdates: vi.fn((fn: () => Promise<void>) => fn()),
    q: vi.fn(),
  },
}));

const q = actualApi.q as unknown as Mock;
const runQuery = actualApi.runQuery as unknown as Mock;

function tx(overrides: Partial<TransferTx> = {}): TransferTx {
  return {
    id: 'tx-1',
    date: '2026-10-01',
    amount: -5000,
    account: 'acc-checking',
    accountName: 'Checking',
    payee: 'p-1',
    payeeName: 'Payment',
    cleared: false,
    notes: null,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('matchTransferPairs', () => {
  it('pairs exact opposite amounts across accounts within the window as unique', () => {
    const a = tx({ id: 'a', date: '2026-10-01', amount: -5000, account: 'acc-checking' });
    const b = tx({ id: 'b', date: '2026-10-03', amount: 5000, account: 'acc-card' });
    const pairs = matchTransferPairs([b, a], 3);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].a.id).toBe('a'); // earlier date first
    expect(pairs[0].b.id).toBe('b');
    expect(pairs[0].daysApart).toBe(2);
    expect(pairs[0].confidence).toBe('unique');
  });

  it('ignores rows in the same account', () => {
    const a = tx({ id: 'a', amount: -5000, account: 'acc-1' });
    const b = tx({ id: 'b', amount: 5000, account: 'acc-1' });
    expect(matchTransferPairs([a, b], 3)).toEqual([]);
  });

  it('includes pairs exactly at the window edge and excludes beyond it', () => {
    const a = tx({ id: 'a', date: '2026-10-01', amount: -5000, account: 'acc-1' });
    const atEdge = tx({ id: 'b', date: '2026-10-04', amount: 5000, account: 'acc-2' });
    const beyond = tx({ id: 'c', date: '2026-10-05', amount: 5000, account: 'acc-3' });
    expect(matchTransferPairs([a, atEdge], 3)).toHaveLength(1);
    expect(matchTransferPairs([a, beyond], 3)).toEqual([]);
  });

  it('ignores amounts that are not exactly opposite and zero amounts', () => {
    const a = tx({ id: 'a', amount: -5000, account: 'acc-1' });
    const off = tx({ id: 'b', amount: 5001, account: 'acc-2' });
    const z1 = tx({ id: 'z1', amount: 0, account: 'acc-1' });
    const z2 = tx({ id: 'z2', amount: 0, account: 'acc-2' });
    expect(matchTransferPairs([a, off, z1, z2], 3)).toEqual([]);
  });

  it('marks every pair ambiguous when a row has more than one possible counterpart', () => {
    const a = tx({ id: 'a', amount: -5000, account: 'acc-1' });
    const b = tx({ id: 'b', amount: 5000, account: 'acc-2' });
    const c = tx({ id: 'c', amount: 5000, account: 'acc-3' });
    const pairs = matchTransferPairs([a, b, c], 3);
    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.confidence === 'ambiguous')).toBe(true);
  });

  it('sorts pairs by date distance, then earliest date, then id', () => {
    const a1 = tx({ id: 'a1', date: '2026-10-01', amount: -1000, account: 'acc-1' });
    const b1 = tx({ id: 'b1', date: '2026-10-03', amount: 1000, account: 'acc-2' });
    const a2 = tx({ id: 'a2', date: '2026-10-10', amount: -2000, account: 'acc-1' });
    const b2 = tx({ id: 'b2', date: '2026-10-10', amount: 2000, account: 'acc-2' });
    const pairs = matchTransferPairs([a1, b1, a2, b2], 3);
    expect(pairs.map((p) => p.a.id)).toEqual(['a2', 'a1']);
  });
});

function mockFindQuery(rows: Array<Record<string, unknown>>) {
  const chain: Record<string, Mock> = {};
  for (const m of ['filter', 'select', 'options']) chain[m] = vi.fn(() => chain);
  q.mockReturnValue(chain);
  runQuery.mockResolvedValue({ data: rows });
  return chain;
}

function dbRow(overrides: Record<string, unknown>) {
  return {
    id: 'x',
    date: '2026-10-01',
    amount: -5000,
    account: 'acc-checking',
    payee: 'p-1',
    notes: null,
    cleared: false,
    ...overrides,
  };
}

describe('findTransferCandidates', () => {
  beforeEach(() => {
    (actualApi.getAccounts as unknown as Mock).mockResolvedValue([
      { id: 'acc-checking', name: 'Checking' },
      { id: 'acc-card', name: 'Card' },
      { id: 'acc-savings', name: 'Savings' },
    ]);
    (actualApi.getPayees as unknown as Mock).mockResolvedValue([
      { id: 'p-1', name: 'Card Payment' },
      { id: 'p-2', name: 'Payment Thank You' },
      { id: 'tp-card', name: 'Transfer: Card', transfer_acct: 'acc-card' },
    ]);
  });

  it('returns enriched unique pairs and queries only unlinked, non-parent rows', async () => {
    const chain = mockFindQuery([
      dbRow({ id: 'a', account: 'acc-checking', amount: -5000, payee: 'p-1', notes: 'ACH <b>' }),
      dbRow({ id: 'b', account: 'acc-card', amount: 5000, date: '2026-10-02', payee: 'p-2', cleared: true }),
    ]);

    const pairs = await findTransferCandidates({});

    expect(chain.filter).toHaveBeenCalledWith({ transfer_id: null, is_parent: false });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].confidence).toBe('unique');
    expect(pairs[0].a).toMatchObject({
      id: 'a',
      accountName: 'Checking',
      payeeName: 'Card Payment',
      cleared: false,
      notes: 'ACH &lt;b&gt;',
    });
    expect(pairs[0].b).toMatchObject({ id: 'b', accountName: 'Card', cleared: true });
  });

  it('excludes rows that already use a transfer payee', async () => {
    mockFindQuery([
      dbRow({ id: 'a', account: 'acc-checking', amount: -5000 }),
      dbRow({ id: 'b', account: 'acc-card', amount: 5000, payee: 'tp-card' }),
    ]);
    expect(await findTransferCandidates({})).toEqual([]);
  });

  it('keeps only pairs touching accountId, while still matching against other accounts', async () => {
    mockFindQuery([
      dbRow({ id: 'a', account: 'acc-checking', amount: -5000 }),
      dbRow({ id: 'b', account: 'acc-card', amount: 5000 }),
      dbRow({ id: 'c', account: 'acc-savings', amount: -700 }),
      dbRow({ id: 'd', account: 'acc-card', amount: 700 }),
    ]);
    const pairs = await findTransferCandidates({ accountId: 'acc-checking' });
    expect(pairs.map((p) => [p.a.id, p.b.id])).toEqual([['a', 'b']]);
  });

  it('forwards sinceDate and respects daysWindow', async () => {
    const chain = mockFindQuery([
      dbRow({ id: 'a', date: '2026-10-01', account: 'acc-checking', amount: -5000 }),
      dbRow({ id: 'b', date: '2026-10-03', account: 'acc-card', amount: 5000 }),
    ]);
    const pairs = await findTransferCandidates({ sinceDate: '2026-09-01', daysWindow: 1 });
    expect(chain.filter).toHaveBeenCalledWith({ date: { $gte: '2026-09-01' } });
    expect(pairs).toEqual([]);
  });
});

type Row = Record<string, unknown>;

function mockRowsById(rows: Record<string, Row>) {
  q.mockImplementation(() => {
    const state: { id?: string } = {};
    const chain: Record<string, unknown> = {
      filter: vi.fn((f: { id: string }) => {
        state.id = f.id;
        return chain;
      }),
      select: vi.fn(() => chain),
      options: vi.fn(() => chain),
      state,
    };
    return chain;
  });
  runQuery.mockImplementation(async (chain: { state: { id: string } }) => {
    const row = rows[chain.state.id];
    return { data: row ? [row] : [] };
  });
}

function rawRow(overrides: Row): Row {
  return {
    id: 'tx-a',
    date: '2026-10-01',
    amount: -5000,
    account: 'acc-checking',
    payee: 'p-pay',
    notes: 'ACH',
    cleared: true,
    transfer_id: null,
    is_parent: false,
    reconciled: false,
    ...overrides,
  };
}

const rowA = () => rawRow({});
const rowB = () =>
  rawRow({
    id: 'tx-b',
    date: '2026-10-02',
    amount: 5000,
    account: 'acc-card',
    payee: 'p-card-co',
    notes: null,
    cleared: false,
  });

describe('linkTransfer', () => {
  beforeEach(() => {
    // clearAllMocks keeps implementations; drop any simulateWrites fake from a previous test.
    (actualApi.updateTransaction as unknown as Mock).mockReset();
    (actualApi.getPayees as unknown as Mock).mockResolvedValue([
      { id: 'tp-checking', name: 'Transfer: Checking', transfer_acct: 'acc-checking' },
      { id: 'tp-card', name: 'Transfer: Card', transfer_acct: 'acc-card' },
      { id: 'p-pay', name: 'Payment' },
    ]);
  });

  it('dry-run projects the linked rows and performs no writes', async () => {
    mockRowsById({ 'tx-a': rowA(), 'tx-b': rowB() });

    const res = await linkTransfer('tx-a', 'tx-b', true);

    expect(res.dryRun).toBe(true);
    expect(res.linked).toBe(false);
    expect(res.before.a.payee).toBe('p-pay');
    expect(res.after.a).toMatchObject({ payee: 'tp-card', transferId: 'tx-b', cleared: true, notes: 'ACH' });
    expect(res.after.b).toMatchObject({ payee: 'tp-checking', transferId: 'tx-a', cleared: true, notes: 'ACH' });
    expect(actualApi.updateTransaction).not.toHaveBeenCalled();
    expect(actualApi.batchBudgetUpdates).not.toHaveBeenCalled();
  });

  const noWait = { attempts: 3, delayMs: 0 };

  function simulateWrites(rows: Record<string, Row>) {
    (actualApi.updateTransaction as unknown as Mock).mockImplementation(
      async (id: string, f: { payee: string; transfer_id: string; cleared: boolean; notes: string | null }) => {
        Object.assign(rows[id], { payee: f.payee, transfer_id: f.transfer_id, cleared: f.cleared, notes: f.notes });
      }
    );
  }

  it('writes both rows inside a batch with transfer payees, cross transfer_ids, cleared and shared notes', async () => {
    const rows = { 'tx-a': rowA(), 'tx-b': rowB() };
    mockRowsById(rows);
    simulateWrites(rows);

    const res = await linkTransfer('tx-a', 'tx-b', false, { settle: noWait });

    expect(actualApi.batchBudgetUpdates).toHaveBeenCalledTimes(1);
    expect(actualApi.updateTransaction).toHaveBeenNthCalledWith(1, 'tx-a', {
      payee: 'tp-card',
      transfer_id: 'tx-b',
      cleared: true,
      notes: 'ACH',
    });
    expect(actualApi.updateTransaction).toHaveBeenNthCalledWith(2, 'tx-b', {
      payee: 'tp-checking',
      transfer_id: 'tx-a',
      cleared: true,
      notes: 'ACH',
    });
    expect(res.dryRun).toBe(false);
    expect(res.linked).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.after.b).toMatchObject({ payee: 'tp-checking', transferId: 'tx-a', cleared: true });
  });

  it('reports verified=false and falls back to the projection when the link never becomes visible', async () => {
    mockRowsById({ 'tx-a': rowA(), 'tx-b': rowB() }); // updateTransaction is a no-op mock
    const res = await linkTransfer('tx-a', 'tx-b', false, { settle: noWait });
    expect(res.linked).toBe(true);
    expect(res.verified).toBe(false);
    expect(res.after.a).toMatchObject({ payee: 'tp-card', transferId: 'tx-b' });
  });

  it('a split parent is rejected as a split parent, not as not-found', async () => {
    mockRowsById({ 'tx-a': { ...rowA(), is_parent: true }, 'tx-b': rowB() });
    await expect(linkTransfer('tx-a', 'tx-b', false)).rejects.toThrow(/split parent/);
  });

  it('merges differing non-empty notes as "<A> | <B>"', async () => {
    mockRowsById({ 'tx-a': rowA(), 'tx-b': { ...rowB(), notes: 'PAYMENT' } });
    const res = await linkTransfer('tx-a', 'tx-b', true);
    expect(res.after.a.notes).toBe('ACH | PAYMENT');
    expect(res.after.b.notes).toBe('ACH | PAYMENT');
  });

  it('writes notes unsanitized but returns them sanitized', async () => {
    const rows = { 'tx-a': { ...rowA(), notes: 'a<b' }, 'tx-b': rowB() };
    mockRowsById(rows);
    simulateWrites(rows);
    const res = await linkTransfer('tx-a', 'tx-b', false, { settle: noWait });
    expect(actualApi.updateTransaction).toHaveBeenCalledWith(
      'tx-a',
      expect.objectContaining({ notes: 'a<b' })
    );
    expect(res.before.a.notes).toBe('a&lt;b');
  });

  it('does not duplicate identical notes', async () => {
    mockRowsById({ 'tx-a': rowA(), 'tx-b': { ...rowB(), notes: 'ACH' } });
    const res = await linkTransfer('tx-a', 'tx-b', true);
    expect(res.after.a.notes).toBe('ACH');
  });

  async function expectRejected(a: Row, b: Row, message: RegExp) {
    mockRowsById({ [String(a.id)]: a, [String(b.id)]: b });
    const err = await linkTransfer(String(a.id), String(b.id), false).catch((e) => e);
    expect(err).toBeInstanceOf(TransferLinkError);
    expect((err as Error).message).toMatch(message);
    expect(actualApi.updateTransaction).not.toHaveBeenCalled();
  }

  it('rejects linking a transaction to itself', async () => {
    mockRowsById({ 'tx-a': rowA() });
    await expect(linkTransfer('tx-a', 'tx-a', false)).rejects.toThrow(/itself/);
  });

  it('rejects a missing transaction with a "not found" message', async () => {
    mockRowsById({ 'tx-a': rowA() });
    await expect(linkTransfer('tx-a', 'tx-missing', false)).rejects.toThrow(/Transaction tx-missing not found/);
  });

  it('rejects an already-linked transaction', async () => {
    await expectRejected(rowA(), { ...rowB(), transfer_id: 'tx-z' }, /already linked/);
  });

  it('rejects a split parent', async () => {
    await expectRejected({ ...rowA(), is_parent: true }, rowB(), /split/);
  });

  it('rejects a reconciled row unless allowReconciled is set', async () => {
    await expectRejected({ ...rowA(), reconciled: true }, rowB(), /reconciled.*allowReconciled/);

    const rows = { 'tx-a': { ...rowA(), reconciled: true }, 'tx-b': rowB() };
    mockRowsById(rows);
    simulateWrites(rows);
    const res = await linkTransfer('tx-a', 'tx-b', false, { allowReconciled: true, settle: noWait });
    expect(res.linked).toBe(true);
  });

  it('rejects two rows in the same account', async () => {
    await expectRejected(rowA(), { ...rowB(), account: 'acc-checking' }, /same account/);
  });

  it('rejects amounts that are not exactly opposite', async () => {
    await expectRejected(rowA(), { ...rowB(), amount: 4999 }, /opposite/);
  });

  it('rejects zero amounts', async () => {
    await expectRejected({ ...rowA(), amount: 0 }, { ...rowB(), amount: 0 }, /non-zero/);
  });

  it('rejects when an account has no transfer payee', async () => {
    (actualApi.getPayees as unknown as Mock).mockResolvedValue([
      { id: 'tp-checking', name: 'Transfer: Checking', transfer_acct: 'acc-checking' },
    ]);
    await expectRejected(rowA(), rowB(), /No transfer payee/);
  });
});
