/**
 * ===== 全局类型定义（分层反选模型）=====
 * 与后端 server/src/report-engine.ts、src/types.ts 严格对齐：
 *   - 四状态：landed / partial / not_landed / na（「不适用」取代旧「未覆盖」）
 *   - 默认全选已落地：无 Assessment 记录 = landed + verified=false
 *   - abnormal 为后端派生字段，status==='not_landed' 时为 true
 */

export type Role = 'leader' | 'auditor' | 'admin';
export type Status = 'landed' | 'partial' | 'not_landed' | 'na';
export type Level = '关键' | '主要' | '一般';
export type Priority = 'P0' | 'P1' | 'P2';
export type Way = '直接对应' | '部分对应' | '扩展要求' | '法规特有';
export type RectifyStatus = 'open' | 'doing' | 'done' | 'waived';
/** 章节层可提交的状态（na 需组长审批，不在章节层操作） */
export type ChapterStatus = 'landed' | 'partial' | 'not_landed';

export interface User {
  id: string;
  name: string;
  role: Role;
  username: string;
  dept?: string | null;
}

export interface Project {
  id: string;
  name: string;
  auditDate: string;
  clientName?: string | null;
  status: 'active' | 'archived';
  remark?: string | null;
  createdAt?: string;
  _count?: { plans: number; assessments: number; reports: number; groups: number };
  /** 已分派去重条款数 */
  assignedTotal?: number;
  /** 已核实数（有 Assessment 记录） */
  verified?: number;
  notLanded?: number;
  /** 工作包数（过程 × 审核组 × 天） */
  slotCount?: number;
  progress?: number;
}

/** 章节（第一层勾选单元） */
export interface GmpChapterMeta {
  code: string;
  name: string;
  seq: number;
  focus: boolean;
}

/** 审核员工作项：条款层（第二层） */
export interface WorkItem {
  /** = GmpClause.id */
  id: string;
  code: string;
  /** 条款原文 */
  text: string;
  level: Level | string;
  /** 《规范》条款号，如「第十四条」 */
  specClause: string;
  /** 对应方式 */
  way: string;
  /** 对应说明 */
  note: string | null;
  isoList: string[];
  status: Status;
  /** 是否被显式点选过（false = 默认已落地·待核实） */
  verified: boolean;
  abnormal: boolean;
}

/** 章节分组：审核页一屏一个，展开后显示 items */
export interface WorkGroup {
  code: string;
  name: string;
  seq: number;
  focus: boolean;
  total: number;
  notLanded: number;
  partial: number;
  /** 由条款层推导：landed | partial | not_landed */
  status: ChapterStatus;
  items: WorkItem[];
}

/** GET /api/assessments/my 返回体 */
export interface MyWorkload {
  projectId: string;
  project: { id: string; name: string; auditDate: string } | null;
  /** 可见条款总数 */
  total: number;
  /** 已核实数（被显式点选过的条款数） */
  verified: number;
  /** 异常数 */
  abnormal: number;
  groups: WorkGroup[];
  statusMeta: StatusMeta[];
}

/** GET /api/assessments/projects 单行 */
export interface MyProjectRow {
  id: string;
  name: string;
  auditDate: string;
  status: string;
  clientName?: string | null;
  total: number | null;
  abnormal: number | null;
}

export interface StatusMeta {
  key: Status;
  label: string;
  color: string;
}

export interface StatusCount {
  landed: number;
  partial: number;
  not_landed: number;
  na: number;
}

export interface ReportTotals extends StatusCount {
  total: number;
  landRate: number;
  /** 已核实条款数 */
  verified: number;
  /** 异常条款数 */
  abnormal: number;
}

export interface RedlineThresholds {
  keyNotMet: number;
  keyPlusMain: number;
  generalNotMet: number;
  totalNotMet: number;
}

export interface Redline {
  triggered: boolean;
  reasons: string[];
  keyNotMet: number;
  keyPlusMainNotMet: number;
  generalNotMet: number;
  totalNotMet: number;
  thresholds: RedlineThresholds;
}

/** 报告页异常清单条目（= 未落地条款，已按 P0→P2 排好序） */
export interface AbnormalItem {
  priority: Priority;
  code: string;
  chapterName: string;
  level: string;
  specClause: string;
  text: string;
  isoList: string[];
  /** 涉及该条的审核组（跨组重复分派时多个） */
  groupNames: string[];
  /** 被几个组分别审过（1 = 无重复） */
  groupCount: number;
  /** 组间判定不一致：末次会议须澄清 */
  conflict: boolean;
}

