// ===== 待整改条目路由：未落地项的闭环跟踪 =====
import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware';
import { writeLog } from '../log';
import { syncRectifications } from '../report-engine';
import { PRIORITY_LABEL, RECTIFY_LABEL, RECTIFY_STATUS, type RectifyStatus } from '../types';
import { requireProjectAccess, visibleProjectIds } from '../access';

export const rectifyRouter = Router();
rectifyRouter.use(requireAuth);

/**
 * GET /api/rectifications?projectId=xxx
 * 待整改清单：未落地项自动汇总，已按 P0/P1/P2 排序。
 * 可见范围与审核员一致（仅本人所属审核组），组长/管理员可见全部。
 */
rectifyRouter.get('/', requireProjectAccess, async (req, res) => {
  const projectId = String(req.query.projectId || '');
  if (!projectId) return res.status(400).json({ error: '缺少 projectId' });
  const uid = req.user!.uid;
  const role = req.user!.role;

  // 先同步一次，保证清单与当前勾选状态一致（幂等）
  await syncRectifications(projectId);

  // 审核员仅见本组
  let groupFilter: string[] | null = null;
  if (role === 'auditor') {
    const gids = await prisma.groupMember.findMany({
      where: { userId: uid, group: { projectId } },
      select: { groupId: true },
    });
    groupFilter = gids.map((g) => g.groupId);
    if (!groupFilter.length) {
      return res.json({ projectId, total: 0, counts: {}, items: [], priorityLabel: PRIORITY_LABEL, statusLabel: RECTIFY_LABEL });
    }
  }

  const rows = await prisma.rectification.findMany({
    where: {
      projectId,
      ...(groupFilter ? { OR: [{ groupId: { in: groupFilter } }, { groupId: null }] } : {}),
    },
    include: {
      gmpClause: { include: { chapter: true } },
      group: { select: { name: true } },
    },
    orderBy: [{ priority: 'asc' }, { chapterCode: 'asc' }],
  });

  const PRIORITY_ORDER = ['P0', 'P1', 'P2'] as const;
  const sorted = [...rows].sort((a, b) => {
    const p = PRIORITY_ORDER.indexOf(a.priority as 'P0') - PRIORITY_ORDER.indexOf(b.priority as 'P0');
    if (p !== 0) return p;
    const c = a.chapterCode.localeCompare(b.chapterCode);
    if (c !== 0) return c;
    return a.gmpClause.code.localeCompare(b.gmpClause.code, 'zh', { numeric: true });
  });

  const counts: Record<string, number> = { P0: 0, P1: 0, P2: 0 };
  const statusCounts: Record<string, number> = { open: 0, doing: 0, done: 0, waived: 0 };
  for (const r of sorted) {
    if (counts[r.priority] !== undefined) counts[r.priority] += 1;
    if (statusCounts[r.status] !== undefined) statusCounts[r.status] += 1;
  }

  res.json({
    projectId,
    total: sorted.length,
    counts,
    statusCounts,
    items: sorted.map((r) => {
      let isoList: string[] = [];
      try {
        const v = JSON.parse(r.gmpClause.isoClauses);
        if (Array.isArray(v)) isoList = v;
      } catch {
        isoList = [];
      }
      return {
        id: r.id,
        gmpClauseId: r.gmpClauseId,
        code: r.gmpClause.code,
        text: r.gmpClause.text,
        chapterCode: r.chapterCode,
        chapterName: r.gmpClause.chapter.name,
        level: r.level,
        specClause: r.gmpClause.specClause,
        isoList,
        priority: r.priority,
        groupName: r.group?.name ?? null,
        owner: r.owner,
        dueDate: r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null,
        status: r.status,
        handleNote: r.handleNote,
        handledAt: r.handledAt ? r.handledAt.toISOString() : null,
      };
    }),
    priorityLabel: PRIORITY_LABEL,
    statusLabel: RECTIFY_LABEL,
  });
});

/**
 * PATCH /api/rectifications/:id
 * 组长指派责任部门、设置期限、更新整改状态与措施。
 * body: { owner?, dueDate?, status?, handleNote? }
 */
rectifyRouter.patch('/:id', requireRole('leader', 'admin'), async (req, res) => {
  const { owner, dueDate, status, handleNote } = req.body || {};
  const row = await prisma.rectification.findUnique({ where: { id: req.params.id } });
  if (!row) return res.status(404).json({ error: '整改条目不存在' });
  // 隔离：整改条目挂在项目下，按 rectifyId 直查会形成横向越权
  const allowed = await visibleProjectIds(req.user!.uid, req.user!.role);
  if (req.user!.role !== 'admin' && !allowed.includes(row.projectId)) {
    return res.status(403).json({ error: '您没有该项目的访问权限' });
  }

  if (status && !RECTIFY_STATUS.includes(status as RectifyStatus)) {
    return res.status(400).json({ error: `status 非法，可选：${RECTIFY_STATUS.join(' / ')}` });
  }

  const nextStatus = status as RectifyStatus | undefined;
  const data: Record<string, unknown> = {};
  if (owner !== undefined) data.owner = owner || null;
  if (handleNote !== undefined) data.handleNote = handleNote || null;
  if (dueDate !== undefined) data.dueDate = dueDate ? new Date(dueDate) : null;
  if (nextStatus) {
    data.status = nextStatus;
    // 状态推进到「整改中/已完成」时记录处理人与时间
    if (nextStatus === 'doing' || nextStatus === 'done') {
      data.handledBy = req.user!.uid;
      data.handledAt = new Date();
    }
  }

  const updated = await prisma.rectification.update({ where: { id: req.params.id }, data });
  await writeLog({
    req,
    action: 'rectify_update',
    target: `rectify:${req.params.id}`,
    detail: { status: nextStatus, owner, dueDate },
  });
  res.json({ ok: true, item: updated });
});

/**
 * POST /api/rectifications/sync  body: { projectId }
 * 手动触发未落地项 → 待整改条目同步（正常情况下已自动同步，此接口供核对用）
 */
rectifyRouter.post('/sync', requireProjectAccess, requireRole('leader', 'admin'), async (req, res) => {
  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: '缺少 projectId' });
  const result = await syncRectifications(projectId);
  await writeLog({ req, action: 'rectify_sync', target: `project:${projectId}`, detail: result });
  res.json({ ok: true, ...result });
});