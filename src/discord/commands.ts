import type { Client } from 'discord.js';
import type { WebhookContext } from '../webhook/server';
import { postToThread } from './threads';
import { logger } from '../logger';

export interface CommandContext {
  client: Client;
  threadId: string;
  webhookCtx: WebhookContext;
}

interface Command {
  description: string;
  usage: string;
  handler: (ctx: CommandContext, args: string[]) => Promise<void>;
}

const commands: Record<string, Command> = {
  help: {
    description: 'List available commands',
    usage: '!help',
    handler: async (ctx) => {
      const lines = ['**Available commands:**', ''];
      for (const [name, cmd] of Object.entries(commands)) {
        lines.push(`\`${cmd.usage}\` — ${cmd.description}`);
      }
      await postToThread(ctx.client, ctx.threadId, lines.join('\n'));
    },
  },

  sync: {
    description: 'Trigger bank sync',
    usage: '!sync',
    handler: async (ctx) => {
      const { handleBankSync } = await import('../webhook/handlers/bank_sync');
      await handleBankSync(ctx.webhookCtx);
    },
  },

  summary: {
    description: 'Weekly spending digest',
    usage: '!summary',
    handler: async (ctx) => {
      const { handleWeeklyDigest } = await import('../webhook/handlers/weekly_digest');
      await handleWeeklyDigest(ctx.webhookCtx);
    },
  },

  overspent: {
    description: 'Check overspent categories',
    usage: '!overspent',
    handler: async (ctx) => {
      const { handleOverspent } = await import('../webhook/handlers/overspent');
      await handleOverspent(ctx.webhookCtx);
    },
  },

  allocate: {
    description: 'Run pay period allocation',
    usage: '!allocate',
    handler: async (ctx) => {
      const { handleAllocatePayPeriod } = await import('../webhook/handlers/allocate_budget');
      await handleAllocatePayPeriod(ctx.webhookCtx);
    },
  },

  cleanup: {
    description: 'Preview budget cleanup with options to export and proceed',
    usage: '!cleanup [months]',
    handler: async (ctx, args) => {
      const months = parseInt(args[0] || '24', 10);
      if (!Number.isFinite(months) || months < 3) {
        await postToThread(ctx.client, ctx.threadId, 'months must be a number >= 3');
        return;
      }

      const { startCleanupFlow } = await import('./cleanup-flow');
      const { getAppContext } = await import('../agent/index');
      const { db } = getAppContext();

      await startCleanupFlow(ctx.client, ctx.threadId, months, {
        dataDir: ctx.webhookCtx.dataDir,
        budgetId: ctx.webhookCtx.budgetId,
        serverUrl: ctx.webhookCtx.actualServerUrl,
        password: ctx.webhookCtx.actualPassword,
      }, db);
    },
  },

  uncategorized: {
    description: 'List uncategorized transactions',
    usage: '!uncategorized',
    handler: async (ctx) => {
      const { withActual } = await import('../actual/client');
      const { actualApi } = await import('../actual/client');
      const wCtx = ctx.webhookCtx;

      const result = await withActual(wCtx.dataDir, wCtx.budgetId, wCtx.actualServerUrl, wCtx.actualPassword, async () => {
        const accounts = await actualApi.getAccounts() as Array<{ id: string; name: string }>;
        const acctMap = Object.fromEntries(accounts.map(a => [a.id, a.name]));

        const txResult = await actualApi.runQuery(
          actualApi.q('transactions')
            .filter({ category: null, 'account.offbudget': false, is_parent: false, transfer_id: null })
            .options({ splits: 'inline' })
            .select(['id', 'date', 'payee', 'amount', 'account'])
            .limit(25)
        ) as { data: Array<{ id: string; date: string; payee: string; amount: number; account: string }> };
        return txResult.data.map(tx => ({
          date: tx.date,
          payee: tx.payee ?? '(no payee)',
          amount: `$${(Math.abs(tx.amount) / 100).toFixed(2)}`,
          account: acctMap[tx.account] || tx.account,
        }));
      });

      if (result.length === 0) {
        await postToThread(ctx.client, ctx.threadId, 'No uncategorized transactions found.');
        return;
      }
      const lines = [`**${result.length} uncategorized transaction(s):**`, ''];
      for (const tx of result) {
        lines.push(`- ${tx.date} | ${tx.payee} | ${tx.amount} | ${tx.account}`);
      }
      await postToThread(ctx.client, ctx.threadId, lines.join('\n'));
    },
  },
};

export function parseCommand(content: string): { name: string; args: string[] } | null {
  if (!content.startsWith('!')) return null;
  const parts = content.slice(1).trim().split(/\s+/);
  const name = parts[0]?.toLowerCase();
  if (!name || !(name in commands)) return null;
  return { name, args: parts.slice(1) };
}

export async function executeCommand(name: string, ctx: CommandContext, args: string[]): Promise<void> {
  const cmd = commands[name];
  if (!cmd) return;
  logger.info('Executing prefix command', { command: name, args });
  await cmd.handler(ctx, args);
}
