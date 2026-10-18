import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withActualRead, withActualWrite } from '../../actual/client';
import { findTransferCandidates, linkTransfer, TransferLinkError } from '../../actual/transfers';
import type { McpDeps } from '../tools';
import { jsonContent, errorContent } from './shared';

export function registerTransferTools(server: McpServer, _deps: McpDeps): void {
  server.registerTool(
    'find_transfer_candidates',
    {
      description:
        'Find pairs of unlinked transactions that look like one transfer imported as two separate rows: ' +
        'exactly opposite amounts, different accounts, dates within daysWindow (default 3). ' +
        'Each pair has confidence "unique" (neither row matches anything else) or "ambiguous" (a row has several possible counterparts). ' +
        'Read-only. If sinceDate is given, both rows must be on or after it. Amounts are cents. ' +
        'Show pairs to the user and link only after they confirm; never link ambiguous pairs without the user choosing one.',
      inputSchema: {
        accountId: z.string().optional(),
        daysWindow: z.number().int().min(0).max(30).optional(),
        sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'sinceDate must be YYYY-MM-DD').optional(),
      },
    },
    async (args) => {
      try {
        const pairs = await withActualRead(() => findTransferCandidates(args));
        return jsonContent(pairs);
      } catch (e) {
        return errorContent(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.registerTool(
    'link_transfer',
    {
      description:
        'Link two existing transactions as the two sides of one transfer, without creating or deleting any transaction. ' +
        'Both rows get the other account\'s transfer payee, are cross-linked, and are marked cleared if either was. ' +
        'Actual shares one notes value across linked rows, so differing notes are merged as "<A> | <B>". ' +
        'Actual also clears the category on both rows for same-type (on/off budget) transfers. ' +
        'Requires exactly opposite non-zero amounts in different accounts; refuses rows that are already linked, split parents, or split children. ' +
        'A dry-run reports reconciledRows (ids of reconciled rows among the two); if it is non-empty, ask the user before calling with dryRun:false and allowReconciled:true ' +
        '(as Actual\'s UI asks for confirmation). A real run with reconciled rows is refused without allowReconciled:true. ' +
        'DRY-RUN IS THE DEFAULT: pass dryRun:false only after the user confirmed the projection. ' +
        'The response has verified:true when a re-read confirmed the link; if verified is false, re-check with get_transaction before reporting success. ' +
        'To undo a link later, note that deleting either side deletes both.',
      inputSchema: {
        txIdA: z.string(),
        txIdB: z.string(),
        dryRun: z.boolean().default(true),
        allowReconciled: z.boolean().default(false),
      },
    },
    async (args) => {
      try {
        const result = await withActualWrite(() => linkTransfer(args.txIdA, args.txIdB, args.dryRun, {
          allowReconciled: args.allowReconciled,
        }));
        return jsonContent(result);
      } catch (e) {
        if (e instanceof TransferLinkError) {
          return errorContent(e.message);
        }
        const msg = e instanceof Error ? e.message : String(e);
        return errorContent(`Actual Budget write failed: ${msg}`);
      }
    }
  );
}
