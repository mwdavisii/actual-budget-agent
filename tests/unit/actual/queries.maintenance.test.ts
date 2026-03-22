// tests/unit/actual/queries.maintenance.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getRollingPruneCutoff, cleanupHiddenCategories, cleanupClosedAccounts } from '../../../src/actual/queries';
import { actualApi } from '../../../src/actual/client';

vi.mock('../../../src/actual/client', () => {
  const mockChain = {
    filter: vi.fn().mockReturnThis(),
    options: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
  };
  return {
    actualApi: {
      getCategoryGroups: vi.fn(),
      getAccounts: vi.fn(),
      runQuery: vi.fn(),
      q: vi.fn(() => mockChain),
      deleteCategory: vi.fn(),
      deleteCategoryGroup: vi.fn(),
      deleteAccount: vi.fn(),
    },
  };
});

// ── getRollingPruneCutoff ────────────────────────────────────────────────────

describe('getRollingPruneCutoff', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns a date string 24 months in the past', () => {
    vi.setSystemTime(new Date('2026-03-22'));
    expect(getRollingPruneCutoff(24)).toBe('2024-03-22');
  });

  it('clamps to last day of month when target month is shorter', () => {
    // March 31 minus 1 month = February 28 (not March 3)
    vi.setSystemTime(new Date('2026-03-31'));
    expect(getRollingPruneCutoff(1)).toBe('2026-02-28');
  });

  it('handles leap year February correctly', () => {
    // March 31 2024 minus 1 month = February 29 2024 (leap year)
    vi.setSystemTime(new Date('2024-03-31'));
    expect(getRollingPruneCutoff(1)).toBe('2024-02-29');
  });
});

// ── cleanupHiddenCategories ──────────────────────────────────────────────────

describe('cleanupHiddenCategories', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dry run returns names without deleting', async () => {
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      {
        id: 'g1', name: 'Old Group', hidden: false,
        categories: [{ id: 'c1', name: 'Old Stuff', hidden: true }],
      },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);

    const result = await cleanupHiddenCategories(true);

    expect(result.deleted).toBe(1);
    expect(result.names).toContain('Old Stuff');
    expect(result.warnings).toHaveLength(0);
    expect(actualApi.deleteCategory).not.toHaveBeenCalled();
  });

  it('deletes hidden category with 0 transactions when not dry run', async () => {
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      {
        id: 'g1', name: 'Active Group', hidden: false,
        categories: [{ id: 'c1', name: 'Empty Hidden', hidden: true }],
      },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);

    const result = await cleanupHiddenCategories(false);

    expect(actualApi.deleteCategory).toHaveBeenCalledWith('c1');
    expect(result.deleted).toBe(1);
    expect(result.warnings).toHaveLength(0);
  });

  it('skips hidden category that still has transactions', async () => {
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      {
        id: 'g1', name: 'Group', hidden: false,
        categories: [{ id: 'c1', name: 'Has Txns', hidden: true }],
      },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [{ id: 'tx1' }] } as any);

    const result = await cleanupHiddenCategories(false);

    expect(actualApi.deleteCategory).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
  });

  it('deletes a hidden group that is already empty (no categories)', async () => {
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      { id: 'g1', name: 'Ghost Group', hidden: true, categories: [] },
    ] as any);

    const result = await cleanupHiddenCategories(false);

    expect(actualApi.deleteCategoryGroup).toHaveBeenCalledWith('g1');
    expect(result.warnings).toHaveLength(0);
    expect(result.deleted).toBe(1);
    expect(result.names).toContain('Ghost Group');
  });

  it('records warning and continues when a delete fails', async () => {
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      {
        id: 'g1', name: 'Group', hidden: false,
        categories: [
          { id: 'c1', name: 'Will Fail', hidden: true },
          { id: 'c2', name: 'Will Succeed', hidden: true },
        ],
      },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);
    vi.mocked(actualApi.deleteCategory)
      .mockRejectedValueOnce(new Error('DB locked'))
      .mockResolvedValueOnce(undefined);

    const result = await cleanupHiddenCategories(false);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Will Fail');
    expect(result.deleted).toBe(1);
  });
});

// ── cleanupClosedAccounts ────────────────────────────────────────────────────

describe('cleanupClosedAccounts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dry run returns names without deleting', async () => {
    vi.mocked(actualApi.getAccounts).mockResolvedValue([
      { id: 'a1', name: 'Old Checking', closed: true },
      { id: 'a2', name: 'Active Checking', closed: false },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);

    const result = await cleanupClosedAccounts(true);

    expect(result.deleted).toBe(1);
    expect(result.names).toContain('Old Checking');
    expect(actualApi.deleteAccount).not.toHaveBeenCalled();
  });

  it('deletes closed account with 0 transactions', async () => {
    vi.mocked(actualApi.getAccounts).mockResolvedValue([
      { id: 'a1', name: 'Empty Closed', closed: true },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);

    const result = await cleanupClosedAccounts(false);

    expect(actualApi.deleteAccount).toHaveBeenCalledWith('a1');
    expect(result.deleted).toBe(1);
  });

  it('skips closed account that has transactions', async () => {
    vi.mocked(actualApi.getAccounts).mockResolvedValue([
      { id: 'a1', name: 'Has History', closed: true },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [{ id: 'tx1' }] } as any);

    const result = await cleanupClosedAccounts(false);

    expect(actualApi.deleteAccount).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
  });

  it('records warning and continues on delete failure', async () => {
    vi.mocked(actualApi.getAccounts).mockResolvedValue([
      { id: 'a1', name: 'Will Fail', closed: true },
      { id: 'a2', name: 'Will Succeed', closed: true },
    ] as any);
    vi.mocked(actualApi.runQuery).mockResolvedValue({ data: [] } as any);
    vi.mocked(actualApi.deleteAccount)
      .mockRejectedValueOnce(new Error('locked'))
      .mockResolvedValueOnce(undefined);

    const result = await cleanupClosedAccounts(false);

    expect(result.warnings).toHaveLength(1);
    expect(result.deleted).toBe(1);
  });
});
