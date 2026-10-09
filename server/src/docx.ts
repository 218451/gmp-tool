// ===== Word (.docx) 报告导出 =====
// 口径基线：国药监械管〔2026〕14 号 附件《规范》检查项目 200 项（2026-11-01 施行）
// 反选模型：条款默认「已落地（待核实）」，仅被反选者落入 partial/not_landed/na，
//          故报告中一律区分「已核实」与「未核实（默认已落地）」，不得混称为已核实落地。
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  HeadingLevel,
  BorderStyle,
  ShadingType,
  VerticalAlign,
  PageBreak,
} from 'docx';
import type { ReportContent } from './report-engine';
import { PRIORITY_LABEL, REDLINE_RULES, STATUS_LABEL, type Priority } from './types';

const FONT = '宋体';
const RED = 'C62828';
const GREEN = '2E7D32';
const ORANGE = 'F9A825';
const GREY = '9E9E9E';
const AMBER_BG = 'FFF4E5';

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const safeDiv = (a: number, b: number) => (b ? a / b : 0);

/** 条款原文可长达上百字，表格内统一限长，完整原文见附录 */
const clip = (s: string, n = 46) => (s.length > n ? `${s.slice(0, n)}…（详见附录）` : s);

const p = (
  text: string,
  opts: { bold?: boolean; size?: number; color?: string; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; indent?: boolean } = {},
) =>
  new Paragraph({
    alignment: opts.align ?? AlignmentType.LEFT,
    spacing: { after: 120 },
    indent: opts.indent ? { left: 360 } : undefined,
    children: [new TextRun({ text, bold: opts.bold, size: opts.size ?? 22, color: opts.color, font: FONT })],
  });

/** 无序条目段落 */
const li = (text: string, color?: string) => p(`· ${text}`, { color, indent: true });

const h1 = (t: string) =>
  new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 }, children: [new TextRun({ text: t, bold: true, size: 28, font: FONT })] });
const h2 = (t: string) =>
  new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 180, after: 100 }, children: [new TextRun({ text: t, bold: true, size: 24, font: FONT })] });

const cell = (text: string, bold = false, color?: string, fill?: string) =>
  new TableCell({
    verticalAlign: VerticalAlign.CENTER,
    shading: fill ? { type: ShadingType.CLEAR, fill } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text, bold, size: 20, color, font: FONT })] })],
  });

const table = (head: string[], rows: string[][], opts: { headFill?: string } = {}) =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1, color: 'AAAAAA' },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: 'AAAAAA' },
      left: { style: BorderStyle.SINGLE, size: 1, color: 'AAAAAA' },
      right: { style: BorderStyle.SINGLE, size: 1, color: 'AAAAAA' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
      insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
    },
    rows: [
      new TableRow({ tableHeader: true, children: head.map((t) => cell(t, true, undefined, opts.headFill ?? 'F2F2F2')) }),
      ...rows.map((r) => new TableRow({ children: r.map((t) => cell(t)) })),
    ],
  });

/** 告警块：浅底色表格包裹，突出红线/风险 */
const alertBlock = (title: string, lines: string[], bg = AMBER_BG, titleColor = RED) => {
  const out: (Paragraph | Table)[] = [
    p(title, { bold: true, color: titleColor, size: 24 }),
    table([title], lines.map((t) => [t]), { headFill: bg }),
  ];
  return out;
};

/** 硬编码底表「统计说明」口径：无对应检查项的 ISO 条款（不得漏审） */
const ISO_NO_CHECK = [
  { no: '5.2', name: '质量方针' },
  { no: '5.4.2', name: '质量目标可测量' },
  { no: '7.2.2', name: '人力资源培训/能力' },
  { no: '7.5.7', name: '生产和服务过程确认' },
  { no: '7.5.10', name: '监视和测量设备的溯源确认' },
  { no: '8.2.5', name: '记录控制（保存期限/可追溯性）' },
  { no: '8.3.2', name: '不合格品处置（返工/让步接收）' },
  { no: '8.3.3', name: '不良事件报告与召回' },
];

