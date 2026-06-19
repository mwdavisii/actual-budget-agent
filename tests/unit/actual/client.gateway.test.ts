import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as actualApi from '@actual-app/api';
import { configureActual, withActualRead, withActualWrite } from '../../../src/actual/client';

vi.mock('@actual-app/api', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  downloadBudget: vi.fn().mockResolvedValue(undefined),
  sync: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
  configureActual({ dataDir: '/tmp/gw-client-test', budgetId: 'b', serverUrl: 'http://x', password: 'p', ttlSeconds: 45 });
});

afterEach(() => vi.useRealTimers());

describe('gateway Actual connection', () => {
  it('first read initializes and downloads once', async () => {
    await withActualRead(async () => 'ok');
    expect(actualApi.init).toHaveBeenCalledTimes(1);
    expect(actualApi.downloadBudget).toHaveBeenCalledTimes(1);
  });

  it('second read within TTL does not re-download', async () => {
    await withActualRead(async () => 1);
    await withActualRead(async () => 2);
    expect(actualApi.downloadBudget).toHaveBeenCalledTimes(1);
  });

  it('read after TTL expiry re-downloads', async () => {
    await withActualRead(async () => 1);
    vi.advanceTimersByTime(46_000);
    await withActualRead(async () => 2);
    expect(actualApi.downloadBudget).toHaveBeenCalledTimes(2);
  });

  it('write forces a download and calls sync', async () => {
    await withActualRead(async () => 1);          // download #1
    await withActualWrite(async () => 'w');        // forced download #2 + sync
    expect(actualApi.downloadBudget).toHaveBeenCalledTimes(2);
    expect(actualApi.sync).toHaveBeenCalledTimes(1);
  });

  it('retries download after re-init when the first download fails', async () => {
    (actualApi.downloadBudget as any).mockRejectedValueOnce(new Error('net'));
    await withActualRead(async () => 'ok');
    expect(actualApi.init).toHaveBeenCalledTimes(2);
    expect(actualApi.downloadBudget).toHaveBeenCalledTimes(2);
  });

  it('a read immediately after a write is served from the warm cache (no extra download)', async () => {
    await withActualWrite(async () => 'w');   // forced download #1 + sync
    await withActualRead(async () => 'r');     // within TTL → no new download
    expect(actualApi.downloadBudget).toHaveBeenCalledTimes(1);
    expect(actualApi.sync).toHaveBeenCalledTimes(1);
  });

  it('exposes the read/write helpers', async () => {
    expect(typeof withActualRead).toBe('function');
    expect(typeof withActualWrite).toBe('function');
  });
});
