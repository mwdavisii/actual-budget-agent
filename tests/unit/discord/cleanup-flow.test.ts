import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatDryRunMessage, startCleanupFlow, handleCleanupInteraction, clearPendingCleanups, getPendingCleanup } from '../../../src/discord/cleanup-flow';

vi.mock('../../../src/actual/client', () => {
  const mockChain = {
    filter: vi.fn().mockReturnThis(),
    options: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
  };
  return {
    withActual: vi.fn((_d, _b, _s, _p, fn) => fn()),
    actualApi: {
      internal: { send: vi.fn().mockResolvedValue({ data: Buffer.from('zip') }) },
      q: vi.fn(() => mockChain),
    },
  };
});

vi.mock('../../../src/actual/queries', () => ({
  getRollingPruneCutoff: vi.fn().mockReturnValue('2024-04-01'),
  pruneTransactions: vi.fn().mockResolvedValue({ deleted: 100, dryRun: true, sample: ['2023-01-01 Grocery $50.00'] }),
  cleanupHiddenCategories: vi.fn().mockResolvedValue({ deleted: 5, names: ['Old Category'], warnings: [] }),
  cleanupClosedAccounts: vi.fn().mockResolvedValue({ deleted: 3, names: ['Old Account'], warnings: [] }),
}));

vi.mock('../../../src/discord/threads', () => ({
  postToThread: vi.fn(),
}));

vi.mock('../../../src/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function createMockThread() {
  const sentMessage = {
    id: 'msg-123',
    content: '',
    channelId: 'thread-1',
    edit: vi.fn(),
  };
  return {
    send: vi.fn().mockResolvedValue(sentMessage),
    sentMessage,
  };
}

function createMockClient(mockThread: ReturnType<typeof createMockThread>) {
  return {
    channels: {
      fetch: vi.fn().mockResolvedValue(mockThread),
    },
  } as any;
}

function createMockInteraction(customId: string, messageId: string, content: string) {
  return {
    isButton: () => true,
    customId,
    message: {
      id: messageId,
      content,
      channelId: 'thread-1',
      edit: vi.fn(),
    },
    deferUpdate: vi.fn(),
    reply: vi.fn(),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPendingCleanups();
});

describe('formatDryRunMessage', () => {
  it('formats a complete dry run result', () => {
    const msg = formatDryRunMessage({
      cutoff: '2024-04-01',
      months: 24,
      transactions: { count: 100, sample: ['2023-01-01 Grocery $50.00'] },
      categories: { count: 5, names: ['Old Category'] },
      accounts: { count: 3, names: ['Old Account'] },
      warnings: [],
    });

    expect(msg).toContain('**Cleanup preview**');
    expect(msg).toContain('24 months');
    expect(msg).toContain('2024-04-01');
    expect(msg).toContain('**Transactions to delete:** 100');
    expect(msg).toContain('**Hidden categories to delete:** 5');
    expect(msg).toContain('**Closed accounts to delete:** 3');
    expect(msg).toContain('Grocery $50.00');
    expect(msg).toContain('Old Category');
    expect(msg).toContain('Old Account');
  });

  it('includes warnings when present', () => {
    const msg = formatDryRunMessage({
      cutoff: '2024-04-01',
      months: 24,
      transactions: { count: 0, sample: [] },
      categories: { count: 0, names: [] },
      accounts: { count: 0, names: [] },
      warnings: ['Something went wrong'],
    });

    expect(msg).toContain('**Warnings:**');
    expect(msg).toContain('Something went wrong');
  });
});

describe('startCleanupFlow', () => {
  it('posts dry-run preview with buttons and stores pending state', async () => {
    const mockThread = createMockThread();
    const client = createMockClient(mockThread);

    const result = await startCleanupFlow(client, 'thread-1', 24, {
      dataDir: '/data',
      budgetId: 'budget-1',
      serverUrl: 'http://actual',
      password: 'pass',
    }, {} as any);

    expect(result.transactions.count).toBe(100);
    expect(result.categories.count).toBe(5);
    expect(result.accounts.count).toBe(3);

    // Verify message was sent with buttons
    expect(mockThread.send).toHaveBeenCalledOnce();
    const sendCall = mockThread.send.mock.calls[0][0];
    expect(sendCall.content).toContain('**Cleanup preview**');
    expect(sendCall.components).toHaveLength(1);
    expect(sendCall.components[0].components).toHaveLength(3); // Cancel, Export, Proceed

    // Verify pending state stored
    const pending = getPendingCleanup('msg-123');
    expect(pending).toBeDefined();
    expect(pending!.result.months).toBe(24);
  });
});

describe('handleCleanupInteraction', () => {
  it('returns false for non-cleanup buttons', async () => {
    const interaction = createMockInteraction('approve', 'msg-1', 'content');
    const handled = await handleCleanupInteraction(interaction, {} as any);
    expect(handled).toBe(false);
  });

  it('responds with expired message for unknown cleanup', async () => {
    const interaction = createMockInteraction('cleanup_cancel', 'unknown-msg', 'content');
    const handled = await handleCleanupInteraction(interaction, {} as any);
    expect(handled).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith({ content: 'This cleanup session has expired.', ephemeral: true });
  });

  it('cancel removes pending state and updates message', async () => {
    const mockThread = createMockThread();
    const client = createMockClient(mockThread);

    await startCleanupFlow(client, 'thread-1', 24, {
      dataDir: '/data', budgetId: 'b', serverUrl: 'http://a', password: 'p',
    }, {} as any);

    const interaction = createMockInteraction('cleanup_cancel', 'msg-123', 'preview content');
    const handled = await handleCleanupInteraction(interaction, client);

    expect(handled).toBe(true);
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(interaction.message.edit).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('**Cancelled.**'), components: [] })
    );
    expect(getPendingCleanup('msg-123')).toBeUndefined();
  });

  it('export sends backup ZIP and updates buttons', async () => {
    const mockThread = createMockThread();
    const client = createMockClient(mockThread);

    await startCleanupFlow(client, 'thread-1', 24, {
      dataDir: '/data', budgetId: 'b', serverUrl: 'http://a', password: 'p',
    }, {} as any);

    const interaction = createMockInteraction('cleanup_export', 'msg-123', 'preview content');
    await handleCleanupInteraction(interaction, client);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    // Should have sent a file attachment
    expect(mockThread.send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Budget backup'),
      files: expect.any(Array),
    }));
    // Should update buttons to Cancel/Proceed only
    expect(interaction.message.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('**Backup exported.**'),
        components: expect.arrayContaining([
          expect.objectContaining({ components: expect.any(Array) }),
        ]),
      })
    );
    // Pending state should still exist
    expect(getPendingCleanup('msg-123')).toBeDefined();
  });

  it('proceed executes cleanup and clears pending state', async () => {
    const mockThread = createMockThread();
    const client = createMockClient(mockThread);
    const { postToThread } = await import('../../../src/discord/threads');

    await startCleanupFlow(client, 'thread-1', 24, {
      dataDir: '/data', budgetId: 'b', serverUrl: 'http://a', password: 'p',
    }, {} as any);

    const interaction = createMockInteraction('cleanup_proceed', 'msg-123', 'preview content');
    await handleCleanupInteraction(interaction, client);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    // Should have removed buttons with "Executing..." message
    expect(interaction.message.edit).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('**Executing cleanup...**'), components: [] })
    );
    // Should post completion summary
    expect(postToThread).toHaveBeenCalledWith(
      client, 'thread-1', expect.stringContaining('**Cleanup complete!**')
    );
    // Pending state should be cleared
    expect(getPendingCleanup('msg-123')).toBeUndefined();
  });
});
