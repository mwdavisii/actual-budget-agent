import * as actualApi from '@actual-app/api';
import path from 'path';
import fs from 'fs';
import { logger } from '../logger';

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

export async function withActual<T>(
  dataDir: string,
  budgetId: string,
  serverUrl: string,
  password: string,
  fn: () => Promise<T>
): Promise<T> {
  return withLock(async () => {
    const syncDir = path.join(dataDir, 'actual-sync');
    fs.mkdirSync(syncDir, { recursive: true });
    process.env.ACTUAL_DATA_DIR = syncDir;
    // Re-init on every call: shutdown() resets actualApp so init() re-runs
    // fully, re-asserting the server URL and re-authenticating. This avoids
    // a persistent network-failure on subsequent calls caused by the server
    // config being lost after the first budget load cycle.
    await actualApi.shutdown();
    await actualApi.init({
      dataDir: syncDir,
      serverURL: serverUrl,
      password,
    });
    // Always re-download to get the latest budget amounts — sync() only
    // syncs transactions and does not refresh the budget spreadsheet cache.
    await actualApi.downloadBudget(budgetId, { password });
    logger.info('Actual Budget synced');
    return fn();
  });
}

export { actualApi };
