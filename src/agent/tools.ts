import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import { withActual } from '../actual/client';
import {
  getUncategorizedTransactions,
  getTransactions,
  getBudgetStatus,
  getScheduledTransactions,
} from '../actual/queries';
import { getPendingProposals } from '../db/proposals';
import { getTargets, setTarget, seedTargets, getUnderfundedCategories } from '../db/targets';
import type Database from 'better-sqlite3';

export interface ActualConfig {
  dataDir: string;
  budgetId: string;
  serverUrl: string;
  password: string;
}

export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'getUncategorizedTransactions',
    description: 'Fetch all transactions missing a budget category.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'getTransactions',
    description: 'Query transactions with optional filters. Amounts are in cents.',
    input_schema: {
      type: 'object' as const,
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
    input_schema: {
      type: 'object' as const,
      properties: { month: { type: 'string', description: 'YYYY-MM (defaults to current month)' } },
      required: [],
    },
  },
  {
    name: 'getScheduledTransactions',
    description: 'Get upcoming scheduled transactions and their funded status.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'getPendingProposals',
    description: 'List all pending categorization proposals and their expiry times.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'proposeCategory',
    description: 'Propose a category for a transaction. Posts a Discord approval message. Do NOT call applyCategory directly.',
    input_schema: {
      type: 'object' as const,
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
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'setBudgetTarget',
    description: 'Set a budget target amount for a category. Set to 0 to remove.',
    input_schema: {
      type: 'object' as const,
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
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'getUnderfundedCategories',
    description: 'Compare current budgeted amounts against stored targets. Returns categories where budgeted &lt; target with the gap.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
];

export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  actualConfig: ActualConfig,
  db: Database.Database,
  proposeCategoryFn: (txId: string, category: string, reason: string, account?: string, payee?: string, amount?: number) => Promise<string>
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

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
