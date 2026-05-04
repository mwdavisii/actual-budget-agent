import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseCommand, executeCommand, type CommandContext } from '../../../src/discord/commands';

vi.mock('../../../src/discord/threads', () => ({
  postToThread: vi.fn(),
}));

vi.mock('../../../src/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Mock webhook handlers
vi.mock('../../../src/webhook/handlers/bank_sync', () => ({ handleBankSync: vi.fn() }));
vi.mock('../../../src/webhook/handlers/weekly_digest', () => ({ handleWeeklyDigest: vi.fn() }));
vi.mock('../../../src/webhook/handlers/overspent', () => ({ handleOverspent: vi.fn() }));
vi.mock('../../../src/webhook/handlers/allocate_budget', () => ({ handleAllocatePayPeriod: vi.fn() }));

// Mock actual client for cleanup and uncategorized
vi.mock('../../../src/actual/client', () => {
  const mockChain = {
    filter: vi.fn().mockReturnThis(),
    options: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  };
  return {
    withActual: vi.fn((_d, _b, _s, _p, fn) => fn()),
    actualApi: {
      getAccounts: vi.fn().mockResolvedValue([]),
      runQuery: vi.fn().mockResolvedValue({ data: [] }),
      q: vi.fn(() => mockChain),
      getSchedules: vi.fn().mockResolvedValue([]),
      getPayees: vi.fn().mockResolvedValue([]),
      getCategoryGroups: vi.fn().mockResolvedValue([]),
    },
  };
});

vi.mock('../../../src/actual/queries', () => ({
  getRollingPruneCutoff: vi.fn().mockReturnValue('2024-04-01'),
  pruneTransactions: vi.fn().mockResolvedValue({ deleted: 0, dryRun: true, sample: [] }),
  cleanupHiddenCategories: vi.fn().mockResolvedValue({ deleted: 0, names: [], warnings: [] }),
  cleanupClosedAccounts: vi.fn().mockResolvedValue({ deleted: 0, names: [], warnings: [] }),
  getScheduledTransactions: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/discord/attachments', () => ({
  attachCsvToThread: vi.fn(),
}));

vi.mock('../../../src/agent/index', () => ({
  getAppContext: vi.fn().mockReturnValue({ db: {} }),
}));

vi.mock('../../../src/discord/cleanup-flow', () => ({
  startCleanupFlow: vi.fn().mockResolvedValue({
    cutoff: '2024-04-01', months: 24,
    transactions: { count: 10, sample: [] },
    categories: { count: 2, names: [] },
    accounts: { count: 1, names: [] },
    warnings: [],
  }),
}));

import { postToThread } from '../../../src/discord/threads';

const mockCtx: CommandContext = {
  client: {} as any,
  threadId: 'test-thread',
  webhookCtx: {
    hmacKey: 'key',
    dataDir: '/data',
    budgetId: 'budget-1',
    actualServerUrl: 'http://actual',
    actualPassword: 'pass',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseCommand', () => {
  it('parses a simple command', () => {
    expect(parseCommand('!help')).toEqual({ name: 'help', args: [] });
  });

  it('parses command with arguments', () => {
    expect(parseCommand('!cleanup 24 --confirm')).toEqual({ name: 'cleanup', args: ['24', '--confirm'] });
  });

  it('returns null for non-command messages', () => {
    expect(parseCommand('hello world')).toBeNull();
  });

  it('returns null for unknown commands', () => {
    expect(parseCommand('!foobar')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(parseCommand('!HELP')).toEqual({ name: 'help', args: [] });
  });

  it('handles extra whitespace', () => {
    expect(parseCommand('!cleanup   24')).toEqual({ name: 'cleanup', args: ['24'] });
  });
});

describe('executeCommand', () => {
  it('help command posts available commands', async () => {
    await executeCommand('help', mockCtx, []);

    expect(postToThread).toHaveBeenCalledOnce();
    const msg = vi.mocked(postToThread).mock.calls[0][2];
    expect(msg).toContain('**Available commands:**');
    expect(msg).toContain('!help');
    expect(msg).toContain('!sync');
    expect(msg).toContain('!summary');
    expect(msg).toContain('!cleanup');
  });

  it('sync command calls handleBankSync', async () => {
    const { handleBankSync } = await import('../../../src/webhook/handlers/bank_sync');
    await executeCommand('sync', mockCtx, []);
    expect(handleBankSync).toHaveBeenCalledWith(mockCtx.webhookCtx);
  });

  it('summary command calls handleWeeklyDigest', async () => {
    const { handleWeeklyDigest } = await import('../../../src/webhook/handlers/weekly_digest');
    await executeCommand('summary', mockCtx, []);
    expect(handleWeeklyDigest).toHaveBeenCalledWith(mockCtx.webhookCtx);
  });

  it('overspent command calls handleOverspent', async () => {
    const { handleOverspent } = await import('../../../src/webhook/handlers/overspent');
    await executeCommand('overspent', mockCtx, []);
    expect(handleOverspent).toHaveBeenCalledWith(mockCtx.webhookCtx);
  });

  it('allocate command calls handleAllocatePayPeriod', async () => {
    const { handleAllocatePayPeriod } = await import('../../../src/webhook/handlers/allocate_budget');
    await executeCommand('allocate', mockCtx, []);
    expect(handleAllocatePayPeriod).toHaveBeenCalledWith(mockCtx.webhookCtx);
  });

  it('cleanup starts the interactive cleanup flow', async () => {
    const { startCleanupFlow } = await import('../../../src/discord/cleanup-flow');
    await executeCommand('cleanup', mockCtx, []);

    expect(startCleanupFlow).toHaveBeenCalledWith(
      mockCtx.client, mockCtx.threadId, 24,
      expect.objectContaining({ budgetId: 'budget-1' }),
      expect.anything()
    );
  });

  it('cleanup accepts custom months', async () => {
    const { startCleanupFlow } = await import('../../../src/discord/cleanup-flow');
    await executeCommand('cleanup', mockCtx, ['12']);

    expect(startCleanupFlow).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 12,
      expect.anything(), expect.anything()
    );
  });

  it('cleanup rejects months < 3', async () => {
    await executeCommand('cleanup', mockCtx, ['2']);

    const msg = vi.mocked(postToThread).mock.calls[0][2];
    expect(msg).toContain('months must be a number >= 3');
  });

  it('uncategorized shows message when none found', async () => {
    await executeCommand('uncategorized', mockCtx, []);

    const msg = vi.mocked(postToThread).mock.calls[0][2];
    expect(msg).toContain('No uncategorized transactions found');
  });

  it('does nothing for unknown command', async () => {
    await executeCommand('nonexistent', mockCtx, []);
    expect(postToThread).not.toHaveBeenCalled();
  });
});

import { attachCsvToThread } from '../../../src/discord/attachments';
import { getScheduledTransactions } from '../../../src/actual/queries';
import { actualApi } from '../../../src/actual/client';

describe('!scheduled-csv command', () => {
  beforeEach(() => vi.clearAllMocks());

  it('attaches a CSV with todays date when there are scheduled transactions', async () => {
    vi.mocked(getScheduledTransactions).mockResolvedValue([
      { id: 's1', payee: 'p1', amount: -1000, nextDate: '2026-06-01', category: 'c1' },
    ] as any);
    vi.mocked(actualApi.getPayees).mockResolvedValue([{ id: 'p1', name: 'Comcast' }] as any);
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([
      { name: 'Bills', categories: [{ id: 'c1', name: 'Internet' }] },
    ] as any);

    await executeCommand('scheduled-csv', mockCtx, []);

    const dateStr = new Date().toISOString().slice(0, 10);
    expect(attachCsvToThread).toHaveBeenCalledWith(
      mockCtx.client,
      'test-thread',
      `scheduled-transactions-${dateStr}.csv`,
      expect.stringContaining('Next Date,Payee,Category,Amount'),
    );
    expect(postToThread).not.toHaveBeenCalled();
  });

  it('posts a fallback message and does not attach when there are no scheduled transactions', async () => {
    vi.mocked(getScheduledTransactions).mockResolvedValue([] as any);
    vi.mocked(actualApi.getPayees).mockResolvedValue([] as any);
    vi.mocked(actualApi.getCategoryGroups).mockResolvedValue([] as any);

    await executeCommand('scheduled-csv', mockCtx, []);

    expect(attachCsvToThread).not.toHaveBeenCalled();
    expect(postToThread).toHaveBeenCalledWith(
      mockCtx.client,
      'test-thread',
      'No scheduled transactions found.',
    );
  });

  it('is parsed as a single command name with hyphen', () => {
    expect(parseCommand('!scheduled-csv')).toEqual({ name: 'scheduled-csv', args: [] });
  });
});
