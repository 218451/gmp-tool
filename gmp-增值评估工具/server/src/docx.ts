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
} from 'docx';
import type { ReportContent } from './report-engine';
import { REDLINE_RULES, type Priority } from './types';

const FONT = '宋体';
const RED = 'C62828';
const GREEN = '2E7D32';
const AMBER_BG = 'FFF4E5';

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

// 注：早期版本里的「ISO 无对应检查项底表」与「法规特有项表」已随正文收敛一并移除，
//     两者均属体系审核底稿而非报告要回答的问题，需要时查 ISO_NO_CHECK_LIST 常量。

// ===== 报告主体：三块（红线预警 → 亟待解决的问题 → 未落地条款清单）=====
/**
 * 报告结构依据（负责人口径，2026-10-09 收敛）：
 *   「生成的报告里面只体现红线预警、亟待解决的问题、未落地条款清单，其余都不要。」
 *
 * 因此正文**只有三块**，顺序按「先定性、再展开、后附明细」：
 *
 *   一、红线预警         —— 触及法规红线才触发，触发即置顶；含四维度阈值对照表
 *   二、亟待解决的问题   —— 按章 + 优先级归并，每条含定性、依据、责任组、处置建议
 *   三、未落地条款清单   —— 支撑第二节的条款明细（含原文），供复核与追责
 *
 * ★ 已删除的内容（负责人明确「其余都不要」）：
 *   · 封面页（标题 / 企业名 / 审核日期 / 复核人）—— 改为正文顶部一行标题
 *   · 「总体评价」整节 —— 一句话结论、评价等级、关键指标横排、评价正文
 *   · 「核查口径说明」小节 —— 已核实/未核实口径表 + 落地率可能被高估的提示
 *   · 「附：审核组补充说明」（AI 生成内容）
 *   连带不再使用 aiSummary / confirmedBy 的内容（签名保留以兼容现有调用）。
 *
 * 保留「声明」一节（合规必要，划清监管红线）：
 *   本工具不提供「直接提交监管 / 包通过检查」类承诺，删掉声明会让报告被误当成认证结论文件。
 *
 * 更早一轮已移除的内容：三大重点章节专项统计、审核组进度明细、
 * ISO 无对应条款硬编码表、法规特有项表、章节分布全表、重复条款明细表。
 */

const PRIORITY_LABEL_SHORT: Record<Priority, string> = { P0: 'P0 立即处置', P1: 'P1 限期整改', P2: 'P2 持续改进' };
const PRIORITY_COLOR: Record<Priority, string> = { P0: RED, P1: 'E65100', P2: '5D4037' };

/** 生成精简版 docx Buffer */
export async function buildDocx(rc: ReportContent, aiSummary: string, confirmedBy?: string | null): Promise<Buffer> {
  // ★ 已按口径移除 AI 补充意见与复核人抬头，保留参数仅为兼容现有调用签名
  void aiSummary;
  void confirmedBy;
  const children: (Paragraph | Table)[] = [];
  const t = rc.totals;
  const problems = rc.problems ?? [];

  // ===== 标题（仅一行，替代原封面页）=====
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [
        new TextRun({
          text: `${rc.project.name || '—'}　新版 GMP 落地增值评估报告`,
          bold: true,
          size: 30,
          font: FONT,
        }),
      ],
    }),
  );

  // ===== 一、红线预警 =====
  children.push(h1('一、红线预警'));
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
  children.push(
    p(`本次核查范围合计 ${t.total} 条，已核实 ${t.verified} 条，未落地 ${t.abnormal} 条。`, { size: 20, color: '666666' }),
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

  // ★ 「附：审核组补充说明」（AI 生成内容）已按口径移除。
  //   aiSummary 参数仍保留在签名里，但内容不再进入正文 —— 见函数开头注释。

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