/** 跨组重复分派统计 */
export interface CrossGroupStat {
  dupClauseCount: number;
  refCount: number;
  conflictCount: number;
  conflictList: {
    code: string;
    text: string;
    level: string;
    status: Status;
    detail: { groupName: string; status: Status; verified: boolean }[];
  }[];
  /** 重复分派明细：跨多个过程或多个组的检查项 */
  dupList: {
    code: string;
    text: string;
    level: string;
    status: Status;
    groupCount: number;
    refCount: number;
    conflict: boolean;
    groupNames: string[];
    /** 涉及的 P 过程码 */
    processCodes: string[];
  }[];
}

/** 报告里的一个问题 = 一个章节里同类未落地条款的集合 */
export interface ProblemGroup {
  id: string;
  title: string;
  chapterName: string;
  chapterCode: string;
  priority: Priority;
  nature: string;
  basis: string;
  clauseCount: number;
  keyCount: number;
  groupNames: string[];
  clauseCodes: string[];
  hasConflict: boolean;
  processCodes: string[];
  actions: string[];
}

/** 总体评价 */
export interface OverallVerdict {
  headline: string;
  grade: 'good' | 'acceptable' | 'poor' | 'critical';
  gradeLabel: string;
  paragraphs: string[];
  metrics: { label: string; value: string }[];
}

export interface ReportContent {
  project: { id: string; name: string; auditDate: string; clientName?: string | null };
  generatedAt: string;
  totals: ReportTotals;
  byChapter: {
    code: string;
    name: string;
    seq: number;
    focus: boolean;
    total: number;
    counts: StatusCount;
    rate: number;
    status: string;
  }[];
  byLevel: { level: string; total: number; notMet: number }[];
  byGroup: { groupName: string; total: number; verified: number; abnormal: number; counts: StatusCount }[];
  focus: { category: string; total: number; counts: StatusCount; rate: number }[];
  redline: Redline;
  /** 异常优先清单：P0 → P1 → P2 */
  abnormalList: AbnormalItem[];
  /** 跨组重复分派统计与冲突清单 */
  crossGroup: CrossGroupStat;
  /** ★ 问题清单：未落地条款按「章 + 优先级」归并 */
  problems?: ProblemGroup[];
  /** ★ 总体评价：结论先行 */
  verdict?: OverallVerdict;
  statusMeta: StatusMeta[];
}

export interface Report {
  id: string;
  projectId: string;
  contentJson: string;
  aiSummary: string | null;
  aiProvider: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  confirmedByName?: string | null;
  createdAt: string;
  updatedAt: string;
  content?: ReportContent;
}

/** 看板：按章节分层的审核组视图 */
export interface BoardGroupChapter {
  code: string;
  name: string;
  seq: number;
  focus: boolean;
  total: number;
  verified: number;
  notLanded: number;
  partial: number;
  status: ChapterStatus;
  progress: number;
  items: WorkItem[];
}

export interface BoardGroup {
  groupId: string;
  name: string;
  sort: number;
  leaderName: string | null;
  members: { id: string; name: string; role: string }[];
  total: number;
  verified: number;
  notLanded: number;
  partial: number;
  progress: number;
  chapters: BoardGroupChapter[];
}

export interface Board {
  project: Project;
  coverage: { assigned: number; verified: number; rate: number; unassigned: number };
  groups: BoardGroup[];
  totals: ReportTotals;
  byChapter: ReportContent['byChapter'];
  redline: Redline;
  abnormalList: AbnormalItem[];
}

/** GET /api/projects/:id/groups */
export interface ProjectGroup {
  id: string;
  name: string;
  sort: number;
  leaderName: string | null;
  members: { id: string; name: string; username: string; role: string }[];
  total: number;
  verified: number;
  abnormal: number;
  groups: WorkGroup[];
}

/** 条款明细矩阵（GET /projects/:id/rows） */
export interface ClauseRow {
  gmpClauseId: string;
  code: string;
  text: string;
  specClause: string;
  chapterCode: string;
  chapterName: string;
  level: string;
  status: Status;
  verified: boolean;
  abnormal: boolean;
  groupName: string | null;
  isoList: string[];
}

