// ===== 通用类型与常量：四状态、级别、角色、红线 =====
import { FOCUS_CATEGORIES as FOCUS_RAW } from '../prisma/seed-data';

export const STATUSES = ['landed', 'partial', 'not_landed', 'na'] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<Status, string> = {
  landed: '已落地',
  partial: '部分落地',
  not_landed: '未落地',
  na: '不适用',
};

/**
 * 四状态固定配色 —— 后端统计与前端 ECharts 共用。
 * 注意：本工具采用「默认全选已落地 + 只反选异常」模式，
 * 因此 landed 同时承载「已核实落地」与「默认已落地（待核实）」两种情形，
 * 前端以 verified 字段区分显示。
 */
export const STATUS_COLOR: Record<Status, string> = {
  landed: '#2E7D32',
  partial: '#F9A825',
  not_landed: '#C62828',
  na: '#9E9E9E',
};

export const LEVELS = ['关键', '主要', '一般'] as const;
export type Level = (typeof LEVELS)[number];

/** 星级 → 级别映射（底表用 ★ 表示） */
export const STAR_LEVEL: Record<string, Level> = { '★★★': '关键', '★★': '主要', '★': '一般' };
export const LEVEL_STAR: Record<Level, string> = { 关键: '★★★', 主要: '★★', 一般: '★' };

export const ROLES = ['leader', 'auditor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  leader: '组长',
  auditor: '审核员',
  admin: '管理员',
};

/**
 * 红线预警阈值（≥ 即触发）
 * 来源：《医疗器械生产质量管理规范检查指导原则》统计说明
 *   关键项目不符合 ≥3 项              → 未通过核查／暂停生产整改
 *   关键+主要合计不符合 ≥10 项        → 未通过核查／暂停生产整改
 *   一般项目不符合 ≥5 项              → 限期整改／整改后复查
 *   总不符合 ≥20 项                  → 未通过核查
 */
export const REDLINE_RULES = {
  keyNotMet: 3,
  keyPlusMain: 10,
  generalNotMet: 5,
  totalNotMet: 20,
} as const;

/** 需单独统计的三个重点章节（真实章节全名） */
export const FOCUS_CATEGORIES = FOCUS_RAW as unknown as readonly string[];

/** 对应方式 */
export const WAYS = ['直接对应', '部分对应', '扩展要求', '法规特有'] as const;
export type Way = (typeof WAYS)[number];

/** 「法规特有」= ISO 13485 无对应条款，属我国法规专属要求，判定口径须区分 */
export const WAY_UNIQUE: Way = '法规特有';

/** 整改优先级 */
export const PRIORITIES = ['P0', 'P1', 'P2'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABEL: Record<Priority, string> = {
  P0: 'P0 立即整改（关键项红线）',
  P1: 'P1 限期整改（主要项）',
  P2: 'P2 持续改进（一般项）',
};

export const RECTIFY_STATUS = ['open', 'doing', 'done', 'waived'] as const;
export type RectifyStatus = (typeof RECTIFY_STATUS)[number];

export const RECTIFY_LABEL: Record<RectifyStatus, string> = {
  open: '待整改',
  doing: '整改中',
  done: '已完成',
  waived: '已豁免',
};

/**
 * 整改优先级派生规则：
 *   P0 = 关键项(★★★) 未落地，或所在章节被整章取消勾选
 *   P1 = 主要项(★★) 未落地
 *   P2 = 一般项(★) 未落地
 * 纯函数，报告与整改清单共用，保证口径一致。
 */
export function derivePriority(level: string, chapterFullyNotLanded = false): Priority {
  if (chapterFullyNotLanded) return 'P0';
  if (level === '关键') return 'P0';
  if (level === '主要') return 'P1';
  return 'P2';
}

export function isStatus(v: unknown): v is Status {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v);
}