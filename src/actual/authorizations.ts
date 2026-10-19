import { actualApi } from './client';
import { sanitize } from '../sanitize';

export class AuthorizationResolveError extends Error {}

export interface AuthTx {
  id: string;
  date: string;
  amount: number;
  account: string;
  accountName: string;
  payee: string | null;
  payeeName: string;
  category: string | null;
  categoryName: string | null;
  cleared: boolean;
  reconciled: boolean;
  notes: string | null;
}

export interface AuthorizationPair {
  pending: AuthTx;
  final: AuthTx;
  tipAmount: number;
  tipPercent: number;
  daysApart: number;
  confidence: 'unique' | 'ambiguous';
  carryOver: { category: string | null; notes: string | null };
}

const DAY_MS = 86_400_000;

function daysBetween(d1: string, d2: string): number {
  return Math.abs(Date.parse(`${d1}T00:00:00Z`) - Date.parse(`${d2}T00:00:00Z`)) / DAY_MS;
}

/** What the surviving (final) row ends up with. Mirrors Actual's merge rule: keep the survivor's value unless empty. */
export function computeCarryOver(
  pending: Pick<AuthTx, 'category' | 'notes'>,
  final: Pick<AuthTx, 'category' | 'notes'>
): { category: string | null; notes: string | null; categoryChanged: boolean; notesChanged: boolean } {
  const category = final.category ?? pending.category;
  const f = final.notes?.trim() || null;
  const p = pending.notes?.trim() || null;
  let notes: string | null;
  if (!p || p === f) notes = final.notes; // unchanged, even if only whitespace differs
  else if (!f) notes = pending.notes;
  else notes = `${f} | ${p}`;
  return {
    category,
    notes,
    categoryChanged: category !== final.category,
    notesChanged: notes !== final.notes,
  };
}

export function matchAuthorizations(
  rows: AuthTx[],
  opts: { daysWindow: number; maxTipPercent: number }
): AuthorizationPair[] {
  const pendings = rows.filter((r) => !r.cleared && !r.reconciled && r.amount < 0 && r.payee != null);
  const finals = rows.filter((r) => r.cleared && r.amount < 0 && r.payee != null);

  const raw: Array<{ pending: AuthTx; final: AuthTx; daysApart: number }> = [];
  for (const p of pendings) {
    for (const f of finals) {
      if (p.account !== f.account || p.payee !== f.payee) continue;
      const pAbs = Math.abs(p.amount);
      const fAbs = Math.abs(f.amount);
      if (fAbs <= pAbs) continue;
      if (fAbs * 100 > pAbs * (100 + opts.maxTipPercent)) continue;
      const daysApart = daysBetween(p.date, f.date);
      if (daysApart > opts.daysWindow) continue;
      raw.push({ pending: p, final: f, daysApart });
    }
  }

  const pendingUses = new Map<string, number>();
  const finalUses = new Map<string, number>();
  for (const m of raw) {
    pendingUses.set(m.pending.id, (pendingUses.get(m.pending.id) ?? 0) + 1);
    finalUses.set(m.final.id, (finalUses.get(m.final.id) ?? 0) + 1);
  }

  return raw
    .map((m) => {
      const tipAmount = Math.abs(m.final.amount) - Math.abs(m.pending.amount);
      const carry = computeCarryOver(m.pending, m.final);
      return {
        ...m,
        tipAmount,
        tipPercent: Math.round((tipAmount / Math.abs(m.pending.amount)) * 1000) / 10,
        confidence: (pendingUses.get(m.pending.id) === 1 && finalUses.get(m.final.id) === 1
          ? 'unique'
          : 'ambiguous') as 'unique' | 'ambiguous',
        carryOver: { category: carry.category, notes: carry.notes },
      };
    })
    .sort(
      (a, b) =>
        a.daysApart - b.daysApart ||
        a.pending.date.localeCompare(b.pending.date) ||
        a.pending.id.localeCompare(b.pending.id)
    );
}