/** 法规特有项：ISO 13485 无对应条款，认证审核与 GMP 检查判定口径不同 */
const REG_ONLY = [
  { code: '3.1.2', note: '法规特有要求，须按《规范》单独判定，不得以 ISO 无对应为由豁免' },
  { code: '3.6.2', note: '法规特有要求，判定口径与认证审核不同' },
  { code: '3.7.1', note: '法规特有要求，判定口径与认证审核不同' },
  { code: '3.8.1', note: '法规特有要求，判定口径与认证审核不同' },
];

// ===== 报告主体：三段式（总体评价 → 亟待解决的问题 → 未落地条款清单）=====
/**
 * 报告结构依据（负责人口径）：
 *   报告要回答的只有三个问题 —— 哪些条款没落地、亟待解决哪些问题、总体评价是什么。
 *   因此正文按「结论先行」组织，不再逐章逐条罗列 200 项：
 *
 *   一、总体评价        —— 一句话结论 + 等级 + 关键指标 + 评价正文（先给结论）
 *   二、亟待解决的问题   —— 按章 + 优先级归并的问题清单，每条含定性、依据、处置建议
 *   三、未落地条款清单   —— 支撑上表的条款明细（含原文），供复核与追责
 *
 * 保留的合规必要内容（三处）：
 *   · 已核实 / 未核实口径说明 —— 防止把「默认已落地」误读为「审核确认已落地」
 *   · 红线预警 —— 触及法规红线，必须显式披露
 *   · 声明 —— 不作认证结论承诺，划清监管红线
 *
 * 已从正文移除（改为按需索取）：三大重点章节专项统计、审核组进度明细、
 * ISO 无对应条款硬编码表、法规特有项表、章节分布全表、重复条款明细表。
 * 这些是过程性材料，不是报告要回答的问题；需要时看系统页面即可。
 */

const PRIORITIES: Priority[] = ['P0', 'P1', 'P2'];
const PRIORITY_LABEL_SHORT: Record<Priority, string> = { P0: 'P0 立即处置', P1: 'P1 限期整改', P2: 'P2 持续改进' };
const PRIORITY_COLOR: Record<Priority, string> = { P0: RED, P1: 'E65100', P2: '5D4037' };
const PRIORITY_BG: Record<Priority, string> = { P0: 'FDECEC', P1: AMBER_BG, P2: 'F5F5F5' };

/** 评价等级 → 配色 */
const GRADE_STYLE: Record<string, { color: string; bg: string }> = {
  critical: { color: RED, bg: 'FDECEC' },
  poor: { color: 'E65100', bg: AMBER_BG },
  acceptable: { color: '2E7D32', bg: 'EDF7ED' },
  good: { color: GREEN, bg: 'EDF7ED' },
};

