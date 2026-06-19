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

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};

describe('MCP HTTP endpoint', () => {
  it('POST /mcp without a token → 401', async () => {
    const { app } = createApp(makeDeps());
    const res = await request(app).post('/mcp').send(INIT);
    expect(res.status).toBe(401);
  });

  it('POST /mcp initialize with a token → 200 and returns server info', async () => {
    const { app } = createApp(makeDeps());
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer secret')
      .set('Accept', 'application/json, text/event-stream')
      .send(INIT);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.text + JSON.stringify(res.body)).toContain('budget-gateway');
  });
});
