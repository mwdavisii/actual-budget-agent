import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getGatewayConfig } from '../../src/config';

const KEYS = ['ACTUAL_SERVER_URL', 'ACTUAL_PASSWORD', 'ACTUAL_BUDGET_ID', 'DATA_DIR', 'GATEWAY_TOKEN', 'PORT', 'SYNC_TTL_SECONDS'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.ACTUAL_SERVER_URL = 'http://actual:5006';
  process.env.ACTUAL_PASSWORD = 'pw';
  process.env.ACTUAL_BUDGET_ID = 'budget-1';
  process.env.GATEWAY_TOKEN = 'secret-token';
  delete process.env.DATA_DIR;
  delete process.env.PORT;
  delete process.env.SYNC_TTL_SECONDS;
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('getGatewayConfig', () => {
  it('reads required values and applies defaults', () => {
    const cfg = getGatewayConfig();
    expect(cfg.actualServerUrl).toBe('http://actual:5006');
    expect(cfg.gatewayToken).toBe('secret-token');
    expect(cfg.dataDir).toBe('/data');
    expect(cfg.port).toBe(3000);
    expect(cfg.syncTtlSeconds).toBe(45);
  });

  it('throws when a required var is missing', () => {
    delete process.env.GATEWAY_TOKEN;
    expect(() => getGatewayConfig()).toThrow(/GATEWAY_TOKEN/);
  });

  it('honors overrides for optional values', () => {
    process.env.DATA_DIR = '/tmp/data';
    process.env.PORT = '8080';
    process.env.SYNC_TTL_SECONDS = '10';
    const cfg = getGatewayConfig();
    expect(cfg.dataDir).toBe('/tmp/data');
    expect(cfg.port).toBe(8080);
    expect(cfg.syncTtlSeconds).toBe(10);
  });
});
