import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { bearerAuth } from '../../../src/http/auth';

function makeApp(token: string) {
  const app = express();
  app.use(bearerAuth(token));
  app.get('/protected', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('bearerAuth', () => {
  it('rejects requests with no Authorization header', async () => {
    const res = await request(makeApp('secret')).get('/protected');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const res = await request(makeApp('secret')).get('/protected').set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
  });

  it('accepts the correct token', async () => {
    const res = await request(makeApp('secret')).get('/protected').set('Authorization', 'Bearer secret');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
