// ===== 现场审核计划 Word 解析器（真实 CMD 认证审核计划版）=====
//
// 真实计划表结构（来自一份 CMD 认证审核计划的 Word 样本）：
//   | 日期 | 时间 | 过程名称 | 受审核部门 | 审核员 |
//   | 10月12日 | 10:30～12:00 | P1领导作用及管理活动 | 管理层 | A（南京） |
//
// 四个必须处理的现实问题：
//   1. 过程名带产品后缀：「P9生产与服务提供过程(无菌产品)」与「(有源产品)」是不同安排
//   2. 审核员是代号不是姓名：「A（南京）」——姓名在另一张「审核组成员」表里
//   3. 条款串极复杂：区间 7.5.8~7.5.11、双标准 4.1（4）、夹杂非条款文本「软件确认」
//   4. 同一过程同日出现多次（派给不同审核员）→ 必须按「过程 × 组」建工作包，不能按条款去重
//
import mammoth from 'mammoth';

// ---------- 基础工具 ----------

function decode(s: string): string {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ISO 条款号归一：兼容全角、中文「第X条」、尾随笔误（7.5.1f）→ 7.5.1 */
export function normalizeIso(s: string): string {
  const m = decode(s)
    .replace(/[０-９．。]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .match(/(\d+(?:\.\d+)*)/);
  return m ? m[1] : '';
}

/**
 * 展开条款串为条款明细列表。
 * 支持：
 *   区间      7.5.8~7.5.11      → 7.5.8 / 7.5.9 / 7.5.10 / 7.5.11
 *             4.2.1~4.2.2        → 4.2.1 / 4.2.2
 *   双标准    4.1（4）→ 主标准 4.1(13485) + 并列条款 4(9001)
 *             括号内是 GB/T 19001（ISO 9001）条款，映射表未覆盖，标 standard='9001'
 *   笔误      7.5.1f）        → 7.5.1（括号不闭合按笔误处理）
 *   夹杂文本  「软件确认」这类非条款内容直接跳过
 */
export function expandIsoList(text: string): { clause: string; standard: '13485' | '9001' }[] {
  const out: { clause: string; standard: '13485' | '9001' }[] = [];
  const src = decode(text);
  //顶层括号 = 9001 并列条款；顶层括号外 = 13485 主标准
  const segments: { body: string; std: '13485' | '9001' }[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of src) {
    if (ch === '(' || ch === '（') {
      if (depth === 0 && buf.trim()) segments.push({ body: buf, std: '13485' });
      depth += 1;
      buf = '';
      continue;
    }
    if (ch === ')' || ch === '）') {
      if (depth > 0) {
        if (buf.trim()) segments.push({ body: buf, std: '9001' });
        depth -= 1;
        buf = '';
        continue;
      }
      // 孤立的右括号（笔误「7.5.1f）」）：忽略，条款号已在上一个片段里
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) segments.push({ body: buf, std: '13485' });

  const seen = new Set<string>();
  for (const seg of segments) {
    // 括号内还可能再嵌套（(7.1.3、7.1.4、7.1.5) 这种），递归按 9001 处理
    const parts = seg.body.split(/[、,，;；]+/).filter((p) => /\d/.test(p));
    for (const part of parts) {
      const range = part.match(/(\d+(?:\.\d+)*)\s*[~～\-—至]\s*(\d+(?:\.\d+)*)/);
      if (range) {
        const a = range[1].split('.');
        const b = range[2].split('.');
        const tail = parseInt(b[b.length - 1], 10);
        const headTail = parseInt(a[a.length - 1], 10);
        const samePrefix = a.slice(0, -1).join('.') === b.slice(0, -1).join('.');
        if (samePrefix && tail - headTail <= 30 && tail >= headTail) {
          const prefix = a.slice(0, -1).join('.');
          for (let i = headTail; i <= tail; i++) {
            const c = prefix ? `${prefix}.${i}` : String(i);
            const key = `${seg.std}:${c}`;
            if (!seen.has(key)) {
              seen.add(key);
              out.push({ clause: c, standard: seg.std });
            }
          }
          continue;
        }
      }
      const one = normalizeIso(part);
      if (/^\d+(\.\d+)*$/.test(one)) {
        const key = `${seg.std}:${one}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ clause: one, standard: seg.std });
        }
      }
    }
  }
  return out;
}

/** 解析审核员字段：「A（南京）」→ { code: 'A', site: '南京' }；「ABC」→ { code: 'ABC' } */
export function parseAuditorCell(text: string): { code: string; site: string } {
  const t = decode(text);
  const m = t.match(/^([A-Za-zＡ-Ｚ]{1,4})\s*[（(]\s*([^）)]*)\s*[）)]$/);
  if (m) return { code: m[1].toUpperCase(), site: decode(m[2]) };
  // 纯代号（可能多位，如「AB」「ABC」）
  const c = t.match(/^([A-Za-zＡ-Ｚ]{1,4})$/);
  if (c) return { code: c[1].toUpperCase(), site: '' };
  return { code: t, site: '' };
}

/** 解析过程名称：「P9生产与服务提供过程(无源产品)」→ { code:'P9', name:'生产与服务提供过程', variant:'无源产品' } */
export function parseProcessCell(text: string): { code: string; name: string; variant: string; isoText: string } {
  const t = decode(text);
  const m = t.match(/^P(\d{1,2})\s*(.*)$/);
  if (!m) return { code: '', name: t, variant: '', isoText: '' };
  const code = `P${m[1]}`;
  const rest = m[2];
  // 过程名与条款串的分界：第一个「数字+点」形态的条款号起点。
  // 用\d[\d.]*\. 限定，避免把「P10」「6.3」这类前缀数字误判，也避免「软件确认」被切开。
  const isoStart = rest.search(/\d+(?:\.\d+)*\.|\d+(?:\.\d+)*(?:\s|$)/);
  const namePart = isoStart >= 0 ? rest.slice(0, isoStart) : rest;
  const isoText = isoStart >= 0 ? rest.slice(isoStart) : '';
  let name = decode(namePart);
  let variant = '';
  const v = name.match(/[（(]([^）)]*)[）)]\s*$/);
  if (v && v[1].length <= 24) {
    variant = v[1];
    name = decode(name.slice(0, v.index));
  }
  return { code, name, variant, isoText };
}

/** 表头关键词匹配 */
const HEADERS = {
  date: ['日期', 'day'],
  time: ['时间', 'time'],
  process: ['过程名称', '过程', 'process'],
  dept: ['受审核部门', '部门', 'dept'],
  auditor: ['审核员', '审核人', 'auditor'],
};

// ---------- 表格抽取 ----------

export function extractTables(html: string): string[][][] {
  const tables: string[][][] = [];
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  const trRe = /<tr[\s\S]*?<\/tr>/gi;
  const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tableRe.exec(html))) {
    const rows: string[][] = [];
    trRe.lastIndex = 0;
    let trm: RegExpExecArray | null;
    while ((trm = trRe.exec(tm[0]))) {
      const cells: string[] = [];
      cellRe.lastIndex = 0;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(trm[0]))) {
        cells.push(decode(cm[1].replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|div)>/gi, ' ').replace(/<[^>]+>/g, '')));
      }
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

// ---------- 审核组成员表（代号 → 姓名/注册信息）----------

export interface MemberInfo {
  code: string;
  name: string;
  role: string;
  regNo: string;
  specialty: string;
  phone: string;
}

/**
 * 从「审核组成员」表里取组内代号与姓名。
 * 真实表头：姓名 | 组内代号 | 注册级别 | 注册号码 | 专业代码 | 组内职务 | 联系电话
 *
 * 注意：该表的列在 Word 里常因合并单元格而整体左移，
 * 因此不按下标取，改按「单元格内容特征」判断每列的角色：
 *   - 代号列：纯字母或数字（长度 ≤ 6）
 *   - 注册号列：长数字串或含字母的长串（长度 ≥ 10）
 *   - 电话列：以 1 开头或长度 ≥ 11 的纯数字
 *   - 姓名列：2~4 个汉字
 */
/**
 * 解析审核组成员表。
 *
 * 真实结构（第 6 行才是表头）：
 *   审核组成员 | 姓名 | 组内代号 | 注册级别 | 注册号码 | 专业代码 | 组内职务 | 联系电话   ← 8 列
 *   张三 | A | 审核员 | 2025-XXXXXX-0000000 | 00Q00C | 组长 | 138XXXXXXXX← 7 列
 * 表头首格是「审核组成员」占位，数据行没有这格，因此数据行比表头少一列、下标整体左移。
 * 解决办法：以「组内代号」列为锚点，向左一格取姓名，向右依次取后续列。
 */
function parseMembers(grid: string[][]): MemberInfo[] {
  if (!grid.length) return [];
  const headRow = grid.findIndex((r) => r.some((c) => c.replace(/\s/g, '').includes('代号')));
  if (headRow < 0) return [];

  const head = (grid[headRow] || []).map((h) => decode(h).replace(/\s/g, ''));
  const iCode = head.findIndex((h) => h.includes('代号'));
  const iReg = head.findIndex((h) => h.includes('注册号码'));
  const iSpec = head.findIndex((h) => h.includes('专业'));
  const iRole = head.findIndex((h) => h.includes('职务'));
  const iPhone = head.findIndex((h) => h.includes('电话'));
  if (iCode < 0) return [];

  const out: MemberInfo[] = [];
  const seen = new Set<string>();
  for (const r of grid.slice(headRow + 1)) {
    const cells = r.map(decode);
    // 合并单元格使数据行比表头少一列，下标不可直接套用。
    // 以「纯字母格」为锚点定位代号列（表头代号列在该行必然左移同样的格数），
    // 姓名取其左侧一格，后续列按相对偏移右移。
    let codeIdx = -1;
    for (let k = 1; k < cells.length; k++) {
      if (/^[A-Za-zＡ-Ｚ]{1,4}$/.test(cells[k])) {
        codeIdx = k;
        break;
      }
    }
    if (codeIdx < 1) continue;
    const code = cells[codeIdx].toUpperCase();
    // ★ 姓名在 Word 里常被排版成「沈  莉」「刘  雨」，中间是全角/半角空格，
    //   必须先去掉空白再校验，否则会被姓名字段判据整行丢弃（连带组员账号丢失）。
    const name = cells[codeIdx - 1].replace(/\s+/g, '');
    if (!/^[\u4e00-\u9fa5·]{2,6}$/.test(name)) continue;
    if (seen.has(code)) continue;
    seen.add(code);

    const shift = codeIdx - iCode; // 通常为 -1（表头首格「审核组成员」占位）
    const get = (headIdx: number): string => {
      if (headIdx < 0) return '';
      let v = decode(cells[headIdx + shift] || '');
      // 注册号在「注册级别」之后；若对齐到「注册级别/审核员」这类词则顺延一格
      if (/^(注册级别|审核员)$/.test(v)) v = decode(cells[headIdx + shift + 1] || '');
      return v;
    };
    out.push({
      code,
      name,
      regNo: get(iReg),
      specialty: get(iSpec),
      role: get(iRole),
      phone: get(iPhone),
    });
  }
  return out;
}

// ---------- 计划表解析 ----------

export interface PlanRow {
  processCode: string;
  processName: string;
  variant: string; // 产品/场所后缀
  auditorCode: string; // A / B / C / AB
  site: string; // 南京 / 南通 / 句容
  deptName: string;
  dateText: string;
  timeRange: string;
  isoClause: string;
  /** 标准归属：13485（主标准，映射表已覆盖）| 9001（括号内并列条款，映射表无对应） */
  standard: '13485' | '9001';
}

export interface ParseResult {
  mode: 'process' | 'none';
  rows: PlanRow[];
  members: MemberInfo[];
  /** 从 Word 全文自动提取 —— 组长无需手填任何字段 */
  meta: { projectName?: string; auditDate?: string; auditEndDate?: string; certNo?: string };
  /** 按「过程 × 审核组 × 产品后缀 × 日期时段」聚合的工作包 —— 这才是真正要建的东西 */
  slots: {
    processCode: string;
    processName: string;
    variant: string;
    auditorCodes: string[];
    auditorNames: string[];
    sites: string[];
    deptName: string;
    dateText: string;
    timeRange: string;
    /** 形如 "13485:7.5.1" / "9001:8.5.2"，前缀为标准归属 */
    isoClauses: string[];
  }[];
  errors: { row: number; reason: string }[];
  diagnostics: string[];
}

const FOOTER_RE = /^(首次会议|末次会议|上午|下午|继续补充|补充审核|审核组内部|与领导层|注[:：]?\s*$|备注)/;

/** 挑出计划表：需含「过程」+「审核员」两列 */
function pickProcessTable(tables: string[][][]): { grid: string[][]; idx: number } | null {
  let best: { grid: string[][]; idx: number } | null = null;
  let bestScore = -1;
  tables.forEach((grid, idx) => {
    const head = (grid[0] || []).map((h) => h.replace(/\s/g, ''));
    const has = (k: string[]) => head.some((h) => k.some((x) => h.includes(x)));
    let score = 0;
    if (has(HEADERS.process)) score += 3;
    if (has(HEADERS.auditor)) score += 2;
    if (has(HEADERS.time)) score += 1;
    if (has(HEADERS.date)) score += 1;
    // 含 P 编号的行越多越像计划表
    const pHits = grid.slice(1).filter((r) => r.some((c) => /\bP\d{1,2}\b/.test(c))).length;
    score += Math.min(pHits, 8) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = { grid, idx };
    }
  });
  return bestScore >= 5 ? best : null;
}

/**
 * 解析计划表。
 *
 * 真实文档的两个坑：
 *  1. 过程名与条款串在同一个单元格（「P1领导作用及管理活动4.1（4）、4.2.1~4.2.2…」）
 *  2. 纵向合并单元格 —— Word 里某格被合并时 mammoth 会省略该格，导致后续列整体左移。
 *     表现为同一表内每行单元格数在 5/4/3/2 之间跳动（日期、时间跨行延续时更明显）。
 * 因此不能用固定下标，必须按「单元格内容特征」定位。
 */
function parseProcessTable(grid: string[][]): { rows: PlanRow[]; errors: ParseResult['errors'] } {
  const rows: PlanRow[] = [];
  const errors: ParseResult['errors'] = [];

  const isTime = (s: string) => /^\d{1,2}[:：]\d{2}/.test(decode(s));
  const isDate = (s: string) => /^\d{1,2}\s*月\s*\d{1,2}\s*日$/.test(decode(s).replace(/\s/g, ''));
  const isAuditor = (s: string) => /^[A-Za-zＡ-Ｚ]{1,4}\s*[（(]?[^）)]*[）)]?$/.test(decode(s)) && /[A-Za-zＡ-Ｚ]/.test(decode(s));
  const isProcess = (s: string) => /^\s*P\d{1,2}\s*\S/.test(decode(s));
  const isDash = (s: string) => /^-+$/.test(decode(s));

  // 跨行延续的状态（合并单元格导致本行没有该列时沿用上一行）
  let st = { date: '', time: '', dept: '', aud: '' };

  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i].map(decode);
    if (!cells.length) continue;

    // 定位过程列：含P 编号的那一格
    let iProc = cells.findIndex(isProcess);
    if (iProc < 0) {
      // 非计划行（首次会议 / 末次会议 / 内部沟通 / 备注），其中审核员要留给后续行继承
      const aIdx = cells.findIndex(isAuditor);
      if (aIdx >= 0 && !isDash(cells[aIdx])) st.aud = cells[aIdx];
      const tIdx = cells.findIndex(isTime);
      if (tIdx >= 0) st.time = cells[tIdx];
      continue;
    }

    // 过程列之前的：时间 / 日期
    const before = cells.slice(0, iProc);
    const tIdx = before.findIndex(isTime);
    if (tIdx >= 0) st.time = before[tIdx];
    const dIdx = before.findIndex(isDate);
    if (dIdx >= 0) st.date = before[dIdx];

    // 过程列之后：部门 / 审核员
    const after = cells.slice(iProc + 1);
    const aIdx = after.findIndex(isAuditor);
    if (aIdx >= 0) st.aud = after[aIdx];
    // 部门 = 审核员前一格（若存在且非破折号）
    if (aIdx > 0 && !isDash(after[aIdx - 1])) st.dept = decode(after[aIdx - 1]).replace(/\s+/g, ' ');

    const p = parseProcessCell(cells[iProc]);
    if (!p.code) {
      errors.push({ row: i + 1, reason: `过程名未识别编号：「${cells[iProc].slice(0, 30)}」` });
      continue;
    }
    const aud = parseAuditorCell(st.aud);
    if (!aud.code) {
      errors.push({ row: i + 1, reason: `${p.code} 未取到审核员（上一行审核员=${st.aud || '空'}）` });
      continue;
    }
    const isos = expandIsoList(p.isoText);
    if (!isos.length) {
      errors.push({ row: i + 1, reason: `${p.code} 未解析到条款号` });
      continue;
    }

    for (const it of isos) {
      rows.push({
        processCode: p.code,
        processName: p.name,
        variant: p.variant,
        auditorCode: aud.code,
        site: aud.site,
        deptName: st.dept,
        dateText: st.date,
        timeRange: st.time,
        isoClause: it.clause,
        standard: it.standard,
      });
    }
  }
  return { rows, errors };
}

/** 日期归一：「10月12日」/「10 月 12日」→ 10-12；跨月跨年由上层补 */
export function normalizeSlotDate(text: string): string {
  const m = decode(text).match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  return m ? `${Number(m[1])}-${Number(m[2])}` : decode(text);
}

/** 按「过程 × 审核组代号 × 产品后缀 × 日期时段」聚合工作包 */
function aggregateSlots(rows: PlanRow[], members: MemberInfo[]): ParseResult['slots'] {
  const nameByCode = new Map(members.map((m) => [m.code, m.name]));
  const map = new Map<string, ParseResult['slots'][number]>();
  for (const r of rows) {
    const slotDate = normalizeSlotDate(r.dateText);
    const key = `${r.processCode}::${r.variant}::${r.auditorCode}::${slotDate}::${r.timeRange}`;
    let s = map.get(key);
    if (!s) {
      const nm = nameByCode.get(r.auditorCode);
      s = {
        processCode: r.processCode,
        processName: r.processName,
        variant: r.variant,
        auditorCodes: [r.auditorCode],
        auditorNames: nm ? [nm] : [],
        sites: r.site ? [r.site] : [],
        deptName: r.deptName,
        dateText: slotDate,
        timeRange: r.timeRange,
        isoClauses: [],
      };
      map.set(key, s);
    }
    if (!s.auditorCodes.includes(r.auditorCode)) s.auditorCodes.push(r.auditorCode);
    const nm = nameByCode.get(r.auditorCode);
    if (nm && !s.auditorNames.includes(nm)) s.auditorNames.push(nm);
    if (r.site && !s.sites.includes(r.site)) s.sites.push(r.site);
    if (r.deptName && !s.deptName) s.deptName = r.deptName;
    const k = `${r.standard}:${r.isoClause}`;
    if (!s.isoClauses.includes(k)) s.isoClauses.push(k);
  }
  return [...map.values()];
}

/**
 * 从 Word 全文提取项目元信息 —— 目的：让组长不用手填任何字段。
 *
 * 真实计划里的写法（CMD 模板，已实测）：
 *   行6  「某受审核方企业名称」← 受审核方名称（表头与值分行）
 *   行30 「管理体系认证项目编号：Q260917455,QY260917614,」
 *   行31 「审核类别：Q3:再认证 QG1:再认证；」
 *   行88 「审核日期：2026年10月12日 上午至2026年10月14日 下午 共 3 人日」
 *
 * 三处易错点（都踩过）：
 *   1. 只扫前 60 行会漏 —— 审核期间写在第 88 行，故全量扫描
 *   2. 企业名与「受审核方名称」表头分行，不能依赖同行相邻
 *   3. 认证项目编号是 Q+6~9 位数字，不能用 /Q\d{4,6}/ 这种松正则
 */
function extractMeta(lines: string[]): ParseResult['meta'] {
  const meta: ParseResult['meta'] = {};
  const all = lines.join('\n');

  // --- 企业名称 ---
  // 优先取「受审核方名称」表头的下一非空行；取不到再退回通用机构名正则
  const idx = lines.findIndex((l) => /受审核方名称|受审核单位|审核方名称/.test(l));
  if (idx >= 0) {
    for (let i = idx + 1; i < Math.min(idx + 4, lines.length); i++) {
      const v = lines[i].trim();
      // 表头行形如「地址」「邮编」「电话」，不是企业名
      if (v && !/^(地址|邮编|电话|传真|管代|投诉|受审核方名称|审核方名称)$/.test(v)) {
        meta.projectName = v;
        break;
      }
    }
  }
  if (!meta.projectName) {
    // 受审核方在前、审核机构（北京国医械华光…）在后，取第一个机构名即为企业
    for (const l of lines.slice(0, 40)) {
      const nm = l.match(/([一-龥A-Za-z0-9()（）]{4,30}?(?:有限公司|股份有限公司|有限责任公司|厂|医院|中心|研究院|研究所))/);
      if (nm && !/认证|委员会/.test(nm[1])) {
        meta.projectName = nm[1];
        break;
      }
    }
  }

  // --- 认证项目编号 / 审核类别 ---
  const projNo = all.match(/(?:管理体系)?认证项目编号[：:]\s*([A-Za-z0-9,，\s]+)/);
  if (projNo) meta.certNo = projNo[1].trim().slice(0, 80);
  if (!meta.certNo) {
    const cat = all.match(/审核类别[：:]\s*([^\n]{0,60})/);
    if (cat) meta.certNo = cat[1].trim().slice(0, 80);
  }

  // --- 审核日期 ---
  // 实测写法一：「审核日期：2026年10月12日 上午至2026年10月14日 下午」→ 取首日
  // 写法二：「审核日期：2026-10-12」
  // 写法三：「计划已于 2026 年 10月08日与受审核方代表进行沟通」→ 仅沟通日期，不作审核日
  const range = all.match(/审核日期[：:]\s*(20\d{2})\s*[年.\-\/]\s*(\d{1,2})\s*[月.\-\/]\s*(\d{1,2})/);
  if (range) {
    meta.auditDate = `${range[1]}-${String(range[2]).padStart(2, '0')}-${String(range[3]).padStart(2, '0')}`;
  } else {
    const ymd = all.match(/\b(20\d{2})[年.\-\/](\d{1,2})[月.\-\/](\d{1,2})/);
    if (ymd) meta.auditDate = `${ymd[1]}-${String(ymd[2]).padStart(2, '0')}-${String(ymd[3]).padStart(2, '0')}`;
  }

  // --- 审核期间（首末两天，供报告与看板展示） ---
  const period = all.match(/审核日期[：:][^\n]{0,40}?(20\d{2})\s*[年.\-\/]\s*(\d{1,2})\s*[月.\-\/]\s*(\d{1,2})\s*日?[^\n]{0,30}?至\s*(20\d{2})\s*[年.\-\/]\s*(\d{1,2})\s*[月.\-\/]\s*(\d{1,2})/);
  if (period) {
    meta.auditEndDate = `${period[4]}-${String(period[5]).padStart(2, '0')}-${String(period[6]).padStart(2, '0')}`;
  }

  return meta;
}

/** 主入口 */
export async function parseWordPlan(buffer: Buffer, maxRows = 800): Promise<ParseResult> {
  const diagnostics: string[] = [];
  const errors: ParseResult['errors'] = [];
  let html = '';
  let rawText = '';
  try {
    const [h, t] = await Promise.all([mammoth.convertToHtml({ buffer }), mammoth.extractRawText({ buffer })]);
    html = h.value;
    rawText = t.value;
  } catch (e) {
    return {
      mode: 'none',
      rows: [],
      members: [],
      meta: {},
      slots: [],
      errors: [{ row: 0, reason: `Word 解析失败：${(e as Error).message}` }],
      diagnostics: ['请确认为 .docx 格式（不支持旧版 .doc）'],
    };
  }

  const lines = html
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map(decode)
    .filter(Boolean);

  const meta = extractMeta(lines);
  const tables = extractTables(html);
  if (tables.length) diagnostics.push(`检测到 ${tables.length} 个表格`);

  // 审核组成员表：任意一张表里含「组内代号」表头即可
  const memberGrid = tables.find((g) => g.some((r) => r.some((c) => c.replace(/\s/g, '').includes('代号'))));
  const members = memberGrid ? parseMembers(memberGrid) : [];
  if (members.length) diagnostics.push(`识别到审核组成员 ${members.length} 人：${members.map((m) => `${m.name}(${m.code})`).join('、')}`);

  // 计划表
  const picked = pickProcessTable(tables);
  if (!picked) {
    return {
      mode: 'none',
      rows: [],
      members,
      meta,
      slots: [],
      errors: [{ row: 0, reason: '未找到计划表（需含「过程名称」与「审核员」列）' }],
      diagnostics: [...diagnostics, '支持表头：日期 | 时间 | 过程名称 | 受审核部门 | 审核员'],
    };
  }

  const { rows, errors: perr } = parseProcessTable(picked.grid);
  errors.push(...perr);
  if (!rows.length) {
    return {
      mode: 'none',
      rows: [],
      members,
      meta,
      slots: [],
      errors: errors.length ? errors : [{ row: 0, reason: '计划表内无有效行' }],
      diagnostics,
    };
  }

  diagnostics.push(`按「过程 × 审核组」解析第 ${picked.idx + 1} 张表，展开条款 ${rows.length} 条`);
  const slots = aggregateSlots(rows, members);
  diagnostics.push(`聚合为 ${slots.length} 个工作包`);

  return {
    mode: 'process',
    rows: rows.slice(0, maxRows),
    members,
    meta,
    slots,
    errors: errors.slice(0, 30),
    diagnostics,
  };
}