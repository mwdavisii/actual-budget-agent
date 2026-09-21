import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getTransactions,
  getTransactionById,
  getPayeesWithCounts,
} from '../../../src/actual/transaction-queries';
import { actualApi } from '../../../src/actual/client';

const chain = {
  filter: vi.fn().mockReturnThis(),
  options: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  offset: vi.fn().mockReturnThis(),
  calculate: vi.fn().mockReturnThis(),
  groupBy: vi.fn().mockReturnThis(),
};

vi.mock('../../../src/actual/client', () => ({
  actualApi: {
    getAccounts: vi.fn(),
    getPayees: vi.fn(),
    getCategoryGroups: vi.fn(),
    runQuery: vi.fn(),
    q: vi.fn(() => chain),
  },
}));
vi.mock('../../../src/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  // Reset chain method return values to the chain itself after clearAllMocks zeroes them.
  chain.filter.mockReturnThis();
  chain.options.mockReturnThis();
  chain.select.mockReturnThis();
  chain.orderBy.mockReturnThis();
  chain.limit.mockReturnThis();
  chain.offset.mockReturnThis();
  chain.calculate.mockReturnThis();
  chain.groupBy.mockReturnThis();
});

function mockStandardMaps() {
  (actualApi.getAccounts as any).mockResolvedValue([{ id: 'a1', name: 'Checking' }]);
  (actualApi.getPayees as any).mockResolvedValue([{ id: 'p1', name: 'ST. JUDE' }]);
  (actualApi.getCategoryGroups as any).mockResolvedValue([
    { categories: [{ id: 'c1', name: 'Dining Out' }] },
  ]);
}

// ── getTransactions default output shape ───────────────────────────────────────

describe('getTransactions default output', () => {
  beforeEach(() => {
    mockStandardMaps();
    (actualApi.runQuery as any).mockResolvedValue({
      data: [
        {
          id: 't1',
          date: '2026-06-22',
          amount: 76126,
          payee: 'p1',
          category: 'c1',
          notes: 'Memo Credit',
          account: 'a1',
          cleared: true,
        },
      ],
    });
  });

  it('uses the exact legacy select list when no fields param is given', async () => {
    await getTransactions({});

    expect(chain.select).toHaveBeenCalledWith([
      'id', 'date', 'amount', 'payee', 'category', 'notes', 'account', 'cleared',
    ]);
  });

  it('returns exactly the current 10 keys with no new fields added', async () => {
    const result = await getTransactions({});

    expect(result).toEqual([
      {
        id: 't1',
        date: '2026-06-22',
        amount: 76126,
        payee: 'p1',
        payeeName: 'ST. JUDE',
        category: 'c1',
        notes: 'Memo Credit',
        account: 'a1',
        accountName: 'Checking',
        cleared: true,
      },
    ]);
  });
});

// ── getTransactions payee filters ────────────────────────────────────────────

