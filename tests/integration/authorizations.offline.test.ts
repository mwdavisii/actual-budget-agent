import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as realApi from '@actual-app/api';
import {
  findSupersededAuthorizations,
  resolveSupersededAuthorization,
} from '../../src/actual/authorizations';

// Real engine, local budget, no server. Guards the delete/update behaviour resolve relies on.
let dataDir: string;
let card: string;
let dining: string;

async function cardRows() {
  const r = await realApi.runQuery(
    realApi
      .q('transactions')
      .filter({ account: card })
      .select(['id', 'date', 'amount', 'payee', 'category', 'notes', 'cleared'])
  );
  return (r as { data: Array<Record<string, unknown>> }).data;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-agent-auth-'));
  await realApi.init({ dataDir });
  await realApi.runImport('auth-contract', async () => {
    const group = (await realApi.createCategoryGroup({ name: 'Food' })) as string;
    dining = (await realApi.createCategory({ name: 'Dining', group_id: group })) as string;
    card = (await realApi.createAccount({ name: 'Card' }, 0)) as string;
    const payee = (await realApi.createPayee({ name: 'Joes Diner' })) as string;
    await realApi.addTransactions(card, [
      { date: '2026-10-01', amount: -5000, payee, category: dining, notes: 'dinner', cleared: false },
      { date: '2026-10-03', amount: -6000, payee, cleared: true },
      { date: '2026-10-02', amount: -1200, cleared: true }, // unrelated
    ]);
  });
}, 60_000);

afterAll(async () => {
  await realApi.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('superseded authorizations against the real Actual engine', () => {
  it('finds the pair, resolves it, and leaves one cleared row with category and notes carried over', async () => {
    const pairs = await findSupersededAuthorizations({});
    expect(pairs).toHaveLength(1);
    expect(pairs[0].confidence).toBe('unique');
    expect(pairs[0].tipAmount).toBe(1000);
    const { pending, final } = pairs[0];

    const dry = await resolveSupersededAuthorization(pending.id, final.id, true);
    expect(dry.deletedId).toBeNull();
    expect((await cardRows()).length).toBe(3);

    const res = await resolveSupersededAuthorization(pending.id, final.id, false);
    expect(res.verified).toBe(true);
    expect(res.deletedId).toBe(pending.id);

    const rows = await cardRows();
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.id === pending.id)).toBeUndefined();
    const kept = rows.find((r) => r.id === final.id)!;
    expect(kept.amount).toBe(-6000);
    expect(kept.cleared).toBe(true);
    expect(kept.category).toBe(dining);
    expect(kept.notes).toBe('dinner');

    expect(await findSupersededAuthorizations({})).toEqual([]);
  }, 60_000);
});
