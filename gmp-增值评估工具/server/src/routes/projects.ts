// ===== 项目 + 审核计划 + 实时看板（组长端）=====
// 分层反选模型下的项目域：审核计划是「唯一的分配依据」，
// 计划经分派引擎展开为 PlanItem（条款）+ GroupScope（审核组可见范围），
// 看板所有口径都建立在这两者之上。
import { Router } from 'express';
import ExcelJS from 'exceljs';
import multer from 'multer';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware';
import { writeLog } from '../log';
import { config } from '../config';
import { dispatchProject, pruneOrphanAssessments, getGroupWorkload } from '../dispatch';
import { buildReportContent, buildClauseTree, collectRows } from '../report-engine';
import { parseWordPlan } from '../plan-parser';
import { requireProjectAccess, visibleProjectIds } from '../access';
import { ingestProcessPlan } from '../process-dispatch';

export const projectRouter = Router();
projectRouter.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/** 解析 ISO 条款号：兼容 "7.5.1" / "7.5" / "第7.5.1条" / 全角 */
function normalizeIso(s: string): string {
  const m = String(s || '')
    .replace(/[０-９．。]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .match(/(\d+(?:\.\d+)*)/);
  return m ? m[1] : String(s || '').trim();
}

/**
 * 审核组名归一：分派引擎按 `groupName || '审核组·' + auditorName` 查找组，
 * 这里用同一约定，保证「计划里的组名」与「库里的组名」永远对得上。
 */
function resolveGroupName(groupName: string | null | undefined, auditorName: string): string {
  const g = String(groupName || '').trim();
  return g || `审核组·${auditorName}`;
}

/**
 * 确保计划涉及的审核组存在，并写入组员。
 * Excel 里没写「审核组」列时按审核员名兜底建组（一人一组），
 * 否则分派引擎找不到组，条款不会落入任何 GroupScope，审核员将看不到任务。
 */
async function ensureGroups(
  projectId: string,
  rows: { auditorName: string; groupName: string }[],
  matchAuditor: (name: string) => string | null,
): Promise<{ groupNames: string[]; created: string[] }> {
  // 按首次出现顺序收集组名，保持 sort 稳定
  const names: string[] = [];
  for (const r of rows) {
    const n = resolveGroupName(r.groupName, r.auditorName);
    if (!names.includes(n)) names.push(n);
  }

  const existing = await prisma.auditGroup.findMany({ where: { projectId }, select: { id: true, name: true } });
  const existSet = new Set(existing.map((g) => g.name));
  const created: string[] = [];

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (existSet.has(name)) continue;
    // 组长取该组内第一个能匹配到用户的审核员
    const leaderName = rows.find((r) => resolveGroupName(r.groupName, r.auditorName) === name)?.auditorName;
    const group = await prisma.auditGroup.create({
      data: { projectId, name, leaderId: leaderName ? matchAuditor(leaderName) : null, sort: i },
    });
    existSet.add(name);
    created.push(name);

    // 组员落库：审核员登录后靠 GroupMember 找自己所在组
    const members = rows
      .filter((r) => resolveGroupName(r.groupName, r.auditorName) === name)
      .map((r) => matchAuditor(r.auditorName))
      .filter((uid): uid is string => !!uid);
    for (const uid of [...new Set(members)]) {
      await prisma.groupMember.upsert({
        where: { groupId_userId: { groupId: group.id, userId: uid } },
        create: { groupId: group.id, userId: uid, role: uid === group.leaderId ? 'leader' : 'member' },
        update: {},
      });
    }
  }
  return { groupNames: names, created };
}

/** 解析出的一行计划（Excel / Word 两条通道统一后的形状） */
interface IngestRow {
  auditorName: string;
  groupName: string;
  isoClause: string;
  processName: string;
}

/**
 * 计划落库统一入口：Excel 与 Word 两条导入通道都走这里。
 * 顺序很关键 —— 必须先 ensureGroups 再 dispatchProject，
 * 否则分派引擎匹配不到组，条款不会落进任何 GroupScope，审核员登录后看不到任何任务。
 */
