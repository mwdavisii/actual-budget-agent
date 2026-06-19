import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { withActualRead } from '../actual/client';
import {
  getUncategorizedTransactions,
  getTransactions,
  getBudgetStatus,
  getCategories,
  getScheduledTransactions,
} from '../actual/queries';

export interface McpDeps {
  db: Database.Database;
}

function jsonContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function registerBudgetTools(server: McpServer, _deps: McpDeps): void {
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
}
