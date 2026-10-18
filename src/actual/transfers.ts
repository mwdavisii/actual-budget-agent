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

interface RawTx {
  id: string;
  date: string;
  amount: number;
  account: string;
  payee: string | null;
  notes: string | null;
  cleared: boolean;
  transferId: string | null;
  isParent: boolean;
  reconciled: boolean;
}

export interface LinkTransferResult {
  dryRun: boolean;
  linked: boolean;
  /** True when a re-read confirmed both rows are linked; false for dry-runs or if the write had not become visible in time. */
  verified: boolean;
  before: { a: RawTx; b: RawTx };
  after: { a: RawTx; b: RawTx };
}

async function getRawTx(id: string): Promise<RawTx | null> {
  const result = await actualApi.runQuery(
    actualApi
      .q('transactions')
      .filter({ id })
      .options({ splits: 'all' }) // default 'inline' hides split parents, which we want to reject explicitly
      .select(['id', 'date', 'amount', 'account', 'payee', 'notes', 'cleared', 'reconciled', 'transfer_id', 'is_parent'])
  );
  const row = (result as { data: Record<string, unknown>[] }).data[0];
  if (!row) return null;
  return {
    id: String(row.id),
    date: String(row.date),
    amount: Number(row.amount),
    account: String(row.account),
    payee: row.payee == null ? null : String(row.payee),
    notes: row.notes == null ? null : String(row.notes),
    cleared: Boolean(row.cleared),
    transferId: row.transfer_id == null ? null : String(row.transfer_id),
    isParent: Boolean(row.is_parent),
    reconciled: Boolean(row.reconciled),
  };
}

// Notes are written back to Actual unmodified; sanitize only what is returned to the model.
function forOutput(t: RawTx): RawTx {
  return { ...t, notes: t.notes == null ? null : sanitize(t.notes) };
}

// Actual mirrors notes between linked transfer rows, so both rows end up with one value.
function mergeNotes(a: string | null, b: string | null): string | null {
  const x = a?.trim() || null;
  const y = b?.trim() || null;
  if (x && y && x !== y) return `${x} | ${y}`;
  return x ?? y;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Actual applies writes a few ms after the call returns, so poll until the link is visible.
async function readLinked(
  a: RawTx,
  b: RawTx,
  settle: { attempts: number; delayMs: number }
): Promise<{ a: RawTx; b: RawTx } | null> {
  for (let i = 0; i < settle.attempts; i++) {
    const [ra, rb] = [await getRawTx(a.id), await getRawTx(b.id)];
    if (ra?.transferId === b.id && rb?.transferId === a.id) return { a: ra, b: rb };
    await sleep(settle.delayMs);
  }
  return null;
}

export async function linkTransfer(
  txIdA: string,
  txIdB: string,
  dryRun: boolean,
  options: { allowReconciled?: boolean; settle?: { attempts: number; delayMs: number } } = {}
): Promise<LinkTransferResult> {
  const settle = options.settle ?? { attempts: 20, delayMs: 50 };
  if (txIdA === txIdB) {
    throw new TransferLinkError('Cannot link a transaction to itself');
  }
  const a = await getRawTx(txIdA);
  if (!a) throw new TransferLinkError(`Transaction ${txIdA} not found`);
  const b = await getRawTx(txIdB);
  if (!b) throw new TransferLinkError(`Transaction ${txIdB} not found`);

  for (const t of [a, b]) {
    if (t.transferId) throw new TransferLinkError(`Transaction ${t.id} is already linked to a transfer`);
    if (t.isParent) throw new TransferLinkError(`Transaction ${t.id} is a split parent and cannot be linked`);
    if (t.reconciled && !options.allowReconciled) {
      throw new TransferLinkError(
        `Transaction ${t.id} is reconciled and linking would change it. Confirm with the user, then retry with allowReconciled:true`
      );
    }
  }
  if (a.account === b.account) {
    throw new TransferLinkError('Transactions are in the same account');
  }
  if (a.amount === 0 || b.amount === 0) {
    throw new TransferLinkError('Transfer amounts must be non-zero');
  }
  if (a.amount + b.amount !== 0) {
    throw new TransferLinkError(
      `Amounts must be exactly opposite (got ${a.amount} and ${b.amount})`
    );
  }

  const payees = (await actualApi.getPayees()) as Array<{ id: string; transfer_acct?: string | null }>;
  const transferPayeeFor = (accountId: string): string => {
    const p = payees.find((x) => x.transfer_acct === accountId);
    if (!p) throw new TransferLinkError(`No transfer payee found for account ${accountId}`);
    return p.id;
  };
  const payeeOnA = transferPayeeFor(b.account); // A's row points at B's account
  const payeeOnB = transferPayeeFor(a.account);

  const cleared = a.cleared || b.cleared;
  const notes = mergeNotes(a.notes, b.notes);
  const projectedA: RawTx = { ...a, payee: payeeOnA, transferId: b.id, cleared, notes };
  const projectedB: RawTx = { ...b, payee: payeeOnB, transferId: a.id, cleared, notes };

  if (dryRun) {
    return {
      dryRun: true,
      linked: false,
      verified: false,
      before: { a: forOutput(a), b: forOutput(b) },
      after: { a: forOutput(projectedA), b: forOutput(projectedB) },
    };
  }

  await actualApi.batchBudgetUpdates(async () => {
    await actualApi.updateTransaction(a.id, { payee: payeeOnA, transfer_id: b.id, cleared, notes });
    await actualApi.updateTransaction(b.id, { payee: payeeOnB, transfer_id: a.id, cleared, notes });
  });

  const settled = await readLinked(a, b, settle);
  const after = settled ?? { a: projectedA, b: projectedB };
  return {
    dryRun: false,
    linked: true,
    verified: settled !== null,
    before: { a: forOutput(a), b: forOutput(b) },
    after: { a: forOutput(after.a), b: forOutput(after.b) },
  };
}
