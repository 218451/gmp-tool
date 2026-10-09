// ===== 审核员「章节视图」=====
/**
 * 业务口径（负责人明确）：
 *   审核员打开项目时，界面的主线必须是《新版 GMP 检查指导原则》的十四章，
 *   不是审核计划里的 P1~P12 过程。P 过程只是「谁去审」的分工信息，
 *   退为章节标题后的括号备注（如「第二章 质量保证（P1、P3）」）。
 *
 * 为什么这样分层：
 *   1. 指导原则是审核的法定依据，审核员手上一份 200 条检查项，
 *      按章找条款符合现场习惯；按 P 过程找会把同一条款拆散到多处。
 *   2. 章内再按「关键项 / 主要项 / 一般项」分层 —— 这是指导原则原有的
 *      风险分级，39/88/73 条，红线判定也依赖这个分级。
 *   3. 默认全选已落地、只反选未落地（沿用分层反选模型），无提交按钮。
 *
 * 与过程工作台（process-slots）的关系：
 *   两者是同一份数据的两种切法。过程工作台按「P几 × 哪天 × 哪个组」排班，
 *   供组长看分工与排期；本章视图按章排，是审核员的主工作界面。
 *   判定数据共用同一张 Assessment 表（唯一键 projectId+gmpClauseId+groupId），
 *   所以两处反选互相实时生效，不会产生两份状态。
 */
import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware';
import { PROCESS_BY_CODE } from '../process-meta';
import { requireProjectAccess } from '../access';

export const chapterViewRouter = Router();
chapterViewRouter.use(requireAuth);

/** 章节 → 分层的固定顺序：关键 → 主要 → 一般 */
const LEVELS = ['关键', '主要', '一般'] as const;

/** 取当前用户在本项目的审核组 ID 列表 */
async function myGroupIds(projectId: string, userId: string): Promise<string[]> {
  const rows = await prisma.groupMember.findMany({
    where: { userId, group: { projectId } },
    select: { groupId: true },
  });
  return rows.map((r) => r.groupId);
}

/**
 * GET /api/projects/:pid/chapter-view —— 审核员按章工作台
 *
 * 返回结构：
 *   chapters[]          十四章，按 seq 升序，只含有分派条款的章
 *     ├ code/name/seq   章节
 *     ├ processCodes    本章条款涉及的 P 过程 → 界面上做括号备注
 *     ├ counts         章内各层条数与已核实数
 *     └ levels[]       关键项 / 主要项 / 一般项三层，每层挂 clauses[]
 *   clauses[]           该条款的全量信息（原文、层级、ISO 条款、状态）
 *   focusBlocks[]       现场核查要点（辅助，不计入报告），标注来自哪个 P 过程
 *
 * 可见范围：审核员 = 本组（跨组去重）；组长/管理员 = 全部组。
 */