async function ingestPlanRows(
  req: any,
  res: any,
  projectId: string,
  rows: IngestRow[],
  errors: { row: number; reason: string }[],
  source: 'excel' | 'word',
) {
  const auditors = await prisma.user.findMany({ where: { role: 'auditor' } });
  const matchAuditor = (name: string) => auditors.find((a) => a.name === name || a.username === name)?.id ?? null;

  const groups = await ensureGroups(projectId, rows, matchAuditor);

  const maxSeq = await prisma.auditPlan.aggregate({ where: { projectId }, _max: { seq: true } });
  let seq = (maxSeq._max.seq ?? -1) + 1;

  await prisma.auditPlan.createMany({
    data: rows.map((r) => ({
      projectId,
      // groupName 落库为空串会被分派引擎当成有效组名，统一归一为 null
      groupName: r.groupName || null,
      auditorName: r.auditorName,
      isoClause: r.isoClause,
      processName: r.processName,
      source,
      seq: seq++,
    })),
  });

  const dispatch = await dispatchProject(projectId);
  // 两类零分派分别反馈：no_mapping 需补映射，deduped 属正常
  const noMapping = dispatch.filter((d) => d.zeroReason === 'no_mapping');
  const deduped = dispatch.filter((d) => d.zeroReason === 'deduped');
  const unmatchedNames = [...new Set(rows.filter((r) => !matchAuditor(r.auditorName)).map((r) => r.auditorName))];

  await writeLog({
    req,
    action: `plan_import_${source}`,
    target: `project:${projectId}`,
    detail: {
      total: rows.length,
      errors: errors.length,
      groups: groups.groupNames,
      groupsCreated: groups.created,
      unmatchedAuditors: unmatchedNames,
    },
  });

  return {
    imported: rows.length,
    errors,
    dispatchTotal: dispatch.reduce((s, d) => s + d.matched, 0),
    groupNames: groups.groupNames,
    groupsCreated: groups.created,
    unmatchedClauses: noMapping.map((d) => d.isoClause),
    dedupedClauses: deduped.map((d) => d.isoClause),
    unmatchedAuditors: unmatchedNames,
    warning:
      [
        noMapping.length
          ? `以下 ISO 条款在映射表中缺少对应检查项，需管理员补充映射：${[...new Set(noMapping.map((d) => d.isoClause))].join('、')}`
          : '',
        unmatchedNames.length
          ? `以下审核员在用户表中不存在，其条款将归入「审核组·姓名」但无人可登录，需管理员创建同名账号：${unmatchedNames.join('、')}`
          : '',
      ]
        .filter(Boolean)
        .join('；') || undefined,
  };
}

// ---------- 项目 CRUD ----------

/** GET /api/projects?status=active —— 项目列表（含进度概览） */
/**
 * ★ 按项目隔离：只返回当前用户有权访问的项目
 *   admin   → 全部
 *   leader  → 自己创建的 + 自己作为审核组成员参与的
 *   auditor → 仅自己参与的
 * 几十个组各自独立使用时，列表是隔离的第一道门 —— 这里漏了，
 * 后面所有端点即使挂了守卫，用户也会从列表里看到别人的项目名。
 */
projectRouter.get('/', async (req, res) => {
  const status = (req.query.status as string) || undefined;
  const uid = req.user!.uid;
  const role = req.user!.role;

  const visible = new Set(await visibleProjectIds(uid, role));

  const projects = await prisma.project.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(role === 'admin' ? {} : { id: { in: [...visible] } }),
    },
    orderBy: { auditDate: 'desc' },
    include: {
      owner: { select: { name: true } },
      _count: { select: { plans: true, assessments: true, reports: true, groups: true } },
    },
  });
  const withProgress = await Promise.all(
    projects.map(async (p) => {
      // 分派后的去重条款数 = 该项目的实际审核范围
      const items = await prisma.planItem.findMany({ where: { projectId: p.id }, select: { gmpClauseId: true } });
      const total = new Set(items.map((i) => i.gmpClauseId)).size;
      const verified = await prisma.assessment.count({ where: { projectId: p.id } });
      const notLanded = await prisma.assessment.count({ where: { projectId: p.id, status: 'not_landed' } });
      const slotCount = await prisma.planSlot.count({ where: { projectId: p.id } });
      return {
        ...p,
        assignedTotal: total,
        verified,
        notLanded,
        slotCount,
        // 进度 = 已核实条款 / 已分派条款（反选模型下默认全落地，故用 verified 而非 assessments 计数）
        progress: total ? +(verified / total).toFixed(3) : 0,
      };
    }),
  );
  res.json(withProgress);
});

/** POST /api/projects —— 新建项目 */
projectRouter.post('/', requireRole('leader', 'admin'), async (req, res) => {
  const { name, auditDate, clientName, remark } = req.body || {};
  if (!name || !auditDate) return res.status(400).json({ error: '请填写企业名称与审核日期' });
  const project = await prisma.project.create({
    data: {
      name: String(name).trim(),
      auditDate: new Date(auditDate),
      clientName: clientName || null,
      remark: remark || null,
      ownerId: req.user!.uid,
    },
  });
  await writeLog({ req, action: 'project_create', target: `project:${project.id}`, detail: { name } });
  res.json(project);
});

