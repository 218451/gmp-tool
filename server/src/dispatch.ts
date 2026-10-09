// ===== 审核计划 -> 审核组范围 自动分派引擎（分层模型）=====
import { prisma } from './db';

/**
 * 依据 AuditPlan 的 ISO 条款，从 ClauseMapping 查出该条款覆盖的 GMP 检查项，
 * 建立 PlanItem（项目级条款去重），并把条款归入对应审核组的 GroupScope。
 *
 * 规则：
 * 1. 只取 enabled=true 的映射；
 * 2. 项目级去重：同一检查项只分派一次（@@unique([projectId, gmpClauseId])），
 *    避免两名审核员因条款重叠重复劳动；
 * 3. 无映射时回退到「按过程名称模糊匹配章节关键词」，仍无结果记入 no_mapping；
 * 4. 零分派区分两因：no_mapping（映射表缺）/ deduped（已被他人领走，正常）。
 */

export interface DispatchResult {
  planId: string;
  isoClause: string;
  processName: string;
  auditorName: string;
  groupId: string | null;
  matched: number;
  fallback: boolean;
  /** 零分派原因：无映射 / 被同组其他条款去重 / 正常 */
  zeroReason: 'no_mapping' | 'deduped' | null;
}

/** 建立/刷新某项目的全部分派关系与审核组范围（幂等：先清空再重建） */
export async function dispatchProject(projectId: string): Promise<DispatchResult[]> {
  const [plans, mappings, groups] = await Promise.all([
    prisma.auditPlan.findMany({ where: { projectId }, orderBy: { seq: 'asc' } }),
    prisma.clauseMapping.findMany({ where: { enabled: true } }),
    prisma.auditGroup.findMany({ where: { projectId } }),
  ]);

  // 按 ISO 条款索引映射
  const byIso = new Map<string, string[]>();
  for (const m of mappings) {
    const arr = byIso.get(m.isoClause) || [];
    arr.push(m.gmpClauseId);
    byIso.set(m.isoClause, arr);
  }

  // 回退索引：按章节关键词匹配过程名称
  const allClauses = await prisma.gmpClause.findMany({ select: { id: true, chapterCode: true } });
  const chapterName = new Map<string, string>();
  {
    const chs = await prisma.gmpChapter.findMany();
    for (const c of chs) chapterName.set(c.code, c.name);
  }
  const byChapter = new Map<string, string[]>();
  for (const c of allClauses) {
    const arr = byChapter.get(c.chapterCode) || [];
    arr.push(c.id);
    byChapter.set(c.chapterCode, arr);
  }

  // 审核组名 -> groupId（计划里的 groupName 优先，其次按「审核组·审核员名」约定）
  const groupByName = new Map<string, string>();
  for (const g of groups) groupByName.set(g.name, g.id);

  // 需要 chapterCode 冗余到 PlanItem
  const clauseChapter = new Map(allClauses.map((c) => [c.id, c.chapterCode]));

  // 清空旧的分派与范围（保留 Assessment / Rectification 记录不动）
  await prisma.planItem.deleteMany({ where: { projectId } });
  await prisma.groupScope.deleteMany({ where: { group: { projectId } } });

  const results: DispatchResult[] = [];
  /** 审核组 -> 已纳入的条款（用于组内去重与零分派归因） */
  const groupTaken = new Map<string, Set<string>>();

  for (const plan of plans) {
    const gname = plan.groupName || `审核组·${plan.auditorName}`;
    const groupId = groupByName.get(gname) ?? null;
    const procLabel = plan.processName || '';

    let ids = byIso.get(plan.isoClause) || [];
    let fallback = false;

    if (ids.length === 0 && procLabel) {
      // 回退：过程名称中包含某章节名（或反之）则匹配之
      const hit = [...chapterName.entries()].find(
        ([, name]) => procLabel.includes(name) || name.includes(procLabel),
      );
      if (hit) {
        ids = byChapter.get(hit[0]) || [];
        fallback = true;
      }
    }

    // 组内去重：同一检查项在同一审核组内只保留一条，跨组各自独立
    const seenInGroup = groupTaken.get(groupId ?? '') || new Set<string>();
    const fresh = ids.filter((id) => !seenInGroup.has(id));
    fresh.forEach((id) => seenInGroup.add(id));
    groupTaken.set(groupId ?? '', seenInGroup);

    if (fresh.length) {
      await prisma.planItem.createMany({
        data: fresh.map((gmpClauseId) => ({
          projectId,
          planId: plan.id,
          groupId,
          gmpClauseId,
          chapterCode: clauseChapter.get(gmpClauseId) || 'CH01',
        })),
      });
      // 归入审核组范围（按章节聚合，便于分层勾选界面渲染）
      if (groupId) {
        const byCh = new Map<string, string[]>();
        for (const id of fresh) {
          const ch = clauseChapter.get(id) || 'CH01';
          const arr = byCh.get(ch) || [];
          arr.push(id);
          byCh.set(ch, arr);
        }
        for (const [chapterCode, clauseIds] of byCh) {
          for (const gmpClauseId of clauseIds) {
            await prisma.groupScope.upsert({
              where: { groupId_chapterCode_gmpClauseId: { groupId, chapterCode, gmpClauseId } },
              create: { groupId, chapterCode, mode: 'clause', gmpClauseId },
              update: {},
            });
          }
        }
      }
    }

    const zeroReason = fresh.length ? null : ids.length ? 'deduped' : 'no_mapping';
    results.push({
      planId: plan.id,
      isoClause: plan.isoClause,
      processName: procLabel,
      auditorName: plan.auditorName,
      groupId,
      matched: fresh.length,
      fallback,
      zeroReason,
    });
  }

  return results;
}

/** 兼容旧调用名 */
export const dispatchProjectPlans = dispatchProject;

/**
 * 覆盖度重算：清理「计划已删除但仍留存的 Assessment」孤儿记录。
 * 在计划增删改、报告生成前调用，保证统计口径干净。
 */
export async function pruneOrphanAssessments(projectId: string) {
  const items = await prisma.planItem.findMany({
    where: { projectId },
    select: { gmpClauseId: true },
  });
  const valid = new Set(items.map((i) => i.gmpClauseId));
  const all = await prisma.assessment.findMany({ where: { projectId }, select: { id: true, gmpClauseId: true } });
  const orphans = all.filter((a) => !valid.has(a.gmpClauseId));
  if (orphans.length) {
    // 连带删除整改条目（外键级联）
    await prisma.assessment.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
  }
  return orphans.length;
}

/**
 * 查询某审核员在某项目下的工作包（分层结构）。
 * 可见范围 = 其所在审核组的 GroupScope 条款集合（跨组合并去重）。
 * 默认全选「已落地」，因此未反选的条款不出现在 Assessment 里，返回时补齐。
 */
export async function getGroupWorkload(projectId: string, groupIds: string[]) {
  const scopes = await prisma.groupScope.findMany({
    where: { groupId: { in: groupIds } },
    select: { chapterCode: true, gmpClauseId: true, mode: true, groupId: true },
  });
  // mode='chapter' 表示整章可见（取该章已分派条款）；mode='clause' 为单条例外
  const wholeChapters = [...new Set(scopes.filter((s) => s.mode === 'chapter').map((s) => s.chapterCode))];
  const singleIds = scopes.filter((s) => s.mode !== 'chapter' && s.gmpClauseId).map((s) => s.gmpClauseId as string);

  const chapterItems = wholeChapters.length
    ? await prisma.planItem.findMany({
        where: { projectId, chapterCode: { in: wholeChapters } },
        select: { gmpClauseId: true },
      })
    : [];
  const gmpIds = [...new Set([...chapterItems.map((i) => i.gmpClauseId), ...singleIds])];

  const [chapters, clauses, assessments] = await Promise.all([
    prisma.gmpChapter.findMany({ orderBy: { seq: 'asc' } }),
    gmpIds.length ? prisma.gmpClause.findMany({ where: { id: { in: gmpIds } }, orderBy: { seq: 'asc' } }) : Promise.resolve([]),
    gmpIds.length ? prisma.assessment.findMany({ where: { projectId, gmpClauseId: { in: gmpIds } } }) : Promise.resolve([]),
  ]);

  const statusMap = new Map(assessments.map((a) => [a.gmpClauseId, a]));
  const chapterByCode = new Map(chapters.map((c) => [c.code, c]));

  // 按章节分组输出
  const grouped = chapters
    .map((ch) => {
      const items = clauses
        .filter((c) => c.chapterCode === ch.code)
        .map((c) => {
          const a = statusMap.get(c.id);
          return {
            id: c.id,
            code: c.code,
            text: c.text,
            level: c.level,
            specClause: c.specClause,
            way: c.way,
            note: c.note,
            isoList: safeJson(c.isoClauses),
            status: a?.status ?? 'landed', // 默认全选「已落地」
            verified: Boolean(a),
            abnormal: a?.abnormal ?? false,
          };
        });
      // 章节状态由条款层推导
      const nl = items.filter((i) => i.status === 'not_landed').length;
      const pa = items.filter((i) => i.status === 'partial').length;
      const chapterStatus = nl === 0 && pa === 0 ? 'landed' : nl >= items.length ? 'not_landed' : 'partial';
      return {
        code: ch.code,
        name: ch.name,
        seq: ch.seq,
        focus: ch.focus,
        total: items.length,
        notLanded: nl,
        partial: pa,
        status: chapterStatus,
        items,
      };
    })
    .filter((g) => g.total > 0);

  const allItems = grouped.flatMap((g) => g.items);
  return {
    total: allItems.length,
    // 「已核实」= 实际点过的条款数；未点过的是默认已落地
    verified: allItems.filter((i) => i.verified).length,
    abnormal: allItems.filter((i) => i.abnormal).length,
    groups: grouped,
  };
}

function safeJson(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}