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

export async function withActual<T>(
  dataDir: string,
  budgetId: string,
  serverUrl: string,
  password: string,
  fn: () => Promise<T>
): Promise<T> {
  return withLock(async () => {
    if (!initialized) {
      const syncDir = path.join(dataDir, 'actual-sync');
      fs.mkdirSync(syncDir, { recursive: true });
      await actualApi.init({
        dataDir: syncDir,
        serverURL: serverUrl,
        password,
      });
      await actualApi.downloadBudget(budgetId, { password });
      initialized = true;
      logger.info('Actual Budget initialized and synced');
    } else {
      await actualApi.sync();
    }
    return fn();
  });
}

export { actualApi };
