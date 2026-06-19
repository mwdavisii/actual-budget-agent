import express from 'express';
import type Database from 'better-sqlite3';
import { bearerAuth } from './auth';
import { errorHandler } from './errors';
import { createTransactionsRouter } from './routes/transactions';
import { createBudgetRouter } from './routes/budget';
import { createAccountsRouter } from './routes/accounts';
import { createTargetsRouter } from './routes/targets';

export interface AppDeps {
  db: Database.Database;
  token: string;
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.use(express.json());

  let ready = false;
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  app.get('/readyz', (_req, res) => {
    if (ready) res.json({ status: 'ready' });
    else res.status(503).json({ status: 'not ready' });
  });

  app.use(bearerAuth(deps.token));

  app.use('/tx', createTransactionsRouter(deps));
  app.use(createBudgetRouter(deps));        // defines /budget/status, /schedules, /categories (later)
  app.use('/accounts', createAccountsRouter(deps));
  app.use('/targets', createTargetsRouter(deps));

  app.use(errorHandler);

  return { app, setReady: () => { ready = true; } };
}
