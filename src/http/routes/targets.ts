import { Router } from 'express';
import { withActualRead } from '../../actual/client';
import { getBudgetStatus } from '../../actual/queries';
import {
  getTargetsWithLive,
  seedTargets,
  getUnderfundedCategories,
  exportTargets,
  importTargets,
  type TargetExport,
} from '../../db/targets';
import { ApiError, actualDown } from '../errors';
import type { AppDeps } from '../app';

function isValidTarget(x: unknown): x is TargetExport['targets'][number] {
  if (typeof x !== 'object' || x === null) return false;
  const t = x as Record<string, unknown>;
  return (
    typeof t['categoryId'] === 'string' &&
    typeof t['categoryName'] === 'string' &&
    typeof t['targetAmount'] === 'number'
  );
}

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
    if (!data.targets.every(isValidTarget)) {
      throw new ApiError(400, 'each target must have categoryId (string), categoryName (string), and targetAmount (number)');
    }
    const count = importTargets(db, { exportedAt: new Date().toISOString(), targets: data.targets });
    res.json({ success: true, imported: count });
  });

  return router;
}
