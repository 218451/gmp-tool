// 由 extract-focus.ts 生成的关注点数据，转成 Prisma seed 可用的结构
// 容器节点判定：「主要活动及输出」这类只有标题、其余全为子项的节点设为 parentId 指向它
import * as fs from 'fs';

interface Raw {
  code: string;
  name: string;
  isoText: string;
  focuses: { seq: number; title: string; detail: string[]; checklist: string[]; fillable: boolean }[];
}

const raw: Raw[] = JSON.parse(fs.readFileSync('focus-points.json', 'utf8'));

/** 容器标题：无自身补充说明、且是子项的概括词 */
export const CONTAINER_TITLES = ['主要活动及输出', '主要活动', '过程要求及审核关注点'];

export interface SeedFocus {
  processCode: string;
  parentKey: string | null; // 用 "P1#3" 形式的临时 key，落库时换成真实 id
  seq: number;
  title: string;
  detail: string;
  checklist: string;
  fillable: boolean;
}

export interface SeedProcess {
  code: string;
  name: string;
  seq: number;
  isoText: string;
  focuses: SeedFocus[];
}

export const PROCESSES: SeedProcess[] = raw.map((p, pi) => {
  const focuses: SeedFocus[] = [];
  let seq = 0;
  for (const f of p.focuses) {
    seq += 1;
    // 容器判定：命中容器词且自身无补充说明
    const isContainer = CONTAINER_TITLES.includes(f.title) && f.detail.length === 0;
    focuses.push({
      processCode: p.code,
      parentKey: null,
      seq,
      title: f.title,
      detail: JSON.stringify(f.detail, null, 0),
      checklist: JSON.stringify(f.checklist, null, 0),
      fillable: isContainer ? false : f.fillable,
    });
  }
  return { code: p.code, name: p.name, seq: pi + 1, isoText: p.isoText, focuses };
});

// 二次遍历：把容器标题之后的关注点挂到最近的容器下，直到遇到下一个容器或总结栏
for (const p of PROCESSES) {
  let current: string | null = null;
  for (const f of p.focuses) {
    if (!f.fillable && CONTAINER_TITLES.includes(f.title)) {
      current = `${p.code}#${f.seq}`;
      continue;
    }
    f.parentKey = current;
  }
}

// 汇总统计（供 seed 日志核对）
export const PROCESS_STATS = PROCESSES.map((p) => ({
  code: p.code,
  name: p.name,
  total: p.focuses.length,
  top: p.focuses.filter((f) => !f.parentKey).length,
  child: p.focuses.filter((f) => f.parentKey).length,
}));

if (require.main === module) {
  console.log('过程数:', PROCESSES.length);
  console.log('关注点总数:', PROCESSES.reduce((s, p) => s + p.focuses.length, 0));
  console.table(PROCESS_STATS);
  console.log('\nP7 层级示例:');
  for (const f of PROCESSES.find((p) => p.code === 'P7')!.focuses) {
    console.log(`  ${f.parentKey ? '└─ ' : '● '}[${f.seq}] ${f.title} (fillable=${f.fillable})`);
  }
}