/** PATCH /api/projects/:id */
projectRouter.patch('/:id', requireProjectAccess, requireRole('leader', 'admin'), async (req, res) => {
  const { name, auditDate, clientName, remark } = req.body || {};
  const project = await prisma.project.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined ? { name: String(name).trim() } : {}),
      ...(auditDate ? { auditDate: new Date(auditDate) } : {}),
      ...(clientName !== undefined ? { clientName: clientName || null } : {}),
      ...(remark !== undefined ? { remark: remark || null } : {}),
    },
  });
  await writeLog({ req, action: 'project_update', target: `project:${project.id}`, detail: req.body });
  res.json(project);
});

/** DELETE /api/projects/:id —— 逻辑删除（归档），保留数据可恢复 */
projectRouter.delete('/:id', requireProjectAccess, requireRole('leader', 'admin'), async (req, res) => {
  await prisma.project.update({ where: { id: req.params.id }, data: { status: 'archived' } });
  await writeLog({ req, action: 'project_archive', target: `project:${req.params.id}` });
  res.json({ ok: true });
});

/** POST /api/projects/:id/restore */
projectRouter.post('/:id/restore', requireProjectAccess, requireRole('leader', 'admin'), async (req, res) => {
  await prisma.project.update({ where: { id: req.params.id }, data: { status: 'active' } });
  await writeLog({ req, action: 'project_restore', target: `project:${req.params.id}` });
  res.json({ ok: true });
});

// ---------- 审核计划 ----------

/**
 * POST /api/projects/:id/plans/excel —— 上传审核计划 Excel
 * 列：审核组(可选) | 审核员姓名 | ISO 13485 条款号 | 过程名称
 * 识别策略：先按表头关键词定位列，识别不到则回退到列序（0=审核员 1=条款 2=过程）。
 * 「审核组」列独立识别：有就按组名分派，没有就按审核员名兜底建组。
 * 导入后自动补齐审核组 → 重跑分派引擎。
 */
projectRouter.post('/:id/plans/excel', requireProjectAccess, requireRole('leader', 'admin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  const projectId = req.params.id;
  const wb = new ExcelJS.Workbook();
  try {
    // multer memoryStorage 给的是 Buffer，直接传入即可（TS 类型差异用 as any 桥接）
    await wb.xlsx.load(req.file.buffer as any);
  } catch {
    return res.status(400).json({ error: 'Excel 文件解析失败，请确认为 .xlsx 格式' });
  }
  const ws = wb.worksheets[0];
  if (!ws) return res.status(400).json({ error: 'Excel 中无工作表' });

  // 读取为二维数组
  const grid: string[][] = [];
  ws.eachRow((row) => {
    const arr: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      let v: any = cell.value;
      if (v && typeof v === 'object')
        v = v.text ?? v.result ?? v.richText?.map((t: any) => t.text).join('') ?? '';
      arr[col - 1] = String(v ?? '').trim();
    });
    grid.push(arr);
  });
  if (!grid.length) return res.status(400).json({ error: 'Excel 内容为空' });

  // 表头识别：若首行含「审核员/条款/过程」等关键词，则跳过首行并按列名映射
  const head = grid[0].map((h) => h.replace(/\s/g, ''));
  const findCol = (keys: string[]) => head.findIndex((h) => keys.some((k) => h.includes(k)));
  let idxAuditor = findCol(['审核员', '审核人', '人员', '姓名']);
  let idxIso = findCol(['条款', 'ISO', 'iso']);
  let idxProcess = findCol(['过程', '流程', '审计内容', '内容']);
  // 审核组为可选列：识别不到就当作没有该列，按审核员名兜底
  let idxGroup = findCol(['审核组', '小组', '组别', '分组']);
  let startRow = 1;
  if (idxAuditor < 0 || idxIso < 0) {
    // 回退到按列序：0=审核员 1=条款 2=过程（组列仍按表头关键词取，不影响旧模板）
    idxAuditor = 0;
    idxIso = 1;
    idxProcess = 2;
    startRow = 0;
  }

  const rows: IngestRow[] = [];
  const errors: { row: number; reason: string }[] = [];
  for (let i = startRow; i < grid.length && rows.length < config.maxPlanRows; i++) {
    const r = grid[i];
    const auditorName = (r[idxAuditor] || '').trim();
    const groupName = idxGroup >= 0 ? (r[idxGroup] || '').trim() : '';
    const isoRaw = (r[idxIso] || '').trim();
    if (!auditorName && !isoRaw) continue; // 空行跳过
    if (!auditorName) {
      errors.push({ row: i + 1, reason: '审核员姓名为空' });
      continue;
    }
    const isoClause = normalizeIso(isoRaw);
    if (!/^\d+(\.\d+)*$/.test(isoClause)) {
      errors.push({ row: i + 1, reason: `条款号无法识别：「${isoRaw}」` });
      continue;
    }
    rows.push({
      auditorName,
      groupName,
      isoClause,
      processName: (r[idxProcess] || '').trim() || '未命名过程',
    });
  }
  if (!rows.length) return res.status(400).json({ error: '未解析到有效数据行', detail: errors.slice(0, 20) });

  res.json(await ingestPlanRows(req, res, projectId, rows, errors, 'excel'));
});

