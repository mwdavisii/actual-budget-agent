import express, { Request, Response } from 'express';
import { verifySignature } from './hmac';
import { dispatchCheckType } from './handlers/index';
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
