// ===== 过程工作包与审核关注点（审核员端）=====
// 审核员的实际工作单元是「过程工作包」：某过程在某天某时段派给本组，
// 下面挂着该组要审的 GMP 检查项，以及该过程模板里的全部审核关注点。
import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware';
import { writeLog } from '../log';
import { PROCESS_BY_CODE, type ProcessMeta } from '../process-meta';
import type { Status } from '../types';
import { requireProjectAccess } from '../access';

export const processRouter = Router();
processRouter.use(requireAuth);

/** 取当前用户在本项目的审核组 ID 列表 */
async function myGroupIds(projectId: string, userId: string): Promise<string[]> {
  const rows = await prisma.groupMember.findMany({
    where: { userId, group: { projectId } },
    select: { groupId: true },
  });
  return rows.map((r) => r.groupId);
}

/**
 * GET /api/processes —— 全部审核过程 + 关注点（组长/管理员用于总览与模板维护）
 */
processRouter.get('/processes', requireRole('leader', 'admin', 'auditor'), async (_req, res) => {
  const processes = await prisma.auditProcess.findMany({
    orderBy: { seq: 'asc' },
    include: { focuses: { orderBy: { seq: 'asc' } } },
  });
  res.json(
    processes.map((p) => ({
      code: p.code,
      name: p.name,
      seq: p.seq,
      isoText: p.isoText,
      focuses: p.focuses.map((f) => ({
        id: f.id,
        parentId: f.parentId,
        seq: f.seq,
        title: f.title,
        detail: safeJson(f.detail),
        checklist: safeJson(f.checklist),
        fillable: f.fillable,
      })),
    })),
  );
});

/**
 * GET /api/projects/:pid/process-slots —— 本人（或指定组）的过程工作包
 *
 * 每个工作包返回：过程信息、时间地点、受审核部门、待审检查项、关注点及各自判定状态。
 * 审核员只能看到自己组内的（越权返回空）。
 */
processRouter.get('/projects/:pid/process-slots', requireProjectAccess, async (req, res) => {
  const projectId = req.params.pid;
  const uid = req.user!.uid;
  const role = req.user!.role;

  const gids = await myGroupIds(projectId, uid);
  const scope = role === 'auditor' ? gids : null;
  if (role === 'auditor' && !gids.length) return res.json({ slots: [], groups: [] });

  const slots = await prisma.planSlot.findMany({
    where: { projectId, ...(scope ? { groupId: { in: scope } } : {}) },
    orderBy: [{ processCode: 'asc' }, { slotDate: 'asc' }, { timeRange: 'asc' }],
    include: {
      group: { select: { id: true, name: true } },
      process: { select: { code: true, name: true, isoText: true, focuses: { orderBy: { seq: 'asc' } } } },
      records: { include: { gmpClause: { select: { id: true, code: true, text: true, level: true, chapterCode: true } } } },
    },
  });

  // 收集全部关注点 ID，一次性查判定记录
  const focusIds = [...new Set(slots.flatMap((s) => s.process.focuses.map((f) => f.id)))];
  const recs = focusIds.length
    ? await prisma.focusRecord.findMany({
        where: { projectId, focusId: { in: focusIds }, ...(scope ? { groupId: { in: scope } } : {}) },
      })
    : [];
  const recByFocus = new Map<string, (typeof recs)[number]>();
  for (const r of recs) {
    // 跨组时以本组记录优先
    const cur = recByFocus.get(r.focusId);
    if (!cur || (r.groupId && !cur.groupId)) recByFocus.set(r.focusId, r);
  }

  // 检查项的落地判定（与关注点判定并列，用于 GMP 落地评估）
  const clauseIds = [...new Set(slots.flatMap((s) => s.records.map((r) => r.gmpClauseId)))];
  const asm = clauseIds.length
    ? await prisma.assessment.findMany({ where: { projectId, gmpClauseId: { in: clauseIds }, ...(scope ? { groupId: { in: scope } } : {}) } })
    : [];
  const asmByClause = new Map<string, (typeof asm)[number]>();
  for (const a of asm) {
    const cur = asmByClause.get(a.gmpClauseId);
    if (!cur || (a.groupId && !cur.groupId)) asmByClause.set(a.gmpClauseId, a);
  }

  const groups = await prisma.auditGroup.findMany({
    where: { projectId, ...(scope ? { id: { in: scope } } : {}) },
    select: { id: true, name: true },
    orderBy: { sort: 'asc' },
  });

  // ★ 跨过程/跨组重复检查（业务口径：同一个 ISO 条款会同时落进多个过程）
  // 审核员在 P8 看到 8.2.6 时，需要知道 P9/P10 也审了同一条 —— 否则会重复劳动或漏判。
  const allRefs = await prisma.slotRecord.findMany({
    where: { slot: { projectId } },
    select: {
      gmpClauseId: true,
      slot: { select: { processCode: true, group: { select: { name: true } } } },
    },
  });
  const refsByClause = new Map<string, { processes: Set<string>; groups: Set<string> }>();
  for (const r of allRefs) {
    const cur = refsByClause.get(r.gmpClauseId) ?? { processes: new Set<string>(), groups: new Set<string>() };
    cur.processes.add(r.slot.processCode);
    if (r.slot.group?.name) cur.groups.add(r.slot.group.name);
    refsByClause.set(r.gmpClauseId, cur);
  }

  const gnameById = new Map(groups.map((g) => [g.id, g.name]));

  res.json({
    groups,
    slots: slots.map((s) => {
      // 反选语义：只有显式提交过才落库，故「有记录」即等价于已确认
      const done = s.records.filter((r) => asmByClause.has(r.gmpClauseId)).length;
      const fDone = s.process.focuses.filter((f) => recByFocus.get(f.id)?.verified).length;
      const meta: ProcessMeta | undefined = PROCESS_BY_CODE.get(s.processCode);
      return {
        id: s.id,
        processCode: s.processCode,
        processName: s.processName || meta?.name || s.process.name,
        // 权威口径：过程名以 process-meta.ts 为准，计划书里的写法作为变体保留
        processMeta: meta
          ? { name: meta.name, elements: meta.elements, kind: meta.kind, scopeNote: meta.scopeNote }
          : null,
        variant: s.variant,
        isoText: s.process.isoText,
        group: s.group,
        auditorName: s.auditorName,
        site: s.site,
        slotDate: s.slotDate,
        timeRange: s.timeRange,
        deptName: s.deptName,
        clauses: s.records.map((r) => {
          const ref = refsByClause.get(r.gmpClauseId);
          const dupProcesses = ref ? [...ref.processes].filter((p) => p !== s.processCode) : [];
          const otherGroups = ref
            ? [...ref.groups].filter((g) => g !== (s.group ? gnameById.get(s.group.id) : undefined))
            : [];
          return {
            id: r.gmpClause.id,
            code: r.gmpClause.code,
            text: r.gmpClause.text,
            level: r.gmpClause.level,
            chapterCode: r.gmpClause.chapterCode,
            isoClause: r.isoClause,
            status: asmByClause.get(r.gmpClauseId)?.status ?? 'landed',
            verified: asmByClause.has(r.gmpClauseId),
            // 重复信息：审核员据此判断「这条是否本组已在他处审过」
            dupProcesses,
            dupProcessCount: dupProcesses.length,
            dupGroups: otherGroups,
            dupGroupCount: otherGroups.length,
          };
        }),
        focuses: s.process.focuses.map((f) => {
          const rec = recByFocus.get(f.id);
          return {
            id: f.id,
            parentId: f.parentId,
            seq: f.seq,
            title: f.title,
            detail: safeJson(f.detail),
            checklist: safeJson(f.checklist),
            fillable: f.fillable,
            status: rec?.status ?? 'landed',
            note: rec?.note ?? '',
            evidence: rec ? safeJson(rec.evidence) : [],
            verified: !!rec?.verified,
          };
        }),
        progress: {
          clauses: { done, total: s.records.length },
          focuses: { done: fDone, total: s.process.focuses.filter((f) => f.fillable).length },
        },
      };
    }),
  });
});

