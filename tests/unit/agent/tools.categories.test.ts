import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeTool, type ActualConfig } from '../../../src/agent/tools';
import { withActual, actualApi } from '../../../src/actual/client';

vi.mock('../../../src/actual/client', () => ({
  withActual: vi.fn(async (_d: any, _b: any, _s: any, _p: any, fn: () => any) => fn()),
  actualApi: {
    getCategoryGroups: vi.fn(),
  },
}));

// Minimal stubs so executeTool can import without crashing
vi.mock('../../../src/actual/queries', () => ({
  getUncategorizedTransactions: vi.fn(),
  getTransactions: vi.fn(),
  getBudgetStatus: vi.fn(),
  getScheduledTransactions: vi.fn(),
  getRollingPruneCutoff: vi.fn(),
  cleanupHiddenCategories: vi.fn(),
  cleanupClosedAccounts: vi.fn(),
  pruneTransactions: vi.fn(),
  revertCarryForwards: vi.fn(),
  setCategoryForTransaction: vi.fn(),
}));

vi.mock('../../../src/db/proposals', () => ({ getPendingProposals: vi.fn() }));
vi.mock('../../../src/db/targets', () => ({
  getTargets: vi.fn(() => []),
  setTarget: vi.fn(),
  seedTargets: vi.fn(),
  getUnderfundedCategories: vi.fn(),
  exportTargets: vi.fn(),
  importTargets: vi.fn(),
}));
vi.mock('discord.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('discord.js')>();
  return { ...real, AttachmentBuilder: vi.fn() };
});

const actualConfig: ActualConfig = {
  dataDir: '/tmp', budgetId: 'test', serverUrl: 'http://localhost', password: 'pw',
};
const noop = async () => '';

describe('getCategories tool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns visible groups with their visible categories', async () => {
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      {
        id: 'g1', name: 'Food', hidden: false,
        categories: [
          { id: 'c1', name: 'Groceries', hidden: false },
          { id: 'c2', name: 'Restaurants', hidden: false },
        ],
      },
      {
        id: 'g2', name: 'Transport', hidden: false,
        categories: [
          { id: 'c3', name: 'Gas', hidden: false },
          { id: 'c4', name: 'Parking', hidden: true }, // hidden — excluded
        ],
      },
    ] as any);

    const result = await executeTool('getCategories', {}, actualConfig, null as any, noop);

    expect(result).toEqual([
      { group: 'Food', categories: ['Groceries', 'Restaurants'] },
      { group: 'Transport', categories: ['Gas'] },
    ]);
  });

  it('excludes hidden groups entirely', async () => {
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      {
        id: 'g1', name: 'Hidden Group', hidden: true,
        categories: [{ id: 'c1', name: 'Some Category', hidden: false }],
      },
      {
        id: 'g2', name: 'Visible Group', hidden: false,
        categories: [{ id: 'c2', name: 'Visible Category', hidden: false }],
      },
    ] as any);

    const result = await executeTool('getCategories', {}, actualConfig, null as any, noop);

    expect(result).toEqual([
      { group: 'Visible Group', categories: ['Visible Category'] },
    ]);
  });

  it('handles groups with no categories field (optional in API type)', async () => {
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      { id: 'g1', name: 'Empty Group', hidden: false }, // no categories field
    ] as any);

    const result = await executeTool('getCategories', {}, actualConfig, null as any, noop);

    expect(result).toEqual([{ group: 'Empty Group', categories: [] }]);
  });
});
