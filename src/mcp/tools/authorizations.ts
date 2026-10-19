import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withActualRead, withActualWrite } from '../../actual/client';
import {
  findSupersededAuthorizations,
  resolveSupersededAuthorization,
  AuthorizationResolveError,
} from '../../actual/authorizations';
import type { McpDeps } from '../tools';
import { jsonContent, errorContent } from './shared';

export function registerAuthorizationTools(server: McpServer, _deps: McpDeps): void {
  server.registerTool(
    'find_superseded_authorizations',
    {
      description:
        'Find uncleared bill-only transactions (card pre-authorizations, e.g. a restaurant bill before the tip) ' +
        'that were superseded by a later cleared transaction for the same payee and account with a larger amount (bill + tip). ' +
        'Matches when the final amount is larger than the pending one by at most maxTipPercent (default 50) and the dates are within daysWindow (default 7). ' +
        'Each pair has confidence "unique" or "ambiguous" (a row has several possible counterparts), tipAmount (cents), tipPercent, and a carryOver preview. ' +
        'Read-only. If sinceDate is given, both rows must be on or after it. ' +
        'Show pairs to the user and resolve only after they confirm; never resolve ambiguous pairs without the user choosing one.',
      inputSchema: {
        accountId: z.string().optional(),
        daysWindow: z.number().int().min(0).max(30).optional(),
        maxTipPercent: z.number().min(0).max(500).optional(),
        sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'sinceDate must be YYYY-MM-DD').optional(),
      },
    },
    async (args) => {
      try {
        const pairs = await withActualRead(() => findSupersededAuthorizations(args));
        return jsonContent(pairs);
      } catch (e) {
        return errorContent(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.registerTool(
    'resolve_superseded_authorization',
    {
      description:
        'Fold an uncleared bill-only transaction into its cleared final transaction: the final row keeps its values, ' +
        'gains the pending row\'s category if it has none and its notes (merged as "<final> | <pending>" when both differ), ' +
        'then the pending row is DELETED (permanent). ' +
        'Requires same account and payee, negative amounts, final larger than pending, pending uncleared and not reconciled, final cleared, ' +
        'neither row linked to a transfer or part of a split. ' +
        'DRY-RUN IS THE DEFAULT: pass dryRun:false only after the user confirmed the projection. ' +
        'The response has verified:true when a re-read confirmed the pending row is gone and the final row has the expected values; ' +
        'if verified is false, re-check with get_transaction before reporting success.',
      inputSchema: {
        pendingTxId: z.string(),
        finalTxId: z.string(),
        dryRun: z.boolean().default(true),
      },
    },
    async (args) => {
      try {
        const result = await withActualWrite(() =>
          resolveSupersededAuthorization(args.pendingTxId, args.finalTxId, args.dryRun)
        );
        return jsonContent(result);
      } catch (e) {
        if (e instanceof AuthorizationResolveError) {
          return errorContent(e.message);
        }
        const msg = e instanceof Error ? e.message : String(e);
        return errorContent(`Actual Budget write failed: ${msg}`);
      }
    }
  );
}
