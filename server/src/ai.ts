// ===== DeepSeek AI 服务：高风险信号 + 改进建议 =====
// 适配「分层反选模型」：默认全选已落地、仅反选异常。
// 因此 landed 混合了「已核实落地」与「默认已落地（待核实）」，落地率高 ≠ 已核实无问题，
// 所有提示词与降级规则都必须显式承载这一口径，避免把「未点选」误读为「审核员确认无问题」。
import { config, hasDeepSeek } from './config';
import { PRIORITY_LABEL } from './types';
import { ISO_CLAUSES_WITHOUT_ITEM, ISO_UNIQUE_ITEMS } from '../prisma/seed-data';
import type { ReportContent } from './report-engine';

export interface AiResult {
  provider: 'deepseek' | 'fallback';
  summary: string;
}

/** 未核实占比高于此值即提示：默认已落地项过多，结论不足以支撑放行判断 */
const VERIFIED_WARN_RATIO = 0.8;

/**
 * 固定的体系性风险提示（来自 seed-data 底表「统计说明」）。
 * 与本次数据无关，属于审核口径固有风险，AI 与降级路径都必须保留 —— 降级时更不能丢。
 */
function systemicRisks(): string[] {
  return [
    `ISO 13485 有 8 个条款在《规范》检查指导原则中无对应检查项（${ISO_CLAUSES_WITHOUT_ITEM.join('、')}），`
      + '做体系符合性审核时不得因底表未列项而漏审，须另行取证评估。',
    `${ISO_UNIQUE_ITEMS.join('、')} 为「法规特有」项，ISO 13485 无对应条款；`
      + '认证审核与 GMP 检查判定口径不同，须分别把握，不可互相替代结论。',
    '「对应方式」仅表示条款关联强度，不构成合规豁免；《规范》有明文而 ISO 13485 无对应者，仍须严格执行。',
  ];
}

/** 把报告压缩为紧凑结构，减少 token 与歧义 */
function buildPrompt(rc: ReportContent) {
  const chapters = rc.byChapter
    .map(
      (c) =>
        `${c.name}(${c.code})：已落地${c.counts.landed}/部分${c.counts.partial}/未落地${c.counts.not_landed}/不适用${c.counts.na}，落地率${(c.rate * 100).toFixed(0)}%${c.focus ? '［重点章节］' : ''}`,
    )
    .join('\n');

  // 异常清单已按 P0→P1→P2 排好序，优先喂 P0/P1，控制长度
  const abnormal = rc.abnormalList
    .filter((a) => a.priority === 'P0' || a.priority === 'P1')
    .slice(0, 15)
    .map(
      (a) =>
        `- [${a.priority}][${a.code}][${a.chapterName}][${a.level}][${a.specClause}]`
        + `${a.groupNames.length ? '［' + a.groupNames.join('/') + '］' : ''} ISO:${a.isoList.join('/') || '—'} ${a.text}`,
    );

  const groups = rc.byGroup
    .map(
      (g) =>
        `${g.groupName}：范围${g.total}，已核实${g.verified}（${g.total ? ((g.verified / g.total) * 100).toFixed(0) : 0}%），异常${g.abnormal}`,
    )
    .join('；');

  const focus = rc.focus
    .filter((f) => f.total > 0)
    .map((f) => `${f.category}(未落地${f.counts.not_landed}/部分${f.counts.partial}/落地率${(f.rate * 100).toFixed(0)}%)`)
    .join('、');

  const p0 = rc.abnormalList.filter((a) => a.priority === 'P0').length;

  return [
    '你是一位资深医疗器械 QMS 审核专家，正在为 ISO 13485 现场审核的末次会议编写增值评估简报。',
    '',
    '## 统计口径（务必先读）',
    '本工具采用「默认全选已落地 + 仅反选异常」模型：未被反选勾掉的条款状态为「已落地·待核实」，',
    '表示默认纳入范围且审核员未提出异议，**不代表审核员已确认其无问题**。',
    `本次范围共 ${rc.totals.total} 项，其中仅 ${rc.totals.verified} 项经过反选核实、${rc.totals.abnormal} 项被标记异常。`,
    '引用落地率时必须同时说明未核实占比，不得把落地率直接等同于体系符合性结论。',
    '',
    '## 现场统计',
    `受审核企业：${rc.project.name}；审核日期：${rc.project.auditDate}`,
    `总计 ${rc.totals.total} 项：已落地 ${rc.totals.landed}、部分落地 ${rc.totals.partial}、未落地 ${rc.totals.not_landed}、不适用 ${rc.totals.na}；落地率 ${(rc.totals.landRate * 100).toFixed(1)}%`,
    `已核实 ${rc.totals.verified} 项、标记异常 ${rc.totals.abnormal} 项、P0 异常 ${p0} 项`,
    `红线预警：${rc.redline.triggered ? '已触发（' + rc.redline.reasons.join('；') + '）' : '未触发'}`,
    `红线四档阈值：关键项不符合≥${rc.redline.thresholds.keyNotMet}、关键+主要≥${rc.redline.thresholds.keyPlusMain}、一般项不符合≥${rc.redline.thresholds.generalNotMet}、总不符合≥${rc.redline.thresholds.totalNotMet}`,
    '',
    '## 分章节四状态（不适用为「不适用」，无「未覆盖」概念）',
    chapters,
    '',
    '## 重点章节',
    focus || '（本次范围未覆盖重点章节）',
    '',
    '## 分组核实进度',
    groups || '（无分组数据）',
    '',
    '## P0/P1 异常清单（最多 15 条，已按优先级排序）',
    abnormal.length ? abnormal.join('\n') : '（无）',
    '',
    '## 固定体系性风险（必须至少覆盖一条建议）',
    ...systemicRisks().map((r, i) => `${i + 1}. ${r}`),
    '',
    '## 输出要求',
    '1) 用中文输出，Markdown 格式，不超过 600 字。',
    '2) 严格分为三节：',
    '   - ### 高风险信号（3-5 条，每条须指明对应章节或条款，客观陈述事实，不夸大）',
    '   - ### 改进建议（3-5 条，须可执行，明确责任部门或落地动作）',
    '   - ### 增值评估小结（2-3 句，给出整体成熟度判断与后续跟进重点）',
    '3) 严禁编造现场未提供的证据、数据或法规条款号；未提供的信息只能标注为「需补充核实」。',
    '4) 严禁出现「直接提交监管」「包通过检查」「保证通过审核」等结论性承诺表述。',
    '5) 不得将「默认已落地（未反选）」表述为「已核实合格」。',
  ].join('\n');
}

