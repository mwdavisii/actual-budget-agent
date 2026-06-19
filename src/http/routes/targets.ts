import { Router } from 'express';
import { withActualRead } from '../../actual/client';
import { getBudgetStatus } from '../../actual/queries';
import {
  getTargetsWithLive,
  seedTargets,
  getUnderfundedCategories,
  exportTargets,
  importTargets,
} from '../../db/targets';
import { ApiError, actualDown } from '../errors';
import type { AppDeps } from '../app';

export function createTargetsRouter(deps: AppDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/', async (_req, res) => {
    const live = await withActualRead(() => getBudgetStatus()).catch(actualDown);
    res.json(getTargetsWithLive(db, live));
  });

  router.post('/seed', async (_req, res) => {
    const live = await withActualRead(() => getBudgetStatus()).catch(actualDown);
    const count = seedTargets(db, live);
    res.json({ success: true, count });
  });

  router.get('/underfunded', async (_req, res) => {
    const live = await withActualRead(() => getBudgetStatus()).catch(actualDown);
    res.json(getUnderfundedCategories(db, live));
  });

  router.get('/export', (_req, res) => {
    res.json(exportTargets(db));
  });

  router.post('/import', (req, res) => {
    const data = (req.body ?? {}) as { targets?: unknown };
    if (!Array.isArray(data.targets)) {
      throw new ApiError(400, 'body must include a "targets" array');
    }
    const count = importTargets(db, { exportedAt: new Date().toISOString(), targets: data.targets as never });
    res.json({ success: true, imported: count });
  });

  return router;
}