/**
 * POST /api/projects/:pid/focus-records —— 保存某工作包的关注点判定
 * body: { slotId, items: [{ focusId, status, note?, evidence? }] }
 * 反选语义：默认「已落地」，只有显式提交才落库并标记 verified。
 */
processRouter.post('/projects/:pid/focus-records', requireProjectAccess, requireRole('auditor', 'leader', 'admin'), async (req, res) => {
  const projectId = req.params.pid;
  const { slotId, items } = req.body || {};
  if (!slotId || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: '缺少 slotId 或 items' });
  }
  if (items.length > 200) return res.status(400).json({ error: '单次提交不能超过 200 条' });

  const uid = req.user!.uid;
  const role = req.user!.role;

  // 越权校验：审核员只能改本组工作包
  const slot = await prisma.planSlot.findFirst({
    where: { id: slotId, projectId },
    select: { id: true, groupId: true, processCode: true },
  });
  if (!slot) return res.status(404).json({ error: '工作包不存在' });
  if (role === 'auditor') {
    const gids = await myGroupIds(projectId, uid);
    if (!slot.groupId || !gids.includes(slot.groupId)) {
      return res.status(403).json({ error: '该工作包未分派给当前审核组' });
    }
  }

  const valid: { focusId: string; status: Status; note?: string; evidence?: string[] }[] = [];
  const rejected: { focusId: string; reason: string }[] = [];
  for (const it of items) {
    if (!it?.focusId || !['landed', 'partial', 'not_landed', 'na'].includes(it.status)) {
      rejected.push({ focusId: it?.focusId ?? '(空)', reason: '状态值非法' });
      continue;
    }
    valid.push({
      focusId: it.focusId,
      status: it.status as Status,
      note: typeof it.note === 'string' ? it.note.slice(0, 2000) : undefined,
      evidence: Array.isArray(it.evidence) ? it.evidence.slice(0, 20).map((x: unknown) => String(x).slice(0, 200)) : undefined,
    });
  }

  await prisma.$transaction(
    valid.map((v) =>
      prisma.focusRecord.upsert({
        where: { projectId_focusId_groupId: { projectId, focusId: v.focusId, groupId: slot.groupId ?? '' } },
        create: {
          projectId,
          focusId: v.focusId,
          groupId: slot.groupId,
          processCode: slot.processCode,
          status: v.status,
          note: v.note ?? null,
          evidence: JSON.stringify(v.evidence ?? []),
          verified: true,
          updatedBy: uid,
        },
        update: {
          status: v.status,
          ...(v.note !== undefined ? { note: v.note } : {}),
          ...(v.evidence !== undefined ? { evidence: JSON.stringify(v.evidence) } : {}),
          verified: true,
          updatedBy: uid,
        },
      }),
    ),
  );

  await writeLog({
    req,
    action: 'focus_record_batch',
    target: `slot:${slotId}`,
    detail: { count: valid.length, rejected: rejected.length, processCode: slot.processCode },
  });

  res.json({ saved: valid.length, rejected });
});

function safeJson(s: string): string[] {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}