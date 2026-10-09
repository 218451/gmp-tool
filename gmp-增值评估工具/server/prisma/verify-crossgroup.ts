/**
 * 验证「同一条款被多组重复审核」的处理是否正确
 * 真实计划实测：100 次引用 → 27 个不同检查项，12 个跨 3 组
 *
 * 校验四件事：
 *   1. 红线计数不被重复放大（一条不符合只算一条）
 *   2. 跨组重复能被识别并统计
 *   3. 组间判定不一致能被检出（conflict）
 *   4. 各组判定明细完整保留（groupStatus）
 */
import fs from 'node:fs';
import { prisma } from '../src/db';
import { parseWordPlan } from '../src/plan-parser';
import { ingestProcessPlan } from '../src/process-dispatch';
import { buildReportContent } from '../src/report-engine';

/**
 * ★ 审核计划文件路径从命令行参数或环境变量读取，不再写死本机绝对路径。
 *   用法：npx tsx prisma/verify-crossgroup.ts "D:/路径/审核计划.docx"
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

async function main() {
  const parsed = await parseWordPlan(fs.readFileSync(FILE));
  const p = await prisma.project.create({
    data: { name: `【XG】${Date.now().toString(36)}`, auditDate: new Date('2026-10-12T00:00:00Z'), status: 'active' },
  });
  await ingestProcessPlan(p.id, parsed);

  const groups = await prisma.auditGroup.findMany({ where: { projectId: p.id } });
  // auditorId 有外键，必须取真实审核员
  const auditor = await prisma.user.findFirst({ where: { role: { in: ['auditor', 'leader'] } } });
  if (!auditor) throw new Error('系统内无可用审核员账号，请先 seed');
  const auditorId = auditor.id;
  const clauses = await prisma.gmpClause.findMany({ take: 60 });

  // 找一个跨 3 组重复的条款（2.3.1 已知跨 3 组）
  const dup = await prisma.planItem.findMany({
    where: { projectId: p.id, gmpClause: { code: '2.3.1' } },
  });
  console.log(`跨组重复样例 2.3.1 → 分派到 ${dup.length} 个组`);

  const [gA, gB, gC] = groups;
  const target = dup[0].gmpClauseId;

  // 造场景：A组判未落地、B组判已落地 → 必须检出 conflict；C组判部分落地
  const scen: [string, string][] = [
    [gA.id, 'not_landed'],
    [gB.id, 'landed'],
    [gC.id, 'partial'],
  ];
  for (const [gid, st] of scen) {
    await prisma.assessment.create({
      data: {
        projectId: p.id,
        gmpClauseId: target,
        groupId: gid,
        auditorId,
        status: st,
        abnormal: st === 'not_landed',
      },
    });
  }
  console.log(`已造场景：A组=未落地 B组=已落地 C组=部分落地\n`);

  // 再给一条单组未落地，用于验证红线只计一条
  const solo = clauses.find((c) => c.code === '2.1.1');
  if (solo) {
    const item = await prisma.planItem.findFirst({ where: { projectId: p.id, gmpClauseId: solo.id } });
    if (item) {
      for (const g of groups) {
        await prisma.assessment.create({
          data: { projectId: p.id, gmpClauseId: solo.id, groupId: g.id, auditorId, status: 'not_landed', abnormal: true },
        });
      }
      console.log(`单组场景 2.1.1 → 3 个组都判未落地（应合并为 1 条不符合）\n`);
    }
  }

  const rc = await buildReportContent(p.id);

  console.log('===== 报告统计 =====');
  console.log(`检查项总数 ${rc.totals.total}（PlanItem 落库 ${dup.length ? '' : ''}共 ${await prisma.planItem.count({ where: { projectId: p.id } })} 条）`);
  console.log(`未落地 ${rc.totals.not_landed} · 部分落地 ${rc.totals.partial} · 已落地 ${rc.totals.landed}`);
  console.log(`红线：关键 ${rc.redline.keyNotMet} · 关键+主要 ${rc.redline.keyPlusMainNotMet} · 总 ${rc.redline.totalNotMet}`);

  console.log('\n===== 跨组重复统计 =====');
  console.log(`重复分派的检查项 ${rc.crossGroup.dupClauseCount} 个`);
  console.log(`涉及重复的引用次数 ${rc.crossGroup.refCount}`);
  console.log(`组间判定不一致 ${rc.crossGroup.conflictCount} 个`);
  for (const c of rc.crossGroup.conflictList.slice(0, 5)) {
    console.log(`  ${c.code} [${c.level}] 合并状态=${c.status}`);
    for (const d of c.detail) console.log(`     ${d.groupName}: ${d.status}${d.verified ? '（已核实）' : ''}`);
  }

  console.log('\n===== 校验 =====');
  const chk1 = rc.totals.not_landed === (solo ? 2 : 1);
  console.log(`${chk1 ? '✓' : '✗'} 红线未被重复放大：3 组各判 1 条未落地 → 合并后只计 ${rc.totals.not_landed} 条（期望 ${solo ? 2 : 1}）`);
  const chk2 = rc.crossGroup.conflictCount >= 1;
  console.log(`${chk2 ? '✓' : '✗'} 组间判定不一致已检出：${rc.crossGroup.conflictCount} 个`);
  const chk3 = rc.crossGroup.dupClauseCount > 0;
  console.log(`${chk3 ? '✓' : '✗'} 跨组重复已识别：${rc.crossGroup.dupClauseCount} 个检查项`);
  const det = rc.crossGroup.conflictList[0];
  const chk4 = det ? det.detail.length === 3 : false;
  console.log(`${chk4 ? '✓' : '✗'} 各组判定明细完整：${det?.detail.length ?? 0} 个组`);

  const abn = rc.abnormalList.find((a) => a.code === '2.3.1');
  console.log(`${abn && abn.conflict ? '✓' : '✗'} 异常清单带跨组标记：2.3.1 跨 ${abn?.groupCount ?? 0} 组，冲突=${abn?.conflict}`);

  // 清理
  await prisma.$transaction([
    prisma.assessment.deleteMany({ where: { projectId: p.id } }),
    prisma.rectification.deleteMany({ where: { projectId: p.id } }),
    prisma.planItem.deleteMany({ where: { projectId: p.id } }),
    prisma.groupScope.deleteMany({ where: { group: { projectId: p.id } } }),
    prisma.slotRecord.deleteMany({ where: { slot: { projectId: p.id } } }),
    prisma.planSlot.deleteMany({ where: { projectId: p.id } }),
    prisma.auditPlan.deleteMany({ where: { projectId: p.id } }),
  ]);
  await prisma.groupMember.deleteMany({ where: { group: { projectId: p.id } } });
  await prisma.auditGroup.deleteMany({ where: { projectId: p.id } });
  await prisma.project.delete({ where: { id: p.id } });
  console.log('\n已清理');
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('失败：', e);
  process.exit(1);
});