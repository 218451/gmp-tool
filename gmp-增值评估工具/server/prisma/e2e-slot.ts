/**
 * A 方案端到端验证：真实 Word 审核计划 → 过程工作包 → 关注点判定
 * 运行：npx tsx prisma/e2e-slot.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/db';
import { parseWordPlan } from '../src/plan-parser';
import { ingestProcessPlan } from '../src/process-dispatch';

/**
 * ★ 审核计划文件路径从命令行参数或环境变量读取，不再写死本机绝对路径。
 *   用法：npx tsx prisma/e2e-slot.ts "D:/路径/审核计划.docx"
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
  if (!fs.existsSync(FILE)) throw new Error(`Word 不存在：${FILE}`);

  const parsed = await parseWordPlan(fs.readFileSync(FILE));
  console.log(`[1] 解析：${parsed.slots.length} 个工作包 / ${parsed.slots.reduce((a, s) => a + s.isoClauses.length, 0)} 条款明细`);

  const suffix = Date.now().toString(36);
  const project = await prisma.project.create({
    data: { name: `【E2E-Slot】示例企业 ${suffix}`, auditDate: new Date('2026-10-12T00:00:00Z'), status: 'active' },
  });
  console.log(`[2] 建项目 ${project.id}`);

  const users = await prisma.user.findMany();
  const ing = await ingestProcessPlan(project.id, parsed);
  console.log(
    `[3] 分派：组 ${ing.groups.join('/')}（新建 ${ing.groupsCreated.join('/')}）· 工作包 ${ing.slots} · 工作包→检查项 ${ing.slotRecords}`,
  );
  console.log(
    `[4] 三类未映射：mappingGap=${ing.mappingGap.length} knownNoItem=${ing.knownNoItem.length} dual9001=${ing.dual9001.length} | 未建工作包=${ing.unmatchedSlots.length} 无账号成员=${ing.unmatchedMembers.length}`,
  );
  if (ing.mappingGap.length) console.log(`     mappingGap：${ing.mappingGap.join('、')}`);
  if (ing.knownNoItem.length) console.log(`knownNoItem：${ing.knownNoItem.join('、')}`);
  if (ing.unmatchedMembers.length) console.log(`     无账号成员：${ing.unmatchedMembers.join('、')}`);

  // ---- 过程关注点统计 ----
  const procs = await prisma.auditProcess.findMany({
    orderBy: { seq: 'asc' },
    include: { focuses: { select: { id: true, fillable: true, parentId: true } } },
  });
  const totalFocus = procs.reduce((a, p) => a + p.focuses.length, 0);
  const fillable = procs.reduce((a, p) => a + p.focuses.filter((f) => f.fillable).length, 0);
  console.log(`[5] 审核过程 ${procs.length} 个 · 关注点 ${totalFocus} 条（可判定 ${fillable}）`);
  console.log(
    `     分布：${procs.map((p) => `${p.code}=${p.focuses.length}`).join(' ')}`,
  );

  // ---- 模拟审核员视角：取一个组的工作包 ----
  const group = await prisma.auditGroup.findFirst({
    where: { projectId: project.id },
    orderBy: { sort: 'asc' },
    include: { members: true },
  });
  if (!group?.members.length) throw new Error('未建出审核组成员');

  const auditorId = group.members[0].userId;
  const slots = await prisma.planSlot.findMany({
    where: { projectId: project.id, groupId: group.id },
    include: { process: { include: { focuses: true } }, records: { include: { gmpClause: true } } },
    orderBy: [{ slotDate: 'asc' }, { processCode: 'asc' }],
  });
  console.log(`[6] 【${group.name}】共 ${slots.length} 个工作包：`);
  for (const s of slots.slice(0, 8)) {
    const fill = s.process.focuses.filter((f) => f.fillable).length;
    console.log(
      `     ${s.slotDate} ${s.timeRange.padEnd(12)} ${s.processCode} ${(s.processName || s.variant || '').slice(0, 14).padEnd(16)} 审核员=${s.auditorName} 场所=${s.site || '-'} 部门=${s.deptName || '-'} | 关注点${fill} 检查项${s.records.length}`,
    );
  }

  // ---- 写入一条关注点判定 ----
  const sample = slots.find((s) => s.process.focuses.some((f) => f.fillable))!;
  const f0 = sample.process.focuses.find((f) => f.fillable)!;
  await prisma.focusRecord.create({
    data: {
      projectId: project.id,
      focusId: f0.id,
      groupId: group.id,
      processCode: sample.processCode,
      status: 'not_landed',
      note: '【E2E】现场核查发现程序文件缺少审批签字栏',
      evidence: JSON.stringify(['QP-013 Rev.5', '批记录 B260301']),
      verified: true,
      updatedBy: auditorId,
    },
  });
  const rec = await prisma.focusRecord.findUnique({
    where: { projectId_focusId_groupId: { projectId: project.id, focusId: f0.id, groupId: group.id } },
  });
  console.log(`[7] 写入关注点判定：${sample.processCode} / ${f0.title} → ${rec?.status} · 记录 ${rec?.note?.length} 字 · 证据 ${JSON.parse(rec!.evidence).length} 条`);

  // ---- 跨组独立留痕：同一关注点在 P7 的多个工作包里各判一次 ----
  const p7slots = await prisma.planSlot.findMany({
    where: { projectId: project.id, processCode: 'P7' },
    select: { id: true, groupId: true, group: { select: { name: true } } },
  });
  for (const s of p7slots) {
    await prisma.focusRecord.upsert({
      where: { projectId_focusId_groupId: { projectId: project.id, focusId: f0.id, groupId: s.groupId ?? '' } },
      create: {
        projectId: project.id,
        focusId: f0.id,
        groupId: s.groupId,
        processCode: 'P7',
        status: 'landed',
        verified: true,
        updatedBy: auditorId,
      },
      update: { status: 'landed' },
    });
  }
  const n = await prisma.focusRecord.count({ where: { projectId: project.id, focusId: f0.id } });
  console.log(
    `[8] 同一关注点跨组独立留痕：P7 派给 ${p7slots.map((x) => x.group?.name || '未分组').join('/')} → ${n} 条独立记录（不去重）`,
  );

  // ---- 清理 ----
  await prisma.$transaction([
    prisma.focusRecord.deleteMany({ where: { projectId: project.id } }),
    prisma.slotRecord.deleteMany({ where: { slot: { projectId: project.id } } }),
    prisma.assessment.deleteMany({ where: { projectId: project.id } }),
    prisma.rectification.deleteMany({ where: { projectId: project.id } }),
    prisma.planItem.deleteMany({ where: { projectId: project.id } }),
    prisma.groupScope.deleteMany({ where: { group: { projectId: project.id } } }),
    prisma.planSlot.deleteMany({ where: { projectId: project.id } }),
    prisma.auditPlan.deleteMany({ where: { projectId: project.id } }),
  ]);
  await prisma.groupMember.deleteMany({ where: { group: { projectId: project.id } } });
  await prisma.auditGroup.deleteMany({ where: { projectId: project.id } });
  await prisma.project.delete({ where: { id: project.id } });
  console.log('[9] 已清理测试项目');
  void path;
}

main()
  .catch((e) => {
    console.error('E2E 失败：', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());