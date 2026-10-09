// ===== 评估路由：审核员分层反选（默认全选「已落地」，只标未落地）=====
import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware';
import { writeLog } from '../log';
import { getGroupWorkload } from '../dispatch';
import { collectRows, syncRectifications } from '../report-engine';
import { STATUS_LABEL, STATUS_COLOR, isStatus, type Status } from '../types';
import { requireProjectAccess, visibleProjectIds } from '../access';

export const assessmentRouter = Router();
assessmentRouter.use(requireAuth);

/** 取当前用户在某项目下所属的审核组 id 列表（无组则空数组） */
async function myGroupIds(projectId: string, uid: string): Promise<string[]> {
  const rows = await prisma.groupMember.findMany({
    where: { userId: uid, group: { projectId } },
    select: { groupId: true },
  });
  return rows.map((r) => r.groupId);
}

/**
 * 取某用户在某项目下可见的条款 id 集合（跨组合并去重）。
 * mode='chapter' 的范围展开为该章已分派条款；mode='clause' 为单条例外。
 */
async function visibleClauseIds(projectId: string, groupIds: string[]): Promise<Set<string>> {
  if (!groupIds.length) return new Set();
  const scopes = await prisma.groupScope.findMany({
    where: { groupId: { in: groupIds } },
    select: { chapterCode: true, gmpClauseId: true, mode: true },
  });
  const wholeChapters = [...new Set(scopes.filter((s) => s.mode === 'chapter').map((s) => s.chapterCode))];
  const singleIds = scopes
    .filter((s) => s.mode !== 'chapter' && s.gmpClauseId)
    .map((s) => s.gmpClauseId as string);
  const chapterItems = wholeChapters.length
    ? await prisma.planItem.findMany({
        where: { projectId, chapterCode: { in: wholeChapters } },
        select: { gmpClauseId: true },
      })
    : [];
  return new Set([...chapterItems.map((i) => i.gmpClauseId), ...singleIds]);
}

/**
 * GET /api/assessments/projects —— 可见项目列表
 * 审核员：仅返回自己作为组员参与的项目
 * 组长/管理员：返回全部
 */
assessmentRouter.get('/projects', async (req, res) => {
  const uid = req.user!.uid;
  const role = req.user!.role;

  const projects =
    role === 'auditor'
      ? await prisma.project.findMany({
          where: { status: 'active', groups: { some: { members: { some: { userId: uid } } } } },
          orderBy: { auditDate: 'desc' },
          select: { id: true, name: true, auditDate: true, status: true, clientName: true },
        })
      : await prisma.project.findMany({
          where: { status: 'active' },
          orderBy: { auditDate: 'desc' },
          select: { id: true, name: true, auditDate: true, status: true, clientName: true },
        });

  const withProgress = await Promise.all(
    projects.map(async (p) => {
      const base = { ...p, total: null as number | null, abnormal: null as number | null };
      if (role !== 'auditor') return base;
      const gids = await myGroupIds(p.id, uid);
      if (!gids.length) return base;
      const wl = await getGroupWorkload(p.id, gids);
      return { ...base, total: wl.total, abnormal: wl.abnormal };
    }),
  );
  res.json(withProgress);
});

/**
 * GET /api/assessments/my?projectId=xxx —— 当前用户的分层工作包
 * 可见范围 = 其所在审核组的 GroupScope 条款集合（跨组合并去重）
 * 默认全选「已落地」，未反选条款 status='landed'、verified=false
 */
assessmentRouter.get('/my', requireProjectAccess, async (req, res) => {
  const projectId = String(req.query.projectId || '');
  if (!projectId) return res.status(400).json({ error: '缺少 projectId' });
  const uid = req.user!.uid;
  const role = req.user!.role;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, auditDate: true },
  });

  // 组长/管理员：可见全部；审核员：仅本组
  let gids: string[] = [];
  if (role === 'auditor') {
    gids = await myGroupIds(projectId, uid);
    if (!gids.length) {
      return res.json({ projectId, project, total: 0, verified: 0, abnormal: 0, groups: [], statusMeta: [] });
    }
  } else {
    const gs = await prisma.auditGroup.findMany({ where: { projectId }, select: { id: true } });
    gids = gs.map((g) => g.id);
  }

  const wl = await getGroupWorkload(projectId, gids);
  res.json({
    projectId,
    project,
    total: wl.total,
    verified: wl.verified,
    abnormal: wl.abnormal,
    groups: wl.groups,
    statusMeta: Object.entries(STATUS_LABEL).map(([key, label]) => ({ key, label, color: STATUS_COLOR[key as Status] })),
  });
});

