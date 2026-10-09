// ===== 报告「问题聚焦」推导 =====
/**
 * 报告要回答的问题只有三个（负责人口径）：
 *   1. 哪些条款没落地
 *   2. 亟待解决哪些问题
 *   3. 总体评价是什么
 *
 * 因此把 200 条的逐条罗列压缩为「问题清单」：
 *   未落地条款 → 按章节归并成问题（problem）→ 每条问题带严重度与处置建议。
 * 严重度派生（不靠人判断，按可计算规则定）：
 *   P0 关键项未落地，或整章未落地 —— 直接影响产品安全与放行
 *   P1 主要项未落地，或关键项部分落地
 *   P2 一般项未落地，或主要项部分落地
 */
import { PROCESS_BY_CODE } from './process-meta';
import { derivePriority, type Priority } from './types';

/** 一条未落地条款（精简字段，够推导问题即可） */
export interface FindingRow {
  code: string;
  text: string;
  level: string;
  chapterCode: string;
  chapterName: string;
  specClause: string;
  status: string;
  isoList: string[];
  groupNames: string[];
  groupCount: number;
  conflict: boolean;
  processCodes: string[];
}

/** 报告里的一个问题 = 一个章节里同类未落地条款的集合 */
export interface ProblemGroup {
  /** 问题编号，如 Q1 */
  id: string;
  title: string;
  /** 所属章节 */
  chapterName: string;
  chapterCode: string;
  priority: Priority;
  /** 问题定性描述（一句话说清问题是什么） */
  nature: string;
  /** 严重度判定依据，写进报告便于复核 */
  basis: string;
  /** 涉及条款数 */
  clauseCount: number;
  /** 涉及的关键项数 */
  keyCount: number;
  /** 责任审核组 */
  groupNames: string[];
  /** 该问题涉及的所有条款号 */
  clauseCodes: string[];
  /** 组间判定不一致 → 末次会议须澄清 */
  hasConflict: boolean;
  /** 涉及的过程（括号备注用） */
  processCodes: string[];
  /** 处置建议 */
  actions: string[];
}

/** 总体评价：结构 + 结论 + 依据，报告与卡片共用 */
export interface OverallVerdict {
  /** 一句话结论 */
  headline: string;
  /** 结论等级：good / acceptable / poor / critical */
  grade: 'good' | 'acceptable' | 'poor' | 'critical';
  gradeLabel: string;
  /** 评价正文段落 */
  paragraphs: string[];
  /** 支撑数据 */
  metrics: { label: string; value: string }[];
}

/** 优先级 → 处置建议模板 */
function actionsFor(p: Priority, keyCount: number, clauseCount: number): string[] {
  const out: string[] = [];
  if (p === 'P0') {
    out.push('立即启动风险评估：评估未落地条款涉及的在产/在检产品，必要时先采取隔离、停售等临时控制措施。');
    out.push(keyCount > 0 ? `其中 ${keyCount} 项为关键项，须在 5 个工作日内提交原因分析与纠正措施，并附证据。` : '须在 5 个工作日内提交原因分析与纠正措施。');
    if (clauseCount > 3) out.push(`单问题涉及 ${clauseCount} 条，建议按体系级问题立项，不宜逐条分散整改。`);
  } else if (p === 'P1') {
    out.push('限期整改：纳入本轮整改计划，明确责任人、完成时限与验证方式。');
    out.push(keyCount > 0 ? '涉及关键项部分落地的，须优先补齐关键控制点证据。' : '须补齐文件与执行记录，避免以文件修补替代实际落地。');
  } else {
    out.push('持续改进：纳入日常监督抽查清单，跟踪三个周期。');
  }
  return out;
}

/**
 * 把未落地条款聚合成问题清单。
 * 归并口径：同一章节 + 同优先级 → 一个问题（同章不同严重度分开，避免一锅端）。
 */