/**
 * POST /api/projects/:id/plans/word —— 上传现场审核计划 Word（.docx）
 *
 * 其中过程名内嵌 ISO 条款串、审核员是「A（南京）」形式的代号。
 * 解析器产出两类结构：
 *   rows  = 展开后的「过程 × 条款」明细（兼容旧条款级看板）
 *   slots = 聚合后的「过程 × 审核组」工作包（真正落库的对象）
 * 同一过程派给多人时会产生多个工作包，各自独立留痕。
 */
/**
 * POST /api/projects/quick-import —— ★ 组长唯一入口：上传 Word 计划即完成全部建档
 *
 * 设计目标（业务要求：组长尽量少操作）：
 *   组长只做一件事 —— 把 Word 版审核计划丢进来，点确认。
 *   企业名称、审核日期、认证编号、审核组、工作包、条款分派全部自动完成，
 *   不需要「新建项目」表单，不需要逐项填写任何字段。
 *
 * 与旧接口的差别：
 *   POST /projects          建空项目（要填 4 个字段）← 保留但不再作为主路径
 *   POST /projects/:id/plans/word  往已有项目灌计划
 *   本接口                    建项目 + 灌计划 + 分派，一步到位
 *
 * 幂等：同企业名 + 同审核日期的项目已存在时，直接复用该���目并覆盖导入，
 *      避免组长重复上传产生「同一个企业两个项目」。
 */
projectRouter.post('/quick-import', requireRole('leader', 'admin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件，请重新选择 Word 计划文件' });

  const originalName = String(req.file.originalname || '');
  if (!/\.docx$/i.test(originalName)) {
    const isPdf = /\.pdf$/i.test(originalName);
    return res.status(400).json({
      error: isPdf ? '暂不支持 PDF 格式' : '仅支持 .docx 格式',
      diagnostics: [
        isPdf
          ? 'PDF 表格结构解析不可靠，请用 Word 打开后「另存为 .docx」再上传'
          : '若为旧版 .doc，请用 Word 打开后「另存为 .docx」再上传',
      ],
    });
  }

  // 1. 解析：企业名、日期、成员、工作包全部自动提取
  let parsed: Awaited<ReturnType<typeof parseWordPlan>>;
  try {
    parsed = await parseWordPlan(req.file.buffer, config.maxPlanRows);
  } catch (e) {
    return res.status(400).json({ error: `Word 解析失败：${(e as Error).message}` });
  }

  if (parsed.mode === 'none' || !parsed.slots.length) {
    return res.status(400).json({
      error: parsed.errors[0]?.reason || '未能识别审核计划格式',
      diagnostics: parsed.diagnostics,
      detail: parsed.errors.slice(0, 20),
    });
  }

  // 2. 项目名 = 计划里的受审核方名称；提取不到才退回文件名
  const fallbackName = originalName.replace(/\.docx$/i, '').slice(0, 60);
  const projectName = parsed.meta.projectName || fallbackName || '未命名审核项目';
  const auditDate = parsed.meta.auditDate
    ? new Date(`${parsed.meta.auditDate}T00:00:00Z`)
    : new Date();

  const uid = req.user!.uid;
  const role = req.user!.role;

  // 3. 同企业 + 同日期 → 复用已有项目（组长重复上传时不产生重复项目）
  //    ★ 隔离：复用必须落在「我有权限的项目」上。
  //    否则组长 A 传过的企业，组长 B 再传一次就会把 A 的项目连同审核记录一起覆盖掉 ——
  //    这正是「几十个组互相干扰」最典型的踩法。
  const existing = await prisma.project.findFirst({
    where: {
      name: projectName,
      status: 'active',
      ...(role === 'admin' ? {} : { id: { in: await visibleProjectIds(uid, role) } }),
    },
    select: { id: true, name: true },
  });

  let projectId = existing?.id;
  let reused = !!existing;

  if (!projectId) {
    const created = await prisma.project.create({
      data: {
        name: projectName,
        clientName: parsed.meta.projectName ?? null,
        auditDate,
        remark: parsed.meta.certNo ? `认证编号 ${parsed.meta.certNo}` : null,
        status: 'active',
        ownerId: uid,
      },
      select: { id: true, name: true },
    });
    projectId = created.id;
  } else if (parsed.meta.certNo) {
    await prisma.project.update({
      where: { id: projectId },
      data: { remark: `认证编号 ${parsed.meta.certNo}` },
    });
  }

  // 4. 清掉旧工作包再灌，保证「重复上传 = 覆盖」而非叠加
  const oldSlots = await prisma.planSlot.count({ where: { projectId } });
  if (oldSlots) {
    await prisma.focusRecord.deleteMany({ where: { projectId } });
    await prisma.slotRecord.deleteMany({ where: { slot: { projectId } } });
    await prisma.planSlot.deleteMany({ where: { projectId } });
  }

  // 5. 落库：审核组 + 工作包 + 条款映射分派
  const summary = await ingestProcessPlan(projectId, parsed);

  await writeLog({
    req,
    action: 'quick_import_word',
    target: `project:${projectId}`,
    detail: {
      projectName,
      auditDate: parsed.meta.auditDate,
      certNo: parsed.meta.certNo,
      reused,
      slots: summary.slots,
      slotRecords: summary.slotRecords,
      groups: summary.groups,
      members: parsed.members.length,
    },
  });

  res.json({
    ok: true,
    reused,
    project: { id: projectId, name: projectName },
    /** 自动提取结果 —— 前端展示给组长确认「系统读到了什么」 */
    extracted: {
      projectName,
      auditDate: parsed.meta.auditDate ?? null,
      auditEndDate: parsed.meta.auditEndDate ?? null,
      certNo: parsed.meta.certNo ?? null,
      members: parsed.members.map((m) => m.name),
    },
    slots: summary.slots,
    groups: summary.groups,
    groupsCreated: summary.groupsCreated,
    imported: summary.slotRecords,
    mappingGap: summary.mappingGap,
    knownNoItem: summary.knownNoItem,
    diagnostics: parsed.diagnostics,
  });
});

