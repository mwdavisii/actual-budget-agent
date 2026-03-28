import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { verifySignature } from './hmac';
import { dispatchCheckType } from './handlers/index';
import { exportTargets, importTargets, type TargetExport } from '../db/targets';
import { pruneTransactions } from '../actual/queries';
import { withActual } from '../actual/client';
import { getAppContext } from '../agent/index';
import { logger } from '../logger';

export interface WebhookPayload {
  checkType:
    | 'uncategorized_transactions'
    | 'overspent_categories'
    | 'unfunded_bills'
    | 'monthly_review'
    | 'weekly_digest'
    | 'bank_sync'
    | 'seed_targets'
    | 'allocate_pay_period';
  triggeredAt: string;
}

export interface WebhookContext {
  hmacKey: string;
  dataDir: string;
  budgetId: string;
  actualServerUrl: string;
  actualPassword: string;
}

export function createWebhookServer(ctx: WebhookContext) {
  // `ready` lives inside the closure — each createWebhookServer call gets its own flag.
  let ready = false;

  const app = express();

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });
  app.use(limiter);

  app.use(
    express.json({
      verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  app.get('/healthz', (_req, res: Response) => res.json({ status: 'ok' }));
  app.get('/readyz', (_req, res: Response) =>
    ready ? res.json({ status: 'ready' }) : res.status(503).json({ status: 'not ready' })
  );

  app.get('/export/targets', (req: Request, res: Response) => {
    const sig = req.headers['x-webhook-signature'] as string | undefined;
    // For GET, sign the empty string or the path — we use empty body
    if (!sig || !verifySignature(ctx.hmacKey, '', sig)) {
      logger.warn('Export targets signature invalid');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }
    const { db } = getAppContext();
    const data = exportTargets(db);
    res.json(data);
  });

  app.post('/import/targets', (req: Request & { rawBody?: Buffer }, res: Response) => {
    const sig = req.headers['x-webhook-signature'] as string | undefined;
    const body = req.rawBody?.toString('utf-8') ?? '';
    if (!sig || !verifySignature(ctx.hmacKey, body, sig)) {
      logger.warn('Import targets signature invalid');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }
    const data = req.body as TargetExport;
    if (!data?.targets || !Array.isArray(data.targets)) {
      res.status(400).json({ error: 'Invalid payload — expected { targets: [...] }' });
      return;
    }
    const { db } = getAppContext();
    const count = importTargets(db, data);
    logger.info('Budget targets imported via API', { count });
    res.json({ imported: count });
  });

  app.post('/admin/prune-transactions', (req: Request & { rawBody?: Buffer }, res: Response) => {
    const sig = req.headers['x-webhook-signature'] as string | undefined;
    const body = req.rawBody?.toString('utf-8') ?? '';
    if (!sig || !verifySignature(ctx.hmacKey, body, sig)) {
      logger.warn('Prune transactions signature invalid');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }
    const { before, dryRun = true } = req.body as { before?: string; dryRun?: boolean };
    if (!before || !/^\d{4}-\d{2}-\d{2}$/.test(before)) {
      res.status(400).json({ error: 'Invalid payload — expected { before: "YYYY-MM-DD", dryRun: true|false }' });
      return;
    }
    res.json({ accepted: true, before, dryRun });
    const { db } = getAppContext();
    withActual(ctx.dataDir, ctx.budgetId, ctx.actualServerUrl, ctx.actualPassword, () =>
      pruneTransactions(before, dryRun, dryRun ? undefined : db)
    ).then((result) => {
      logger.info('Prune transactions complete', result);
    }).catch((err: unknown) => {
      logger.error('Prune transactions failed', { err: String(err) });
    });
  });

  app.post('/webhook', (req: Request & { rawBody?: Buffer }, res: Response) => {
    const sig = req.headers['x-webhook-signature'] as string | undefined;
    const body = req.rawBody?.toString('utf-8') ?? '';

    if (!sig || !verifySignature(ctx.hmacKey, body, sig)) {
      logger.warn('Webhook signature invalid');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    const payload = req.body as WebhookPayload;
    logger.info('Webhook received', { checkType: payload.checkType });
    res.json({ accepted: true });

    dispatchCheckType(payload, ctx).catch((err: unknown) => {
      logger.error('Webhook handler error', { checkType: payload.checkType, err: String(err) });
    });
  });

  return { app, setReady: () => { ready = true; } };
}