export function deriveProblems(rows: FindingRow[]): ProblemGroup[] {
  const bad = rows.filter((r) => r.status === 'not_landed' || r.status === 'partial');
  if (!bad.length) return [];

  // 章 → 优先级 → 条款
  const byCh = new Map<string, Map<Priority, FindingRow[]>>();
  for (const r of bad) {
    const pr = derivePriority(r.level, false);
    const m = byCh.get(r.chapterCode) ?? new Map<Priority, FindingRow[]>();
    const arr = m.get(pr) ?? [];
    arr.push(r);
    m.set(pr, arr);
    byCh.set(r.chapterCode, m);
  }

  const out: ProblemGroup[] = [];
  for (const [chapterCode, m] of byCh) {
    // 章名取该章任一条款即可（同章内一致）
    const sample = (m.values().next().value ?? [])[0];
    for (const [pr, list] of m) {
      const keyCount = list.filter((x) => x.level === '关键').length;
      const notLanded = list.filter((x) => x.status === 'not_landed');
      const partial = list.filter((x) => x.status === 'partial');
      const groupNames = [...new Set(list.flatMap((x) => x.groupNames))];
      const processCodes = [...new Set(list.flatMap((x) => x.processCodes))];

      const parts: string[] = [];
      if (notLanded.length) parts.push(`${notLanded.length} 项未落地`);
      if (partial.length) parts.push(`${partial.length} 项部分落地`);

      // 问题定性：一句话说清问题是什么（不是罗列条款）
      const nature =
        pr === 'P0'
          ? `本章存在关键项未落地，属体系性风险，可能直接关联产品安全与合规放行。`
          : pr === 'P1'
            ? `本章主要项存在差距，反映体系要求与现场执行之间未形成闭环。`
            : `本章一般项存在差距，需通过日常监督持续跟进。`;

      // 判定依据（可复核，不靠主观）
      const basisBits: string[] = [];
      if (keyCount) basisBits.push(`含关键项 ${keyCount} 项`);
      basisBits.push(...parts);
      const conflicts = list.filter((x) => x.conflict);
      if (conflicts.length) basisBits.push(`其中 ${conflicts.length} 项组间判定不一致，须末次会议澄清`);

      out.push({
        id: `Q${out.length + 1}`,
        title: `${sample.chapterName}　${keyCount ? `关键项未落地 ${keyCount} 项` : pr === 'P1' ? '主要项存在差距' : '一般项存在差距'}`,
        chapterName: sample.chapterName,
        chapterCode,
        priority: pr,
        nature,
        basis: basisBits.join('，'),
        clauseCount: list.length,
        keyCount,
        groupNames,
        clauseCodes: list.map((x) => x.code).sort((a, b) => a.localeCompare(b, 'zh', { numeric: true })),
        hasConflict: conflicts.length > 0,
        processCodes,
        actions: actionsFor(pr, keyCount, list.length),
      });
    }
  }

  // 排序：优先级 → 关键项数 → 条款数
  const rank: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 };
  out.sort((a, b) => {
    if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
    if (a.keyCount !== b.keyCount) return b.keyCount - a.keyCount;
    return b.clauseCount - a.clauseCount;
  });
  // 重排序号
  out.forEach((p, i) => (p.id = `Q${i + 1}`));
  return out;
}

/**
 * 总体评价：不给"通过/不通过"的结论（认证结论不在本工具职责内），
 * 只陈述 GMP 落地水平与证据强度。
 */
