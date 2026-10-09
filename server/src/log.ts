// ===== 操作日志工具 =====
import { prisma } from './db';
import type { Request } from 'express';
import { clientIp } from './middleware';
import type { Role } from './types';

/**
 * 写操作日志（登录、勾选、项目增删改、报告生成、映射表变更等）
 * 故意不抛异常：日志失败不应影响主流程。
 */
export async function writeLog(params: {
  req?: Request;
  action: string;
  target?: string;
  detail?: unknown;
  userId?: string;
  userName?: string;
  role?: Role;
}) {
  try {
    const user = params.req?.user;
    await prisma.operationLog.create({
      data: {
        userId: params.userId ?? user?.uid ?? null,
        userName: params.userName ?? user?.name ?? null,
        role: params.role ?? user?.role ?? null,
        action: params.action,
        target: params.target ?? null,
        detail:
          typeof params.detail === 'string'
            ? params.detail
            : params.detail
              ? JSON.stringify(params.detail)
              : null,
        ip: params.req ? clientIp(params.req) : null,
      },
    });
  } catch (e) {
    console.warn('[log] 写入操作日志失败:', (e as Error).message);
  }
}
