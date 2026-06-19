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
    expect(res.body.error).toMatch(/category/i);
  });

  it('POST /tx/:id/category with unknown category → 404', async () => {
    (setCategoryForTransaction as any).mockRejectedValueOnce(new Error('Category "Nope" not found'));
    const { app } = createApp(makeDeps());
    const res = await request(app).post('/tx/t9/category').set(AUTH).send({ category: 'Nope' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe('budget/schedules/categories routes', () => {
  it('GET /budget/status returns categories', async () => {
    const { app } = createApp(makeDeps());
    const res = await request(app).get('/budget/status').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe('Groceries');
  });

  it('GET /budget/status with malformed month → 400', async () => {
    const { app } = createApp(makeDeps());
    const res = await request(app).get('/budget/status?month=2026-1').set(AUTH);
    expect(res.status).toBe(400);
  });

  it('GET /budget/status with a valid month is forwarded to the handler', async () => {
    const { app } = createApp(makeDeps());
    const res = await request(app).get('/budget/status?month=2026-01').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe('Groceries');
  });

  it('GET /schedules returns schedules', async () => {
    const { app } = createApp(makeDeps());
    const res = await request(app).get('/schedules').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 's1' }]);
  });

  it('GET /categories returns groups', async () => {
    const { app } = createApp(makeDeps());
    const res = await request(app).get('/categories').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ group: 'Food', categories: ['Groceries'] }]);
  });
});

describe('accounts route', () => {
  it('POST /accounts/sync returns synced/failed', async () => {
    const { app } = createApp(makeDeps());
    const res = await request(app).post('/accounts/sync').set(AUTH).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ synced: ['Checking'], failed: [] });
  });
});

describe('targets routes', () => {
  it('POST /targets/seed seeds from live budget then GET /targets returns them', async () => {
    const { app } = createApp(makeDeps());
    const seed = await request(app).post('/targets/seed').set(AUTH).send({});
    expect(seed.status).toBe(200);
    expect(seed.body.count).toBe(1); // Groceries budgeted 100, not income

    const list = await request(app).get('/targets').set(AUTH);
    expect(list.status).toBe(200);
    expect(list.body[0].categoryName).toBe('Groceries');
    expect(list.body[0].target).toBe(100);
  });

  it('GET /targets/underfunded returns gaps', async () => {
    const { app } = createApp(makeDeps());
    await request(app).post('/targets/seed').set(AUTH).send({}); // target 100 == budgeted 100 → no gap
    const res = await request(app).get('/targets/underfunded').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]); // budgeted == target, gap not > 0
  });

  it('GET /targets/export then POST /targets/import round-trips', async () => {
    const { app } = createApp(makeDeps());
    await request(app).post('/targets/seed').set(AUTH).send({});
    const exported = await request(app).get('/targets/export').set(AUTH);
    expect(exported.body.targets.length).toBe(1);

    const fresh = createApp(makeDeps());
    const imported = await request(fresh.app).post('/targets/import').set(AUTH).send(exported.body);
    expect(imported.status).toBe(200);
    expect(imported.body.imported).toBe(1);
  });

  it('POST /targets/import with no targets array → 400', async () => {
    const { app } = createApp(makeDeps());
    const res = await request(app).post('/targets/import').set(AUTH).send({ nope: true });
    expect(res.status).toBe(400);
  });
});
