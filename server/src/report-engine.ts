// ===== 统计与报告计算引擎（分层反选模型）=====
import { prisma } from './db';
import {
  STATUS_LABEL,
  STATUS_COLOR,
  REDLINE_RULES,
  FOCUS_CATEGORIES,
  derivePriority,
  type Status,
  type Priority,
} from './types';
import { deriveProblems, deriveVerdict, type ProblemGroup, type OverallVerdict } from './report-focus';

export interface StatusCount {
  landed: number;
  partial: number;
  not_landed: number;
  na: number;
}

const emptyCount = (): StatusCount => ({ landed: 0, partial: 0, not_landed: 0, na: 0 });

export interface ClauseRow {
  gmpClauseId: string;
  code: string;
  text: string;
  /** 《规范》条款号，如「第十四条」 */
  specClause: string;
  chapterCode: string;
  chapterName: string;
  /** 指导原则原章顺序（前端按此排序，非按章号字典序） */
  chapterSeq: number;
  /** 是否三大重点章节 */
  chapterFocus: boolean;
  level: string;
  status: Status;
  /** 是否被显式点选过（false = 默认已落地·待核实） */
  verified: boolean;
  abnormal: boolean;
  /** 涉及的审核组（同一检查项可能跨组重复分派） */
  groupNames: string[];
  /** 该检查项被几个组审（1 = 无重复） */
  groupCount: number;
  /** 组间判定是否不一致（有组判未落地、有组判已落地） */
  conflict: boolean;
  /** 各组各自的状态明细，供报告溯源 */
  groupStatus: { groupName: string; status: Status; verified: boolean }[];
  /** 涉及的 P 过程（同一条款会同时落进多个过程，如 8.2.6 同时属 P8/P9/P10） */
  processCodes: string[];
  /** 工作包引用次数（同一条款被引用了几次） */
  refCount: number;
  isoList: string[];
}

/**
 * 核心：拉取项目全量条款矩阵。
 * 关键规则（反选模型 + 跨组重复归并）：
 *   1. 范围 = PlanItem（组长上传计划后由映射表分派出的条款）
 *   2. 有 Assessment 记录 = 被反选过，取其状态
 *   3. 无记录 = 默认 landed（已落地·待核实）
 *   4. **同一检查项被多个组重复分派时，按「更严重」归并为一行**
 *      ——否则一条不符合会在红线统计里被数多次，造成误判。
 *      归并后保留 groupNames / groupStatus / conflict 供报告溯源。
 */
