import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { withActualRead, withActualWrite } from '../actual/client';
import { applyCategory } from '../actual/mutations';
import {
  getUncategorizedTransactions,
  getTransactions,
  getAccounts,
  getBudgetStatus,
  getCategories,
  getScheduledTransactions,
  setCategoryForTransaction,
} from '../actual/queries';
import { getTargetsWithLive, getUnderfundedCategories } from '../db/targets';
import { registerWriteTools } from './tools/writes';
import { registerRulesTools } from './tools/rules';
import { registerAnalysisTools } from './tools/analysis';
import { jsonContent, errorContent } from './tools/shared';

export interface McpDeps {
  db: Database.Database;
}

export function registerBudgetTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'list_uncategorized_transactions',
    {
      description: 'List all on-budget transactions that are missing a category. Returns an array of transactions.',
      inputSchema: {},
    },
    async () => {
      const txs = await withActualRead(getUncategorizedTransactions);
      return jsonContent(txs);
    }
  );

  server.registerTool(
    'query_transactions',
    {
      description:
        'Query transactions with optional filters. Amounts are in cents. Dates are YYYY-MM-DD. ' +
        'Filter by payee id (payeeId), payee name substring (payeeContains), or notes substring (notesContains). ' +
        'Use limit/offset/orderBy for pagination. Request specific output fields via fields[]. ' +
        'Pass summary=payee or summary=category for grouped counts instead of rows. ' +
        'Pass cleared=false to list only uncleared transactions.',
      inputSchema: {
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        accountId: z.string().optional(),
        categoryId: z.string().optional(),
        payeeId: z.string().optional(),
        payeeContains: z.string().optional(),
        notesContains: z.string().optional(),
        amountMin: z.number().optional(),
        amountMax: z.number().optional(),
        cleared: z.boolean().optional(),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
        orderBy: z.object({ field: z.enum(['date', 'amount', 'id']), direction: z.enum(['asc', 'desc']) }).optional(),
        fields: z.array(z.string()).optional(),
        summary: z.enum(['payee', 'category']).optional(),
      },
    },
    async (args) => {
      const txs = await withActualRead(() => getTransactions(args));
      return jsonContent(txs);
    }
  );

  server.registerTool(
    'get_budget_status',
    {
      description: 'Get budgeted/spent/available per category for a month (YYYY-MM, defaults to current). Amounts in cents.',
      inputSchema: { month: z.string().optional() },
    },
    async (args) => {
      const status = await withActualRead(() => getBudgetStatus(args.month));
      return jsonContent(status);
    }
  );

  server.registerTool(
    'list_categories',
    {
      description: 'List all non-hidden budget category groups and their categories. Call this before applying categories.',
      inputSchema: {},
    },
    async () => {
      const categories = await withActualRead(getCategories);
      return jsonContent(categories);
    }
  );

  server.registerTool(
    'get_accounts',
    {
      description: 'List all accounts with their current balances. Amounts in cents. Includes closed and off-budget accounts (flagged).',
      inputSchema: {},
    },
    async () => {
      const accounts = await withActualRead(getAccounts);
      return jsonContent(accounts);
    }
  );

  server.registerTool(
    'get_schedules',
    {
      description: 'List upcoming scheduled transactions and their next due dates.',
      inputSchema: {},
    },
    async () => {
      const schedules = await withActualRead(getScheduledTransactions);
      return jsonContent(schedules);
    }
  );

  server.registerTool(
    'get_targets',
    {
      description: 'List stored budget targets merged with current budgeted amounts and the gap (target - budgeted). Amounts in cents.',
      inputSchema: {},
    },
    async () => {
      const live = await withActualRead(() => getBudgetStatus());
      return jsonContent(getTargetsWithLive(deps.db, live));
    }
  );

  server.registerTool(
    'get_underfunded',
    {
      description: 'List categories whose current budgeted amount is below their stored target, with the gap. Amounts in cents.',
      inputSchema: {},
    },
    async () => {
      const live = await withActualRead(() => getBudgetStatus());
      return jsonContent(getUnderfundedCategories(deps.db, live));
    }
  );

  server.registerTool(
    'apply_category',
    {
      description:
        'Assign a category to a transaction by id, or pass category=null to clear it. ' +
        'Use a category name from list_categories. Writes to Actual Budget.',
      inputSchema: {
        txId: z.string(),
        category: z.string().nullable(),
      },
    },
    async (args) => {
      try {
        const result = await withActualWrite(() => applyCategory(args.txId, args.category));
        return jsonContent({ success: true, changed: result.changed, tx: result.tx });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not found|cannot be empty|not supported/i.test(msg)) {
          return errorContent(msg);
        }
        return errorContent(`Actual Budget write failed: ${msg}`);
      }
    }
  );

  registerWriteTools(server, deps);
  registerRulesTools(server, deps);
  registerAnalysisTools(server, deps);
}
