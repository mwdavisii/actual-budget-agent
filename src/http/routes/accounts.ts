import { Router } from 'express';
import { withActualRead, withActualWrite } from '../../actual/client';
import { getAccounts, syncAllAccounts } from '../../actual/queries';
import { actualDown } from '../errors';
import type { AppDeps } from '../app';

export function createAccountsRouter(_deps: AppDeps): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json(await withActualRead(getAccounts).catch(actualDown));
  });

  router.post('/sync', async (_req, res) => {
    const result = await withActualWrite(syncAllAccounts).catch(actualDown);
    res.json(result);
  });

  return router;
}
