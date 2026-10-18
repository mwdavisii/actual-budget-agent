import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as realApi from '@actual-app/api';
import { findTransferCandidates, linkTransfer } from '../../src/actual/transfers';

// Real engine, local budget, no server. Guards the undocumented behaviour linkTransfer relies on.
let dataDir: string;
let checking: string;
let card: string;

async function accountRows(account: string) {
  const r = await realApi.runQuery(
    realApi
      .q('transactions')
      .filter({ account })
      .select(['id', 'amount', 'payee', 'notes', 'cleared', 'transfer_id'])
  );
  return (r as { data: Array<Record<string, unknown>> }).data;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-agent-offline-'));
  await realApi.init({ dataDir });
  await realApi.runImport('transfer-contract', async () => {
    checking = (await realApi.createAccount({ name: 'Checking' }, 0)) as string;
    card = (await realApi.createAccount({ name: 'Card' }, 0)) as string;
    await realApi.addTransactions(checking, [
      { date: '2026-10-01', amount: -5000, notes: 'ACH', cleared: true },
      { date: '2026-10-05', amount: -900, subtransactions: [{ amount: -400 }, { amount: -500 }] },
    ]);
    await realApi.addTransactions(card, [{ date: '2026-10-02', amount: 5000, notes: 'PAYMENT' }]);
  });
}, 60_000);

afterAll(async () => {
  await realApi.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('transfer linking against the real Actual engine', () => {
  it('finds the pair, links it without creating or deleting rows, and the pair then disappears from candidates', async () => {
    const pairs = await findTransferCandidates({});
    expect(pairs).toHaveLength(1);
    expect(pairs[0].confidence).toBe('unique');
    const [{ a, b }] = pairs;
    expect([a.amount, b.amount].sort()).toEqual([-5000, 5000]);

    const dry = await linkTransfer(a.id, b.id, true);
    expect(dry.linked).toBe(false);
    expect((await accountRows(checking)).length).toBe(3); // 1 plain + 2 split children
    expect((await accountRows(card)).length).toBe(1);

    const res = await linkTransfer(a.id, b.id, false);
    expect(res.linked).toBe(true);
    expect(res.verified).toBe(true);

    expect((await accountRows(checking)).length).toBe(3); // no orphan created
    expect((await accountRows(card)).length).toBe(1);

    const [ra] = (await accountRows(a.account)).filter((r) => r.id === a.id);
    const [rb] = (await accountRows(b.account)).filter((r) => r.id === b.id);
    expect(ra.transfer_id).toBe(b.id);
    expect(rb.transfer_id).toBe(a.id);
    expect(ra.cleared).toBe(true);
    expect(rb.cleared).toBe(true);
    expect(ra.notes).toBe('ACH | PAYMENT');
    expect(rb.notes).toBe('ACH | PAYMENT');

    const payees = (await realApi.getPayees()) as Array<{ id: string; transfer_acct?: string | null }>;
    expect(payees.find((p) => p.id === ra.payee)?.transfer_acct).toBe(b.account);
    expect(payees.find((p) => p.id === rb.payee)?.transfer_acct).toBe(a.account);

    expect(await findTransferCandidates({})).toEqual([]);
  }, 60_000);

  it('rejects re-linking an already linked row', async () => {
    const linked = (await accountRows(card))[0];
    const other = (await accountRows(checking)).find((r) => r.transfer_id === linked.id)!;
    await expect(linkTransfer(String(linked.id), String(other.id), false)).rejects.toThrow(/already linked/);
  });

  it('deleting one side of a linked transfer deletes the other (documents why delete_transaction warns)', async () => {
    const linked = (await accountRows(card))[0];
    await realApi.deleteTransaction(String(linked.id));
    await new Promise((r) => setTimeout(r, 1000));
    const remaining = (await accountRows(checking)).filter((r) => r.transfer_id != null || r.amount === -5000);
    expect(remaining).toEqual([]);
    expect(await accountRows(card)).toEqual([]);
  }, 30_000);
});
