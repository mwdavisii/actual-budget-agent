import { describe, it, expect } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/schema';
import { createApp } from '../../src/http/app';

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
    const { app } = createApp(makeDeps());
    const res = await request(app).get('/targets');
    expect(res.status).toBe(401);
  });
});
