import { actualApi } from './client';
import { sanitize } from '../sanitize';

export class TransferLinkError extends Error {}

export interface TransferTx {
  id: string;
  date: string;
  amount: number;
  account: string;
  accountName: string;
  payee: string | null;
  payeeName: string;
  cleared: boolean;
  notes: string | null;
}

export interface TransferPair {
  a: TransferTx;
  b: TransferTx;
  daysApart: number;
  confidence: 'unique' | 'ambiguous';
}

const DAY_MS = 86_400_000;

function daysBetween(d1: string, d2: string): number {
  return Math.abs(Date.parse(`${d1}T00:00:00Z`) - Date.parse(`${d2}T00:00:00Z`)) / DAY_MS;
}

export function matchTransferPairs(rows: TransferTx[], daysWindow: number): TransferPair[] {
  const byAbsAmount = new Map<number, TransferTx[]>();
  for (const row of rows) {
    if (row.amount === 0) continue;
    const key = Math.abs(row.amount);
    const bucket = byAbsAmount.get(key);
    if (bucket) bucket.push(row);
    else byAbsAmount.set(key, [row]);
  }

  const raw: Array<{ a: TransferTx; b: TransferTx; daysApart: number }> = [];
  for (const bucket of byAbsAmount.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const x = bucket[i];
        const y = bucket[j];
        if (x.amount + y.amount !== 0 || x.account === y.account) continue;
        const daysApart = daysBetween(x.date, y.date);
        if (daysApart > daysWindow) continue;
        const [a, b] = [x, y].sort((p, q) => p.date.localeCompare(q.date) || p.id.localeCompare(q.id));
        raw.push({ a, b, daysApart });
      }
    }
  }

  const uses = new Map<string, number>();
  for (const p of raw) {
    uses.set(p.a.id, (uses.get(p.a.id) ?? 0) + 1);
    uses.set(p.b.id, (uses.get(p.b.id) ?? 0) + 1);
  }

  return raw
    .map((p) => ({
      ...p,
      confidence: (uses.get(p.a.id) === 1 && uses.get(p.b.id) === 1 ? 'unique' : 'ambiguous') as
        | 'unique'
        | 'ambiguous',
    }))
    .sort(
      (p, q) =>
        p.daysApart - q.daysApart || p.a.date.localeCompare(q.a.date) || p.a.id.localeCompare(q.a.id)
    );
}

export async function findTransferCandidates(opts: {
  accountId?: string;
  daysWindow?: number;
  sinceDate?: string;
}): Promise<TransferPair[]> {
  const daysWindow = opts.daysWindow ?? 3;

  const accounts = (await actualApi.getAccounts()) as Array<{ id: string; name?: string }>;
  const accountMap = Object.fromEntries(accounts.map((a) => [a.id, a.name ?? '']));
  const payees = (await actualApi.getPayees()) as Array<{
    id: string;
    name?: string;
    transfer_acct?: string | null;
  }>;
  const payeeMap = Object.fromEntries(payees.map((p) => [p.id, p.name ?? '']));
  const transferPayeeIds = new Set(payees.filter((p) => p.transfer_acct != null).map((p) => p.id));

  let query = actualApi.q('transactions').filter({ transfer_id: null, is_parent: false });
  if (opts.sinceDate) query = query.filter({ date: { $gte: opts.sinceDate } });
  query = query.select(['id', 'date', 'amount', 'account', 'payee', 'notes', 'cleared']);
  const result = await actualApi.runQuery(query);

  const rows: TransferTx[] = (result as { data: Record<string, unknown>[] }).data
    .filter((r) => !transferPayeeIds.has(String(r.payee)))
    .map((r) => ({
      id: String(r.id),
      date: String(r.date),
      amount: Number(r.amount),
      account: String(r.account),
      accountName: sanitize(accountMap[String(r.account)] ?? ''),
      payee: r.payee == null ? null : String(r.payee),
      payeeName: sanitize(payeeMap[String(r.payee)] ?? ''),
      cleared: Boolean(r.cleared),
      notes: r.notes == null ? null : sanitize(String(r.notes)),
    }));

  const pairs = matchTransferPairs(rows, daysWindow);
  return opts.accountId
    ? pairs.filter((p) => p.a.account === opts.accountId || p.b.account === opts.accountId)
    : pairs;
}
