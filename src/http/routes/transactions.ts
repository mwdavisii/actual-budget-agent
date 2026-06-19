import { Router } from 'express';
import { withActualRead, withActualWrite } from '../../actual/client';
import { getUncategorizedTransactions, getTransactions, setCategoryForTransaction } from '../../actual/queries';
import { ApiError, actualDown } from '../errors';
import type { AppDeps } from '../app';

export function createTransactionsRouter(_deps: AppDeps): Router {
  const router = Router();

  router.get('/uncategorized', async (_req, res) => {
    const txs = await withActualRead(getUncategorizedTransactions).catch(actualDown);
    res.json(txs);
  });

  router.post('/query', async (req, res) => {
    const f = (req.body ?? {}) as Record<string, unknown>;
    const txs = await withActualRead(() =>
      getTransactions({
        startDate: f['startDate'] as string | undefined,
        endDate: f['endDate'] as string | undefined,
        accountId: f['accountId'] as string | undefined,
        categoryId: f['categoryId'] as string | undefined,
        amountMin: f['amountMin'] as number | undefined,
        amountMax: f['amountMax'] as number | undefined,
      })
    ).catch(actualDown);
    res.json(txs);
  });

  router.post('/:id/category', async (req, res) => {
    const id = req.params.id;
    const category = (req.body ?? {})['category'];
    if (typeof category !== 'string' || !category.trim()) {
      throw new ApiError(400, 'body must include a non-empty "category" string');
    }
    try {
      await withActualWrite(() => setCategoryForTransaction(id, category));
    } catch (e) {
      if (/not found/i.test(String(e))) throw new ApiError(404, String(e));
      throw new ApiError(502, `actual unreachable: ${String(e)}`);
    }
    res.json({ success: true, txId: id, category });
  });

  return router;
}
