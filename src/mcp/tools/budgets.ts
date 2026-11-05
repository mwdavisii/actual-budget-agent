import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withActualWrite } from '../../actual/client';
import { setBudgetsByMode, BUDGET_MODES } from '../../actual/budgets';
import type { McpDeps } from '../tools';
import { jsonContent, errorContent } from './shared';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function registerSetBudgetTools(server: McpServer, _deps: McpDeps): void {
  server.registerTool(
    'set_budgets',
    {
      description:
        'Set budgeted amounts for a month using one of three modes: ' +
        '"copy_last_month" copies each category\'s budgeted amount from the previous calendar month, ' +
        '"three_month_average" uses the rounded average of the previous 3 calendar months, and ' +
        '"custom_amount" sets every selected category to amount (integer cents). ' +
        'By default every visible non-income category is updated; pass category to target exactly one ' +
        '(name or id), or includeIncome=true to include income categories. ' +
        'DRY-RUN IS THE DEFAULT: pass dryRun:false only after reviewing the projected old/new amounts. ' +
        'Returns the per-category projection. Amounts are in cents.',
      inputSchema: {
        month: z
          .string()
          .regex(MONTH_RE, 'month must be YYYY-MM')
          .optional(),
        mode: z.enum(BUDGET_MODES),
        category: z.string().optional(),
        amount: z.number().int().optional(),
        includeIncome: z.boolean().default(false),
        dryRun: z.boolean().default(true),
      },
    },
    async (args) => {
      try {
        const result = await withActualWrite(() =>
          setBudgetsByMode({
            month: args.month,
            mode: args.mode,
            category: args.category,
            amount: args.amount,
            includeIncome: args.includeIncome,
            dryRun: args.dryRun,
          })
        );
        return jsonContent(result);
      } catch (e) {
        return errorContent(e instanceof Error ? e.message : String(e));
      }
    }
  );
}