export async function collectRows(projectId: string): Promise<ClauseRow[]> {
  const planItems = await prisma.planItem.findMany({
    where: { projectId },
    include: { gmpClause: { include: { chapter: true } } },
  });

  // 组名：gmpClauseId -> 组名[]
  const groupNamesOf = new Map<string, string[]>();
  if (planItems.length) {
    const scopes = await prisma.groupScope.findMany({
      where: { gmpClauseId: { in: planItems.map((p) => p.gmpClauseId) } },
      include: { group: true },
    });
    for (const s of scopes) {
      const nm = s.group?.name;
      const cid = s.gmpClauseId;
      if (!nm || !cid) continue;
      const arr = groupNamesOf.get(cid) || [];
      if (!arr.includes(nm)) arr.push(nm);
      groupNamesOf.set(cid, arr);
    }
  }

  // 跨过程引用统计：gmpClauseId -> { 过程码[], 引用次数 }
  // 业务口径：同一条款会同时落进多个 P 过程，这是「重复」的真正来源。
  const procRefs = new Map<string, { processes: string[]; refCount: number }>();
  {
    const srs = await prisma.slotRecord.findMany({
      where: { slot: { projectId } },
      select: { gmpClauseId: true, slotId: true, slot: { select: { processCode: true } } },
    });
    const perSlot = new Map<string, Set<string>>();
    for (const r of srs) {
      const cur = procRefs.get(r.gmpClauseId) ?? { processes: [], refCount: 0 };
      if (!cur.processes.includes(r.slot.processCode)) cur.processes.push(r.slot.processCode);
      cur.refCount += 1;
      procRefs.set(r.gmpClauseId, cur);
      const ss = perSlot.get(r.gmpClauseId) || new Set<string>();
      ss.add(r.slotId);
      perSlot.set(r.gmpClauseId, ss);
    }
    for (const [cid, ss] of perSlot) {
      const cur = procRefs.get(cid);
      if (cur) cur.refCount = Math.max(cur.refCount, ss.size);
    }
  }

  const assessments = await prisma.assessment.findMany({ where: { projectId } });
  // groupId -> 组名（Assessment 无反向关系，按 id 批量取）
  const gidSet = [...new Set(assessments.map((a) => a.groupId).filter((x): x is string => !!x))];
  const gnameById = new Map<string, string>();
  if (gidSet.length) {
    const gs = await prisma.auditGroup.findMany({ where: { id: { in: gidSet } }, select: { id: true, name: true } });
    for (const g of gs) gnameById.set(g.id, g.name);
  }
  const severity: Record<Status, number> = { not_landed: 3, partial: 2, na: 1, landed: 0 };

  // 按「检查项 + 组」保留每组的最终判定，再按检查项归并
  const byClauseGroup = new Map<string, { status: Status; verified: boolean; abnormal: boolean; groupName: string }>();
  for (const a of assessments) {
    const st = a.status as Status;
    const gn = (a.groupId && gnameById.get(a.groupId)) || '未分组';
    const key = `${a.gmpClauseId}||${gn}`;
    const cur = byClauseGroup.get(key);
    if (!cur) {
      byClauseGroup.set(key, { status: st, verified: true, abnormal: a.abnormal, groupName: gn });
    } else if (severity[st] > severity[cur.status]) {
      byClauseGroup.set(key, { status: st, verified: true, abnormal: a.abnormal || cur.abnormal, groupName: gn });
    } else {
      cur.abnormal = cur.abnormal || a.abnormal;
    }
  }

  // 归并：同一检查项的多行合成一行
  const rows: ClauseRow[] = [];
  const seen = new Set<string>();
  for (const pi of planItems) {
    if (seen.has(pi.gmpClauseId)) continue;
    seen.add(pi.gmpClauseId);

    let isoList: string[] = [];
    try {
      const v = JSON.parse(pi.gmpClause.isoClauses);
      if (Array.isArray(v)) isoList = v;
    } catch {
      isoList = [];
    }

    const gn = groupNamesOf.get(pi.gmpClauseId) || [];

    // 该检查项下所有组的判定
    const allForClause: { groupName: string; status: Status; verified: boolean; abnormal: boolean }[] = [];
    for (const [key, v] of byClauseGroup) {
      if (key.startsWith(`${pi.gmpClauseId}||`)) {
        allForClause.push({ groupName: v.groupName, status: v.status, verified: v.verified, abnormal: v.abnormal });
      }
    }

    let status: Status = 'landed';
    let verified = false;
    let abnormal = false;
    for (const d of allForClause) {
      if (severity[d.status] > severity[status]) status = d.status;
      verified = verified || d.verified;
      abnormal = abnormal || d.abnormal;
    }

    // 组间判定冲突：有组判未落地、同时有组判已落地
    const stSet = new Set(allForClause.map((d) => d.status));
    const conflict = allForClause.length > 1 && stSet.has('not_landed') && (stSet.has('landed') || stSet.has('partial'));

    const pr2 = procRefs.get(pi.gmpClauseId);
    const processCodes = pr2 ? [...pr2.processes].sort((a, b) => a.localeCompare(b, 'zh', { numeric: true })) : [];

    rows.push({
      gmpClauseId: pi.gmpClauseId,
      code: pi.gmpClause.code,
      text: pi.gmpClause.text,
      specClause: pi.gmpClause.specClause,
      chapterCode: pi.gmpClause.chapterCode,
      chapterName: pi.gmpClause.chapter.name,
      chapterSeq: pi.gmpClause.chapter.seq,
      chapterFocus: pi.gmpClause.chapter.focus,
      level: pi.gmpClause.level,
      status,
      verified,
      abnormal,
      groupNames: gn,
      groupCount: Math.max(gn.length, allForClause.length),
      conflict,
      groupStatus: allForClause
        .map((d) => ({ groupName: d.groupName, status: d.status, verified: d.verified }))
        .sort((a, b) => a.groupName.localeCompare(b.groupName, 'zh')),
      processCodes,
      refCount: pr2?.refCount ?? gn.length,
      isoList,
    });
  }
  return rows;
}