/**
 * POST /api/assessments/batch —— 批量同步（弱网恢复后自动 POST）
 * body: { projectId, items: [{ gmpClauseId, status }] }
 *
 * 反选模型要点：
 *   - 只提交「与默认不同」的条款；前端已把 clicked 项全量上报，后端幂等覆盖
 *   - status='landed' 表示显式确认落地（verified=true）
 *   - status='not_landed' → abnormal 自动置 true，并同步生成待整改条目
 *   - status='na'（不适用）需组长审批，先记 isApproved=false
 *   唯一键 projectId+gmpClauseId，实现「同一条只保留一条」
 */
assessmentRouter.post('/batch', requireProjectAccess, requireRole('auditor', 'leader', 'admin'), async (req, res) => {
  const { projectId, items } = req.body || {};
  if (!projectId || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: '缺少 projectId 或 items' });
  }
  if (items.length > 500) return res.status(400).json({ error: '单次提交不能超过 500 条' });

  const uid = req.user!.uid;
  const role = req.user!.role;

  // 越权校验：审核员只能提交自己被分派的条款（按审核组范围）
  let allowed: Set<string> | null = null;
  if (role === 'auditor') {
    const gids = await myGroupIds(projectId, uid);
    allowed = await visibleClauseIds(projectId, gids);
  }

  // 条款 → 责任审核组（用于整改条目归属）
  const groupIdByClause = new Map<string, string>();
  {
    const ids = [...new Set(items.map((i: any) => i?.gmpClauseId).filter(Boolean) as string[])];
    if (ids.length) {
      const scopes = await prisma.groupScope.findMany({
        where: { gmpClauseId: { in: ids }, group: { projectId } },
        select: { gmpClauseId: true, groupId: true },
      });
      for (const s of scopes) {
        const cid = s.gmpClauseId;
        if (cid && !groupIdByClause.has(cid)) groupIdByClause.set(cid, s.groupId);
      }
    }
  }

  // 审核员跨组时，每条评估归到它真正所属的组（跨组不去重）
  const gid = role === 'auditor' ? ((await myGroupIds(projectId, uid))[0] ?? null) : null;

  const accepted: string[] = [];
  const rejected: { gmpClauseId: string; reason: string }[] = [];
  const valid = items.filter((it: any) => {
    if (!it?.gmpClauseId || !isStatus(it.status)) {
      rejected.push({ gmpClauseId: it?.gmpClauseId ?? '(空)', reason: '状态值非法' });
      return false;
    }
    if (allowed && !allowed.has(it.gmpClauseId)) {
      rejected.push({ gmpClauseId: it.gmpClauseId, reason: '该条款未分派给当前审核组' });
      return false;
    }
    return true;
  });

  // 事务批量 upsert —— 提升弱网批量同步性能
  await prisma.$transaction(
    valid.map((it: any) => {
      const st = it.status as Status;
      const data = {
        status: st,
        abnormal: st === 'not_landed',
        isApproved: st === 'na' ? false : undefined,
        version: { increment: 1 },
      };
      // 逐条归属：优先用 GroupScope 解析出的责任组，退化到登录者所在组
      const gidRaw = groupIdByClause.get(it.gmpClauseId) ?? gid ?? '';
      const groupId = gidRaw; // 唯一键用（复合唯一键不接受 null）
      const groupIdOrNull = gidRaw || null; // 落库用（可空字段）
      return prisma.assessment.upsert({
        where: { projectId_gmpClauseId_groupId: { projectId, gmpClauseId: it.gmpClauseId, groupId } },
        create: {
          projectId,
          gmpClauseId: it.gmpClauseId,
          auditorId: uid,
          groupId: groupIdOrNull,
          status: st,
          abnormal: st === 'not_landed',
          isApproved: st === 'na' ? false : false,
        },
        update: data,
      });
    }),
  );
  valid.forEach((it: any) => accepted.push(it.gmpClauseId));

  // 未落地项自动汇总为待整改条目
  const sync = await syncRectifications(projectId);

  await writeLog({
    req,
    action: 'assessment_batch',
    target: `project:${projectId}`,
    detail: { count: accepted.length, rejected: rejected.length, rectify: sync },
  });

  // 报告若已复核，审核员再改动则回到「待复核」
  const rep = await prisma.report.findFirst({ where: { projectId }, orderBy: { updatedAt: 'desc' } });
  if (rep?.confirmedAt && accepted.length) {
    await prisma.report.update({ where: { id: rep.id }, data: { confirmedAt: null, confirmedBy: null } });
  }

  res.json({ ok: true, accepted, rejected, rectify: sync, syncedAt: new Date().toISOString() });
});