chapterViewRouter.get('/projects/:pid/chapter-view', requireProjectAccess, async (req, res) => {
  const projectId = req.params.pid;
  const uid = req.user!.uid;
  const role = req.user!.role;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, auditDate: true, clientName: true },
  });
  if (!project) return res.status(404).json({ error: '项目不存在' });

  // ---- 1. 确定可见的审核组 ----
  let gids: string[] = [];
  if (role === 'auditor') {
    gids = await myGroupIds(projectId, uid);
    if (!gids.length) {
      return res.json({
        project,
        scope: { role, groupIds: [], groupNames: [] },
        totals: emptyTotals(),
        chapters: [],
        focusBlocks: [],
      });
    }
  } else {
    gids = (await prisma.auditGroup.findMany({ where: { projectId }, select: { id: true } })).map((g) => g.id);
  }
  if (!gids.length) {
    return res.json({
      project,
      scope: { role, groupIds: [], groupNames: [] },
      totals: emptyTotals(),
      chapters: [],
      focusBlocks: [],
    });
  }

  const groups = await prisma.auditGroup.findMany({
    where: { id: { in: gids } },
    select: { id: true, name: true, sort: true },
    orderBy: { sort: 'asc' },
  });
  const gnameById = new Map(groups.map((g) => [g.id, g.name]));

  // ---- 2. 本次可见的工作包（决定「哪些条款要审」与「由谁审」）----
  const slots = await prisma.planSlot.findMany({
    where: { projectId, groupId: { in: gids } },
    select: {
      id: true,
      processCode: true,
      processName: true,
      variant: true,
      groupId: true,
      auditorName: true,
      slotDate: true,
      timeRange: true,
      deptName: true,
      site: true,
      records: { select: { gmpClauseId: true, isoClause: true } },
    },
  });
  // 可见条款 = 本组工作包挂的全部条款（跨过程去重）
  const visibleClauseIds = [...new Set(slots.flatMap((s) => s.records.map((r) => r.gmpClauseId)))];

  // ---- 3. 条款主数据（含章节与层级）----
  const clauses = visibleClauseIds.length
    ? await prisma.gmpClause.findMany({
        where: { id: { in: visibleClauseIds } },
        select: {
          id: true,
          code: true,
          text: true,
          level: true,
          chapterCode: true,
          specClause: true,
          way: true,
          note: true,
          isoClauses: true,
          isoNames: true,
        },
      })
    : [];
  const clauseById = new Map(clauses.map((c) => [c.id, c]));

  // ---- 4. 落地判定（本组口径；无记录 = landed + verified=false）----
  const asm = visibleClauseIds.length
    ? await prisma.assessment.findMany({
        where: { projectId, gmpClauseId: { in: visibleClauseIds }, groupId: { in: gids } },
        select: { gmpClauseId: true, status: true, remark: true },
      })
    : [];
  // 同一条被组内多个工作包引用时只会有一条记录（唯一键含 groupId）
  const asmByClause = new Map(asm.map((a) => [a.gmpClauseId, a]));

  // ---- 5. 全项目重复引用统计（跨过程 / 跨组）----
  // 用途：界面上提示「这条 P8 也审、P10 也审」，避免重复劳动或漏判。
  const allRefs = await prisma.slotRecord.findMany({
    where: { slot: { projectId } },
    select: {
      gmpClauseId: true,
      slot: { select: { processCode: true, groupId: true } },
    },
  });
  // 全项目所有组的 id→name（重复提示要显示别组的组名，故不能只取可见组）
  const allGroupRows = await prisma.auditGroup.findMany({ where: { projectId }, select: { id: true, name: true } });
  const allGroupName = new Map(allGroupRows.map((g) => [g.id, g.name]));

  const refStat = new Map<string, { processes: Set<string>; groups: Set<string> }>();
  for (const r of allRefs) {
    const cur = refStat.get(r.gmpClauseId) ?? { processes: new Set<string>(), groups: new Set<string>() };
    cur.processes.add(r.slot.processCode);
    const gn = r.slot.groupId ? allGroupName.get(r.slot.groupId) : undefined;
    if (gn) cur.groups.add(gn);
    refStat.set(r.gmpClauseId, cur);
  }

  // ---- 6. 按章节聚合 ----
  const chapters = await prisma.gmpChapter.findMany({
    where: { code: { in: [...new Set(clauses.map((c) => c.chapterCode))] } },
    orderBy: { seq: 'asc' },
    select: { code: true, name: true, seq: true, focus: true, itemCount: true, keyCount: true, mainCount: true, genCount: true },
  });

  // 条款 → 分派它的（过程, 组, 工作包）组合，用于章内展示「由谁审」
  const dispatchByClause = new Map<string, { processes: Set<string>; groups: Set<string>; slots: Set<string> }>();
  for (const s of slots) {
    for (const r of s.records) {
      const cur = dispatchByClause.get(r.gmpClauseId) ?? { processes: new Set<string>(), groups: new Set<string>(), slots: new Set<string>() };
      cur.processes.add(s.processCode);
      const gn = s.groupId ? gnameById.get(s.groupId) : undefined;
      if (gn) cur.groups.add(gn);
      cur.slots.add(s.id);
      dispatchByClause.set(r.gmpClauseId, cur);
    }
  }

  const outChapters = chapters
    .map((ch) => {
      const mine = clauses.filter((c) => c.chapterCode === ch.code);
      const levels = LEVELS.map((lv) => {
        const items = mine
          .filter((c) => c.level === lv)
          .sort((a, b) => a.code.localeCompare(b.code, 'zh', { numeric: true }))
          .map((c) => {
            const rec = asmByClause.get(c.id);
            const ref = refStat.get(c.id);
            const disp = dispatchByClause.get(c.id);
            // 本组可见的过程集合 vs 全项目的过程集合 —— 差集即「别处也审这条」
            const mineProcs = [...(disp?.processes ?? [])];
            const allProcs = ref ? [...ref.processes] : mineProcs;
            const allGroups = ref ? [...ref.groups] : [...(disp?.groups ?? [])];
            return {
              id: c.id,
              code: c.code,
              text: c.text,
              level: c.level,
              chapterCode: c.chapterCode,
              specClause: c.specClause,
              way: c.way,
              note: c.note,
              isoClause: safeJson(c.isoClauses),
              isoNames: safeJson(c.isoNames),
              // 反选模型：无记录 = 已落地（默认勾选）+ 未核实
              status: rec?.status ?? 'landed',
              verified: !!rec,
              remark: rec?.remark ?? '',
              // 本组内由哪些过程审
              processCodes: mineProcs,
              // 别处（其他过程）也审这条
              dupProcesses: allProcs.filter((p) => !mineProcs.includes(p)),
              // 别处（其他组）也审这条
              dupGroups: allGroups.filter((g) => !disp?.groups.has(g)),
              dupGroupCount: allGroups.filter((g) => !disp?.groups.has(g)).length,
            };
          });
        return {
          level: lv,
          total: items.length,
          verified: items.filter((i) => i.verified).length,
          notLanded: items.filter((i) => i.status === 'not_landed').length,
          partial: items.filter((i) => i.status === 'partial').length,
          items,
        };
      })
      .filter((l) => l.total > 0); // 三层里没条款的不占位（章内可能只有「关键 + 一般」）

      const dispProcs = new Set<string>();
      for (const c of mine) for (const p of dispatchByClause.get(c.id)?.processes ?? []) dispProcs.add(p);

      return {
        code: ch.code,
        name: ch.name,
        seq: ch.seq,
        focus: ch.focus,
        // 指导原则原章规模（来自 200 条全表），供审核员判断本章分量
        chapterTotals: { all: ch.itemCount, key: ch.keyCount, main: ch.mainCount, general: ch.genCount },
        // 本次（本人可见）范围
        total: mine.length,
        verified: levels.reduce((a, l) => a + l.verified, 0),
        notLanded: levels.reduce((a, l) => a + l.notLanded, 0),
        partial: levels.reduce((a, l) => a + l.partial, 0),
        // ★ 括号备注的数据源：本章条款涉及的 P 过程
        processCodes: [...dispProcs].sort((a, b) => a.localeCompare(b, 'zh', { numeric: true })),
        processNames: [...dispProcs]
          .sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }))
          .map((p) => ({ code: p, name: PROCESS_BY_CODE.get(p)?.name ?? '' })),
        groupNames: [...new Set(mine.flatMap((c) => [...(dispatchByClause.get(c.id)?.groups ?? [])]))],
        levels,
      };
    })
    .filter((c) => c.total > 0);

  // ---- 7. 现场核查要点（辅助，不计入报告）----
  // 按 P 过程给块，并在块上标注它服务于本章的哪些条款。
  const procCodes = [...new Set(slots.map((s) => s.processCode))];
  const procSet = await prisma.auditProcess.findMany({
    where: { code: { in: procCodes } },
    select: { code: true, name: true, seq: true, focuses: { orderBy: { seq: 'asc' }, select: { id: true } } },
    orderBy: { seq: 'asc' },
  });
  const focusIds = procSet.flatMap((p) => p.focuses.map((f) => f.id));
  const focusRecs = focusIds.length
    ? await prisma.focusRecord.findMany({
        where: { projectId, focusId: { in: focusIds }, groupId: { in: gids } },
        select: { focusId: true, status: true, note: true, evidence: true, verified: true },
      })
    : [];
  const frecByFocus = new Map<string, (typeof focusRecs)[number]>();
  for (const r of focusRecs) if (!frecByFocus.has(r.focusId)) frecByFocus.set(r.focusId, r);

  const focusBlocks = procSet.map((p) => {
    const ps = slots.filter((s) => s.processCode === p.code);
    const pClauseIds = new Set(ps.flatMap((s) => s.records.map((r) => r.gmpClauseId)));
    const chaptersTouched = [...new Set([...pClauseIds].map((id) => clauseById.get(id)?.chapterCode).filter(Boolean) as string[])];
    return {
      processCode: p.code,
      processName: PROCESS_BY_CODE.get(p.code)?.name ?? p.name,
      processElements: PROCESS_BY_CODE.get(p.code)?.elements ?? '',
      processScopeNote: PROCESS_BY_CODE.get(p.code)?.scopeNote ?? '',
      slotCount: ps.length,
      groupNames: [...new Set(ps.map((s) => (s.groupId ? gnameById.get(s.groupId) : '')).filter(Boolean))],
      dates: [...new Set(ps.map((s) => s.slotDate).filter(Boolean))] as string[],
      chapterCodes: chaptersTouched,
      focusIds: p.focuses.map((f) => f.id),
      focusTotal: p.focuses.length,
      focusDone: p.focuses.filter((f) => frecByFocus.get(f.id)?.verified).length,
      records: p.focuses.map((f) => frecByFocus.get(f.id)),
    };
  });

  // ---- 8. 总计 ----
  const allLevels = outChapters.flatMap((c) => c.levels);
  const totals = {
    chapters: outChapters.length,
    clauses: outChapters.reduce((a, c) => a + c.total, 0),
    verified: outChapters.reduce((a, c) => a + c.verified, 0),
    notLanded: outChapters.reduce((a, c) => a + c.notLanded, 0),
    partial: outChapters.reduce((a, c) => a + c.partial, 0),
    byLevel: Object.fromEntries(
      LEVELS.map((lv) => {
        const ls = allLevels.filter((l) => l.level === lv);
        return [
          lv,
          {
            total: ls.reduce((a, l) => a + l.total, 0),
            verified: ls.reduce((a, l) => a + l.verified, 0),
            notLanded: ls.reduce((a, l) => a + l.notLanded, 0),
          },
        ];
      }),
    ) as Record<string, { total: number; verified: number; notLanded: number }>,
    slots: slots.length,
    focusTotal: focusBlocks.reduce((a, b) => a + b.focusTotal, 0),
    focusDone: focusBlocks.reduce((a, b) => a + b.focusDone, 0),
  };

  void slots; // slots 已在上方聚合完毕，此处仅避免未使用告警

  res.json({
    project,
    scope: { role, groupIds: gids, groupNames: groups.map((g) => g.name) },
    totals,
    chapters: outChapters,
    focusBlocks,
  });
});

function emptyTotals() {
  return {
    chapters: 0,
    clauses: 0,
    verified: 0,
    notLanded: 0,
    partial: 0,
    byLevel: {
      关键: { total: 0, verified: 0, notLanded: 0 },
      主要: { total: 0, verified: 0, notLanded: 0 },
      一般: { total: 0, verified: 0, notLanded: 0 },
    } as Record<string, { total: number; verified: number; notLanded: number }>,
    slots: 0,
    focusTotal: 0,
    focusDone: 0,
  };
}

function safeJson(s: string): string[] {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