/**
 * POST /api/projects/:id/plans/word —— 上传现场审核计划 Word（.docx）
 *
 * 面向真实 CMD 认证审核计划：表结构为「日期 | 时间 | 过程名称 | 受审核部门 | 审核员」，
 * 其中过程名内嵌 ISO 条款串、审核员是「A（南京）」形式的代号。
 * 注：组长主路径已改为 POST /projects/quick-import（一步建档），本接口保留供补传/改计划用。
 */
projectRouter.post('/:id/plans/word', requireProjectAccess, requireRole('leader', 'admin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  const projectId = req.params.id;
  const originalName = String(req.file.originalname || '').toLowerCase();
  if (originalName && !originalName.endsWith('.docx')) {
    return res.status(400).json({
      error: '仅支持 .docx 格式',
      diagnostics: ['若为旧版 .doc，请用 Word 打开后「另存为 .docx」再上传'],
    });
  }

  let parsed: Awaited<ReturnType<typeof parseWordPlan>>;
  try {
    parsed = await parseWordPlan(req.file.buffer, config.maxPlanRows);
  } catch (e) {
    return res.status(400).json({ error: `Word 解析失败：${(e as Error).message}` });
  }

  if (parsed.mode === 'none' || !parsed.slots.length) {
    return res.status(400).json({
      error: parsed.errors[0]?.reason || '未能识别审核计划格式',
      mode: parsed.mode,
      diagnostics: parsed.diagnostics,
      detail: parsed.errors.slice(0, 20),
    });
  }

  // 抬头信息回填：企业名称优先，审核日期仅在项目未填时补
  const metaFilled: string[] = [];
  const proj = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true, clientName: true } });
  if (proj) {
    const patch: { name?: string; clientName?: string } = {};
    if (parsed.meta.projectName && !proj.clientName && proj.name !== parsed.meta.projectName) {
      patch.clientName = parsed.meta.projectName;
    }
    if (Object.keys(patch).length) {
      await prisma.project.update({ where: { id: projectId }, data: patch });
      metaFilled.push(...Object.keys(patch));
    }
  }

  const summary = await ingestProcessPlan(projectId, parsed);

  await writeLog({
    req,
    action: 'plan_import_word',
    target: `project:${projectId}`,
    detail: {
      slots: summary.slots,
      slotRecords: summary.slotRecords,
      groups: summary.groups,
      mappingGap: summary.mappingGap,
      knownNoItem: summary.knownNoItem,
      members: parsed.members.length,
    },
  });

  res.json({
    mode: parsed.mode,
    imported: summary.slotRecords,
    slots: summary.slots,
    groups: summary.groups,
    groupsCreated: summary.groupsCreated,
    members: parsed.members,
    /** 映射表数据缺口，需管理员补映射 */
    mappingGap: summary.mappingGap,
    /** 法规确无对应检查项：体系审核不得漏审，需组长另行安排人工核查 */
    knownNoItem: summary.knownNoItem,
    /** 括号内 GB/T 19001 并列条款，不参与 GMP 映射 */
    dual9001: summary.dual9001,
    unmatchedMembers: summary.unmatchedMembers,
    /** 未匹配到审核组而未建出的工作包 */
    unmatchedSlots: summary.unmatchedSlots,
    unmappedDetail: summary.unmatchedIsoDetail.slice(0, 20),
    meta: parsed.meta,
    metaFilled,
    errors: parsed.errors,
    diagnostics: parsed.diagnostics,
    warning: [
      summary.mappingGap.length
        ? `${summary.mappingGap.length} 个 ISO 条款在映射表中查无对应检查项，疑似映射表数据缺口，需管理员核对：${summary.mappingGap.join('、')}`
        : '',
      summary.knownNoItem.length
        ? `${summary.knownNoItem.length} 个 ISO 条款法规上确无对应 GMP 检查项（《规范》未设检查项），但体系审核仍不得漏审，需组长另行安排人工核查：${summary.knownNoItem.join('、')}`
        : '',
      summary.unmatchedMembers.length
        ? `以下审核组成员在系统中无同名账号，工作包已建但无人可登录：${summary.unmatchedMembers.join('、')}`
        : '',
      summary.unmatchedSlots.length
        ? `以下工作包未匹配到审核组，未分派下去：${summary.unmatchedSlots.join('、')}`
        : '',
    ]
      .filter(Boolean)
      .join('；') || undefined,
  });
});

/** POST /api/projects/:id/plans —— 手动加行 */
projectRouter.post('/:id/plans', requireProjectAccess, requireRole('leader', 'admin'), async (req, res) => {
  const { auditorName, groupName, isoClause, processName } = req.body || {};
  if (!auditorName || !isoClause) return res.status(400).json({ error: '请填写审核员姓名与 ISO 条款号' });
  const projectId = req.params.id;
  const iso = normalizeIso(isoClause);
  const auditors = await prisma.user.findMany({ where: { role: 'auditor' } });
  const matchAuditor = (name: string) => auditors.find((a) => a.name === name || a.username === name)?.id ?? null;
  const auditorNameStr = String(auditorName).trim();

  await ensureGroups(projectId, [{ auditorName: auditorNameStr, groupName: groupName || '' }], matchAuditor);

  const maxSeq = await prisma.auditPlan.aggregate({ where: { projectId }, _max: { seq: true } });
  const plan = await prisma.auditPlan.create({
    data: {
      projectId,
      groupName: groupName ? resolveGroupName(groupName, auditorNameStr) : null,
      auditorName: auditorNameStr,
      isoClause: iso,
      processName: processName || '未命名过程',
      source: 'manual',
      seq: (maxSeq._max.seq ?? -1) + 1,
    },
  });
  await dispatchProject(projectId);
  await writeLog({
    req,
    action: 'plan_create',
    target: `plan:${plan.id}`,
    detail: { auditorName: auditorNameStr, groupName: groupName || null, isoClause: iso },
  });
  res.json({ plan, auditorMatched: !!matchAuditor(auditorNameStr) });
});

/** DELETE /api/projects/:id/plans/:planId —— 删计划 → 清孤儿评估 → 重跑分派 */
projectRouter.delete('/:id/plans/:planId', requireProjectAccess, requireRole('leader', 'admin'), async (req, res) => {
  const { id, planId } = req.params;
  await prisma.auditPlan.delete({ where: { id: planId } });
  // 分派引擎会先清空 PlanItem，所以要先按旧范围清孤儿，再重建
  const pruned = await pruneOrphanAssessments(id);
  await dispatchProject(id);
  await writeLog({ req, action: 'plan_delete', target: `plan:${planId}`, detail: { projectId: id, pruned } });
  res.json({ ok: true, pruned });
});

/** GET /api/projects/:id/plans —— 计划清单（含分派数与归属审核组） */
projectRouter.get('/:id/plans', requireProjectAccess, async (req, res) => {
  const plans = await prisma.auditPlan.findMany({
    where: { projectId: req.params.id },
    orderBy: { seq: 'asc' },
    include: { _count: { select: { items: true } } },
  });
  // 组名回填：与分派引擎同一约定，前端不必自己拼
  const groups = await prisma.auditGroup.findMany({ where: { projectId: req.params.id }, select: { id: true, name: true } });
  const nameById = new Map(groups.map((g) => [g.id, g.name]));
  const scopes = await prisma.groupScope.findMany({
    where: { group: { projectId: req.params.id } },
    select: { groupId: true, gmpClauseId: true },
  });
  const groupByClause = new Map<string, string>();
  for (const s of scopes) if (s.gmpClauseId && !groupByClause.has(s.gmpClauseId)) groupByClause.set(s.gmpClauseId, s.groupId);

  const items = await prisma.planItem.findMany({
    where: { projectId: req.params.id },
    select: { planId: true, gmpClauseId: true },
  });
  const groupNameByPlan = new Map<string, Set<string>>();
  for (const it of items) {
    const gid = groupByClause.get(it.gmpClauseId);
    if (!gid) continue;
    const s = groupNameByPlan.get(it.planId) || new Set<string>();
    s.add(nameById.get(gid) || gid);
    groupNameByPlan.set(it.planId, s);
  }

  res.json(
    plans.map((p) => ({
      ...p,
      itemCount: p._count.items,
      groupName: p.groupName || resolveGroupName(null, p.auditorName),
      assignedGroups: [...(groupNameByPlan.get(p.id) || [])],
    })),
  );
});

