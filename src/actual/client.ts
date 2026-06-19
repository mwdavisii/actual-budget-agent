import * as actualApi from '@actual-app/api';
import path from 'path';
import fs from 'fs';
import { logger } from '../logger';

let initialized = false;
let lock: Promise<void> = Promise.resolve();

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  let resolveNext!: () => void;
  const next = new Promise<void>((res) => { resolveNext = res; });
  const current = lock;
  lock = next;
  try {
    await current;
    return await fn();
  } finally {
    resolveNext();
  }
}

async function initActual(syncDir: string, serverUrl: string, password: string): Promise<void> {
  process.env.ACTUAL_DATA_DIR = syncDir;
  await actualApi.shutdown();
  await actualApi.init({ dataDir: syncDir, serverURL: serverUrl, password });
  initialized = true;
}

// ── Gateway connection: warm cache + TTL refresh ────────────────────────────

interface GatewayActualConfig {
  dataDir: string;
  budgetId: string;
  serverUrl: string;
  password: string;
  ttlMs: number;
}

let gatewayConfig: GatewayActualConfig | null = null;
let lastDownloadMs = 0;

/**
 * Configure the warm-cache gateway connection. Call once at startup before the
 * HTTP server accepts connections. Not safe to call concurrently with
 * withActualRead/withActualWrite — it mutates module state outside the lock.
 */
export function configureActual(cfg: {
  dataDir: string;
  budgetId: string;
  serverUrl: string;
  password: string;
  ttlSeconds: number;
}): void {
  gatewayConfig = {
    dataDir: cfg.dataDir,
    budgetId: cfg.budgetId,
    serverUrl: cfg.serverUrl,
    password: cfg.password,
    ttlMs: cfg.ttlSeconds * 1000,
  };
  initialized = false;
  lastDownloadMs = 0;
}

async function downloadWithRetry(cfg: GatewayActualConfig): Promise<void> {
  const syncDir = path.join(cfg.dataDir, 'actual-sync');
  fs.mkdirSync(syncDir, { recursive: true });
  if (!initialized) {
    await initActual(syncDir, cfg.serverUrl, cfg.password);
  }
  try {
    await actualApi.downloadBudget(cfg.budgetId, { password: cfg.password });
  } catch (e) {
    logger.warn('Budget sync failed, retrying after re-init', { error: String(e) });
    await initActual(syncDir, cfg.serverUrl, cfg.password);
    await actualApi.downloadBudget(cfg.budgetId, { password: cfg.password });
  }
  // Authoritative freshness marker: reflects when the local cache was last
  // populated. This is the only place lastDownloadMs should be set.
  lastDownloadMs = Date.now();
  logger.info('Actual Budget synced');
}

async function ensureFresh(force: boolean): Promise<void> {
  if (!gatewayConfig) {
    throw new Error('Actual connection not configured — call configureActual() first');
  }
  // Strict ">" means a cache exactly ttlMs old is still served as fresh; the
  // re-download fires only once it is strictly older. Intentional — do not
  // change to ">=" expecting a bug fix.
  const stale = Date.now() - lastDownloadMs > gatewayConfig.ttlMs;
  if (force || !initialized || stale) {
    await downloadWithRetry(gatewayConfig);
  }
}

export async function withActualRead<T>(fn: () => Promise<T>): Promise<T> {
  return withLock(async () => {
    await ensureFresh(false);
    return fn();
  });
}

export async function withActualWrite<T>(fn: () => Promise<T>): Promise<T> {
  return withLock(async () => {
    await ensureFresh(true);
    const result = await fn();
    await actualApi.sync();
    return result;
  });
}

export { actualApi };
