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

    if (!initialized) {
      await initActual(syncDir, serverUrl, password);
    }

    // Always re-download to get the latest budget amounts — sync() only
    // syncs transactions and does not refresh the budget spreadsheet cache.
    try {
      await actualApi.downloadBudget(budgetId, { password });
    } catch (e) {
      // On network-failure the internal server config can be lost after a
      // budget load cycle. Force a full re-init and retry once.
      logger.warn('Budget sync failed, retrying after re-init', { error: String(e) });
      await initActual(syncDir, serverUrl, password);
      await actualApi.downloadBudget(budgetId, { password });
    }

    logger.info('Actual Budget synced');
    return fn();
  });
}

export { actualApi };
