import type { ToolDefinition } from '../llm/types';
import { withActual, actualApi } from '../actual/client';
import {
  getUncategorizedTransactions,
  getTransactions,
  getBudgetStatus,
  getScheduledTransactions,
  getRollingPruneCutoff,
  cleanupHiddenCategories,
  cleanupClosedAccounts,
  pruneTransactions,
} from '../actual/queries';
import { getPendingProposals } from '../db/proposals';
import { getTargets, setTarget, seedTargets, getUnderfundedCategories, exportTargets, importTargets, type TargetExport } from '../db/targets';
import type Database from 'better-sqlite3';
import type { Client } from 'discord.js';
import { AttachmentBuilder } from 'discord.js';

export interface ActualConfig {
  dataDir: string;
  budgetId: string;
  serverUrl: string;
  password: string;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'getUncategorizedTransactions',
    description: 'Fetch all transactions missing a budget category.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getTransactions',
    description: 'Query transactions with optional filters. Amounts are in cents.',
    parameters: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'YYYY-MM-DD' },
        endDate: { type: 'string', description: 'YYYY-MM-DD' },
        accountId: { type: 'string' },
        categoryId: { type: 'string' },
        amountMin: { type: 'number', description: 'Minimum amount in cents' },
        amountMax: { type: 'number', description: 'Maximum amount in cents' },
      },
      required: [],
    },
  },
  {
    name: 'getBudgetStatus',
    description: 'Get budgeted/spent/available per category. Amounts in cents.',
    parameters: {
      type: 'object',
      properties: { month: { type: 'string', description: 'YYYY-MM (defaults to current month)' } },
      required: [],
    },
  },
  {
    name: 'getScheduledTransactions',
    description: 'Get upcoming scheduled transactions and their funded status.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getPendingProposals',
    description: 'List all pending categorization proposals and their expiry times.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'proposeCategory',
    description: 'Propose a category for a transaction. Posts a Discord approval message. Do NOT call applyCategory directly.',
    parameters: {
      type: 'object',
      properties: {
        txId: { type: 'string', description: 'Transaction ID from Actual Budget' },
        category: { type: 'string', description: 'Category name to assign' },
        reason: { type: 'string', description: 'Why you are proposing this category' },
        account: { type: 'string', description: 'Account name the transaction belongs to' },
        payee: { type: 'string', description: 'Payee/merchant name' },
        amount: { type: 'number', description: 'Transaction amount in cents' },
      },
      required: ['txId', 'category', 'reason'],
    },
  },
  {
    name: 'getBudgetTargets',
    description: 'Get all stored budget targets with current budgeted amounts and the gap.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'setBudgetTarget',
    description: 'Set a budget target amount for a category. Set to 0 to remove.',
    parameters: {
      type: 'object',
      properties: {
        categoryName: { type: 'string', description: 'Category name (case-insensitive exact match)' },
        amount: { type: 'number', description: 'Target amount in cents' },
      },
      required: ['categoryName', 'amount'],
    },
  },
  {
    name: 'seedBudgetTargets',
    description: 'Seed budget targets from current month budgeted amounts. Overwrites all existing targets. Excludes income categories.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getUnderfundedCategories',
    description: 'Compare current budgeted amounts against stored targets. Returns categories where budgeted is less than target with the gap.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'allocatePayPeriodBudget',
    description: 'Allocate budget amounts for the current pay period. Fixed bills due before next payday get full target. Discretionary gets half on 1st paycheck, full on 2nd. 3rd paycheck skipped.',
    parameters: {
      type: 'object',
      properties: {
        forceDate: { type: 'string', description: 'Optional ISO date to treat as payday (bypasses payday check). For testing.' },
      },
      required: [],
    },
  },
  {
    name: 'exportBudgetTargets',
    description: 'Export all budget targets as JSON. Returns the full target set for backup or sharing.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'importBudgetTargets',
    description: 'Import budget targets from a JSON payload. Upserts each target — existing categories are updated, new ones are added.',
    parameters: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          description: 'Array of target objects with categoryId, categoryName, and targetAmount (in cents)',
          items: {
            type: 'object',
            properties: {
              categoryId: { type: 'string' },
              categoryName: { type: 'string' },
              targetAmount: { type: 'number' },
            },
            required: ['categoryId', 'categoryName', 'targetAmount'],
          },
        },
      },
      required: ['targets'],
    },
  },
  {
    name: 'cleanup_budget',
    description: 'Preview or execute budget maintenance: prune old transactions, delete hidden categories with no transactions, and delete closed accounts with no transactions. ALWAYS call with dry_run=true first to preview. ALWAYS offer export_budget before calling with dry_run=false.',
    parameters: {
      type: 'object',
      properties: {
        months: {
          type: 'number',
          description: 'Delete transactions older than this many months. Must be >= 3.',
        },
        dry_run: {
          type: 'boolean',
          description: 'If true (default), returns a preview without deleting anything.',
        },
      },
      required: ['months'],
    },
  },
  {
    name: 'export_budget',
    description: 'Exports the Actual Budget database as a ZIP file attachment in the current Discord thread. This exports the full budget database, not the budget targets JSON.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  actualConfig: ActualConfig,
  db: Database.Database,
  proposeCategoryFn: (txId: string, category: string, reason: string, account?: string, payee?: string, amount?: number) => Promise<string>,
  context?: { discord: Client; threadId: string }
): Promise<unknown> {
  switch (toolName) {
    case 'getUncategorizedTransactions':
      return withActual(actualConfig.dataDir, actualConfig.budgetId, actualConfig.serverUrl, actualConfig.password, getUncategorizedTransactions);

    case 'getTransactions':
      return withActual(actualConfig.dataDir, actualConfig.budgetId, actualConfig.serverUrl, actualConfig.password, () =>
        getTransactions(input as Parameters<typeof getTransactions>[0])
      );

    case 'getBudgetStatus':
      return withActual(actualConfig.dataDir, actualConfig.budgetId, actualConfig.serverUrl, actualConfig.password, () =>
        getBudgetStatus(input['month'] as string | undefined)
      );

    case 'getScheduledTransactions':
      return withActual(actualConfig.dataDir, actualConfig.budgetId, actualConfig.serverUrl, actualConfig.password, getScheduledTransactions);

    case 'getPendingProposals':
      return getPendingProposals(db);

    case 'proposeCategory':
      return proposeCategoryFn(
        input['txId'] as string,
        input['category'] as string,
        input['reason'] as string,
        (input['account'] as string) || undefined,
        (input['payee'] as string) || undefined,
        input['amount'] != null ? Number(input['amount']) : undefined
      );

    case 'getBudgetTargets': {
      const categories = await withActual(actualConfig.dataDir, actualConfig.budgetId, actualConfig.serverUrl, actualConfig.password, getBudgetStatus);
      const targets = getTargets(db);
      return targets.map((t) => {
        const live = categories.find((c) => c.id === t.categoryId);
        return {
          categoryName: live?.name ?? t.categoryName,
          target: t.targetAmount,
          budgeted: live?.budgeted ?? 0,
          gap: t.targetAmount - (live?.budgeted ?? 0),
        };
      });
    }

    case 'setBudgetTarget': {
      const name = input['categoryName'] as string;
      const amount = Number(input['amount']);
      const categories = await withActual(actualConfig.dataDir, actualConfig.budgetId, actualConfig.serverUrl, actualConfig.password, getBudgetStatus);
      const match = categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (!match) return { error: `No category found matching "${name}". Check the exact name in Actual Budget.` };
      setTarget(db, match.id, match.name, amount);
      return { success: true, categoryName: match.name, targetAmount: amount };
    }

    case 'seedBudgetTargets': {
      const categories = await withActual(actualConfig.dataDir, actualConfig.budgetId, actualConfig.serverUrl, actualConfig.password, getBudgetStatus);
      const count = seedTargets(db, categories);
      return { success: true, count, month: new Date().toISOString().slice(0, 7) };
    }

    case 'getUnderfundedCategories': {
      const categories = await withActual(actualConfig.dataDir, actualConfig.budgetId, actualConfig.serverUrl, actualConfig.password, getBudgetStatus);
      return getUnderfundedCategories(db, categories);
    }

    case 'allocatePayPeriodBudget': {
      const { handleAllocatePayPeriod } = await import('../webhook/handlers/allocate_budget');
      const forceDate = input['forceDate'] as string | undefined;
      const ctx: import('../webhook/server').WebhookContext = {
        hmacKey: '',
        dataDir: actualConfig.dataDir,
        budgetId: actualConfig.budgetId,
        actualServerUrl: actualConfig.serverUrl,
        actualPassword: actualConfig.password,
      };
      await handleAllocatePayPeriod(ctx, forceDate);
      return { success: true, message: 'Pay-period allocation completed. Check the Discord thread for details.' };
    }

    case 'exportBudgetTargets':
      return exportTargets(db);

    case 'importBudgetTargets': {
      const targets = input['targets'] as TargetExport['targets'];
      const count = importTargets(db, { exportedAt: new Date().toISOString(), targets });
      return { success: true, imported: count };
    }

    case 'cleanup_budget': {
      const months = Number(input['months']);
      const dryRun = input['dry_run'] !== false; // defaults to true
      if (!Number.isFinite(months) || months < 3) return { error: 'months must be >= 3 to prevent accidental data loss' };

      const warnings: string[] = [];
      let transactions = { count: 0, sample: [] as string[] };
      let categories = { count: 0, names: [] as string[] };
      let accounts = { count: 0, names: [] as string[] };

      const cutoff = getRollingPruneCutoff(months);
      return withActual(actualConfig.dataDir, actualConfig.budgetId, actualConfig.serverUrl, actualConfig.password, async () => {
        try {
          const pruneResult = await pruneTransactions(cutoff, dryRun);
          transactions = { count: pruneResult.deleted, sample: pruneResult.sample };
        } catch (err) {
          warnings.push(`Transaction prune failed: ${String(err)}`);
        }
        try {
          const catResult = await cleanupHiddenCategories(dryRun, cutoff);
          categories = { count: catResult.deleted, names: catResult.names };
          warnings.push(...catResult.warnings);
        } catch (err) {
          warnings.push(`Category cleanup failed: ${String(err)}`);
        }
        try {
          const accResult = await cleanupClosedAccounts(dryRun, cutoff);
          accounts = { count: accResult.deleted, names: accResult.names };
          warnings.push(...accResult.warnings);
        } catch (err) {
          warnings.push(`Account cleanup failed: ${String(err)}`);
        }
        return { dryRun, transactions, categories, accounts, warnings };
      });
    }

    case 'export_budget': {
      if (!context?.discord || !context?.threadId) {
        return { error: 'No Discord context available for export_budget' };
      }
      const { discord, threadId } = context;
      return withActual(actualConfig.dataDir, actualConfig.budgetId, actualConfig.serverUrl, actualConfig.password, async () => {
        const exportResult = await (actualApi as any).internal.send('export-budget') as { data?: Buffer; error?: string };
        if (exportResult.error || !exportResult.data) {
          return { error: `Export failed: ${exportResult.error ?? 'no data returned'}` };
        }
        const dateStr = new Date().toISOString().slice(0, 10);
        const attachment = new AttachmentBuilder(exportResult.data, { name: `budget-backup-${dateStr}.zip` });
        const thread = await discord.channels.fetch(threadId) as any;
        await thread.send({ content: `Budget backup — ${dateStr}`, files: [attachment] });
        return { success: true, filename: `budget-backup-${dateStr}.zip` };
      });
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