export async function findSupersededAuthorizations(opts: {
  accountId?: string;
  sinceDate?: string;
  daysWindow?: number;
  maxTipPercent?: number;
}): Promise<AuthorizationPair[]> {
  const daysWindow = opts.daysWindow ?? 7;
  const maxTipPercent = opts.maxTipPercent ?? 50;

  const accounts = (await actualApi.getAccounts()) as Array<{ id: string; name?: string }>;
  const accountMap = Object.fromEntries(accounts.map((a) => [a.id, a.name ?? '']));
  const payees = (await actualApi.getPayees()) as Array<{
    id: string;
    name?: string;
    transfer_acct?: string | null;
  }>;
  const payeeMap = Object.fromEntries(payees.map((p) => [p.id, p.name ?? '']));
  const transferPayeeIds = new Set(payees.filter((p) => p.transfer_acct != null).map((p) => p.id));
  const categories = (await actualApi.getCategories()) as Array<{ id: string; name?: string }>;
  const categoryMap = Object.fromEntries(categories.map((c) => [c.id, c.name ?? '']));

  let query = actualApi.q('transactions').filter({ transfer_id: null, is_parent: false, is_child: false });
  if (opts.sinceDate) query = query.filter({ date: { $gte: opts.sinceDate } });
  query = query.select(['id', 'date', 'amount', 'account', 'payee', 'category', 'notes', 'cleared', 'reconciled']);
  const result = await actualApi.runQuery(query);

  const rows: AuthTx[] = (result as { data: Record<string, unknown>[] }).data
    .filter((r) => !transferPayeeIds.has(String(r.payee)))
    .map((r) => toAuthTx(r, accountMap, payeeMap, categoryMap));

  const pairs = matchAuthorizations(rows, { daysWindow, maxTipPercent });
  const scoped = opts.accountId ? pairs.filter((p) => p.pending.account === opts.accountId) : pairs;
  return scoped.map((p) => ({
    ...p,
    pending: outputTx(p.pending),
    final: outputTx(p.final),
    carryOver: {
      category: p.carryOver.category,
      notes: p.carryOver.notes == null ? null : sanitize(p.carryOver.notes),
    },
  }));
}

function toAuthTx(
  r: Record<string, unknown>,
  accountMap: Record<string, string>,
  payeeMap: Record<string, string>,
  categoryMap: Record<string, string>
): AuthTx {
  const category = r.category == null ? null : String(r.category);
  return {
    id: String(r.id),
    date: String(r.date),
    amount: Number(r.amount),
    account: String(r.account),
    accountName: accountMap[String(r.account)] ?? '',
    payee: r.payee == null ? null : String(r.payee),
    payeeName: payeeMap[String(r.payee)] ?? '',
    category,
    categoryName: category == null ? null : (categoryMap[category] ?? null),
    cleared: Boolean(r.cleared),
    reconciled: Boolean(r.reconciled),
    notes: r.notes == null ? null : String(r.notes),
  };
}

// Names and notes are written to Actual unmodified; sanitize only what is returned to the model.
function outputTx(t: AuthTx): AuthTx {
  return {
    ...t,
    accountName: sanitize(t.accountName),
    payeeName: sanitize(t.payeeName),
    categoryName: t.categoryName == null ? null : sanitize(t.categoryName),
    notes: t.notes == null ? null : sanitize(t.notes),
  };
}

interface RawAuthTx {
  id: string;
  date: string;
  amount: number;
  account: string;
  payee: string | null;
  category: string | null;
  notes: string | null;
  cleared: boolean;
  reconciled: boolean;
  transferId: string | null;
  isParent: boolean;
  isChild: boolean;
}

type OutRaw = Omit<RawAuthTx, 'transferId' | 'isParent' | 'isChild'>;

export interface ResolveAuthorizationResult {
  dryRun: boolean;
  /** True when a re-read confirmed the pending row is gone and the final row has the expected values; false for dry-runs or if not visible in time. */
  verified: boolean;
  deletedId: string | null;
  carriedOver: { category: boolean; notes: boolean };
  before: { pending: OutRaw; final: OutRaw };
  after: { final: OutRaw };
}

async function getRawTx(id: string): Promise<RawAuthTx | null> {
  const result = await actualApi.runQuery(
    actualApi
      .q('transactions')
      .filter({ id })
      .options({ splits: 'all' }) // default 'inline' hides split parents, which we want to reject explicitly
      .select(['id', 'date', 'amount', 'account', 'payee', 'category', 'notes', 'cleared', 'reconciled', 'transfer_id', 'is_parent', 'is_child'])
  );
  const row = (result as { data: Record<string, unknown>[] }).data[0];
  if (!row) return null;
  return {
    id: String(row.id),
    date: String(row.date),
    amount: Number(row.amount),
    account: String(row.account),
    payee: row.payee == null ? null : String(row.payee),
    category: row.category == null ? null : String(row.category),
    notes: row.notes == null ? null : String(row.notes),
    cleared: Boolean(row.cleared),
    reconciled: Boolean(row.reconciled),
    transferId: row.transfer_id == null ? null : String(row.transfer_id),
    isParent: Boolean(row.is_parent),
    isChild: Boolean(row.is_child),
  };
}

