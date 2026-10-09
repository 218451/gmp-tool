/**
 * ============================================================
 * 审核过程 P1~P12 权威口径（业务负责人口述确认，唯一依据）
 * ============================================================
 * 来源：业务负责人 2026 年口述「P1~P12 记录模板」内容要点。
 *
 * 用途（这是本文件存在的全部理由）：
 *   审核计划按「过程 × 审核组 × 天」拆工作包，过程码是分组唯一依据。
 *   同一个 ISO 条款会同时落进多个过程（如 8.2.6 同时属 P8/P9/P10），
 *   所以必须有一份权威口径来回答两个问题：
 *     1. 这个过程到底审什么（name / elements，用于界面与报告溯源）
 *     2. 这条重复条款在每个过程里各自的「审核落点」是什么（scopeNote）
 *
 * ★ 与关注点的关系：
 *   关注点是记录模板里的专业核查要点，不是 GMP 条款。
 *   本文件的 elements 只用于说明「这个过程审什么」，不参与条款映射计算。
 *   条款映射一律以《ISO13485与新版GMP检查指导原则条款映射表》为准。
 */

export interface ProcessMeta {
  code: string;
  seq: number;
  /** 过程名（业务口述原话） */
  name: string;
  /** 审核要素要点（业务口述原话，逗号分隔） */
  elements: string;
  /** 过程属性：体系 / 支持 / 输出 */
  kind: '体系过程' | '支持过程' | '输出过程';
  /**
   * 该过程审 GMP 条款时的落点说明。
   * 用于组间判定不一致时，提示末次会议「这条在 P几 的语境下到底怎么算」。
   */
  scopeNote: string;
}

export const PROCESS_META: readonly ProcessMeta[] = [
  {
    code: 'P1',
    seq: 1,
    name: '领导层审核',
    elements: '内审、管理评审等相关要求',
    kind: '体系过程',
    scopeNote: '看管理评审与内审是否真实开展、输入输出是否闭环，不看单个文件',
  },
  {
    code: 'P2',
    seq: 2,
    name: '文件管理和记录管理',
    elements: '文件与记录控制',
    kind: '体系过程',
    scopeNote: '看文件/记录控制是否覆盖新版 GMP 附录的全部要求，含保存期限',
  },
  {
    code: 'P3',
    seq: 3,
    name: '人力资源',
    elements: '人员健康档案、培训、任命等相关内容',
    kind: '体系过程',
    scopeNote: '看人员资质与健康档案的持续有效性，任命是否与实际岗位一致',
  },
  {
    code: 'P4',
    seq: 4,
    name: '基础设施',
    elements: '主要设施维护保养验证、工作环境控制、环境确认验证、监视测量设备计量校准、软件确认',
    kind: '体系过程',
    scopeNote: '★ 基础设施的验证放本过程，不放 P7。设施/环境/设备/软件四条线都在这里',
  },
  {
    code: 'P5',
    seq: 5,
    name: '销售',
    elements: '售前、售中、售后相关记录',
    kind: '体系过程',
    scopeNote: '看销售全过程记录与售后投诉/反馈是否闭环',
  },
  {
    code: 'P6',
    seq: 6,
    name: '设计开发',
    elements: '设计开发过程、医疗器械文档',
    kind: '支持过程',
    scopeNote: '看设计开发文档体系与医疗器械文档（技术要求、说明书、标签）',
  },
  {
    code: 'P7',
    seq: 7,
    name: '验证与确认',
    elements: '工艺验证与确认、关键工序验证',
    kind: '支持过程',
    scopeNote: '★ 只管工艺验证与关键工序验证；基础设施验证归 P4',
  },
  {
    code: 'P8',
    seq: 8,
    name: '采购',
    elements: '供应商管理、采购相关',
    kind: '支持过程',
    scopeNote: '看供应商评价与采购控制，外包过程也在此',
  },
  {
    code: 'P9',
    seq: 9,
    name: '生产',
    elements: '生产现场控制、生产批记录追溯性、过程检验',
    kind: '输出过程',
    scopeNote: '看生产现场状态、批记录追溯链与过程检验点',
  },
  {
    code: 'P10',
    seq: 10,
    name: '检验环节',
    elements: '进货检验、成品检验',
    kind: '输出过程',
    scopeNote: '看进货与成品检验的放行依据，判定直接决定产品能否出库',
  },
  {
    code: 'P11',
    seq: 11,
    name: '仓库管理',
    elements: '区域划分、产品防护、账卡物一致性',
    kind: '输出过程',
    scopeNote: '看库房分区、产品防护措施与账卡物是否一致',
  },
  {
    code: 'P12',
    seq: 12,
    name: '数据分析和改进',
    elements: '数据统计分析、纠正预防措施',
    kind: '输出过程',
    scopeNote: '看统计分析是否真实支撑改进，CAPA 是否闭环验证',
  },
] as const;

export const PROCESS_BY_CODE: ReadonlyMap<string, ProcessMeta> = new Map(PROCESS_META.map((p) => [p.code, p]));

/** 过程码自然序（P2 排在 P10 之前） */
export const compareProcess = (a: string, b: string): number => a.localeCompare(b, 'zh', { numeric: true });

/** 取过程名，未登记的过程码回退为码本身 */
export const processName = (code: string): string => PROCESS_BY_CODE.get(code)?.name ?? code;
