/**
 * 数据库初始化脚本（真实条款版）
 * ----------------------------------------------------------------
 * 内容：
 * 1. 默认账号：1 管理员 + 1 组长 + 4 审核员（审核员免密）
 * 2. 14 个章节（GmpChapter）+ 200 条真实检查项（GmpClause）
 * 3. ISO 13485 ↔ GMP 检查项映射表（388 对，来自真实底表）
 * 4. 一个示例项目 + 审核组 + 审核计划 + 已分派的条款
 *
 * 执行：npm run db:seed（首次可用 npm run db:push 一并建表）
 */
import bcrypt from 'bcryptjs';
import {
  GMP_ITEMS,
  CHAPTERS,
  MAPPING_PAIRS,
  REVERSE_INDEX,
  ISO_CLAUSES_WITHOUT_ITEM,
  ISO_UNIQUE_ITEMS,
  DEMO_AUDITORS,
  DEMO_PLANS,
} from './seed-data';
import { createPrisma } from '../src/db';
import { dispatchProject } from '../src/dispatch';
import { PROCESSES } from './focus-seed';

const prisma = createPrisma();

/**
 * 落库审核过程与关注点。
 * 数据源：三组《审核记录模板》P1..P12 真实 Word（见extract-focus.ts 抽取结果）。
 * 关注点分两层：容器节点（如「主要活动及输出」）以 parentId 承载子项，
 * 落库时先把容器写入拿到 id，再回填子项的 parentId。
 */
async function seedProcesses() {
  const prisma = createPrisma();
  // 「P1#3」形式的临时 key → 真实 id
  const idByKey = new Map<string, string>();

  for (const p of PROCESSES) {
    await prisma.auditProcess.upsert({
      where: { code: p.code },
      create: { code: p.code, name: p.name, seq: p.seq, isoText: p.isoText },
      update: { name: p.name, seq: p.seq, isoText: p.isoText },
    });
    // 先删后插：关注点是模板数据，重建比增量更新更可控
    await prisma.processFocus.deleteMany({ where: { processCode: p.code } });

    // 第一轮：所有顶层关注点（parentKey === null），容器与普通关注点都在此写入
    for (const f of p.focuses) {
      if (f.parentKey !== null) continue;
      const row = await prisma.processFocus.create({
        data: {
          processCode: p.code,
          seq: f.seq,
          title: f.title,
          detail: f.detail,
          checklist: f.checklist,
          fillable: f.fillable,
        },
      });
      idByKey.set(`${p.code}#${f.seq}`, row.id);
    }

    // 第二轮：有父节点的挂到容器下
    for (const f of p.focuses) {
      if (!f.parentKey) continue;
      const parentId = idByKey.get(f.parentKey);
      if (!parentId) continue;
      await prisma.processFocus.create({
        data: {
          processCode: p.code,
          parentId,
          seq: f.seq,
          title: f.title,
          detail: f.detail,
          checklist: f.checklist,
          fillable: f.fillable,
        },
      });
    }
  }
  await prisma.$disconnect();
}

