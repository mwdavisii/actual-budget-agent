import request from 'supertest';
import { createWebhookServer } from '../../src/webhook/server';
import { signPayload } from '../../src/webhook/hmac';

const ctx = {
  hmacKey: 'test-key',
  dataDir: '/tmp',
  budgetId: 'test',
  actualServerUrl: 'http://localhost',
  actualPassword: 'test',
};

describe('webhook server security', () => {
  const { app } = createWebhookServer(ctx);

  it('GET /healthz returns 200', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('POST /webhook without signature → 401', async () => {
    const res = await request(app).post('/webhook').send({ checkType: 'uncategorized_transactions', triggeredAt: '2026-03-18T10:00:00Z' });
    expect(res.status).toBe(401);
  });

  it('POST /webhook with wrong signature → 401', async () => {
    const res = await request(app)
      .post('/webhook')
      .set('X-Webhook-Signature', 'sha256=badhash')
      .send({ checkType: 'uncategorized_transactions', triggeredAt: '2026-03-18T10:00:00Z' });
    expect(res.status).toBe(401);
  });

  it('POST /webhook with valid signature → 200 accepted', async () => {
    const body = JSON.stringify({ checkType: 'uncategorized_transactions', triggeredAt: '2026-03-18T10:00:00Z' });
    const sig = signPayload('test-key', body);
    const res = await request(app)
      .post('/webhook')
      .set('X-Webhook-Signature', sig)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
  });
});
