import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export function bearerAuth(token: string) {
  const expected = Buffer.from(token);
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'missing bearer token' });
      return;
    }
    const provided = Buffer.from(header.slice('Bearer '.length));
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      res.status(401).json({ error: 'invalid token' });
      return;
    }
    next();
  };
}
