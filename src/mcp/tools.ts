import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { withActualRead } from '../actual/client';
import { getUncategorizedTransactions } from '../actual/queries';

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
}