/**
 * POST /api/assessments/chapter —— 章节层反选（第一层）
 * body: { projectId, chapterCode, status }
 * 联动规则：取消章节勾选 → 该章全条款置 not_landed（批量生成异常 + 整改项）
 */
assessmentRouter.post('/chapter', requireProjectAccess, requireRole('auditor', 'leader', 'admin'), async (req, res) => {
  const { projectId, chapterCode, status } = req.body || {};
  if (!projectId || !chapterCode || !['landed', 'partial', 'not_landed'].includes(status)) {
    return res.status(400).json({ error: '参数非法：需 projectId / chapterCode / status(landed|partial|not_landed)' });
  }
  const uid = req.user!.uid;

  // 审核员只应改本组范围；组长/管理员可跨组（groupId 为空串表示覆盖全部已分派条款）
  const role = req.user!.role;
  let groupId = '';
  if (role === 'auditor') {
    const mem = await prisma.groupMember.findFirst({ where: { userId: uid, group: { projectId } } });
    groupId = mem?.groupId ?? '';
    if (!groupId) return res.status(403).json({ error: '当前账号未加入本项目任何审核组' });
  }

  const items = await prisma.planItem.findMany({
    where: { chapterCode, ...(groupId ? { groupId } : {}), projectId },
    select: { gmpClauseId: true },
  });
  if (!items.length) return res.status(400).json({ error: '该章节未分派任何条款' });

  // 整章取消勾选 → 全章条款置未落地（异常）
  if (status === 'not_landed') {
    await prisma.$transaction(
      items.map((i) =>
        prisma.assessment.upsert({
          where: { projectId_gmpClauseId_groupId: { projectId, gmpClauseId: i.gmpClauseId, groupId } },
          create: {
            projectId,
            gmpClauseId: i.gmpClauseId,
            auditorId: uid,
            groupId: groupId || null,
            status: 'not_landed',
            abnormal: true,
            isApproved: false,
          },
          update: { status: 'not_landed', abnormal: true, version: { increment: 1 } },
        }),
      ),
    );
  } else {
    // 勾回章节 → 只清掉本章的 not_landed，其余保持
    await prisma.assessment.updateMany({
      where: {
        projectId,
        ...(groupId ? { groupId } : {}),
        gmpClause: { chapterCode },
        status: 'not_landed',
      },
      data: { status: 'landed', abnormal: false, version: { increment: 1 } },
    });
  }

  const sync = await syncRectifications(projectId);
  await writeLog({
    req,
    action: 'chapter_toggle',
    target: `project:${projectId}/${chapterCode}`,
    detail: { status, touched: items.length, rectify: sync },
  });
  res.json({ ok: true, touched: items.length, rectify: sync });
});

/** GET /api/assessments/stats?projectId=xxx —— 轻量进度（顶部显示） */
assessmentRouter.get('/stats', requireProjectAccess, async (req, res) => {
  const projectId = String(req.query.projectId || '');
  const uid = req.user!.uid;
  const gids = await myGroupIds(projectId, uid);
  if (!gids.length) return res.json({ total: 0, verified: 0, abnormal: 0 });
  const wl = await getGroupWorkload(projectId, gids);
  res.json({ total: wl.total, verified: wl.verified, abnormal: wl.abnormal });
});

/**
 * GET /api/assessments/export?projectId=xxx —— 导出勾选结果 CSV（组长/管理员）
 * 输出全量条款（含默认已落地），便于归档与线下核对
 */
assessmentRouter.get('/export', requireProjectAccess, requireRole('leader', 'admin'), async (req, res) => {
  const projectId = String(req.query.projectId || '');
  const rows = await collectRows(projectId);
  const head = '条款号,章节,风险等级,《规范》条款,条款原文,ISO条款,责任审核组,状态,是否已核实';
  const body = rows
    .map((r) =>
      [
        r.code,
        r.chapterName,
        r.level,
        r.specClause ?? '',
        `"${r.text.replace(/"/g, '""')}"`,
        r.isoList.join('；'),
        r.groupNames.join('/'),
        STATUS_LABEL[r.status],
        r.verified ? '是' : '否（默认已落地）',
      ].join(','),
    )
    .join('\n');
  await writeLog({ req, action: 'assessment_export', target: `project:${projectId}`, detail: { rows: rows.length } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="assessments-${projectId}.csv"`);
  res.send('﻿' + head + '\n' + body); // BOM 保证 Excel 中文不乱码
});