export interface ReportContent {
  project: { id: string; name: string; auditDate: string; clientName?: string | null };
  generatedAt: string;
  totals: StatusCount & { total: number; landRate: number; verified: number; abnormal: number };
  byChapter: { code: string; name: string; seq: number; focus: boolean; total: number; counts: StatusCount; rate: number; status: string }[];
  byLevel: { level: string; total: number; notMet: number }[];
  byGroup: { groupName: string; total: number; verified: number; abnormal: number; counts: StatusCount }[];
  focus: { category: string; total: number; counts: StatusCount; rate: number }[];
  redline: {
    triggered: boolean;
    reasons: string[];
    keyNotMet: number;
    keyPlusMainNotMet: number;
    generalNotMet: number;
    totalNotMet: number;
    thresholds: typeof REDLINE_RULES;
  };
  /** 异常优先排序清单：P0 → P1 → P2，同级按风险等级、条款号 */
  abnormalList: {
    priority: Priority;
    code: string;
    chapterName: string;
    level: string;
    specClause: string;
    text: string;
    isoList: string[];
    groupNames: string[];
    groupCount: number;
    conflict: boolean;
  }[];
  /**
   * 跨组重复分派统计：同一检查项被多个组分别审过。
   * 报告须显式披露，避免「一条不符合被当成三条」或「多组各说各话」被忽略。
   */
  crossGroup: {
    /** 重复分派的检查项数 */
    dupClauseCount: number;
    /** 涉及重复的总引用次数 */
    refCount: number;
    /** 组间判定不一致的项数（末次会议须澄清） */
    conflictCount: number;
    conflictList: {
      code: string;
      text: string;
      level: string;
      status: Status;
      detail: { groupName: string; status: Status; verified: boolean }[];
    }[];
    /** 重复分派明细：按重复引用数降序，供报告逐条披露 */
    dupList: {
      code: string;
      text: string;
      level: string;
      status: Status;
      groupCount: number;
      refCount: number;
      conflict: boolean;
      groupNames: string[];
      processCodes: string[];
    }[];
  };
  /**
   * ★ 问题清单：未落地条款按「章 + 优先级」归并而成。
   * 报告主体用它替代逐条罗列 —— 领导看的是「有哪些问题、多严重、怎么办」。
   */
  problems: ProblemGroup[];
  /** ★ 总体评价：一句话结论 + 等级 + 评价正文 + 支撑指标 */
  verdict: OverallVerdict;
  statusMeta: typeof STATUS_META_EXPORT;
}

const STATUS_META_EXPORT = [
  { key: 'landed', label: '已落地', color: STATUS_COLOR.landed },
  { key: 'partial', label: '部分落地', color: STATUS_COLOR.partial },
  { key: 'not_landed', label: '未落地', color: STATUS_COLOR.not_landed },
  { key: 'na', label: '不适用', color: STATUS_COLOR.na },
] as const;

/**
 * ★ 全量条款树（第 5 项支撑）——组长「条款分级」页签专用
 *
 * 为什么要单独一个函数，而不是直接用 collectRows：
 *   collectRows 的口径是「本次审核计划实际覆盖的条款」（PlanItem），
 *   报告的落地率、异常清单都必须按这个口径算，否则分母会被没审的条款稀释。
 *   但组长在页面上要看到的是指导原则全表（200 条）按关键/主要/一般三级展开，
 *   才好判断「这次计划漏了哪一章、漏了哪些关键项」。
 *   两个口径混用会误导决策，所以这里单独出一个只读视图，不参与任何统计。
 *
 * 返回按章 → 层 → 条 三级组织好的树，章按指导原则原序、重点章排前。
 */