/** 生成精简版 docx Buffer */
export async function buildDocx(rc: ReportContent, aiSummary: string, confirmedBy?: string | null): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  const t = rc.totals;
  const unverified = t.total - t.verified;
  const problems = rc.problems ?? [];
  const v = rc.verdict;
  const gradeStyle = GRADE_STYLE[v.grade] ?? { color: GREEN, bg: 'EDF7ED' };

  // ===== 封面（压到最小：标题 + 企业 + 日期）=====
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [new TextRun({ text: '新版 GMP 落地增值评估报告', bold: true, size: 34, font: FONT })],
    }),
  );
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [new TextRun({ text: rc.project.name || '—', size: 24, color: '333333', font: FONT })],
    }),
  );
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: `审核日期 ${rc.project.auditDate}　|　复核人 ${confirmedBy || '待复核'}　|　生成于 ${new Date(rc.generatedAt).toLocaleDateString('zh-CN')}`,
          size: 18,
          color: '777777',
          font: FONT,
        }),
      ],
    }),
  );

  // ===== 一、总体评价 =====
  children.push(h1('一、总体评价'));

  // 一句话结论（最醒目）
  children.push(
    new Paragraph({
      spacing: { after: 120 },
      shading: { type: ShadingType.CLEAR, fill: gradeStyle.bg },
      border: {
        left: { style: BorderStyle.SINGLE, size: 18, color: gradeStyle.color, space: 8 },
      },
      children: [new TextRun({ text: v.headline, bold: true, size: 24, color: gradeStyle.color, font: FONT })],
    }),
  );
  children.push(p(`评价等级：${v.gradeLabel}`, { bold: true, color: gradeStyle.color, size: 22, align: AlignmentType.RIGHT }));

  // 关键指标横排
  children.push(
    table(
      v.metrics.map((m) => m.label),
      [v.metrics.map((m) => m.value)],
      { headFill: 'F5F5F5' },
    ),
  );

  // 评价正文
  for (const para of v.paragraphs) children.push(p(para, { size: 21 }));

  // 核查口径说明（合规必要：防止把「默认已落地」误读为「审核确认落地」）
  children.push(h2('核查口径说明'));
  children.push(
    table(
      ['口径', '条款数', '含义'],
      [
        [`已核实 ${t.verified} 条`, `${t.verified}`, '有明确核查记录与结论'],
        [`未核实 ${unverified} 条`, `${unverified}`, '默认已落地（待核实），不等同于审核确认已落地'],
        [`合计 ${t.total} 条`, `${t.total}`, '本次核查范围'],
      ],
    ),
  );
  children.push(
    p(
      unverified > 0
        ? `本报告落地率含 ${unverified} 项「默认已落地（待核实）」，可能被高估。建议以已核实条款为主要判断依据。`
        : '本次范围内条款均已核实并形成结论，落地率可作为合规判断依据。',
      { size: 20, color: unverified > 0 ? 'E65100' : GREEN },
    ),
  );

  // 红线预警（触及法规红线，必须显式披露）
  children.push(h2('红线预警'));
  const th = rc.redline.thresholds ?? REDLINE_RULES;
  if (rc.redline.triggered) {
    children.push(...alertBlock('本次审核已触发红线预警，需按下列结论处置：', rc.redline.reasons));
  } else {
    children.push(p('本次审核未触发红线预警。', { color: GREEN, bold: true }));
  }
  children.push(
    table(
      ['红线维度', '实际值', '阈值', '判定'],
      [
        ['关键项不符合', `${rc.redline.keyNotMet}`, `≥${th.keyNotMet}`, rc.redline.keyNotMet >= th.keyNotMet ? '触发' : '未触发'],
        ['关键＋主要不符合', `${rc.redline.keyPlusMainNotMet}`, `≥${th.keyPlusMain}`, rc.redline.keyPlusMainNotMet >= th.keyPlusMain ? '触发' : '未触发'],
        ['一般项不符合', `${rc.redline.generalNotMet}`, `≥${th.generalNotMet}`, rc.redline.generalNotMet >= th.generalNotMet ? '触发' : '未触发'],
        ['总不符合', `${rc.redline.totalNotMet}`, `≥${th.totalNotMet}`, rc.redline.totalNotMet >= th.totalNotMet ? '触发' : '未触发'],
      ],
    ),
  );

  // ===== 二、亟待解决的问题 =====
  children.push(h1('二、亟待解决的问题'));
  if (!problems.length) {
    children.push(p('本次核查未发现未落地条款，无需列入整改。', { color: GREEN }));
  } else {
    children.push(
      p(
        `共归并 ${problems.length} 个问题。归并口径：同章节 + 同优先级合并为一个问题，避免同类差距被拆成多条分散整改。优先级判定：关键项未落地为 P0，主要项未落地为 P1，一般项未落地为 P2。`,
        { size: 20 },
      ),
    );

    // 问题概览表（先给一张能排序的清单）
    children.push(
      table(
        ['编号', '问题', '优先级', '条款数', '关键项', '涉及过程', '责任组'],
        problems.map((x) => [
          x.id,
          clip(x.title, 24),
          PRIORITY_LABEL_SHORT[x.priority],
          `${x.clauseCount}`,
          `${x.keyCount}`,
          x.processCodes.join('、') || '—',
          x.groupNames.join('/') || '未分组',
        ]),
      ),
    );

    // 逐个问题展开
    for (const x of problems) {
      children.push(h2(`${x.id}　${x.title}`));
      children.push(
        table(
          ['项', '内容'],
          [
            ['优先级', PRIORITY_LABEL_SHORT[x.priority]],
            ['所属章节', x.chapterName + (x.processCodes.length ? `（${x.processCodes.join('、')}）` : '')],
            ['问题定性', x.nature],
            ['判定依据', x.basis],
            ['涉及条款', `${x.clauseCount} 项${x.keyCount ? `，其中关键项 ${x.keyCount} 项` : ''}`],
            ['责任审核组', x.groupNames.join('、') || '未分组'],
            ...(x.hasConflict ? [['⚠ 组间判定不一致', '各审核组对部分条款判定不一致，须在末次会议当面澄清并统一口径']] : []),
          ],
        ),
      );
      children.push(p('处置建议：', { bold: true, size: 21 }));
      x.actions.forEach((a) => children.push(li(a, PRIORITY_COLOR[x.priority])));
      children.push(p(`涉及条款：${x.clauseCodes.join('、')}（原文见第三节）`, { size: 18, color: '777777' }));
    }
  }

  // ===== 三、未落地条款清单 =====
  children.push(h1('三、未落地条款清单'));
  children.push(
    p(`下列 ${rc.abnormalList.length} 条为本次核查判定未落地的条款，作为第二节问题的支撑明细。完整原文一并列出，便于受审核方逐条确认与追责。`, { size: 20 }),
  );
  if (!rc.abnormalList.length) {
    children.push(p('无。', { color: GREEN }));
  } else {
    // 概览表（速览）
    children.push(
      table(
        ['优先级', '条款号', '章节', '级别', '《规范》条款', '条款要求（摘要）', '责任组'],
        rc.abnormalList.map((x) => [
          PRIORITY_LABEL_SHORT[x.priority],
          x.code,
          x.chapterName,
          x.level,
          x.specClause,
          clip(x.text, 40),
          x.groupNames.join('/') || '未分组',
        ]),
      ),
    );
    // 原文（复核用）
    children.push(h2('条款原文与判定依据'));
    rc.abnormalList.forEach((x) => {
      children.push(
        p(`${x.code}　${x.chapterName}　${x.level}项　《规范》${x.specClause}`, { bold: true, size: 21, color: PRIORITY_COLOR[x.priority] }),
      );
      children.push(p(x.text, { size: 20 }));
      children.push(
        p(
          `ISO 13485 对应：${x.isoList.length ? x.isoList.join('、') : '无对应（法规特有或扩展要求）'}　|　责任组：${x.groupNames.join('/') || '未分组'}${x.conflict ? '　【组间判定不一致，须澄清】' : ''}`,
          { size: 18, color: '777777' },
        ),
      );
    });
  }

  // ===== 附：AI 补充意见（若有）=====
  const aiLines = (aiSummary || '').split(/\r?\n/).filter((l) => l.trim());
  if (aiLines.length) {
    children.push(h1('附：审核组补充说明'));
    for (const ln of aiLines) {
      const text = ln.replace(/^#+\s*/, '').trim();
      if (!text) continue;
      const isHead = /^(高风险信号|改进建议|增值评估小结)/.test(text);
      children.push(p(text, { bold: isHead, size: isHead ? 23 : 21 }));
    }
  }

  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(
    new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: '（本报告正文结束）', size: 18, color: '999999', font: FONT })] }),
  );

children.push(h1('声明'));
  children.push(
    p(
      '本报告依据 ISO 13485:2016 及《医疗器械生产质量管理规范》（国药监械管〔2026〕14 号附件，2026-11-01 起施行）现场审核记录生成，采用「默认已落地＋反选异常」核查模式，仅作为认证审核组的增值评估与技术支持材料，不构成对受审核方产品注册、体系认证或其他行政许可结果的承诺。整改建议的最终实施责任在受审核方。本报告不提供直接提交监管、包通过检查或保证通过检查等结论性承诺。',
      { size: 20, color: '666666' },
    ),
  );

  const doc = new Document({
    creator: 'GMP 落地增值评估工具',
    title: `${rc.project.name} - GMP 落地增值评估报告`,
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(doc);
}