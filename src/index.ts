// Polyfill: @actual-app/api accesses navigator.platform which doesn't exist in Node
if (typeof globalThis.navigator === 'undefined') {
  (globalThis as any).navigator = { platform: '' };
}

process.on('unhandledRejection', (err) => {
  console.error(JSON.stringify({ level: 'error', message: 'Unhandled rejection', err: String(err) }));
});

import { getGatewayConfig } from './config';
import { getDb } from './db/client';
import { runMigrations } from './db/schema';
import { configureActual } from './actual/client';
import { createApp } from './http/app';
import { logger } from './logger';

async function main(): Promise<void> {
  logger.info('Actual gateway starting');

  const cfg = getGatewayConfig();
  const db = getDb(cfg.dataDir);
  runMigrations(db);

  configureActual({
    dataDir: cfg.dataDir,
    budgetId: cfg.actualBudgetId,
    serverUrl: cfg.actualServerUrl,
    password: cfg.actualPassword,
    ttlSeconds: cfg.syncTtlSeconds,
  });

  const { app, setReady } = createApp({ db, token: cfg.gatewayToken });
  app.listen(cfg.port, () => {
    logger.info('Gateway listening', { port: cfg.port });
    setReady();
  });
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'critical', message: 'Fatal startup error', err: String(err) }));
  process.exit(1);
});
