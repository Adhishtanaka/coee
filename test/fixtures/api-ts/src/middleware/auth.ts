import { Request, Response, NextFunction } from 'express';

export function requireUser(req: Request, res: Response, next: NextFunction) {
  const user = req.header('x-user-id');
  if (!user) return res.status(401).json({ error: 'login required' });
  (req as any).userId = user;
  next();
}