async function main() {
  console.log('▶ 开始初始化数据库…');

  // ---------- 1. 默认账号 ----------
  const adminPwd = process.env.DEFAULT_ADMIN_PASSWORD || '请在 .env 中设置 DEFAULT_ADMIN_PASSWORD';
  const accounts = [
    { username: 'admin', name: '系统管理员', role: 'admin', password: adminPwd, dept: '认证中心' },
    { username: 'zhangwei', name: '张伟', role: 'leader', password: 'Leader@123', dept: '认证中心' },
    ...DEMO_AUDITORS.map((n: string) => ({ username: n, name: n, role: 'auditor', password: null as any, dept: '认证中心' })),
  ];

  for (const a of accounts) {
    const exists = await prisma.user.findUnique({ where: { username: a.username } });
    if (exists) {
      // 名称可能被改动过，回写确保与 seed 一致
      await prisma.user.update({ where: { id: exists.id }, data: { name: a.name, role: a.role, dept: a.dept } });
      continue;
    }
    await prisma.user.create({
      data: {
        username: a.username,
        name: a.name,
        role: a.role,
        dept: a.dept,
        passwordHash: a.password ? bcrypt.hashSync(a.password, 10) : null,
      },
    });
    console.log(`  ✓ 创建用户 ${a.username}（${a.role}）`);
  }

  // ---------- 2. 章节 14 个 ----------
  for (const ch of CHAPTERS) {
    const data = {
      name: ch.name,
      seq: ch.seq,
      itemCount: ch.itemCount,
      keyCount: ch.keyCount,
      mainCount: ch.mainCount,
      genCount: ch.generalCount,
      focus: ch.focus,
    };
    await prisma.gmpChapter.upsert({ where: { code: ch.code }, create: { code: ch.code, ...data }, update: data });
  }
  console.log(`  ✓ 章节：${CHAPTERS.length} 个（三大重点：${CHAPTERS.filter((c) => c.focus).map((c) => c.name).join('、')}）`);

  // ---------- 3. 检查项 200 条（真实条款） ----------
  const chapterByName = new Map(CHAPTERS.map((c) => [c.name, c.code]));
  const clauseIdByCode = new Map<string, string>();
  let seq = 1;
  for (const [category, items] of Object.entries(GMP_ITEMS)) {
    const chapterCode = chapterByName.get(category);
    if (!chapterCode) throw new Error(`章节未预置：${category}`);
    for (const it of items) {
      const data = {
        chapterCode,
        seq: seq++,
        level: it.level,
        specClause: it.spec,
        text: it.text,
        way: it.way,
        note: it.note,
        isoClauses: JSON.stringify(it.isoList),
        isoNames: JSON.stringify(it.isoNames),
        enabled: true,
      };
      const row = await prisma.gmpClause.upsert({
        where: { code: it.code },
        create: { code: it.code, ...data },
        update: data,
      });
      clauseIdByCode.set(it.code, row.id);
    }
  }
  console.log(`  ✓ 检查项：${seq - 1} 条（真实条款号 ${Object.keys(GMP_ITEMS).length} 章）`);

  // ---------- 4. 映射表 388 对 ----------
  const isoNameMap = new Map(REVERSE_INDEX.map((r) => [r.clause, r.name]));
  let mappingCount = 0;
  for (const [isoClause, code] of MAPPING_PAIRS) {
    const gmpClauseId = clauseIdByCode.get(code);
    if (!gmpClauseId) continue;
    const meta = Object.values(GMP_ITEMS).flat().find((i) => i.code === code);
    const data = {
      isoName: isoNameMap.get(isoClause) ?? null,
      way: meta?.way ?? '直接对应',
      remark: meta?.note ?? null,
      enabled: true,
    };
    await prisma.clauseMapping.upsert({
      where: { isoClause_gmpClauseId: { isoClause, gmpClauseId } },
      create: { isoClause, gmpClauseId, ...data },
      update: data,
    });
    mappingCount++;
  }
  console.log(`  ✓ 映射表：${mappingCount} 对，覆盖 ${REVERSE_INDEX.length} 个 ISO 13485 条款`);
  console.log(`    ⚠ ${ISO_CLAUSES_WITHOUT_ITEM.length} 个 ISO 条款无对应检查项（体系审核不得漏审）：${ISO_CLAUSES_WITHOUT_ITEM.join('、')}`);
  console.log(`    ⚠ ${ISO_UNIQUE_ITEMS.length} 项为「法规特有」（ISO 无对应条款，判定口径不同）：${ISO_UNIQUE_ITEMS.join('、')}`);

  // ---------- 5. 示例项目 + 审核组 + 计划 ----------
  const demoName = '示例医疗器械有限公司';
  let project = await prisma.project.findFirst({ where: { name: demoName } });
  if (!project) {
    const leader = await prisma.user.findUnique({ where: { username: 'zhangwei' } });
    project = await prisma.project.create({
      data: {
        name: demoName,
        clientName: '一次性使用无菌注射器',
        auditDate: new Date(),
        ownerId: leader?.id ?? null,
        remark: '示例项目，可直接删除或改名使用',
      },
    });
    console.log(`  ✓ 示例项目：${project.name}`);
  } else {
    console.log('  · 示例项目已存在，复用');
  }

  // 审核计划（幂等：按 项目+审核员+条款 判断）
  const groupNameOf = (auditorName: string) => `审核组·${auditorName}`;
  let planCreated = 0;
  let seqPlan = 0;
  for (const p of DEMO_PLANS) {
    const exists = await prisma.auditPlan.findFirst({
      where: { projectId: project.id, auditorName: p.auditorName, isoClause: p.isoClause },
    });
    if (exists) continue;
    await prisma.auditPlan.create({
      data: {
        projectId: project.id,
        auditorName: p.auditorName,
        groupName: groupNameOf(p.auditorName),
        isoClause: p.isoClause,
        processName: p.processName,
        source: 'excel',
        seq: seqPlan++,
      },
    });
    planCreated++;
  }
  console.log(`  ✓ 审核计划：新增 ${planCreated} 条 / 共 ${DEMO_PLANS.length} 条`);

  // 审核组（按审核员一人一组，组内即该审核员负责的条款集合）
  const auditors = await prisma.user.findMany({ where: { role: 'auditor' } });
  for (const name of DEMO_AUDITORS) {
    const u = auditors.find((a) => a.name === name);
    if (!u) continue;
    const gname = groupNameOf(name);
    let g = await prisma.auditGroup.findFirst({ where: { projectId: project.id, name: gname } });
    if (!g) {
      g = await prisma.auditGroup.create({
        data: { projectId: project.id, name: gname, leaderId: null, sort: DEMO_AUDITORS.indexOf(name) },
      });
    }
    await prisma.groupMember.upsert({
      where: { groupId_userId: { groupId: g.id, userId: u.id } },
      create: { groupId: g.id, userId: u.id, role: 'member' },
      update: {},
    });
  }
  console.log(`  ✓ 审核组：${DEMO_AUDITORS.length} 个`);

  // 调用与线上一致的分派引擎，把检查项按 ISO 条款分派到审核组
  const dispatched = await dispatchProject(project.id);
  const assigned = dispatched.reduce((s, d) => s + d.matched, 0);
  console.log(`  ✓ 分派检查项：${assigned} 个（覆盖 ${dispatched.length} 条计划 / ${dispatched.filter((d) => d.matched > 0).length} 条命中）`);

  // ---------- 6. 审核过程 P1..P12 + 审核关注点（真实模板抽取） ----------
  await seedProcesses();
  const procCount = await prisma.auditProcess.count();
  const focusCount = await prisma.processFocus.count();
  console.log(`  ✓ 审核过程 ${procCount} 个（P1..P12）· 审核关注点 ${focusCount} 条`);

  // ---------- 7. 统计输出 ----------
  const [users, chapters, clauses, mappings, plans, scopes] = await Promise.all([
    prisma.user.count(),
    prisma.gmpChapter.count(),
    prisma.gmpClause.count(),
    prisma.clauseMapping.count(),
    prisma.auditPlan.count(),
    prisma.groupScope.count(),
  ]);
  console.log('────────────────────────────────────────');
  console.log(`  用户 ${users} · 章节 ${chapters} · 检查项 ${clauses} · 映射 ${mappings}`);
  console.log(`  计划 ${plans} · 分配范围 ${scopes}`);
  console.log('  默认账号：admin / ' + adminPwd + '（管理员）');
  console.log('           zhangwei / Leader@123（组长）');
  console.log('           ' + DEMO_AUDITORS.join('、') + '（审核员，免密登录）');
  console.log('────────────────────────────────────────');
  console.log('▶ 初始化完成');
}

main()
  .catch((e) => {
    console.error('✗ 初始化失败：', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });