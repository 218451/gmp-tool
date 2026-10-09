// ===== 过程工作包落库 =====
// 把 Word 计划解析结果（过程 × 审核组 × 条款）写成库里的可执行结构：
//   1. 审核组：按代号建组（组名即代号，如「A组」），成员按「审核组成员」表关联
//   2. PlanSlot：一行 = 「某过程派给某组」的工作包，含日期/时段/部门/场所
//   3. SlotRecord：工作包 → 具体 GMP 检查项（经ISO 条款映射表桥接）
//   4. PlanSlot 同步生成 AuditPlan，保证与旧的条款级看板口径一致
//
// 为什么不直接复用 dispatch.ts（章节级分派）：
// 真实计划里同一过程会派给多人（P7 同日出现 4 次分派给 A/B/C），
// 必须按「过程 × 组」建独立工作包，章节级分派会把它们合并掉。
import { prisma } from './db';
import type { ParseResult } from './plan-parser';
import { ISO_CLAUSES_WITHOUT_ITEM } from '../prisma/seed-data';

/**
 * ISO 条款 → GMP 检查项。
 *
 * 现实里计划书写的是「父级条款号」，而映射表存的是子项号：
 *   计划书 8.3  →  映射表 8.3.1 / 8.3.4
 *   计划书 5.5  →  映射表 5.5.1 / 5.5.2 / 5.5.3
 * 因此精确匹配失败时按「前缀 +点」做子项聚合（5. 不会误命中 50）。
 * 多条候选时取level 最重的一条（关键 > 主要 > 一般），保证风险不被稀释。
 */
async function mapIsoToClause(iso: string): Promise<{ id: string; chapterCode: string; label: string; aggregated: number } | null> {
  const weight: Record<string, number> = { 关键: 3, 主要: 2, 一般: 1 };

  let ms = await prisma.clauseMapping.findMany({
    where: { isoClause: iso, enabled: true },
    include: { gmpClause: true },
  });

  // 父级条款回退：8.3 → 8.3.1、8.3.4
  if (!ms.length) {
    ms = await prisma.clauseMapping.findMany({
      where: { isoClause: { startsWith: `${iso}.` }, enabled: true },
      include: { gmpClause: true },
    });
    if (ms.length) {
      // 子项聚合：同一检查项只落一条，取最重的映射
      const byGmp = new Map<string, (typeof ms)[number]>();
      for (const m of ms) {
        const cur = byGmp.get(m.gmpClauseId);
        if (!cur || (weight[m.gmpClause.level] || 0) > (weight[cur.gmpClause.level] || 0)) {
          byGmp.set(m.gmpClauseId, m);
        }
      }
      ms = [...byGmp.values()];
    }
  }

  if (!ms.length) return null;
  const best = ms.sort((a, b) => (weight[b.gmpClause.level] || 0) - (weight[a.gmpClause.level] || 0))[0];
  return {
    id: best.gmpClauseId,
    chapterCode: best.gmpClause.chapterCode,
    label: best.gmpClause.code,
    aggregated: ms.length,
  };
}

export interface IngestSummary {
  groups: string[];
  groupsCreated: string[];
  slots: number;
  slotRecords: number;
  unmappedIso: string[];
  unmatchedMembers: string[];
  /** 未能匹配到审核组的工作包（组名缺失，工作包未建） */
  unmatchedSlots: string[];
  /** 导入时自动创建的免密账号（审核员走姓名免密登录，无账号则工作包无人可登录） */
  autoCreatedUsers: string[];
  unmatchedIsoDetail: { slot: string; iso: string }[];
  /** 括号内的 GB/T 19001 并列条款：无 GMP 对应检查项，仅记录不告警 */
  dual9001: string[];
  /** 法规确无对应 GMP 检查项（体系审核仍不得漏审，需组长另行安排） */
  knownNoItem: string[];
  /** 映射表数据缺口（需管理员补映射） */
  mappingGap: string[];
}

