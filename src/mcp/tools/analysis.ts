import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withActualRead } from '../../actual/client';
import { getTransactionById } from '../../actual/queries';
import { getUnreconciled, findDuplicatePayees } from '../../actual/analysis';
import { jsonContent, errorContent } from './shared';
import type { McpDeps } from '../tools';

function mapReadError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not found/i.test(msg)) {
    return errorContent(msg);
  }
  return errorContent(`Actual Budget read failed: ${msg}`);
}

export function registerAnalysisTools(server: McpServer, _deps: McpDeps): void {
  server.registerTool(
    'get_transaction',
    {
      description:
        'Read a single transaction by id. Returns the full row including imported_payee, transfer_id, reconciled, and categoryName.',
      inputSchema: {
        txId: z.string(),
      },
    },
    async (args) => {
      try {
        const tx = await withActualRead(() => getTransactionById(args.txId));
        if (tx == null) {
          return errorContent(`Transaction ${args.txId} not found`);
        }
        return jsonContent(tx);
      } catch (err) {
        return mapReadError(err);
      }
    }
  );

  server.registerTool(
    'get_unreconciled',
    {
      description:
        'Return an unreconciled view for an account: last reconciled date, current/cleared balances, uncleared transactions with running balances, and the unreconciled count.',
      inputSchema: {
        accountId: z.string(),
      },
    },
    async (args) => {
      try {
        const result = await withActualRead(() => getUnreconciled(args.accountId));
        return jsonContent(result);
      } catch (err) {
        return mapReadError(err);
      }
    }
  );

  server.registerTool(
    'find_duplicate_payees',
    {
      description:
        'Scan all non-transfer payees and report groups whose normalized names match, suggesting a canonical payee and listing duplicates with transaction counts and date ranges.',
      inputSchema: {},
    },
    async () => {
      try {
        const report = await withActualRead(() => findDuplicatePayees());
        return jsonContent(report);
      } catch (err) {
        return mapReadError(err);
      }
    }
  );
}