/** 管理端映射表（ClauseMapping 上已无 category/level） */
export interface MappingRow {
  id: string;
  isoClause: string;
  isoName: string | null;
  way: Way | string;
  remark: string | null;
  enabled: boolean;
  gmpClause: {
    code: string;
    text: string;
    level: string;
    way: string;
    chapterCode: string;
    chapter: { name: string };
  };
}

export interface MappingsResp {
  total: number;
  page: number;
  size: number;
  list: MappingRow[];
  isoClauses: string[];
  chapters: { code: string; name: string }[];
  ways: readonly string[];
}

export interface GmpClauseRow {
  id: string;
  code: string;
  text: string;
  level: string;
  way: string;
  chapterCode: string;
  specClause: string;
  chapter: { code: string; name: string };
}

/** ===== 常量：与后端 src/types.ts 完全一致 ===== */

/** 四状态固定配色 —— 必须与后端一致 */
export const STATUS_COLOR: Record<Status, string> = {
  landed: '#2E7D32',
  partial: '#F9A825',
  not_landed: '#C62828',
  na: '#9E9E9E',
};

export const STATUS_LABEL: Record<Status, string> = {
  landed: '已落地',
  partial: '部分落地',
  not_landed: '未落地',
  na: '不适用',
};

export const STATUS_ORDER: Status[] = ['landed', 'partial', 'not_landed', 'na'];

/** 风险等级配色：关键=红 / 主要=橙 / 一般=灰 */
export const LEVEL_COLOR: Record<string, string> = {
  关键: '#C62828',
  主要: '#F9A825',
  一般: '#9E9E9E',
};

export const LEVELS = ['关键', '主要', '一般'] as const;

export const WAYS = ['直接对应', '部分对应', '扩展要求', '法规特有'] as const;

export const PRIORITY_LABEL: Record<Priority, string> = {
  P0: 'P0 立即整改（关键项红线）',
  P1: 'P1 限期整改（主要项）',
  P2: 'P2 持续改进（一般项）',
};

export const PRIORITY_SHORT: Record<Priority, string> = {
  P0: '立即整改',
  P1: '限期整改',
  P2: '持续改进',
};

export const PRIORITY_COLOR: Record<Priority, string> = {
  P0: '#C62828',
  P1: '#F9A825',
  P2: '#9E9E9E',
};

export const PRIORITY_ORDER: Priority[] = ['P0', 'P1', 'P2'];

export const RECTIFY_LABEL: Record<RectifyStatus, string> = {
  open: '待整改',
  doing: '整改中',
  done: '已完成',
  waived: '已豁免',
};

/** 三大重点章节真实全名（后端 FOCUS_CATEGORIES） */
export const FOCUS_CATEGORIES = ['第二章 质量保证', '第九章 验证与确认', '第十二章 委托生产与外协加工'];

export const ROLE_LABEL: Record<Role, string> = {
  leader: '组长',
  auditor: '审核员',
  admin: '管理员',
};

/** 主色（深蓝）：结构与标题用色，状态色仅用于状态标识 */
export const BRAND = '#1F3A5F';

export const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** 安全除法 */
export const safeDiv = (a: number, b: number) => (b ? a / b : 0);

// ============================================================
// ===== 过程工作包与审核关注点（A 方案）=====
// ============================================================

/** 审核关注点（模板里左栏的「审核关注点」，含两级 parentId 结构） */
export interface FocusItem {
  id: string;
  /** 父关注点 id；顶层为 null */
  parentId: string | null;
  seq: number;
  title: string;
  /** 关注点详情（模板原文条目） */
  detail: string[];
  /** 模板右栏「审核记录」要点清单：审核员逐条核查/填写 */
  checklist: string[];
  /** 是否可判定：false = 容器节点（仅分组标题） */
  fillable: boolean;
  status: Status;
  /** 审核员填写的现场记录 */
  note: string;
  /** 客观证据 */
  evidence: string[];
  verified: boolean;
}

/** 工作包内的一条 GMP 检查项 */
export interface SlotClause {
  id: string;
  code: string;
  text: string;
  level: string;
  chapterCode: string;
  /** 来源 ISO 条款（含标准前缀，如「13485:7.5.1」） */
  isoClause: string;
  status: Status;
  verified: boolean;
  /** 该检查项还被哪些其他 P 过程引用（业务口径：同一条款会落进多个过程） */
  dupProcesses: string[];
  dupProcessCount: number;
  /** 该检查项还被哪些其他审核组审到 */
  dupGroups: string[];
  dupGroupCount: number;
}