export async function ingestProcessPlan(projectId: string, parsed: ParseResult): Promise<IngestSummary> {
  const summary: IngestSummary = {
    groups: [],
    groupsCreated: [],
    slots: 0,
    slotRecords: 0,
    unmappedIso: [],
    unmatchedMembers: [],
    unmatchedSlots: [],
    autoCreatedUsers: [],
    unmatchedIsoDetail: [],
    dual9001: [],
    knownNoItem: [],
    mappingGap: [],
  };

  // ---------- 1. 审核组：代号即组名 ----------
  const codes = [...new Set(parsed.slots.flatMap((s) => s.auditorCodes))];
  const memberByCode = new Map(parsed.members.map((m) => [m.code, m]));

  // 尝试匹配系统内已有审核员：先按姓名精确匹配，再按组内代号匹配登录名
  const users = await prisma.user.findMany({ where: { role: { in: ['auditor', 'leader'] } } });
  const matchUser = (code: string): string | null => {
    const info = memberByCode.get(code);
    if (info) {
      const byName = users.find((u) => u.name === info.name);
      if (byName) return byName.id;
      const byCode = users.find((u) => u.username?.toUpperCase() === code || u.username?.toUpperCase() === `${code}组`);
      if (byCode) return byCode.id;
    }
    return users.find((u) => u.name === code || u.username?.toUpperCase() === code)?.id ?? null;
  };

  /**
   * 审核员走免密登录（登录时只按姓名匹配），因此姓名在系统里唯一即可用。
   * 真实计划里常有组内审核员在系统中还没有账号 —— 此时自动建一个免密审核员账号，
   * 否则工作包分派下去没人能登录，计划就等于白做。
   */
  const ensureUser = async (code: string): Promise<string | null> => {
    const hit = matchUser(code);
    if (hit) return hit;
    const info = memberByCode.get(code);
    const name = info?.name || code;
    // 同名不同角色：若已存在该姓名（任何角色），直接复用，避免免密登录按姓名查不到
    const existed = await prisma.user.findFirst({ where: { name } });
    if (existed) {
      if (!existed.active) await prisma.user.update({ where: { id: existed.id }, data: { active: true } });
      return existed.id;
    }
    const created = await prisma.user.create({
      data: {
        username: `${code.toLowerCase()}#${Date.now().toString(36).slice(-4)}`,
        name,
        role: info?.role === '组长' ? 'leader' : 'auditor',
        dept: info?.specialty || null,
        active: true,
      },
    });
    users.push(created);
    summary.autoCreatedUsers.push(`${name}(${code})`);
    return created.id;
  };

  const groupIds = new Map<string, string>();
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const groupName = `${code}组`;
    summary.groups.push(groupName);
    const existing = await prisma.auditGroup.findFirst({ where: { projectId, name: groupName } });
    let gid = existing?.id;
    // 该组的组长（计划里「组内职务 = 组长」的那位）
    const leaderUid = memberByCode.get(code)?.role === '组长' ? await ensureUser(code) : null;
    if (!gid) {
      const created = await prisma.auditGroup.create({
        data: {
          projectId,
          name: groupName,
          leaderId: leaderUid,
          sort: i,
        },
      });
      gid = created.id;
      summary.groupsCreated.push(groupName);
    } else if (existing!.leaderId !== (leaderUid ?? null)) {
      // 组长字段与计划不一致时以计划为准：
      //   早期版本对每个组都无条件把首个成员当组长，导致「组内职务=组员」的人被误标为组长；
      //   现在计划里标「组长」的补齐、标「组员」的清空，界面上的组长字段才可信。
      await prisma.auditGroup.update({ where: { id: gid }, data: { leaderId: leaderUid } });
    }
    groupIds.set(code, gid);

    // 组成员：真实计划里一位审核员可能带多个代号（如同一人兼 A、B 组）
    const uid = await ensureUser(code);
    if (uid) {
      const memberRole = memberByCode.get(code)?.role === '组长' ? 'leader' : 'member';
      await prisma.groupMember.upsert({
        where: { groupId_userId: { groupId: gid, userId: uid } },
        create: { groupId: gid, userId: uid, role: memberRole },
        // 同步职务：早期导入把所有人都写成 member，计划里标明「组长」的人要能正确显示
        update: { role: memberRole },
      });
    } else if (parsed.members.length) {
      summary.unmatchedMembers.push(`${code}(${memberByCode.get(code)?.name || '未知'})`);
    }
  }

  // ---------- 2. PlanSlot：过程 × 组工作包 ----------
  // 清掉本项目旧工作包（计划只上传一次，重复导入以最新为准）
  await prisma.planSlot.deleteMany({ where: { projectId } });
  await prisma.auditPlan.deleteMany({ where: { projectId, source: 'word' } });

  let seq = 0;
  for (const s of parsed.slots) {
    const groupId = s.auditorCodes.map((c) => groupIds.get(c)).find(Boolean) ?? null;
    if (!groupId) {
      summary.unmatchedSlots.push(`${s.processCode} / ${s.auditorCodes.join('/')}`);
      continue;
    }
    const auditorName = s.auditorNames.join('、') || s.auditorCodes.join('');

    // 兼容旧的条款级计划表：每个工作包补一条 AuditPlan，看板与旧口径一致
    const plan = await prisma.auditPlan.create({
      data: {
        projectId,
        auditorName,
        groupName: s.auditorCodes.map((c) => `${c}组`).join('、'),
        processCode: s.processCode,
        processName: [s.processName, s.variant].filter(Boolean).join('（') + (s.variant ? '）' : ''),
        site: s.sites.join('/') || null,
        isoClause: s.isoClauses.map((t) => t.split(':')[1]).join('、'),
        processLabel: null,
        source: 'word',
        seq: seq++,
      },
    });

    const slot = await prisma.planSlot.create({
      data: {
        projectId,
        processCode: s.processCode,
        variant: s.variant || '',
        processName: s.processName || '',
        groupId,
        planId: plan.id,
        auditorName,
        site: s.sites.join('/') || null,
        slotDate: s.dateText || '',
        timeRange: s.timeRange || '',
        deptName: s.deptName || null,
        seq: seq++,
      },
    });
    summary.slots += 1;

    // ---------- 3. SlotRecord：条款 → GMP 检查项 ----------
    for (const tagged of s.isoClauses) {
      const [std, iso] = tagged.includes(':') ? tagged.split(':') : ['13485', tagged];
      // GB/T 19001（ISO 9001）条款不在 GMP 映射表覆盖范围内，只记录不映射，
      // 否则会污染「未映射条款」告警，让组长误以为映射表有缺口。
      if (std === '9001') {
        if (!summary.dual9001.includes(iso)) summary.dual9001.push(iso);
        continue;
      }
      const hit = await mapIsoToClause(iso);
      if (!hit) {
        // 区分两种「未映射」：法规确无对应检查项（正常，需提醒不得漏审）vs 映射表缺口（需补数据）
        const known = (ISO_CLAUSES_WITHOUT_ITEM as readonly string[]).includes(iso);
        const bucket = known ? summary.knownNoItem : summary.mappingGap;
        if (!bucket.includes(iso)) bucket.push(iso);
        summary.unmatchedIsoDetail.push({ slot: `${s.processCode}/${s.auditorCodes.join('')}`, iso });
        continue;
      }
      await prisma.slotRecord.upsert({
        where: { slotId_gmpClauseId: { slotId: slot.id, gmpClauseId: hit.id } },
        create: { slotId: slot.id, gmpClauseId: hit.id, isoClause: iso, processLabel: hit.label },
        update: { isoClause: iso, processLabel: hit.label },
      });
      summary.slotRecords += 1;

      // 同步写入 PlanItem（组内去重），保持与旧看板/报告口径一致
      await prisma.planItem.upsert({
        where: { projectId_gmpClauseId_groupId: { projectId, gmpClauseId: hit.id, groupId } },
        create: { projectId, planId: plan.id, groupId, chapterCode: hit.chapterCode, gmpClauseId: hit.id },
        update: { chapterCode: hit.chapterCode },
      });

      // 同步写入 GroupScope，让审核员的可见范围生效
      await prisma.groupScope.upsert({
        where: { groupId_chapterCode_gmpClauseId: { groupId, chapterCode: hit.chapterCode, gmpClauseId: hit.id } },
        create: { groupId, chapterCode: hit.chapterCode, mode: 'clause', gmpClauseId: hit.id },
        update: {},
      });
    }
  }

  return summary;
}