import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withActualRead, withActualWrite } from '../../actual/client';
import {
  listRules,
  createRule,
  updateRule,
  deleteRule,
  explainTransaction,
  runRules,
  humanizeRule,
  buildRefs,
  type RuleEntity,
} from '../../actual/rules';
import type { McpDeps } from '../tools';
import { jsonContent, errorContent } from './shared';

function mapRuleError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not found/i.test(msg)) {
    return errorContent(msg);
  }
  return errorContent(`Actual Budget write failed: ${msg}`);
}

const ruleSchema = z.object({
  stage: z.enum(['pre', 'post']).nullable(),
  conditionsOp: z.enum(['and', 'or']),
  conditions: z.array(
    z.object({
      field: z.string(),
      op: z.string(),
      value: z.unknown(),
      options: z.record(z.string(), z.unknown()).optional(),
    })
  ),
  actions: z.array(
    z.object({
      op: z.enum(['set', 'prepend-notes', 'append-notes']),
      field: z.string().optional(),
      value: z.unknown(),
    })
  ),
});

export function registerRulesTools(server: McpServer, _deps: McpDeps): void {
  server.registerTool(
    'list_rules',
    {
      description: 'List all native Actual Budget rules with their raw conditions, actions, and a human-readable summary.',
      inputSchema: {},
    },
    async () => {
      try {
        const rules = await withActualRead(() => listRules());
        const refs = await buildRefs();
        const result = rules.map((rule) => ({
          ...rule,
          text: humanizeRule(rule, refs),
        }));
        return jsonContent(result);
      } catch (e) {
        return mapRuleError(e);
      }
    }
  );

  server.registerTool(
    'create_rule',
    {
      description: 'Create a new native Actual Budget rule. Writes to Actual Budget.',
      inputSchema: { rule: ruleSchema },
    },
    async (args) => {
      try {
        const { id } = await withActualWrite(() => createRule(args.rule));
        const refs = await buildRefs();
        const text = humanizeRule({ id, ...args.rule } as RuleEntity, refs);
        return jsonContent({ success: true, ruleId: id, text });
      } catch (e) {
        return mapRuleError(e);
      }
    }
  );

  server.registerTool(
    'update_rule',
    {
      description: 'Replace an existing native Actual Budget rule by id. Writes to Actual Budget.',
      inputSchema: { ruleId: z.string(), rule: ruleSchema },
    },
    async (args) => {
      try {
        const { id } = await withActualWrite(() => updateRule(args.ruleId, args.rule));
        const refs = await buildRefs();
        const text = humanizeRule({ id, ...args.rule } as RuleEntity, refs);
        return jsonContent({ success: true, ruleId: id, text });
      } catch (e) {
        return mapRuleError(e);
      }
    }
  );

  server.registerTool(
    'delete_rule',
    {
      description: 'Delete a single native Actual Budget rule by id. Writes to Actual Budget.',
      inputSchema: { ruleId: z.string() },
    },
    async (args) => {
      try {
        const deleted = await withActualWrite(() => deleteRule(args.ruleId));
        return jsonContent({ success: deleted, deleted });
      } catch (e) {
        return mapRuleError(e);
      }
    }
  );

  server.registerTool(
    'explain_transaction',
    {
      description:
        'Explain which native rules would fire on a single transaction and what the resulting category, payee, cleared flag, and notes would be. Read-only.',
      inputSchema: { txId: z.string() },
    },
    async (args) => {
      try {
        const result = await withActualRead(() => explainTransaction(args.txId));
        return jsonContent(result);
      } catch (e) {
        return mapRuleError(e);
      }
    }
  );

  server.registerTool(
    'run_rules',
    {
      description:
        'Re-apply native rules over an explicit scope of transactions. ' +
        'Always run with dryRun=true first, review the projection, then re-invoke with dryRun=false. ' +
        'The scope must be explicit: txIds, accountId, categoryId, or all:true.',
      inputSchema: {
        scope: z
          .object({
            txIds: z.array(z.string()).optional(),
            accountId: z.string().optional(),
            categoryId: z.string().optional(),
            all: z.boolean().optional(),
          })
          .strict(),
        dryRun: z.boolean().default(true),
      },
    },
    async (args) => {
      try {
        const result = await withActualWrite(() => runRules(args.scope, args.dryRun));
        return jsonContent(result);
      } catch (e) {
        return mapRuleError(e);
      }
    }
  );
}