/** 过程工作包：某 P 过程 × 某审核组 × 某天某时段 */
export interface ProcessSlot {
  id: string;
  processCode: string;
  processName: string;
  /** P1~P12 权威口径（process-meta.ts），审核员看这个知道本过程到底审什么 */
  processMeta: { name: string; elements: string; kind: string; scopeNote: string } | null;
  /** 过程变体（如「无菌」「有源」），来自计划书的子过程名 */
  variant: string;
  isoText: string;
  group: { id: string; name: string } | null;
  auditorName: string;
  site: string | null;
  slotDate: string;
  timeRange: string;
  deptName: string | null;
  clauses: SlotClause[];
  focuses: FocusItem[];
  progress: {
    clauses: { done: number; total: number };
    focuses: { done: number; total: number };
  };
}

/** GET /api/projects/:id/process-slots 返回体 */
export interface SlotWorkload {
  groups: { id: string; name: string }[];
  slots: ProcessSlot[];
  project?: { id: string; name: string; auditDate: string } | null;
}

/** 审核过程（P1..P12）总览 */
export interface AuditProcessMeta {
  code: string;
  name: string;
  seq: number;
  isoText: string | null;
  focuses: Omit<FocusItem, 'status' | 'note' | 'evidence' | 'verified'>[];
}

// ============================================================
// ===== 章节视图（审核员主工作台）=====
// ============================================================

/** 章内一条检查项 */
export interface ChapterClause {
  id: string;
  code: string;
  text: string;
  level: string;
  chapterCode: string;
  /** 《规范》条款号，如「第十四条」 */
  specClause: string;
  /** 对应方式：直接对应 / 部分对应 / 扩展要求 / 法规特有 */
  way: string;
  note: string | null;
  /** 对应 ISO 13485 条款号数组 */
  isoClause: string[];
  isoNames: string[];
  /** 反选模型：无记录 = landed + verified=false（默认勾选已落地） */
  status: Status;
  verified: boolean;
  remark: string;
  /** 本组内由哪些 P 过程审到这条 */
  processCodes: string[];
  /** 别处（其他过程）也审这条 —— 避免重复劳动与漏判 */
  dupProcesses: string[];
  /** 别处（其他审核组）也审这条 */
  dupGroups: string[];
  dupGroupCount: number;
}

/** 章内一层：关键项 / 主要项 / 一般项 */
export interface ChapterLevelGroup {
  level: string;
  total: number;
  verified: number;
  notLanded: number;
  partial: number;
  items: ChapterClause[];
}

/** 章节（第一层勾选单元） */
export interface ChapterBlock {
  code: string;
  name: string;
  seq: number;
  /** 三大重点章节（质量保证 / 验证与确认 / 委托生产与外协加工） */
  focus: boolean;
  /** 指导原则原章规模（200 条全表口径），用于对照本章分量 */
  chapterTotals: { all: number; key: number; main: number; general: number };
  /** 本人可见范围 */
  total: number;
  verified: number;
  notLanded: number;
  partial: number;
  /** ★ 括号备注的数据源：本章条款涉及的 P 过程 */
  processCodes: string[];
  processNames: { code: string; name: string }[];
  groupNames: string[];
  levels: ChapterLevelGroup[];
}

/** 现场核查要点块（辅助，不计入报告） */
export interface FocusBlock {
  processCode: string;
  processName: string;
  processElements: string;
  processScopeNote: string;
  slotCount: number;
  groupNames: string[];
  dates: string[];
  /** 该过程覆盖了哪几章 */
  chapterCodes: string[];
  focusIds: string[];
  focusTotal: number;
  focusDone: number;
  records: ({ status: Status; note: string; evidence: string[]; verified: boolean } | undefined)[];
}

/** GET /api/projects/:id/chapter-view 返回体 */
export interface ChapterView {
  project: { id: string; name: string; auditDate: string; clientName?: string | null } | null;
  scope: { role: Role; groupIds: string[]; groupNames: string[] };
  totals: {
    chapters: number;
    clauses: number;
    verified: number;
    notLanded: number;
    partial: number;
    byLevel: Record<string, { total: number; verified: number; notLanded: number }>;
    slots: number;
    focusTotal: number;
    focusDone: number;
  };
  chapters: ChapterBlock[];
  focusBlocks: FocusBlock[];
}