function forOutput(t: RawAuthTx): OutRaw {
  const { transferId: _t, isParent: _p, isChild: _c, ...rest } = t;
  return { ...rest, notes: rest.notes == null ? null : sanitize(rest.notes) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Actual applies writes a few ms after the call returns, so poll until they are visible.
async function readResolved(
  pendingId: string,
  finalId: string,
  expected: { category: string | null; notes: string | null },
  settle: { attempts: number; delayMs: number }
): Promise<RawAuthTx | null> {
  for (let i = 0; i < settle.attempts; i++) {
    const [p, f] = [await getRawTx(pendingId), await getRawTx(finalId)];
    if (!p && f && f.category === expected.category && f.notes === expected.notes) return f;
    await sleep(settle.delayMs);
  }
  return null;
}

export async function resolveSupersededAuthorization(
  pendingTxId: string,
  finalTxId: string,
  dryRun: boolean,
  options: { settle?: { attempts: number; delayMs: number } } = {}
): Promise<ResolveAuthorizationResult> {
  const settle = options.settle ?? { attempts: 20, delayMs: 50 };
  if (pendingTxId === finalTxId) {
    throw new AuthorizationResolveError('Cannot resolve a transaction against itself');
  }
  const pending = await getRawTx(pendingTxId);
  if (!pending) throw new AuthorizationResolveError(`Transaction ${pendingTxId} not found`);
  const final = await getRawTx(finalTxId);
  if (!final) throw new AuthorizationResolveError(`Transaction ${finalTxId} not found`);

  for (const t of [pending, final]) {
    if (t.transferId) throw new AuthorizationResolveError(`Transaction ${t.id} is linked to a transfer`);
    if (t.isParent) throw new AuthorizationResolveError(`Transaction ${t.id} is a split parent and cannot be resolved`);
    if (t.isChild) throw new AuthorizationResolveError(`Transaction ${t.id} is a split child and cannot be resolved`);
  }
  if (pending.account !== final.account) {
    throw new AuthorizationResolveError('Transactions must be in the same account');
  }
  if (pending.payee !== final.payee) {
    throw new AuthorizationResolveError('Transactions must have the same payee');
  }
  if (pending.amount >= 0 || final.amount >= 0) {
    throw new AuthorizationResolveError('Both amounts must be negative (expenses)');
  }
  if (Math.abs(final.amount) <= Math.abs(pending.amount)) {
    throw new AuthorizationResolveError(
      `The final amount must be larger than the pending amount (got ${final.amount} and ${pending.amount})`
    );
  }
  if (pending.cleared) {
    throw new AuthorizationResolveError(`Pending transaction ${pending.id} must be uncleared`);
  }
  if (!final.cleared) {
    throw new AuthorizationResolveError(`Final transaction ${final.id} must be cleared`);
  }
  if (pending.reconciled) {
    throw new AuthorizationResolveError(`Pending transaction ${pending.id} is reconciled and cannot be deleted`);
  }

  const carry = computeCarryOver(pending, final);
  const projectedFinal: RawAuthTx = { ...final, category: carry.category, notes: carry.notes };
  const carriedOver = { category: carry.categoryChanged, notes: carry.notesChanged };
  const before = { pending: forOutput(pending), final: forOutput(final) };

  if (dryRun) {
    return {
      dryRun: true,
      verified: false,
      deletedId: null,
      carriedOver,
      before,
      after: { final: forOutput(projectedFinal) },
    };
  }

  const update: { category?: string | null; notes?: string | null } = {};
  if (carry.categoryChanged) update.category = carry.category;
  if (carry.notesChanged) update.notes = carry.notes;
  // Update first: if this fails nothing has been deleted.
  if (Object.keys(update).length > 0) {
    await actualApi.updateTransaction(final.id, update);
  }

  try {
    await actualApi.deleteTransaction(pending.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AuthorizationResolveError(
      `The final transaction ${final.id} was updated, but deleting the pending transaction failed (${msg}). ` +
        `The pending transaction ${pending.id} still exists; delete it with delete_transaction.`
    );
  }

  const settled = await readResolved(pending.id, final.id, carry, settle);
  return {
    dryRun: false,
    verified: settled !== null,
    deletedId: pending.id,
    carriedOver,
    before,
    after: { final: forOutput(settled ?? projectedFinal) },
  };
}
