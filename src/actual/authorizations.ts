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