export interface ClauseTreeNode {
  gmpClauseId: string;
  code: string;
  text: string;
  specClause: string;
  chapterCode: string;
  chapterName: string;
  chapterSeq: number;
  chapterFocus: boolean;
  level: string;
  /** 是否被本次审核计划覆盖（false = 计划未涉及，仅供对照参考） */
  inPlan: boolean;
  /** 计划内条款的落地状态；计划外固定为 landed 且 verified=false */
  status: Status;
  verified: boolean;
  groupNames: string[];
  processCodes: string[];
}

export interface ClauseTreeLevel {
  level: string;
  total: number;
  inPlan: number;
  notLanded: number;
  clauses: ClauseTreeNode[];
}

export interface ClauseTreeChapter {
  code: string;
  name: string;
  seq: number;
  focus: boolean;
  total: number;
  inPlan: number;
  notLanded: number;
  levels: ClauseTreeLevel[];
}

export interface ClauseTree {
  totals: {
    all: number;
    inPlan: number;
    key: number;
    main: number;
    gen: number;
    keyInPlan: number;
    notLanded: number;
  };
  chapters: ClauseTreeChapter[];
}

const LEVEL_SEQ: Record<string, number> = { 关键: 0, 主要: 1, 一般: 2 };

export async function buildClauseTree(projectId: string): Promise<ClauseTree> {
  const allClauses = await prisma.gmpClause.findMany({
    where: { enabled: true },
    include: { chapter: true },
    orderBy: [{ chapter: { seq: 'asc' } }, { seq: 'asc' }],
  });

  // 计划内条款：复用 collectRows 的归并结果，保证状态口径与报告完全一致
  const inPlanRows = await collectRows(projectId);
  const inPlan = new Map(inPlanRows.map((r) => [r.gmpClauseId, r]));

  const byChapter = new Map<string, ClauseTreeChapter>();
  const totals = {
    all: 0, inPlan: 0, key: 0, main: 0, gen: 0, keyInPlan: 0, notLanded: 0,
  };

  for (const c of allClauses) {
    const hit = inPlan.get(c.id);
    const node: ClauseTreeNode = {
      gmpClauseId: c.id,
      code: c.code,
      text: c.text,
      specClause: c.specClause,
      chapterCode: c.chapterCode,
      chapterName: c.chapter.name,
      chapterSeq: c.chapter.seq,
      chapterFocus: c.chapter.focus,
      level: c.level,
      inPlan: !!hit,
      status: hit?.status ?? 'landed',
      verified: hit?.verified ?? false,
      groupNames: hit?.groupNames ?? [],
      processCodes: hit?.processCodes ?? [],
    };

    let ch = byChapter.get(c.chapterCode);
    if (!ch) {
      ch = {
        code: c.chapterCode,
        name: c.chapter.name,
        seq: c.chapter.seq,
        focus: c.chapter.focus,
        total: 0,
        inPlan: 0,
        notLanded: 0,
        levels: [],
      };
      byChapter.set(c.chapterCode, ch);
    }
    let lv = ch.levels.find((l) => l.level === c.level);
    if (!lv) {
      lv = { level: c.level, total: 0, inPlan: 0, notLanded: 0, clauses: [] };
      ch.levels.push(lv);
    }

    ch.total += 1;
    lv.total += 1;
    lv.clauses.push(node);
    totals.all += 1;
    if (node.inPlan) {
      ch.inPlan += 1;
      lv.inPlan += 1;
      totals.inPlan += 1;
      if (node.status === 'not_landed') {
        ch.notLanded += 1;
        lv.notLanded += 1;
        totals.notLanded += 1;
      }
    }
    if (c.level === '关键') {
      totals.key += 1;
      if (node.inPlan) totals.keyInPlan += 1;
    } else if (c.level === '主要') totals.main += 1;
    else totals.gen += 1;
  }

  // 章内层按 关键→主要→一般 固定顺序；章按「重点章优先，其余原序」
  for (const ch of byChapter.values()) {
    ch.levels.sort((a, b) => (LEVEL_SEQ[a.level] ?? 9) - (LEVEL_SEQ[b.level] ?? 9));
  }
  const chapters = [...byChapter.values()].sort((a, b) =>
    a.focus !== b.focus ? (a.focus ? -1 : 1) : a.seq - b.seq,
  );

  return { totals, chapters };
}

