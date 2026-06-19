import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { withActualRead, withActualWrite } from '../actual/client';
import {
  getUncategorizedTransactions,
  getTransactions,
  getBudgetStatus,
  getCategories,
  getScheduledTransactions,
  setCategoryForTransaction,
} from '../actual/queries';
import { getTargetsWithLive, getUnderfundedCategories } from '../db/targets';

export interface McpDeps {
  db: Database.Database;
}

function jsonContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function errorContent(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
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
      description: 'Query transactions with optional filters. Amounts are in cents. Dates are YYYY-MM-DD.',
      inputSchema: {
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        accountId: z.string().optional(),
        categoryId: z.string().optional(),
        amountMin: z.number().optional(),
        amountMax: z.number().optional(),
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
      description: 'Assign a category to a transaction by id. Use a category name from list_categories. Writes to Actual Budget.',
      inputSchema: {
        txId: z.string(),
        category: z.string(),
      },
    },
    async (args) => {
      try {
        await withActualWrite(() => setCategoryForTransaction(args.txId, args.category));
      } catch (e) {
        // Same not-found definition as the REST apply-category route. Give the
        // agent an actionable hint for the correctable case; mark the rest as a
        // write failure it should not blindly retry with the same inputs.
        const msg = e instanceof Error ? e.message : String(e);
        if (/category .* not found/i.test(msg)) {
          return errorContent(`${msg} — call list_categories to see valid category names.`);
        }
        return errorContent(`Actual Budget write failed: ${msg}`);
      }
      return jsonContent({ success: true, txId: args.txId, category: args.category });
    }
  );
}