/**
 * GET /api/projects/:id/board —— 实时看板
 *
 * 指标口径（全部以 PlanItem 为范围）：
 *   coverage.assigned  分母 = 本项目已分派的去重条款数（planItem.projectId 去重）
 *   coverage.verified  分子 = 已核实条款数（有 Assessment 记录 = 被反选/确认过）
 *   coverage.rate      = verified / assigned
 *   groups[]           每个审核组按章节展开：条款总数 / 已核实 / 未落地 / 部分落地
 *   redline/totals     直接取 report-engine，口径与最终报告完全一致
 */
projectRouter.get('/:id/board', requireProjectAccess, async (req, res) => {
  const projectId = req.params.id;
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return res.status(404).json({ error: '项目不存在' });

  // 分母：已分派的去重条款（不按映射表条数算，避免映射冗余虚高）
  const planItems = await prisma.planItem.findMany({ where: { projectId }, select: { gmpClauseId: true } });
  const assigned = new Set(planItems.map((i) => i.gmpClauseId)).size;
  const verified = await prisma.assessment.count({ where: { projectId } });

  // 各审核组进度（按章节分层，组内条款可见范围来自 GroupScope）
  const groups = await prisma.auditGroup.findMany({
    where: { projectId },
    orderBy: { sort: 'asc' },
    include: {
      leader: { select: { id: true, name: true } },
      members: { include: { user: { select: { id: true, name: true } } } },
    },
  });
  const workload =
    groups.length
      ? await getGroupWorkload(
          projectId,
          groups.map((g) => g.id),
        )
      : { total: 0, verified: 0, abnormal: 0, groups: [] };

  // 组 → 章节视图的映射（getGroupWorkload 返回的是跨组合并的章节列表）
  const clausesByGroup = new Map<string, string[]>();
  {
    const scopes = await prisma.groupScope.findMany({
      where: { group: { projectId } },
      select: { groupId: true, gmpClauseId: true },
    });
    for (const s of scopes) {
      if (!s.gmpClauseId) continue;
      const arr = clausesByGroup.get(s.groupId) || [];
      arr.push(s.gmpClauseId);
      clausesByGroup.set(s.groupId, arr);
    }
  }

  const content = await buildReportContent(projectId);

  // 未分派条款 = 启用映射覆盖的去重检查项 − 已分派条款
  // 用于提示组长「计划是否覆盖完整」，与覆盖率分母互不干扰
  const mappedClauseIds = await prisma.clauseMapping.findMany({
    where: { enabled: true },
    select: { gmpClauseId: true },
    distinct: ['gmpClauseId'],
  });

  res.json({
    project,
    coverage: {
      assigned,
      verified,
      rate: assigned ? +(verified / assigned).toFixed(3) : 0,
      unassigned: Math.max(0, mappedClauseIds.length - assigned),
    },
    groups: groups.map((g) => {
      const ids = new Set(clausesByGroup.get(g.id) || []);
      // getGroupWorkload 返回跨组合并的章节视图，这里按 GroupScope 裁回本组条款
      const chapters = workload.groups
        .map((c) => {
          const items = c.items.filter((i) => ids.has(i.id));
          if (!items.length) return null;
          const notLanded = items.filter((i) => i.status === 'not_landed').length;
          const partial = items.filter((i) => i.status === 'partial').length;
          const chVerified = items.filter((i) => i.verified).length;
          return {
            code: c.code,
            name: c.name,
            seq: c.seq,
            focus: c.focus,
            total: items.length,
            verified: chVerified,
            notLanded,
            partial,
            status: notLanded === 0 && partial === 0 ? 'landed' : notLanded >= items.length ? 'not_landed' : 'partial',
            progress: +(chVerified / items.length).toFixed(3),
            items,
          };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null);
      const gTotal = chapters.reduce((s, c) => s + c.total, 0);
      const gVerified = chapters.reduce((s, c) => s + c.verified, 0);
      return {
        groupId: g.id,
        name: g.name,
        sort: g.sort,
        leaderName: g.leader?.name ?? null,
        members: g.members.map((m) => ({ id: m.user.id, name: m.user.name, role: m.role })),
        total: gTotal,
        verified: gVerified,
        notLanded: chapters.reduce((s, c) => s + c.notLanded, 0),
        partial: chapters.reduce((s, c) => s + c.partial, 0),
        progress: gTotal ? +(gVerified / gTotal).toFixed(3) : 0,
        chapters,
      };
    }),
    totals: content.totals,
    byChapter: content.byChapter,
    redline: content.redline,
    abnormalList: content.abnormalList.slice(0, 20),
  });
});

/**
 * GET /api/projects/:id/groups —— 本项目审核组 + 各自分层工作负载
 * 取代旧的「按审核员分派」视图：审核员只是组员，工作包以组为单位下发。
 */
projectRouter.get('/:id/groups', requireProjectAccess, async (req, res) => {
  const projectId = req.params.id;
  const groups = await prisma.auditGroup.findMany({
    where: { projectId },
    orderBy: { sort: 'asc' },
    include: {
      leader: { select: { id: true, name: true } },
      members: { include: { user: { select: { id: true, name: true, username: true } } } },
    },
  });
  const out = await Promise.all(
    groups.map(async (g) => {
      const wl = await getGroupWorkload(projectId, [g.id]);
      return {
        id: g.id,
        name: g.name,
        sort: g.sort,
        leaderName: g.leader?.name ?? null,
        members: g.members.map((m) => ({ ...m.user, role: m.role })),
        total: wl.total,
        verified: wl.verified,
        abnormal: wl.abnormal,
        groups: wl.groups,
      };
    }),
  );
  res.json(out);
});

/**
 * GET /api/projects/:id/auditors —— 本项目参与人员（审核组成员 + 计划里出现过的审核员）
 * 仅返回名单与所属组，工作负载见 /groups。
 */
projectRouter.get('/:id/auditors', requireProjectAccess, async (req, res) => {
  const projectId = req.params.id;
  const [members, plans] = await Promise.all([
    prisma.groupMember.findMany({
      where: { group: { projectId } },
      include: { user: { select: { id: true, name: true, username: true } }, group: { select: { id: true, name: true } } },
    }),
    prisma.auditPlan.findMany({ where: { projectId }, select: { auditorName: true, groupName: true } }),
  ]);

  const byUser = new Map<string, { id: string; name: string; username: string; groups: { id: string; name: string; role: string }[] }>();
  for (const m of members) {
    const e = byUser.get(m.userId) || { ...m.user, groups: [] };
    e.groups.push({ id: m.group.id, name: m.group.name, role: m.role });
    byUser.set(m.userId, e);
  }
  // 计划里有、但还没进任何组的人（用户表匹配不上或尚未分组）也列出来，避免漏掉责任人
  const ungrouped = [...new Set(plans.map((p) => p.auditorName))].filter(
    (n) => ![...byUser.values()].some((u) => u.name === n),
  );
  res.json({ users: [...byUser.values()], ungrouped });
});

/** GET /api/projects/:id/rows —— 条款明细矩阵（看板下钻用，口径同报告） */
projectRouter.get('/:id/rows', requireProjectAccess, async (req, res) => {
  const rows = await collectRows(req.params.id);
  res.json(rows);
});

/**
 * GET /api/projects/:id/clause-tree —— ★ 全量条款树（第 5 项）
 *
 * 与 /rows 的区别（这是两个刻意分开的口径，不能合并）：
 *   /rows         = 本次审核计划实际覆盖的条款，报告落地率/异常清单按此算
 *   /clause-tree  = 指导原则全表（200 条）按 关键/主要/一般 三级 + 章展开
 * 组长要靠后者判断「这次计划漏审了哪一章、漏了哪些关键项」，
 * 所以额外给每条打一个 inPlan 标记，页面上未覆盖的一眼能看出来。
 */
projectRouter.get('/:id/clause-tree', requireProjectAccess, async (req, res) => {
  const tree = await buildClauseTree(req.params.id);
  await writeLog({ req, action: 'clause_tree_view', target: `project:${req.params.id}` });
  res.json(tree);
});

/** GET /api/projects/:id/export —— 项目全量数据导出（JSON 备份） */
projectRouter.get('/:id/export', requireProjectAccess, requireRole('leader', 'admin'), async (req, res) => {
  const projectId = req.params.id;
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      plans: { include: { items: true } },
      groups: { include: { members: true, scopes: true } },
      assessments: true,
      rectifications: true,
      reports: true,
    },
  });
  await writeLog({ req, action: 'project_export', target: `project:${projectId}` });
  res.setHeader('Content-Disposition', `attachment; filename="project-${projectId}.json"`);
  res.json(project);
});