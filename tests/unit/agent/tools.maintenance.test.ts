// tests/unit/agent/tools.maintenance.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeTool, type ActualConfig } from '../../../src/agent/tools';
import { withActual, actualApi } from '../../../src/actual/client';
import {
  pruneTransactions,
  cleanupHiddenCategories,
  cleanupClosedAccounts,
} from '../../../src/actual/queries';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/schema';

vi.mock('../../../src/actual/client', () => ({
  withActual: vi.fn(async (_d: any, _b: any, _s: any, _p: any, fn: () => any) => fn()),
  actualApi: {
    internal: { send: vi.fn() },
  },
}));

vi.mock('../../../src/actual/queries', () => ({
  getRollingPruneCutoff: vi.fn(() => '2024-04-01'),
  pruneTransactions: vi.fn(),
  cleanupHiddenCategories: vi.fn(),
  cleanupClosedAccounts: vi.fn(),
  getUncategorizedTransactions: vi.fn(),
  getTransactions: vi.fn(),
  getBudgetStatus: vi.fn(),
  getScheduledTransactions: vi.fn(),
  setCategoryForTransaction: vi.fn(),
  syncAllAccounts: vi.fn(),
  allocateBudget: vi.fn(),
}));

vi.mock('discord.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('discord.js')>();
  return {
    ...real,
    AttachmentBuilder: vi.fn().mockImplementation(function(this: any, data: Buffer, opts: { name: string }) {
      this._isAttachment = true;
      this.data = data;
      this.name = opts.name;
    }),
  };
});

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

const actualConfig: ActualConfig = {
  dataDir: '/tmp', budgetId: 'test', serverUrl: 'http://localhost', password: 'pw',
};
const noop = async () => '';

// Mock the cleanup flow module
vi.mock('../../../src/discord/cleanup-flow', () => ({
  startCleanupFlow: vi.fn().mockResolvedValue({
    cutoff: '2024-04-01', months: 24,
    transactions: { count: 100, sample: ['2023-01-01 Target $10.00'] },
    categories: { count: 2, names: ['Old Cat'] },
    accounts: { count: 1, names: ['Closed Account'] },
    warnings: [],
  }),
}));

import { startCleanupFlow } from '../../../src/discord/cleanup-flow';

// ── cleanup_budget ───────────────────────────────────────────────────────────

describe('executeTool — cleanup_budget', () => {
  const mockDiscord = { channels: { fetch: vi.fn() } } as any;

  beforeEach(() => vi.clearAllMocks());

  it('returns error when months < 3', async () => {
    const result = await executeTool('cleanup_budget', { months: 2 }, actualConfig, makeDb(), noop, { discord: mockDiscord, threadId: 'thread-1' });
    expect(result).toMatchObject({ error: expect.stringContaining('months must be >= 3') });
  });

  it('returns error when no Discord context provided', async () => {
    const result = await executeTool('cleanup_budget', { months: 24 }, actualConfig, makeDb(), noop);
    expect(result).toMatchObject({ error: expect.stringContaining('No Discord context') });
  });

  it('delegates to startCleanupFlow and returns preview', async () => {
    const db = makeDb();
    const result = await executeTool('cleanup_budget', { months: 24 }, actualConfig, db, noop, { discord: mockDiscord, threadId: 'thread-1' }) as any;

    expect(startCleanupFlow).toHaveBeenCalledWith(
      mockDiscord, 'thread-1', 24,
      expect.objectContaining({ budgetId: 'test' }),
      db
    );
    expect(result.dryRun).toBe(true);
    expect(result.message).toContain('buttons');
    expect(result.transactions.count).toBe(100);
    expect(result.categories.count).toBe(2);
    expect(result.accounts.count).toBe(1);
  });
});

// ── export_budget ────────────────────────────────────────────────────────────

describe('executeTool — export_budget', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error when no context provided', async () => {
    const result = await executeTool('export_budget', {}, actualConfig, makeDb(), noop);
    expect(result).toMatchObject({ error: expect.stringContaining('No Discord context') });
  });

  it('calls internal.send and posts attachment to thread', async () => {
    const mockZipBuffer = Buffer.from('fake-zip-data');
    vi.mocked((actualApi as any).internal.send).mockResolvedValue({ data: mockZipBuffer });

    const mockSend = vi.fn().mockResolvedValue({});
    const mockThread = { send: mockSend };
    const mockDiscord = { channels: { fetch: vi.fn().mockResolvedValue(mockThread) } };

    const result = await executeTool(
      'export_budget', {}, actualConfig, makeDb(), noop,
      { discord: mockDiscord as any, threadId: 'thread-abc' }
    ) as any;

    expect((actualApi as any).internal.send).toHaveBeenCalledWith('export-budget');
    expect(mockDiscord.channels.fetch).toHaveBeenCalledWith('thread-abc');
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/Budget backup — \d{4}-\d{2}-\d{2}/),
        files: expect.arrayContaining([expect.anything()]),
      })
    );
    expect(result.success).toBe(true);
    expect(result.filename).toMatch(/budget-backup-\d{4}-\d{2}-\d{2}\.zip/);
  });

  it('returns error object when export returns error field', async () => {
    vi.mocked((actualApi as any).internal.send).mockResolvedValue({ error: 'internal-error' });

    const mockDiscord = { channels: { fetch: vi.fn() } };
    const result = await executeTool('export_budget', {}, actualConfig, makeDb(), noop,
      { discord: mockDiscord as any, threadId: 'thread-abc' }) as any;
    expect(result).toMatchObject({ error: expect.stringContaining('Export failed') });
  });
});
