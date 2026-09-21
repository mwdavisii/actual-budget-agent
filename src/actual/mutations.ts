import { actualApi } from './client';
import { getTransactionById, type Transaction } from './queries';
import { resolveCategory, resolvePayee } from './naming';

export interface WriteResult {
  txId: string;
  changed: boolean;
  tx: NonNullable<Awaited<ReturnType<typeof getTransactionById>>>;
}

export interface MergeResult {
  dryRun: boolean;
  target: { id: string; name: string };
  sources: Array<{ id: string; name: string; txCount: number }>;
  projectedTargetTxCount: number;
}

export interface BulkCategoryResult {
  dryRun: boolean;
  category: string | null;
  applied: number;
  results: Array<{
    txId: string;
    changed: boolean;
    before: string | null;
    after: string | null;
    error?: string;
  }>;
}

const ALLOWED_UPDATE_FIELDS = ['date', 'amount', 'notes', 'cleared'] as const;
const FORBIDDEN_UPDATE_FIELDS = ['transfer_id', 'payee', 'category'] as const;

export async function applyCategory(txId: string, category: string | null): Promise<WriteResult> {
  const current = await getTransactionById(txId);
  if (!current) {
    throw new Error(`Transaction ${txId} not found`);
  }

  const targetId = category === null ? null : (await resolveCategory(category)).id;
  if (current.category === targetId) {
    return { txId, changed: false, tx: current };
  }

  await actualApi.updateTransaction(txId, { category: targetId });
  const tx = (await getTransactionById(txId)) as Transaction;
  return { txId, changed: true, tx };
}

export async function setPayee(txId: string, payee: string): Promise<WriteResult> {
  const current = await getTransactionById(txId);
  if (!current) {
    throw new Error(`Transaction ${txId} not found`);
  }

  const targetId = (await resolvePayee(payee)).id;
  if (current.payee === targetId) {
    return { txId, changed: false, tx: current };
  }

  await actualApi.updateTransaction(txId, { payee: targetId });
  const tx = (await getTransactionById(txId)) as Transaction;
  return { txId, changed: true, tx };
}

export async function mergePayees(target: string, sources: string[], dryRun: boolean): Promise<MergeResult> {
  const targetPayee = await resolvePayee(target);
  if (targetPayee.transferAcct !== null) {
    throw new Error(`Payee "${targetPayee.name}" is a transfer payee and cannot be a merge target`);
  }

  const seen = new Set<string>();
  const resolvedSources: Array<{ id: string; name: string }> = [];
  for (const source of sources) {
    const resolved = await resolvePayee(source);
    if (resolved.transferAcct !== null) {
      throw new Error(`Payee "${resolved.name}" is a transfer payee and cannot be merged`);
    }
    if (resolved.id === targetPayee.id) {
      throw new Error('Target payee cannot also be a source');
    }
    if (seen.has(resolved.id)) {
      throw new Error(`Duplicate source payee: ${resolved.name}`);
    }
    seen.add(resolved.id);
    resolvedSources.push({ id: resolved.id, name: resolved.name });
  }

  const allInvolvedIds = [targetPayee.id, ...resolvedSources.map((s) => s.id)];
  const countResult = await actualApi.runQuery(
    actualApi
      .q('transactions')
      .filter({ payee: { $oneof: allInvolvedIds } })
      .groupBy('payee')
      .select(['payee', { count: { $count: '$id' } }])
  );
  const countRows = (countResult as { data: Array<{ payee: string; count: number }> }).data;
  const countMap = Object.fromEntries(countRows.map((r) => [r.payee, r.count]));

  const targetTxCount = countMap[targetPayee.id] ?? 0;
  const sourceRows = resolvedSources.map((s) => ({
    ...s,
    txCount: countMap[s.id] ?? 0,
  }));
  const projectedTargetTxCount = targetTxCount + sourceRows.reduce((sum, s) => sum + s.txCount, 0);

  if (dryRun) {
    return {
      dryRun: true,
      target: { id: targetPayee.id, name: targetPayee.name },
      sources: sourceRows,
      projectedTargetTxCount,
    };
  }

  await actualApi.mergePayees(
    targetPayee.id,
    resolvedSources.map((s) => s.id)
  );

  const payees = (await actualApi.getPayees()) as Array<{ id: string; name?: string }>;
  const refreshedTarget = payees.find((p) => p.id === targetPayee.id);
  return {
    dryRun: false,
    target: {
      id: targetPayee.id,
      name: refreshedTarget?.name ?? targetPayee.name,
    },
    sources: sourceRows,
    projectedTargetTxCount,
  };
}

export async function updateTransactionFields(
  txId: string,
  fields: Record<string, unknown>
): Promise<WriteResult> {
  const current = await getTransactionById(txId);
  if (!current) {
    throw new Error(`Transaction ${txId} not found`);
  }

  const forbidden = FORBIDDEN_UPDATE_FIELDS.filter((k) => k in fields);
  if (forbidden.length > 0) {
    throw new Error(
      `Updating ${forbidden.join(', ')} is not supported — use the dedicated tools`
    );
  }

  const unknown = Object.keys(fields).filter(
    (k) => !(ALLOWED_UPDATE_FIELDS as readonly string[]).includes(k)
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown field "${unknown[0]}" — allowed: ${ALLOWED_UPDATE_FIELDS.join(', ')}`
    );
  }

  const update = fields as { date?: string; amount?: number; notes?: string | null; cleared?: boolean };
  const changed =
    (update.date !== undefined && update.date !== current.date) ||
    (update.amount !== undefined && update.amount !== current.amount) ||
    (update.notes !== undefined && update.notes !== current.notes) ||
    (update.cleared !== undefined && update.cleared !== current.cleared);

  if (changed) {
    await actualApi.updateTransaction(txId, update);
  }
  const tx = (await getTransactionById(txId)) as Transaction;
  return { txId, changed, tx };
}

export async function applyCategoryBulk(
  txIds: string[],
  category: string | null,
  dryRun: boolean
): Promise<BulkCategoryResult> {
  const targetId = category === null ? null : (await resolveCategory(category)).id;
  const results: BulkCategoryResult['results'] = [];

  const run = async () => {
    for (const txId of txIds) {
      try {
        const current = await getTransactionById(txId);
        if (!current) {
          throw new Error(`Transaction ${txId} not found`);
        }
        const before = current.category;
        if (dryRun) {
          results.push({ txId, changed: before !== targetId, before, after: targetId });
          continue;
        }
        if (before !== targetId) {
          await actualApi.updateTransaction(txId, { category: targetId });
        }
        const after = (await getTransactionById(txId))!.category;
        results.push({ txId, changed: before !== after, before, after });
      } catch (err) {
        results.push({ txId, changed: false, before: null, after: null, error: String(err) });
      }
    }
  };

  if (dryRun) {
    await run();
  } else {
    await actualApi.batchBudgetUpdates(run);
  }

  return {
    dryRun,
    category,
    applied: results.filter((r) => r.changed && !r.error).length,
    results,
  };
}
