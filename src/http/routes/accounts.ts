import { Router } from 'express';
import { withActualWrite } from '../../actual/client';
import { syncAllAccounts } from '../../actual/queries';
import { actualDown } from '../errors';
import type { AppDeps } from '../app';

export function createAccountsRouter(_deps: AppDeps): Router {
  const router = Router();

  router.post('/sync', async (_req, res) => {
    const result = await withActualWrite(syncAllAccounts).catch(actualDown);
    res.json(result);
  });

  return router;
}
