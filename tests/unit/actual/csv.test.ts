import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toCsv } from '../../../src/actual/csv';

describe('toCsv', () => {
  it('joins plain values with commas and trailing newline', () => {
    const csv = toCsv(['A', 'B'], [['1', '2'], ['3', '4']]);
    expect(csv).toBe('A,B\n1,2\n3,4\n');
  });

  it('quotes fields containing a comma', () => {
    const csv = toCsv(['Name'], [['Smith, John']]);
    expect(csv).toBe('Name\n"Smith, John"\n');
  });

  it('quotes fields containing a double quote and escapes the quote', () => {
    const csv = toCsv(['Q'], [['He said "hi"']]);
    expect(csv).toBe('Q\n"He said ""hi"""\n');
  });

  it('quotes fields containing a newline', () => {
    const csv = toCsv(['Note'], [['line1\nline2']]);
    expect(csv).toBe('Note\n"line1\nline2"\n');
  });

  it('returns header-only CSV when rows is empty', () => {
    const csv = toCsv(['A', 'B'], []);
    expect(csv).toBe('A,B\n');
  });

  it('escapes special characters in headers the same way as data', () => {
    const csv = toCsv(['has,comma'], [['v']]);
    expect(csv).toBe('"has,comma"\nv\n');
  });
});

import { buildScheduledTransactionsCsv } from '../../../src/actual/csv';

vi.mock('../../../src/actual/client', () => ({
  actualApi: {
    getPayees: vi.fn(),
    getCategoryGroups: vi.fn(),
  },
}));

vi.mock('../../../src/actual/queries', () => ({
  getScheduledTransactions: vi.fn(),
}));

import { actualApi } from '../../../src/actual/client';
import { getScheduledTransactions } from '../../../src/actual/queries';

describe('buildScheduledTransactionsCsv', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves payee and category IDs to names and formats amount as dollars', async () => {
    vi.mocked(getScheduledTransactions).mockResolvedValue([
      { id: 's1', payee: 'p1', amount: -12500, nextDate: '2026-06-01', category: 'c1' },
    ] as any);
    vi.mocked(actualApi.getPayees).mockResolvedValue([
      { id: 'p1', name: 'Comcast' },
    ] as any);
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      { name: 'Bills', categories: [{ id: 'c1', name: 'Internet' }] },
    ] as any);

    const { csv } = await buildScheduledTransactionsCsv();

    expect(csv).toBe('Next Date,Payee,Category,Amount\n2026-06-01,Comcast,Internet,-125.00\n');
  });

  it('falls back to (unknown) for unresolvable payee', async () => {
    vi.mocked(getScheduledTransactions).mockResolvedValue([
      { id: 's1', payee: 'missing', amount: -1000, nextDate: '2026-06-01', category: 'c1' },
    ] as any);
    vi.mocked(actualApi.getPayees).mockResolvedValue([] as any);
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      { name: 'Bills', categories: [{ id: 'c1', name: 'Internet' }] },
    ] as any);

    const { csv } = await buildScheduledTransactionsCsv();

    expect(csv).toContain('(unknown)');
  });

  it('falls back to (uncategorized) for null or missing category', async () => {
    vi.mocked(getScheduledTransactions).mockResolvedValue([
      { id: 's1', payee: 'p1', amount: -1000, nextDate: '2026-06-01', category: null },
    ] as any);
    vi.mocked(actualApi.getPayees).mockResolvedValue([{ id: 'p1', name: 'Comcast' }] as any);
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([] as any);

    const { csv } = await buildScheduledTransactionsCsv();

    expect(csv).toContain('(uncategorized)');
  });

  it('sorts ascending by Next Date, then by Payee', async () => {
    vi.mocked(getScheduledTransactions).mockResolvedValue([
      { id: 's2', payee: 'p2', amount: -100, nextDate: '2026-06-01', category: 'c1' },
      { id: 's1', payee: 'p1', amount: -100, nextDate: '2026-06-01', category: 'c1' },
      { id: 's3', payee: 'p3', amount: -100, nextDate: '2026-05-15', category: 'c1' },
    ] as any);
    vi.mocked(actualApi.getPayees).mockResolvedValue([
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Bravo' },
      { id: 'p3', name: 'Charlie' },
    ] as any);
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      { name: 'Bills', categories: [{ id: 'c1', name: 'Internet' }] },
    ] as any);

    const { csv } = await buildScheduledTransactionsCsv();
    const lines = csv.trim().split('\n');

    expect(lines[1]).toContain('2026-05-15,Charlie');
    expect(lines[2]).toContain('2026-06-01,Alpha');
    expect(lines[3]).toContain('2026-06-01,Bravo');
  });

  it('preserves sign on amount', async () => {
    vi.mocked(getScheduledTransactions).mockResolvedValue([
      { id: 's1', payee: 'p1', amount: 5000, nextDate: '2026-06-01', category: 'c1' },
    ] as any);
    vi.mocked(actualApi.getPayees).mockResolvedValue([{ id: 'p1', name: 'Refund' }] as any);
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      { name: 'Bills', categories: [{ id: 'c1', name: 'Internet' }] },
    ] as any);

    const { csv } = await buildScheduledTransactionsCsv();

    expect(csv).toContain('50.00');
    expect(csv).not.toContain('-50.00');
  });

  it('returns header-only CSV when there are no schedules', async () => {
    vi.mocked(getScheduledTransactions).mockResolvedValue([] as any);
    vi.mocked(actualApi.getPayees).mockResolvedValue([] as any);
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([] as any);

    const { csv } = await buildScheduledTransactionsCsv();

    expect(csv).toBe('Next Date,Payee,Category,Amount\n');
  });

  it('quotes payee names containing a comma', async () => {
    vi.mocked(getScheduledTransactions).mockResolvedValue([
      { id: 's1', payee: 'p1', amount: -1000, nextDate: '2026-06-01', category: 'c1' },
    ] as any);
    vi.mocked(actualApi.getPayees).mockResolvedValue([{ id: 'p1', name: 'Smith, John' }] as any);
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      { name: 'Bills', categories: [{ id: 'c1', name: 'Internet' }] },
    ] as any);

    const { csv } = await buildScheduledTransactionsCsv();

    expect(csv).toContain('"Smith, John"');
  });

  it('returns rowCount equal to the number of schedules', async () => {
    vi.mocked(getScheduledTransactions).mockResolvedValue([
      { id: 's1', payee: 'p1', amount: -1000, nextDate: '2026-06-01', category: 'c1' },
      { id: 's2', payee: 'p2', amount: -1000, nextDate: '2026-07-01', category: 'c1' },
    ] as any);
    vi.mocked(actualApi.getPayees).mockResolvedValue([
      { id: 'p1', name: 'A' },
      { id: 'p2', name: 'B' },
    ] as any);
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      { name: 'Bills', categories: [{ id: 'c1', name: 'Internet' }] },
    ] as any);

    const { rowCount } = await buildScheduledTransactionsCsv();

    expect(rowCount).toBe(2);
  });
});