/** 生成报告 content_json（结构固定，数据全填充） */
export async function buildReportContent(projectId: string): Promise<ReportContent> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const rows = await collectRows(projectId);

  const totals = emptyCount();
  const chMap = new Map<string, StatusCount>();
  const levelAgg = new Map<string, { total: number; notMet: number }>();
  const groupAgg = new Map<string, { total: number; verified: number; abnormal: number; counts: StatusCount }>();

  for (const r of rows) {
    totals[r.status] += 1;
    const c = chMap.get(r.chapterCode) || emptyCount();
    c[r.status] += 1;
    chMap.set(r.chapterCode, c);

    const l = levelAgg.get(r.level) || { total: 0, notMet: 0 };
    l.total += 1;
    if (r.status === 'not_landed') l.notMet += 1;
    levelAgg.set(r.level, l);

    // 一行可能归属多个审核组（跨组重复分派），需逐组计入，否则组进度会漏
    const gs = r.groupNames.length ? r.groupNames : ['未分组'];
    for (const gn of gs) {
      const g = groupAgg.get(gn) || { total: 0, verified: 0, abnormal: 0, counts: emptyCount() };
      g.total += 1;
      if (r.verified) g.verified += 1;
      if (r.abnormal) g.abnormal += 1;
      g.counts[r.status] += 1;
      groupAgg.set(gn, g);
    }
  }

  const total = rows.length;
  const keyNotMet = rows.filter((r) => r.level === '关键' && r.status === 'not_landed').length;
  const mainNotMet = rows.filter((r) => r.level === '主要' && r.status === 'not_landed').length;
  const genNotMet = rows.filter((r) => r.level === '一般' && r.status === 'not_landed').length;
  const totalNotMet = totals.not_landed;
  const keyPlusMainNotMet = keyNotMet + mainNotMet;

  const reasons: string[] = [];
  if (keyNotMet >= REDLINE_RULES.keyNotMet)
    reasons.push(`关键项目不符合 ${keyNotMet} 项，达到红线阈值（≥${REDLINE_RULES.keyNotMet}）→ 未通过核查／暂停生产整改`);
  if (keyPlusMainNotMet >= REDLINE_RULES.keyPlusMain)
    reasons.push(`关键+主要项目不符合合计 ${keyPlusMainNotMet} 项，达到红线阈值（≥${REDLINE_RULES.keyPlusMain}）→ 未通过核查／暂停生产整改`);
  if (genNotMet >= REDLINE_RULES.generalNotMet)
    reasons.push(`一般项目不符合 ${genNotMet} 项，达到阈值（≥${REDLINE_RULES.generalNotMet}）→ 限期整改／整改后复查`);
  if (totalNotMet >= REDLINE_RULES.totalNotMet)
    reasons.push(`总不符合 ${totalNotMet} 项，达到红线阈值（≥${REDLINE_RULES.totalNotMet}）`);

  const chapters = await prisma.gmpChapter.findMany({ orderBy: { seq: 'asc' } });
  const chMeta = new Map(chapters.map((c) => [c.code, c]));

  const byChapter = chapters
    .map((ch) => {
      const counts = chMap.get(ch.code) || emptyCount();
      const t = Object.values(counts).reduce((s, n) => s + n, 0);
      return {
        code: ch.code,
        name: ch.name,
        seq: ch.seq,
        focus: ch.focus,
        total: t,
        counts,
        rate: rate(counts),
        status: chapterStatus(counts, t),
      };
    })
    .filter((c) => c.total > 0);

  // 章节整章未落地判定（用于 P0 优先级提升）
  const fullyNotLanded = new Set(
    byChapter.filter((c) => c.status === 'not_landed').map((c) => c.code),
  );

  const PRIORITY_ORDER: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 };
  const abnormalList = rows
    .filter((r) => r.status === 'not_landed')
    .map((r) => ({
      priority: derivePriority(r.level, fullyNotLanded.has(r.chapterCode)),
      code: r.code,
      chapterName: r.chapterName,
      level: r.level,
      specClause: r.specClause,
      text: r.text,
      isoList: r.isoList,
      groupNames: r.groupNames,
      /** 跨组重复：该项被几个组分别审过 */
      groupCount: r.groupCount,
      /** 组间判定不一致：需末次会议当面澄清 */
      conflict: r.conflict,
    }))
    .sort((a, b) => {
      if (PRIORITY_ORDER[a.priority] !== PRIORITY_ORDER[b.priority])
        return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      const lvl = { 关键: 0, 主要: 1, 一般: 2 };
      if (lvl[a.level as keyof typeof lvl] !== lvl[b.level as keyof typeof lvl])
        return lvl[a.level as keyof typeof lvl] - lvl[b.level as keyof typeof lvl];
      return a.code.localeCompare(b.code, 'zh', { numeric: true });
    });

  // ===== 跨组重复分派统计 =====
  // 同一检查项被多个组分别审过时，报告必须披露：
  //   1. 合并口径下它只算一条（红线不会重复计数）
  //   2. 各组判定不一致的必须列出，末次会议当面澄清
  // 「重复」有两个来源：跨多个 P 过程（业务口径里最常见的），或跨多个审核组
  const dupRows = rows.filter((r) => r.groupCount > 1 || r.processCodes.length > 1 || r.refCount > 1);
  const conflictRows = rows.filter((r) => r.conflict);
  const lvlRank: Record<string, number> = { 关键: 0, 主要: 1, 一般: 2 };
  const crossGroup = {
    dupClauseCount: dupRows.length,
    refCount: rows.reduce((a, r) => a + Math.max(r.refCount, r.groupCount, 1), 0),
    conflictCount: conflictRows.length,
    conflictList: conflictRows
      .map((r) => ({
        code: r.code,
        text: r.text,
        level: r.level,
        status: r.status,
        detail: r.groupStatus,
      }))
      .sort((a, b) => {
        if (lvlRank[a.level] !== lvlRank[b.level]) return lvlRank[a.level] - lvlRank[b.level];
        return a.code.localeCompare(b.code, 'zh', { numeric: true });
      }),
    // 重复分派明细：跨多个过程或多个组的检查项，按重复次数降序
    dupList: dupRows
      .map((r) => ({
        code: r.code,
        text: r.text,
        level: r.level,
        status: r.status,
        groupCount: r.groupCount,
        refCount: r.refCount,
        conflict: r.conflict,
        processCodes: r.processCodes,
        groupNames: r.groupNames,
      }))
      .sort((a, b) => {
        const ap = a.processCodes.length;
        const bp = b.processCodes.length;
        if (ap !== bp) return bp - ap; // 跨过程多的排前
        if (a.refCount !== b.refCount) return b.refCount - a.refCount;
        if (a.conflict !== b.conflict) return a.conflict ? -1 : 1;
        return a.code.localeCompare(b.code, 'zh', { numeric: true });
      }),
  };

  // ===== ★ 报告聚焦：问题清单 + 总体评价 =====
  // 报告只回答三件事：哪些条款没落地、亟待解决哪些问题、总体评价是什么。
  // 下面两个推导把 200 条逐条罗列压缩成可决策的信息：
  //   problems = 未落地条款按章 + 优先级归并后的问题清单
  //   verdict  = 由问题分布 + 落地率 + 核实率推出的总体评价
  const problems: ProblemGroup[] = deriveProblems(rows);
  const verdict: OverallVerdict = deriveVerdict(
    problems,
    {
      total,
      landed: totals.landed,
      partial: totals.partial,
      not_landed: totals.not_landed,
      na: totals.na,
      verified: rows.filter((r) => r.verified).length,
      landRate: total ? +(totals.landed / total).toFixed(4) : 0,
    },
    reasons.length > 0,
  );

  return {
    project: {
      id: project.id,
      name: project.name,
      auditDate: project.auditDate.toISOString().slice(0, 10),
      clientName: project.clientName,
    },
    generatedAt: new Date().toISOString(),
    totals: {
      ...totals,
      total,
      landRate: total ? +(totals.landed / total).toFixed(4) : 0,
      verified: rows.filter((r) => r.verified).length,
      abnormal: rows.filter((r) => r.abnormal).length,
    },
    byChapter,
    byLevel: [...levelAgg.entries()].map(([level, v]) => ({ level, ...v })),
    crossGroup,
    byGroup: [...groupAgg.entries()].map(([groupName, v]) => ({ groupName, ...v })),
    focus: FOCUS_CATEGORIES.map((fc) => {
      const ch = chapters.find((c) => c.name === fc);
      const counts = (ch && chMap.get(ch.code)) || emptyCount();
      return {
        category: fc,
        total: Object.values(counts).reduce((s, n) => s + n, 0),
        counts,
        rate: rate(counts),
      };
    }),
    redline: {
      triggered: reasons.length > 0,
      reasons,
      keyNotMet,
      keyPlusMainNotMet,
      generalNotMet: genNotMet,
      totalNotMet,
      thresholds: REDLINE_RULES,
    },
    abnormalList,
    problems,
    verdict,
    statusMeta: STATUS_META_EXPORT,
  };
}

