import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withActualRead, withActualWrite } from '../../actual/client';
import {
  applyCategoryBulk,
  setPayee,
  mergePayees,
  updateTransactionFields,
} from '../../actual/mutations';
import { getPayeesWithCounts } from '../../actual/queries';
import type { McpDeps } from '../tools';
import { jsonContent, errorContent } from './shared';

function mapWriteError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not found/i.test(msg)) {
    return errorContent(msg);
  }
  return errorContent(`Actual Budget write failed: ${msg}`);
}

export function registerWriteTools(server: McpServer, _deps: McpDeps): void {
  server.registerTool(
    'apply_category_bulk',
    {
      description:
        'Assign a category to multiple transactions by explicit id list. Pass null to clear the category. ' +
        'dryRun=true returns a projection without writing. Rows are applied one-by-one (not atomic); ' +
        'the response reports which rows changed and any per-row errors.',
      inputSchema: {
        txIds: z.array(z.string()).min(1),
        category: z.string().nullable(),
        dryRun: z.boolean().default(false),
      },
    },
    async (args) => {
      try {
        const result = await withActualWrite(() =>
          applyCategoryBulk(args.txIds, args.category, args.dryRun)
        );
        return jsonContent(result);
      } catch (e) {
        return mapWriteError(e);
      }
    }
  );

  server.registerTool(
    'set_payee',
    {
      description:
        'Set the payee on a transaction by id. The payee name must already exist; unknown names are rejected with suggestions.',
      inputSchema: {
        txId: z.string(),
        payee: z.string(),
      },
    },
    async (args) => {
      try {
        const { changed, tx } = await withActualWrite(() => setPayee(args.txId, args.payee));
        return jsonContent({ success: true, changed, tx });
      } catch (e) {
        return mapWriteError(e);
      }
    }
  );

  server.registerTool(
    'list_payees',
    {
      description:
        'List all payees with their transaction counts. Transfer payees are flagged with isTransfer and are excluded from merge targets.',
      inputSchema: {},
    },
    async () => {
      const rows = await withActualRead(() => getPayeesWithCounts());
      return jsonContent(rows);
    }
  );

  server.registerTool(
    'merge_payees',
    {
      description:
        'Merge source payees into a target payee. DRY-RUN IS THE DEFAULT: this tool deletes source payees, ' +
        'so pass dryRun:false only after reviewing the projection. Transfer payees are refused. ' +
        'Per-source transaction counts are included in the response.',
      inputSchema: {
        targetPayee: z.string(),
        sourcePayees: z.array(z.string()).min(1),
        dryRun: z.boolean().default(true),
      },
    },
    async (args) => {
      try {
        const result = await withActualWrite(() =>
          mergePayees(args.targetPayee, args.sourcePayees, args.dryRun)
        );
        return jsonContent(result);
      } catch (e) {
        return mapWriteError(e);
      }
    }
  );

  server.registerTool(
    'update_transaction',
    {
      description:
        'Update one or more allowed fields on a transaction by id. Allowed fields: date, amount (cents), notes, cleared. ' +
        'Updating payee, category, or transfer_id is not supported — use the dedicated tools.',
      inputSchema: {
        txId: z.string(),
        fields: z.object({
          date: z.string().optional(),
          amount: z.number().int().optional(),
          notes: z.string().nullable().optional(),
          cleared: z.boolean().optional(),
        }),
      },
    },
    async (args) => {
      try {
        const { changed, tx } = await withActualWrite(() =>
          updateTransactionFields(args.txId, args.fields)
        );
        return jsonContent({ success: true, changed, tx });
      } catch (e) {
        return mapWriteError(e);
      }
    }
  );
}