export function deriveVerdict(
  problems: ProblemGroup[],
  t: { total: number; landed: number; partial: number; not_landed: number; na: number; verified: number; landRate: number },
  redlineTriggered: boolean,
): OverallVerdict {
  const p0 = problems.filter((p) => p.priority === 'P0').length;
  const p1 = problems.filter((p) => p.priority === 'P1').length;
  const p2 = problems.filter((p) => p.priority === 'P2').length;
  const unverified = t.total - t.verified;
  const verifyRate = t.total ? t.verified / t.total : 0;

  // 等级判定：先看红线，再看关键项，再看落地率
  let grade: OverallVerdict['grade'];
  if (redlineTriggered || p0 > 0) grade = 'critical';
  else if (p1 > 0 || t.not_landed > 0) grade = 'poor';
  else if (t.partial > 0 || unverified > t.total * 0.3) grade = 'acceptable';
  else grade = 'good';

  const gradeLabel =
    grade === 'critical' ? '存在重大风险，须立即处置' : grade === 'poor' ? '存在明显差距，须限期整改' : grade === 'acceptable' ? '基本符合，存在局部差距' : '总体良好，保持持续监督';

  const headline =
    grade === 'critical'
      ? `发现 ${p0} 个高风险问题（涉及关键项未落地），建议立即启动风险评估与临时控制措施。`
      : problems.length
        ? `共发现 ${problems.length} 个问题（重大 ${p0} / 限期整改 ${p1} / 持续改进 ${p2}），综合落地率 ${(t.landRate * 100).toFixed(1)}%。`
        : `本次核查 ${t.total} 项检查项全部落地，未发现差距，建议转入持续监督与记录证据抽查。`;

  const paragraphs: string[] = [];

  paragraphs.push(
    `本次核查覆盖《新版 GMP 检查指导原则》检查项 ${t.total} 项，条款落地率 ${(t.landRate * 100).toFixed(1)}%（已落地 ${t.landed} 项、部分落地 ${t.partial} 项、未落地 ${t.not_landed} 项、不适用 ${t.na} 项）。`,
  );

  if (problems.length) {
    const p0List = problems.filter((p) => p.priority === 'P0');
    const p0Where = p0List.length ? `其中 ${p0List.length} 个重大问题集中在 ${p0List.map((p) => p.chapterName).join('、')}，` : '';
    paragraphs.push(
      `按问题归类共 ${problems.length} 个：重大问题 ${p0} 个、限期整改 ${p1} 个、持续改进 ${p2} 个。${p0Where}建议按「风险评估 → 临时控制 → 原因分析 → 纠正措施 → 有效性验证」顺序推进。`,
    );
  } else {
    paragraphs.push('未发现未落地条款。需要说明的是，「未发现」不等于「已验证」，仍需结合核查记录确认结论可靠性。');
  }

  paragraphs.push(
    verifyRate >= 0.8
      ? `证据强度方面，${t.verified} 项已形成明确核查结论（核实率 ${(verifyRate * 100).toFixed(1)}%），结论可信度较高。`
      : `证据强度方面，仅 ${t.verified} 项形成明确核查结论（核实率 ${(verifyRate * 100).toFixed(1)}%），其余 ${unverified} 项为「默认已落地·待核实」。该口径下落地率可能被高估，建议补充现场核查后再据此作出最终判断。`,
  );

  const conflicts = problems.filter((p) => p.hasConflict);
  if (conflicts.length) {
    paragraphs.push(
      `另需注意：${conflicts.length} 个问题存在审核组间判定不一致（共 ${conflicts.reduce((a, p) => a + p.clauseCount, 0)} 条），须在末次会议当面澄清并统一判定口径，否则整改要求可能相互矛盾。`,
    );
  }

  paragraphs.push(
    '本评价仅反映 GMP 检查项的现场落地情况与证据强度，不构成认证结论或行政许可承诺；整改实施责任在受审核方，整改有效性须另行验证。',
  );

  return {
    headline,
    grade,
    gradeLabel,
    paragraphs,
    metrics: [
      { label: '检查项总数', value: `${t.total} 项` },
      { label: '落地率', value: `${(t.landRate * 100).toFixed(1)}%` },
      { label: '未落地', value: `${t.not_landed} 项` },
      { label: '问题数', value: `${problems.length} 个` },
      { label: '重大问题', value: `${p0} 个` },
      { label: '核实率', value: `${(verifyRate * 100).toFixed(1)}%` },
    ],
  };
}

/** 供报告/卡片显示：过程码 → 过程名 */
export function processLabel(code: string): string {
  const m = PROCESS_BY_CODE.get(code);
  return m ? `${code} ${m.name}` : code;
}