/** 章节状态由条款层推导：全未落地 / 有未落地或部分落地 / 全落地 */
function chapterStatus(c: StatusCount, total: number): string {
  if (total === 0) return 'empty';
  const bad = c.not_landed;
  if (bad === 0 && c.partial === 0) return 'landed';
  if (bad >= total) return 'not_landed';
  return 'partial';
}

/** 已落地率 = (已落地 + 部分落地×0.5) / 总数 */
function rate(c: StatusCount): number {
  const t = c.landed + c.partial + c.not_landed + c.na;
  if (!t) return 0;
  return +((c.landed + c.partial * 0.5) / t).toFixed(4);
}

/**
 * 同步未落地项到整改清单（幂等）。
 * 未落地 → 自动生成 Rectification，priority 由 derivePriority 派生。
 * 条款被重新勾回落地 → 该条整改项关闭或删除，避免脏数据。
 */
export async function syncRectifications(projectId: string) {
  const rows = await collectRows(projectId);
  const chapters = await prisma.gmpChapter.findMany({ orderBy: { seq: 'asc' } });
  const countsByCh = new Map<string, { bad: number; total: number }>();
  for (const r of rows) {
    const e = countsByCh.get(r.chapterCode) || { bad: 0, total: 0 };
    e.total += 1;
    if (r.status === 'not_landed') e.bad += 1;
    countsByCh.set(r.chapterCode, e);
  }

  const existing = await prisma.rectification.findMany({ where: { projectId } });
  const existingByClause = new Map(existing.map((x) => [x.gmpClauseId, x]));
  const notLandedIds = new Set(rows.filter((r) => r.status === 'not_landed').map((r) => r.gmpClauseId));

  // 新增
  for (const r of rows.filter((x) => x.status === 'not_landed')) {
    const st = countsByCh.get(r.chapterCode);
    const priority = derivePriority(r.level, (st?.bad ?? 0) >= (st?.total ?? 1));
    if (existingByClause.has(r.gmpClauseId)) {
      await prisma.rectification.update({
        where: { id: existingByClause.get(r.gmpClauseId)!.id },
        data: { priority, level: r.level, chapterCode: r.chapterCode, title: `${r.code} ${r.text.slice(0, 60)}` },
      });
    } else {
      const a = await prisma.assessment.findFirst({
        where: { projectId, gmpClauseId: r.gmpClauseId },
        select: { id: true, groupId: true },
      });
      await prisma.rectification.create({
        data: {
          projectId,
          gmpClauseId: r.gmpClauseId,
          groupId: (await prisma.groupScope.findFirst({
            where: { gmpClauseId: r.gmpClauseId, group: { projectId } },
            select: { groupId: true },
          }))?.groupId ?? null,
          assessmentId: a?.id ?? null,
          priority,
          level: r.level,
          chapterCode: r.chapterCode,
          title: `${r.code} ${r.text.slice(0, 60)}`,
        },
      });
    }
  }

  // 移除：已重新勾回落地
  const stale = existing.filter((x) => !notLandedIds.has(x.gmpClauseId));
  if (stale.length) {
    await prisma.rectification.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  }
  return { added: rows.filter((r) => r.status === 'not_landed').length, removed: stale.length, total: notLandedIds.size };
}

export { STATUS_LABEL, STATUS_META_EXPORT };