/** 调用 DeepSeek；失败或未配置 Key 时自动降级为规则引擎 */
export async function generateAiInsight(rc: ReportContent): Promise<AiResult> {
  if (!hasDeepSeek()) {
    return { provider: 'fallback', summary: fallbackInsight(rc) };
  }
  try {
    const res = await fetch(`${config.deepseek.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.deepseek.apiKey}`,
      },
      body: JSON.stringify({
        model: config.deepseek.model,
        temperature: 0.3,
        max_tokens: 1200,
        messages: [
          { role: 'system', content: '你是严谨的 QMS 审核专家，输出中文 Markdown。' },
          { role: 'user', content: buildPrompt(rc) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}`);
    const json = (await res.json()) as any;
    const text = json?.choices?.[0]?.message?.content;
    if (!text) throw new Error('DeepSeek 返回内容为空');
    return { provider: 'deepseek', summary: text.trim() };
  } catch (e) {
    console.warn('[ai] DeepSeek 调用失败，降级规则引擎:', (e as Error).message);
    return { provider: 'fallback', summary: fallbackInsight(rc) };
  }
}

/**
 * 降级规则引擎：完全基于统计数据生成结构化建议，不含任何编造内容。
 * AI 未配置 Key 或调用失败时使用，保证功能可用。
 * 注意：反选模型下不存在「未覆盖」，薄弱环节只看真实的 not_landed / partial。
 */
function fallbackInsight(rc: ReportContent): string {
  const L: string[] = [];
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const t = rc.totals;
  // 已核实率：落地项中有多少是被反选真正确认过的
  const verifiedRate = t.total ? t.verified / t.total : 0;

  L.push('### 高风险信号');
  let n = 0;
  const keyBad = rc.abnormalList.filter((a) => a.level === '关键');
  const p0 = rc.abnormalList.filter((a) => a.priority === 'P0');
  if (p0.length) {
    n++;
    L.push(
      `${n}. P0 立即整改项 ${p0.length} 条（关键项不符合或所在章节被整章取消），涉及：${
        [...new Set(p0.map((a) => a.chapterName))].join('、')
      }，直接影响产品合规放行，须优先处理。`,
    );
  } else if (keyBad.length) {
    n++;
    L.push(`1. 关键项未落地 ${keyBad.length} 条，涉及：${[...new Set(keyBad.map((k) => k.chapterName))].join('、')}，直接影响产品合规放行。`);
  }

  // 薄弱章节：排除「无未落地且无部分落地」的健康章节，加权排序（未落地权重更高）
  const worst = rc.byChapter
    .filter((c) => c.total > 0)
    .filter((c) => c.counts.not_landed + c.counts.partial > 0)
    .map((c) => ({ c, score: c.counts.not_landed * 2 + c.counts.partial }))
    .sort((a, b) => b.score - a.score || a.c.rate - b.c.rate)
    .slice(0, 3);
  for (const w of worst) {
    if (n >= 4) break;
    n++;
    L.push(
      `${n}. 「${w.c.name}」未落地 ${w.c.counts.not_landed} 条、部分落地 ${w.c.counts.partial} 条，落地率 ${pct(w.c.rate)}，为本次审核薄弱环节。`,
    );
  }

  // 反选模型特有风险：落地率可能虚高，必须提示核实深度
  if (verifiedRate < VERIFIED_WARN_RATIO && n < 5) {
    n++;
    L.push(
      `${n}. 范围 ${t.total} 项中仅 ${t.verified} 项经过反选核实（${pct(verifiedRate)}），其余为「默认已落地·待核实」而非确认无问题；落地率 ${pct(t.landRate)} 存在虚高风险，须补充抽样核实。`,
    );
  }
  if (rc.redline.triggered && n < 5) {
    n++;
    L.push(`${n}. 红线预警已触发：${rc.redline.reasons.join('；')}。`);
  }
  if (n === 0) L.push('1. 本次审核范围内未发现明显高风险信号，建议维持现有控制水平并关注数据趋势。');

  // 固定体系性风险：与数据无关的审核口径固有风险，DeepSeek 不可用时也不丢
  L.push('', '#### 体系性风险提示（固定口径）');
  systemicRisks().forEach((r, i) => L.push(`${i + 1}. ${r}`));

  L.push('', '### 改进建议');
  let m = 0;
  const advice: string[] = [];
  if (p0.length) {
    m++;
    advice.push(`${m}. 对 ${p0.length} 条 P0 项（${PRIORITY_LABEL.P0}）建立专项整改台账，明确责任人与完成时限，整改后由质量负责人现场复核确认。`);
  } else if (keyBad.length) {
    m++;
    advice.push(`${m}. 对 ${keyBad.length} 条关键项未落地内容建立专项整改台账，明确责任人与完成时限，整改后由质量负责人现场复核确认。`);
  }
  for (const f of rc.focus) {
    if (m >= 5) break;
    if (f.total > 0 && f.counts.not_landed + f.counts.partial > 0) {
      m++;
      advice.push(`${m}. 「${f.category}」：未落地 ${f.counts.not_landed} 条、部分落地 ${f.counts.partial} 条，补充缺失证据文件并完善记录，确保文件与现场实操一致。`);
    }
  }
  // 分组核实进度低 = 该组条款大概率只是默认落地，须回头确认
  const lazyGroups = rc.byGroup
    .filter((g) => g.total > 0 && g.verified / g.total < VERIFIED_WARN_RATIO)
    .sort((a, b) => a.verified / a.total - b.verified / b.total);
  for (const g of lazyGroups.slice(0, 2)) {
    if (m >= 5) break;
    m++;
    advice.push(
      `${m}. 小组「${g.groupName}」范围 ${g.total} 项中仅核实 ${g.verified} 项，请在本阶段完成剩余条款确认，避免把「默认已落地」误当作已核实合格。`,
    );
  }
  // 固定口径对应的动作：8 个无对应检查项条款须单独取证，4 项法规特有分别判定
  if (m < 5) {
    m++;
    advice.push(`${m}. 对 ISO 13485 无对应检查项的 ${ISO_CLAUSES_WITHOUT_ITEM.join('、')} 条款单独安排取证与评价，不得因底表未列项而漏审。`);
  }
  if (m < 5) {
    m++;
    advice.push(`${m}. 对「法规特有」${ISO_UNIQUE_ITEMS.join('、')} 分别按认证审核与 GMP 检查两套口径判定并留存结论，不互相替代。`);
  }
  if (m === 0) advice.push('1. 维持现有体系运行节奏，按年度计划开展内审与管理评审，持续跟踪质量指标趋势。');

  L.push(advice.join('\n'));
  L.push('', '### 增值评估小结');
  L.push(
    `本次现场审核共评估 ${t.total} 项 GMP 落地情况，落地率 ${pct(t.landRate)}，其中 ${t.verified} 项经反选核实（${pct(verifiedRate)}）、${t.abnormal} 项标记异常，${
      rc.redline.triggered ? '已触发红线预警，需重点关注上述高风险领域。' : '未触发红线预警。'
    }落地率含「默认已落地·待核实」项，仅作趋势参考；建议按本简报改进建议逐项跟进，并在整改完成后提交验证证据。`,
  );
  return L.join('\n');
}