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
