// 审核关注点全量抽取：12 个 P 过程 Word → 结构化 JSON
// 单元格内<strong> 段落视为关注点标题，其后普通段落视为该关注点的补充说明
import * as fs from 'fs';
import * as path from 'path';

// ★ 记录模板所在目录从命令行参数或环境变量读取，不再写死本机绝对路径。
//   用法：npx tsx extract-focus.ts "D:/某路径/P1-P12 记录模板目录"
//   或：  set PLAN_TPL_DIR=D:/某路径/记录模板目录 && npx tsx extract-focus.ts
const DIR = process.argv[2] || process.env.PLAN_TPL_DIR || '';
if (!DIR) {
  console.error('请传入 P1~P12 记录模板所在目录：npx tsx extract-focus.ts "D:/路径/记录模板目录"');
  process.exit(1);
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把单元格 HTML 拆成段落数组，标注是否为加粗标题 */
function parseParas(cellHtml: string): { text: string; bold: boolean }[] {
  const out: { text: string; bold: boolean }[] = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>|<br\s*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cellHtml))) {
    if (m[1] === undefined) continue;
    const raw = m[1];
    const bold = /<strong[\s>]/i.test(raw) || /<b[\s>]/i.test(raw);
    const text = decode(raw.replace(/<[^>]+>/g, ''));
    if (text) out.push({ text, bold });
  }
  return out;
}

interface Focus {
  seq: number;
  title: string;
  detail: string[];
  /** 右栏（审核记录）已有的提示文字，作为填写指引 */
  checklist: string[];
  fillable: boolean;
}

interface ProcessFile {
  code: string; // P1
  name: string; // 特殊过程确认及关键工序验证过程
  isoText: string; // 过程涉及的标准条款 原文
  gmpFocus: boolean; // 是否 GMP 重点章节
  focuses: Focus[];
}

const files = fs
  .readdirSync(DIR)
  .filter((f) => /^P\d+.*\.docx$/i.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)![0]) - parseInt(b.match(/\d+/)![0]));

const out: ProcessFile[] = [];

for (const f of files) {
  const html = fs.readFileSync(path.join(__dirname, 'dump-' + f.replace(/\.docx$/i, '.html')), 'utf8');
  const table = html.match(/<table[\s\S]*?<\/table>/i)![0];
  const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];

  const cellArr = (rowHtml: string) => rowHtml.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || [];

  // 第1 行：过程编号及名称
  const row1 = cellArr(rows[1] || '');
  const nameCell = decode((row1[1] || '').replace(/<[^>]+>/g, ''));
  const code = (nameCell.match(/P\d+/) || [f.match(/P\d+/)![0]])[0];
  const name = decode(nameCell.replace(/P\d+/, '').trim()) || f.replace(/\.docx$/i, '').replace(/^P\d+/, '');

  // 第 2 行：过程涉及的标准条款
  const row2 = cellArr(rows[2] || '');
  const isoText = decode((row2[0] || '').replace(/<[^>]+>/g, '').replace(/^过程涉及的标准条款[:：]/, ''));

  // 第 4 行起为关注点行，第 3 行是表头
  const focuses: Focus[] = [];
  for (let i = 4; i < rows.length; i++) {
    const cells = cellArr(rows[i]);
    if (cells.length < 2) continue;
    const leftParas = parseParas(cells[0]);
    const rightParas = parseParas(cells[1] || '');
    if (!leftParas.length) continue;

    // 一个单元格内可能有多个加粗关注点（如 P7 的「特殊过程确认」「关键工序验证」是两条），
    // 因此按加粗段落切分：每个加粗段开启一条新关注点，其后的普通段落归入该条。
    // 无加粗段落的行（整格都是正文）按首段开启一条，其余作补充。
    const boldIdx = leftParas.map((p, k) => (p.bold ? k : -1)).filter((k) => k >= 0);
    const starts = boldIdx.length ? boldIdx : [0];

    for (let s = 0; s < starts.length; s++) {
      const from = starts[s];
      const to = s + 1 < starts.length ? starts[s + 1] : leftParas.length;
      const title = leftParas[from].text;
      const detail = leftParas.slice(from + 1, to).map((p) => p.text);
      focuses.push({
        seq: focuses.length + 1,
        title,
        detail,
        // 右栏是模板里「审核记录」那一列 —— 它不是提示，而是审核员要逐条填写/核查的记录要点清单。
        // 例如 P1 首条右栏是「公司成立于 年 / 企业负责人：年龄 专业 学历」这类待填项。
        checklist: rightParas.map((p) => p.text),
        // 总结栏判定：整条标题就是「实施评价 / 小结 / 效果评价」这类收口语。
        // 注意不能用 /实施情况/ 这类宽泛匹配 —— P1 的「管理评审的策划及实施情况」是
        // 正常的核查项（含「实施情况」四字），会被误杀。
        fillable: !/^\s*(本过程(的)?)?(实施评价|实施情况|小结|效果评价|总体评价|结论)\s*[:：]?\s*$/.test(title),
      });
    }
  }

  out.push({ code, name, isoText, gmpFocus: false, focuses });
  console.log(`${code.padEnd(4)} ${name.padEnd(30)} 关注点 ${focuses.length} 条 | 条款: ${isoText.slice(0, 60)}`);
}

fs.writeFileSync('focus-points.json', JSON.stringify(out, null, 2), 'utf8');
console.log('\n已写出 focus-points.json');
console.log('总关注点数:', out.reduce((s, p) => s + p.focuses.length, 0));