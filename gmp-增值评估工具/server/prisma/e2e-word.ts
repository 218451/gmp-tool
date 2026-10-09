// 端到端验证：真实 CMD 审核计划 Word → 解析 → 落库 → 核对
import * as fs from 'fs';
import { parseWordPlan } from '../src/plan-parser';
import { ingestProcessPlan } from '../src/process-dispatch';
import { prisma } from '../src/db';

/**
 * ★ 审核计划文件路径从命令行参数或环境变量读取，不再写死本机绝对路径。
 *   用法：npx tsx prisma/e2e-word.ts "D:/路径/审核计划.docx"
 *   或：  set PLAN_FILE=D:/某路径/审核计划.docx（Windows cmd）
 * 为什么要改：真实审核计划含受审核方名称与审核员姓名，属客户资料，
 *   仓库里既不该出现本机绝对路径，也不该出现客户名称。
 */
const FILE = process.argv[2] || process.env.PLAN_FILE || '';
if (!FILE) {
  console.error('请传入审核计划文件路径：npx tsx %s "D:/路径/审核计划.docx"', process.argv[1].split('/').pop());
  process.exit(1);
}
if (!fs.existsSync(FILE)) {
  console.error('文件不存在：' + FILE);
  process.exit(1);
}

(async () => {
  const parsed = await parseWordPlan(fs.readFileSync(FILE));
  console.log(`解析：${parsed.slots.length} 个工作包 / ${parsed.rows.length} 条款明细 / ${parsed.members.length} 名成员`);
  if (parsed.errors.length) console.log('解析警告：', parsed.errors.slice(0, 5));

  // 建项目
  const owner = await prisma.user.findFirstOrThrow({ where: { role: 'leader' } });
  const proj = await prisma.project.create({
    data: {
      name: parsed.meta.projectName || '示例企业（请上传真实计划覆盖此兜底值）',
      auditDate: new Date('2026-10-12'),
      clientName: parsed.meta.projectName || null,
      ownerId: owner.id,
    },
  });
  console.log('项目已建：', proj.id);

  const s = await ingestProcessPlan(proj.id, parsed);
  console.log('\n落库结果：');
  console.log('  审核组:', s.groups.join('、'), '| 新建:', s.groupsCreated.join('、') || '无');
  console.log('  工作包:', s.slots);
  console.log('  工作包→检查项:', s.slotRecords);
  console.log('  未映射条款:', s.unmappedIso.join('、') || '无');
  console.log('  无账号成员:', s.unmatchedMembers.join('、') || '无');

  // 核对：组 × 过程 × 条款
  console.log('\n明细核对：');
  const slots = await prisma.planSlot.findMany({
    where: { projectId: proj.id },
    orderBy: [{ processCode: 'asc' }],
    include: { group: true, records: true },
  });
  for (const sl of slots) {
    console.log(
      `  ${sl.processCode} → ${sl.group?.name} | ${sl.auditorName} @${sl.site} | ${sl.deptName} | ${sl.slotDate} ${sl.timeRange} | ${sl.records.length} 项`,
    );
  }

  // 关键验证：同一过程派给多组 → 各自独立
  console.log('\n[关键] 同过程多组验证：');
  const byProcess = new Map<string, typeof slots>();
  for (const sl of slots) {
    const arr = byProcess.get(sl.processCode) || [];
    arr.push(sl);
    byProcess.set(sl.processCode, arr);
  }
  for (const [code, arr] of byProcess) {
    if (arr.length > 1) {
      console.log(`  ${code} 派给 ${arr.length} 个组: ${arr.map((x) => x.group?.name).join('、')}`);
      const clauseSets = arr.map((x) => new Set(x.records.map((r) => r.gmpClauseId)).size);
      console.log(`     各组条款数: ${clauseSets.join(' / ')}（跨组独立，不去重）`);
    }
  }

  // 关注点检查
  const focusTotal = await prisma.processFocus.count();
  const procTotal = await prisma.auditProcess.count();
  const fillable = await prisma.processFocus.count({ where: { fillable: true } });
  console.log(`\n审核过程 ${procTotal} 个 · 关注点 ${focusTotal} 条（可判定 ${fillable} 条）`);

  // 清理测试项目
  await prisma.project.delete({ where: { id: proj.id } });
  console.log('\n已清理测试项目');
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('✗ 失败：', e);
  await prisma.$disconnect();
  process.exit(1);
});