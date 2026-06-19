import { Router } from 'express';
import { withActualRead } from '../../actual/client';
import { getBudgetStatus, getScheduledTransactions, getCategories } from '../../actual/queries';
import { ApiError, actualDown } from '../errors';
import type { AppDeps } from '../app';

export function createBudgetRouter(_deps: AppDeps): Router {
  const router = Router();

  router.get('/budget/status', async (req, res) => {
    const month = typeof req.query.month === 'string' ? req.query.month : undefined;
    if (month && !/^\d{4}-\d{2}$/.test(month)) {
      throw new ApiError(400, 'month must be in YYYY-MM format');
    }
    const cats = await withActualRead(() => getBudgetStatus(month)).catch(actualDown);
    res.json(cats);
  });

  router.get('/schedules', async (_req, res) => {
    const schedules = await withActualRead(getScheduledTransactions).catch(actualDown);
    res.json(schedules);
  });

  router.get('/categories', async (_req, res) => {
    const categories = await withActualRead(getCategories).catch(actualDown);
    res.json(categories);
  });

  return router;
}
