// ===== 认证中间件：解析 Bearer Token -> 挂载 req.user =====
import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from './auth';
import type { Role } from './types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { uid: string; name: string; role: Role };
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: '未登录或登录已过期' });
  req.user = { uid: payload.uid, name: payload.name, role: payload.role };
  next();
}

/** 角色白名单中间件 */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: '当前角色无权执行此操作' });
    }
    next();
  };
}

/** 取当前用户 IP（兼容反向代理） */
export function clientIp(req: Request): string {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.ip || req.socket.remoteAddress || '';
}
