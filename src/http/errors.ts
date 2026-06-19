import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Use as a `.catch()` handler around withActualRead/withActualWrite calls. */
export function actualDown(err: unknown): never {
  throw new ApiError(502, `actual unreachable: ${String(err)}`);
}

/** Express error-handling middleware (must be registered last, with 4 args). */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  logger.error('Unhandled route error', { err: String(err) });
  res.status(500).json({ error: 'internal error' });
}