describe('getTransactions payee filters', () => {
  beforeEach(() => {
    (actualApi.getAccounts as any).mockResolvedValue([{ id: 'a1', name: 'Checking' }]);
    (actualApi.getPayees as any).mockResolvedValue([
      { id: 'p1', name: 'Amex Card Payment' },
      { id: 'p2', name: 'Amazon' },
      { id: 'p3', name: 'Coffee Shop' },
    ]);
    (actualApi.getCategoryGroups as any).mockResolvedValue([]);
    (actualApi.runQuery as any).mockResolvedValue({ data: [] });
  });

  it('payeeId filters by exact payee id', async () => {
    await getTransactions({ payeeId: 'p1' });

    expect(chain.filter).toHaveBeenCalledWith({ payee: 'p1' });
  });

  it('payeeContains with zero matching payees returns [] without calling runQuery', async () => {
    const result = await getTransactions({ payeeContains: 'zzzzzz' });

    expect(actualApi.runQuery).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('payeeContains with matches filters by $oneof ids', async () => {
    await getTransactions({ payeeContains: 'amex' });

    expect(chain.filter).toHaveBeenCalledWith({ payee: { $oneof: ['p1'] } });
  });

  it('payeeContains is case-insensitive', async () => {
    await getTransactions({ payeeContains: 'AMEX' });

    expect(chain.filter).toHaveBeenCalledWith({ payee: { $oneof: ['p1'] } });
  });
});

// ── getTransactions notes filter ─────────────────────────────────────────────

describe('getTransactions notes filter', () => {
  beforeEach(() => {
    mockStandardMaps();
    (actualApi.runQuery as any).mockResolvedValue({ data: [] });
  });

  it('escapes % and ? wildcards in notesContains', async () => {
    await getTransactions({ notesContains: 'what?' });

    expect(chain.filter).toHaveBeenCalledWith({ notes: { $like: '%what\\?%' } });
  });

  it('escapes backslashes in notesContains', async () => {
    await getTransactions({ notesContains: 'C:\\path' });

    expect(chain.filter).toHaveBeenCalledWith({ notes: { $like: '%C:\\\\path%' } });
  });

  it('does not escape underscores', async () => {
    await getTransactions({ notesContains: 'foo_bar' });

    expect(chain.filter).toHaveBeenCalledWith({ notes: { $like: '%foo_bar%' } });
  });
});

// ── getTransactions pagination and ordering ──────────────────────────────────

describe('getTransactions pagination and ordering', () => {
  beforeEach(() => {
    mockStandardMaps();
    (actualApi.runQuery as any).mockResolvedValue({ data: [] });
  });

  it('applies limit and offset when provided', async () => {
    await getTransactions({ limit: 50, offset: 10 });

    expect(chain.limit).toHaveBeenCalledWith(50);
    expect(chain.offset).toHaveBeenCalledWith(10);
  });

  it('applies orderBy with mapped aql field and direction', async () => {
    await getTransactions({ orderBy: { field: 'amount', direction: 'desc' } });

    expect(chain.orderBy).toHaveBeenCalledWith({ amount: 'desc' });
  });

  it('maps id orderBy field to aql id', async () => {
    await getTransactions({ orderBy: { field: 'id', direction: 'asc' } });

    expect(chain.orderBy).toHaveBeenCalledWith({ id: 'asc' });
  });
});

// ── getTransactions field selection ────────────────────────────────────────

describe('getTransactions field selection', () => {
  beforeEach(() => {
    mockStandardMaps();
    (actualApi.runQuery as any).mockResolvedValue({
      data: [
        {
          id: 't1',
          date: '2026-06-22',
          amount: 76126,
          payee: 'p1',
          category: 'c1',
          notes: 'Memo',
          account: 'a1',
          cleared: true,
          transfer_id: 't2',
          imported_payee: 'ST JUDE',
          is_parent: false,
          parent_id: null,
          reconciled: false,
        },
      ],
    });
  });

  it('maps output names to aql columns and always includes id', async () => {
    await getTransactions({ fields: ['transferId', 'importedPayee', 'isParent', 'parentId', 'reconciled'] });

    expect(chain.select).toHaveBeenCalledWith([
      'id', 'transfer_id', 'imported_payee', 'is_parent', 'parent_id', 'reconciled',
    ]);
  });

  it('deduplicates mapped columns', async () => {
    await getTransactions({ fields: ['payee', 'payeeName', 'category', 'categoryName', 'account', 'accountName'] });

    expect(chain.select).toHaveBeenCalledWith(['id', 'payee', 'category', 'account']);
  });

  it('throws with the allowed field list for unknown fields', async () => {
    await expect(getTransactions({ fields: ['bad'] })).rejects.toThrow(
      'Unknown field "bad" — allowed: id, date, amount, payee, payeeName, category, categoryName, notes, account, accountName, cleared, reconciled, transferId, importedPayee, isParent, parentId'
    );
  });
});

// ── getTransactions summary mode ─────────────────────────────────────────────

describe('getTransactions summary mode', () => {
  beforeEach(() => {
    (actualApi.getAccounts as any).mockResolvedValue([{ id: 'a1', name: 'Checking' }]);
    (actualApi.getPayees as any).mockResolvedValue([
      { id: 'p1', name: 'Amex Card' },
      { id: 'p2', name: 'Coffee Shop' },
    ]);
    (actualApi.getCategoryGroups as any).mockResolvedValue([
      { categories: [{ id: 'c1', name: 'Dining Out' }] },
    ]);

    // runQuery call order in summary mode: calculate, groupBy count, detail rows.
    (actualApi.runQuery as any)
      .mockResolvedValueOnce({ data: 42 }) // wrong shape on purpose; implementation must read .data
      .mockResolvedValueOnce({
        data: [
          { payee: 'p1', count: 2 },
          { payee: 'p2', count: 1 },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          { payee: 'p1', date: '2026-06-20', amount: -5000 },
          { payee: 'p1', date: '2026-06-22', amount: -3000 },
          { payee: 'p2', date: '2026-06-21', amount: -1200 },
        ],
      });
  });

  it('reads totalMatching from scalar calculate result { data: 42 }', async () => {
    const result = await getTransactions({ summary: 'payee' });

    expect((result as any).totalMatching).toBe(42);
  });

  it('returns grouped counts, names, first/last dates, and totalAmount', async () => {
    const result = await getTransactions({ summary: 'payee' });

    expect((result as any).groups).toEqual([
      {
        key: 'p1',
        name: 'Amex Card',
        count: 2,
        firstDate: '2026-06-20',
        lastDate: '2026-06-22',
        totalAmount: -8000,
      },
      {
        key: 'p2',
        name: 'Coffee Shop',
        count: 1,
        firstDate: '2026-06-21',
        lastDate: '2026-06-21',
        totalAmount: -1200,
      },
    ]);
  });

  it('uses category names when summarizing by category', async () => {
    (actualApi.runQuery as any)
      .mockReset()
      .mockResolvedValueOnce({ data: 100 })
      .mockResolvedValueOnce({
        data: [{ category: 'c1', count: 3 }],
      })
      .mockResolvedValueOnce({
        data: [
          { category: 'c1', date: '2026-06-01', amount: 1000 },
          { category: 'c1', date: '2026-06-15', amount: 2000 },
          { category: 'c1', date: '2026-06-10', amount: -500 },
        ],
      });

    const result = await getTransactions({ summary: 'category' });

    expect((result as any).groups).toEqual([
      {
        key: 'c1',
        name: 'Dining Out',
        count: 3,
        firstDate: '2026-06-01',
        lastDate: '2026-06-15',
        totalAmount: 2500,
      },
    ]);
  });
});

// ── getTransactionById ─────────────────────────────────────────────────────────

describe('getTransactionById', () => {
  beforeEach(() => {
    (actualApi.getAccounts as any).mockResolvedValue([{ id: 'a1', name: 'Checking' }]);
    (actualApi.getPayees as any).mockResolvedValue([{ id: 'p1', name: 'ST. JUDE' }]);
    (actualApi.getCategoryGroups as any).mockResolvedValue([
      { categories: [{ id: 'c1', name: 'Dining Out' }] },
    ]);
  });

  it('enriches payeeName, accountName, and categoryName', async () => {
    (actualApi.runQuery as any).mockResolvedValue({
      data: [
        {
          id: 't1',
          date: '2026-06-22',
          amount: -9300,
          payee: 'p1',
          category: 'c1',
          notes: 'Lunch',
          account: 'a1',
          cleared: true,
          transfer_id: null,
          imported_payee: 'ST JUDE',
          reconciled: false,
          is_parent: false,
          parent_id: null,
        },
      ],
    });

    const result = await getTransactionById('t1');

    expect(actualApi.q).toHaveBeenCalledWith('transactions');
    expect(chain.filter).toHaveBeenCalledWith({ id: 't1' });
    expect(chain.select).toHaveBeenCalledWith('*');
    expect(chain.options).toHaveBeenCalledWith({ splits: 'grouped' });
    expect(result).toMatchObject({
      id: 't1',
      payeeName: 'ST. JUDE',
      accountName: 'Checking',
      categoryName: 'Dining Out',
    });
  });

  it('returns null when no row matches', async () => {
    (actualApi.runQuery as any).mockResolvedValue({ data: [] });

    const result = await getTransactionById('missing');

    expect(result).toBeNull();
  });
});

// ── getPayeesWithCounts ──────────────────────────────────────────────────────

describe('getPayeesWithCounts', () => {
  beforeEach(() => {
    (actualApi.getPayees as any).mockResolvedValue([
      { id: 'p1', name: 'ST. JUDE' },
      { id: 'p2', name: 'Transfer: Checking', transfer_acct: 'a1' },
      { id: 'p3', name: 'Coffee Shop' },
    ]);
    (actualApi.runQuery as any).mockResolvedValue({
      data: [
        { payee: 'p1', count: 5 },
        { payee: 'p3', count: 2 },
      ],
    });
  });

  it('returns payees with txCount and flags transfer payees', async () => {
    const result = await getPayeesWithCounts();

    expect(result).toEqual([
      { id: 'p1', name: 'ST. JUDE', txCount: 5, isTransfer: false },
      { id: 'p2', name: 'Transfer: Checking', txCount: 0, isTransfer: true },
      { id: 'p3', name: 'Coffee Shop', txCount: 2, isTransfer: false },
    ]);
  });

  it('uses a grouped query for counts', async () => {
    await getPayeesWithCounts();

    expect(chain.groupBy).toHaveBeenCalledWith('payee');
    expect(chain.select).toHaveBeenCalledWith(['payee', { count: { $count: '$id' } }]);
  });
});
