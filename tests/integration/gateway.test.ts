import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/schema';
import { createApp } from '../../src/http/app';
import { setCategoryForTransaction } from '../../src/actual/queries';

vi.mock('../../src/actual/client', () => ({
  withActualRead: (fn: () => Promise<unknown>) => fn(),
  withActualWrite: (fn: () => Promise<unknown>) => fn(),
  configureActual: vi.fn(),
}));

vi.mock('../../src/actual/queries', () => ({
  getUncategorizedTransactions: vi.fn().mockResolvedValue([{ id: 't1', payee: 'Shop' }]),
  getTransactions: vi.fn().mockResolvedValue([{ id: 't2' }]),
  setCategoryForTransaction: vi.fn().mockResolvedValue(undefined),
  getBudgetStatus: vi.fn().mockResolvedValue([{ id: 'c1', name: 'Groceries', budgeted: 100, spent: 0, available: 100, isIncome: false }]),
  getScheduledTransactions: vi.fn().mockResolvedValue([{ id: 's1' }]),
  getCategories: vi.fn().mockResolvedValue([{ group: 'Food', categories: ['Groceries'] }]),
  syncAllAccounts: vi.fn().mockResolvedValue({ synced: ['Checking'], failed: [] }),
}));

function makeDeps() {
  const db = new Database(':memory:');
  runMigrations(db);
  return { db, token: 'secret' };
}

describe('gateway app skeleton', () => {
  it('GET /healthz returns 200 ok (no auth required)', async () => {
    const { app } = createApp(makeDeps());
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /readyz returns 503 until setReady is called', async () => {
    const { app, setReady } = createApp(makeDeps());
    let res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    setReady();
    res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
  });

  it('a protected path without a token returns 401', async () => {
    // 401 comes from bearerAuth firing before the (empty) targets router is
    // reached — proving auth sits in front of all routers, not from /targets itself.
    const { app } = createApp(makeDeps());
    const res = await request(app).get('/targets');
    expect(res.status).toBe(401);
  });
});

const AUTH = { Authorization: 'Bearer secret' };

describe('transactions routes', () => {
  it('GET /tx/uncategorized returns the list', async () => {
    const { app } = createApp(makeDeps());
    const res = await request(app).get('/tx/uncategorized').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 't1', payee: 'Shop' }]);
  });

  it('POST /tx/query returns filtered transactions', async () => {
    const { app } = createApp(makeDeps());
    const res = await request(app).post('/tx/query').set(AUTH).send({ startDate: '2026-01-01' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 't2' }]);
  });

  it('POST /tx/:id/category with a valid body succeeds', async () => {
    const { app } = createApp(makeDeps());
    const res = await request(app).post('/tx/t9/category').set(AUTH).send({ category: 'Groceries' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, txId: 't9', category: 'Groceries' });
  });

  it('POST /tx/:id/category with no category → 400', async () => {
    const { app } = createApp(makeDeps());
    const res = await request(app).post('/tx/t9/category').set(AUTH).send({});
    expect(res.status).toBe(400);
  });

  it('POST /tx/:id/category with unknown category → 404', async () => {
    (setCategoryForTransaction as any).mockRejectedValueOnce(new Error('Category "Nope" not found'));
    const { app } = createApp(makeDeps());
    const res = await request(app).post('/tx/t9/category').set(AUTH).send({ category: 'Nope' });
    expect(res.status).toBe(404);
  });
});
