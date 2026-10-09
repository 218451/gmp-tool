// ===== 项目级数据隔离 ======
/**
 * 业务要求（负责人原话）：
 *   「系统要支持几十个组同时独立使用，避免互相干扰」
 *   「每个项目的数据必须严格隔离互不混用，项目成员只能查看和操作本项目的数据」
 *
 * 隔离模型（一个项目 = 一个受审核企业 = 一个审核组集合）：
 *   admin    → 全库可见（系统维护角色）
 *   leader   → 自己创建的（ownerId）+ 自己作为审核组成员参与的项目
 *   auditor  → 仅自己作为审核组成员参与的项目的「本组可见范围」
 *
 * 为什么必须收在中间件层而不是各处手写 where：
 *   本项目已有 8 个路由文件、近 40 个端点，逐处加过滤条件必然漏。
 *   收成一个 requireProjectAccess 中间件后，新增端点只需挂一次，漏写成本从
 *   「静默越权」降为「忘记挂中间件（code review 可查）」。
 *
 * ★ 与「组长需要看到别人建的项目」的取舍：
 *   几十个组独立使用时，跨组看到对方的审核进度/报告没有业务价值，
 *   反而是数据泄露面。故一律按「参与关系」判定，只有 admin 例外。
 */
import type { NextFunction, Request, Response } from 'express';
import { prisma } from './db';

/** 某用户可见的项目 id 列表；admin 走 allProjectsOf 之外的特权路径 */
export async function visibleProjectIds(userId: string, role: string): Promise<string[]> {
  if (role === 'admin') {
    const all = await prisma.project.findMany({ select: { id: true } });
    return all.map((p) => p.id);
  }
  if (role === 'leader') {
    const rows = await prisma.project.findMany({
      where: {
        OR: [
          { ownerId: userId },
          { groups: { some: { members: { some: { userId } } } } },
        ],
      },
      select: { id: true },
    });
    return rows.map((p) => p.id);
  }
  // 审核员：仅参与的项目
  const rows = await prisma.project.findMany({
    where: { groups: { some: { members: { some: { userId } } } } },
    select: { id: true },
  });
  return rows.map((p) => p.id);
}

/** 该用户在此项目下的可见审核组 id 列表；组长/管理员为空数组（表示「全部组」） */
export async function visibleGroupIds(userId: string, role: string, projectId: string): Promise<string[]> {
  if (role === 'leader' || role === 'admin') return [];
  const rows = await prisma.groupMember.findMany({
    where: { userId, group: { projectId } },
    select: { groupId: true },
  });
  return rows.map((r) => r.groupId);
}

/**
 * requireProjectAccess —— 挂在所有 /api/projects/:id/* 端点上
 *
 * 用法：projectRouter.get('/:id/board', requireProjectAccess, handler)
 *
 * params 名不固定：有的端点是 :id，有的在 query 里（projectId）。
 * 默认取 params.id；取不到时回落到 query.projectId，
 * 覆盖 /assessments/my?projectId=xxx 这类「项目 id 不在路径上」的接口。
 *
 * 校验通过后往 req 上挂 projectId，后续 handler 直接取，
 * 避免每个 handler 再解一遍字符串。
 */
export function requireProjectAccess(req: Request, res: Response, next: NextFunction) {
  void (async () => {
    const uid = req.user!.uid;
    const role = req.user!.role;
    const pid = String(req.params.id || req.params.pid || req.query.projectId || req.body?.projectId || '');
    if (!pid) return res.status(400).json({ error: '缺少项目编号' });

    if (role === 'admin') {
      const exists = await prisma.project.findUnique({ where: { id: pid }, select: { id: true } });
      if (!exists) return res.status(404).json({ error: '项目不存在' });
      (req as any).projectId = pid;
      return next();
    }

    const ids = await visibleProjectIds(uid, role);
    if (!ids.includes(pid)) {
      // 不区分「不存在」与「无权限」会泄露项目 id 的存在性，统一给 403
      return res.status(403).json({ error: '您没有该项目的访问权限' });
    }
    (req as any).projectId = pid;
    next();
  })().catch(next);
}

/** 取中间件解析好的项目 id（回落到手动解析，双保险） */
export function pidOf(req: Request): string {
  return String((req as any).projectId || req.params.id || req.params.pid || req.query.projectId || req.body?.projectId || '');
}

/**
 * 报表/整改类守卫 —— 这些表的主键不是 projectId，先反查归属项目再判权限。
 *
 * 用法：reportRouter.get('/:id', requireReportProjectAccess, handler)
 * 校验通过后 req.reportProjectId 上挂着归属项目 id。
 *
 * 为什么必须有：Report 与 Rectification 都是「挂在项目下的产物」，
 * 只按 reportId 直查会形成横向越权——知道别人的 reportId 就能读别人的报告原文。
 */
export function requireReportProjectAccess(req: Request, res: Response, next: NextFunction) {
  void (async () => {
    const uid = req.user!.uid;
    const role = req.user!.role;
    const ids = await visibleProjectIds(uid, role);

    // 按项目 id 直接查的（by-project/:projectId）
    const direct = req.params.projectId || (req.query.projectId as string) || req.body?.projectId;
    if (direct) {
      if (role !== 'admin' && !ids.includes(String(direct))) {
        return res.status(403).json({ error: '您没有该项目的访问权限' });
      }
      (req as any).projectId = String(direct);
      return next();
    }

    // 按自身主键查的：先反查归属项目
    const rid = req.params.id;
    if (!rid) return res.status(400).json({ error: '缺少编号' });
    const row = await prisma.report.findUnique({ where: { id: rid }, select: { projectId: true } });
    if (!row) return res.status(404).json({ error: '报告不存在' });
    if (role !== 'admin' && !ids.includes(row.projectId)) {
      return res.status(403).json({ error: '您没有该项目的访问权限' });
    }
    (req as any).projectId = row.projectId;
    next();
  })().catch(next);
}