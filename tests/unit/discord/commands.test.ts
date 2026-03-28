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
    },
  };
});

vi.mock('../../../src/actual/queries', () => ({
  getRollingPruneCutoff: vi.fn().mockReturnValue('2024-04-01'),
  pruneTransactions: vi.fn().mockResolvedValue({ deleted: 0, dryRun: true, sample: [] }),
  cleanupHiddenCategories: vi.fn().mockResolvedValue({ deleted: 0, names: [], warnings: [] }),
  cleanupClosedAccounts: vi.fn().mockResolvedValue({ deleted: 0, names: [], warnings: [] }),
}));

vi.mock('../../../src/agent/index', () => ({
  getAppContext: vi.fn().mockReturnValue({ db: {} }),
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

  it('cleanup defaults to dry-run with 24 months', async () => {
    const { pruneTransactions } = await import('../../../src/actual/queries');
    await executeCommand('cleanup', mockCtx, []);

    expect(pruneTransactions).toHaveBeenCalledWith('2024-04-01', true, undefined);
    const msg = vi.mocked(postToThread).mock.calls[0][2];
    expect(msg).toContain('**Preview**');
    expect(msg).toContain('!cleanup 24 --confirm');
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
