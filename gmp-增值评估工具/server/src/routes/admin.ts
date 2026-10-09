// ===== 管理员路由：映射表 CRUD / 导入导出、用户管理、日志 =====
import { Router } from 'express';
import ExcelJS from 'exceljs';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware';
import { writeLog } from '../log';
import { hashPassword } from '../auth';
import { config } from '../config';
import { LEVELS, ROLES, WAYS, type Role } from '../types';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('admin'));

// ===== 映射表 =====
// 分层反选模型下，章节归属与级别都只存在于 GmpClause 上，
// ClauseMapping 仅描述「ISO 条款 ↔ GMP 检查项」的对应关系，故管理端不再直接编辑这两者。

/** 映射列表统一携带的检查项字段（含章节名，供前端免二次查询） */
const CLAUSE_SELECT = {
  code: true,
  text: true,
  level: true,
  way: true,
  chapterCode: true,
  chapter: { select: { name: true } },
} as const;

/** GET /api/admin/mappings?isoClause=&chapterCode=&way=&keyword= —— 分页查询 */
adminRouter.get('/mappings', async (req, res) => {
  const { isoClause, chapterCode, way, keyword } = req.query as Record<string, string>;
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(200, Math.max(1, Number(req.query.size) || 50));

  const where: any = {};
  if (isoClause) where.isoClause = isoClause;
  if (way) where.way = way;
  if (chapterCode) where.gmpClause = { chapterCode };
  if (keyword) {
    where.AND = [
      {
        OR: [
          { gmpClause: { text: { contains: keyword } } },
          { gmpClause: { code: { contains: keyword } } },
          { isoClause: { contains: keyword } },
          { isoName: { contains: keyword } },
        ],
      },
    ];
  }

  const [total, list] = await Promise.all([
    prisma.clauseMapping.count({ where }),
    prisma.clauseMapping.findMany({
      where,
      orderBy: [{ isoClause: 'asc' }, { gmpClause: { seq: 'asc' } }],
      skip: (page - 1) * size,
      take: size,
      include: { gmpClause: { select: CLAUSE_SELECT } },
    }),
  ]);

  const [isoAll, chapters] = await Promise.all([
    prisma.clauseMapping.groupBy({ by: ['isoClause'] }),
    prisma.gmpChapter.findMany({ orderBy: { seq: 'asc' }, select: { code: true, name: true } }),
  ]);

  res.json({
    total,
    page,
    size,
    list,
    isoClauses: isoAll.map((a) => a.isoClause).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    chapters,
    ways: WAYS,
  });
});

/** POST /api/admin/mappings —— 新增映射 */
adminRouter.post('/mappings', async (req, res) => {
  const { isoClause, isoName, gmpClauseId, way, remark } = req.body || {};
  if (!isoClause || !gmpClauseId) {
    return res.status(400).json({ error: 'isoClause / gmpClauseId 均为必填' });
  }
  if (way && !(WAYS as readonly string[]).includes(way)) {
    return res.status(400).json({ error: 'way 必须是 直接对应/部分对应/扩展要求/法规特有' });
  }
  const gmp = await prisma.gmpClause.findUnique({ where: { id: gmpClauseId } });
  if (!gmp) return res.status(400).json({ error: 'GMP 检查项不存在' });

  try {
    const m = await prisma.clauseMapping.create({
      data: {
        isoClause: String(isoClause).trim(),
        isoName: isoName || null,
        gmpClauseId,
        way: way || '直接对应',
        remark: remark || null,
      },
      include: { gmpClause: { select: CLAUSE_SELECT } },
    });
    await writeLog({ req, action: 'mapping_create', target: `mapping:${m.id}`, detail: req.body });
    res.json(m);
  } catch (e: any) {
    if (String(e.message).includes('Unique')) return res.status(409).json({ error: '该 ISO 条款与 GMP 检查项的映射已存在' });
    throw e;
  }
});

/** PATCH /api/admin/mappings/:id */
adminRouter.patch('/mappings/:id', async (req, res) => {
  const { isoClause, isoName, way, remark, enabled } = req.body || {};
  if (way && !(WAYS as readonly string[]).includes(way)) return res.status(400).json({ error: 'way 非法' });
  const m = await prisma.clauseMapping.update({
    where: { id: req.params.id },
    data: {
      ...(isoClause ? { isoClause: String(isoClause).trim() } : {}),
      ...(isoName !== undefined ? { isoName: isoName || null } : {}),
      ...(way ? { way } : {}),
      ...(remark !== undefined ? { remark: remark || null } : {}),
      ...(enabled !== undefined ? { enabled: !!enabled } : {}),
    },
    include: { gmpClause: { select: CLAUSE_SELECT } },
  });
  await writeLog({ req, action: 'mapping_update', target: `mapping:${m.id}`, detail: req.body });
  res.json(m);
});

/** DELETE /api/admin/mappings/:id */
adminRouter.delete('/mappings/:id', async (req, res) => {
  await prisma.clauseMapping.delete({ where: { id: req.params.id } });
  await writeLog({ req, action: 'mapping_delete', target: `mapping:${req.params.id}` });
  res.json({ ok: true });
});

/** GET /api/admin/mappings/export.xlsx —— 导出映射表（真实条款号 + 章节名） */
adminRouter.get('/mappings/export.xlsx', async (req, res) => {
  const list = await prisma.clauseMapping.findMany({
    orderBy: [{ isoClause: 'asc' }, { gmpClause: { seq: 'asc' } }],
    include: { gmpClause: { include: { chapter: { select: { name: true } } } } },
  });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('映射表');
  ws.addRow([
    'ISO 13485 条款号',
    'ISO 条款名称',
    'GMP 检查项编号',
    '章节号',
    'GMP 章节',
    '级别',
    '《规范》条款号',
    '对应方式',
    '条款原文',
    '启用',
    '备注',
  ]);
  list.forEach((m) =>
    ws.addRow([
      m.isoClause,
      m.isoName || '',
      m.gmpClause.code,
      m.gmpClause.chapterCode,
      m.gmpClause.chapter.name,
      m.gmpClause.level,
      m.gmpClause.specClause,
      m.way,
      m.gmpClause.text,
      m.enabled ? '是' : '否',
      m.remark || '',
    ]),
  );
  ws.columns = [
    { width: 18 }, { width: 26 }, { width: 16 }, { width: 8 }, { width: 22 },
    { width: 8 }, { width: 14 }, { width: 12 }, { width: 60 }, { width: 8 }, { width: 24 },
  ] as any;
  const buf = await wb.xlsx.writeBuffer();
  await writeLog({ req, action: 'mapping_export', detail: { count: list.length } });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="clause-mappings.xlsx"');
  res.send(Buffer.from(buf));
});

/**
 * POST /api/admin/mappings/import —— 导入映射表（覆盖式 upsert）
 * 列名兼容中英文表头；「级别」列仅作校验用：与检查项实际级别不符时跳过该行，
 * 避免脏数据覆盖底表的 level。
 */
adminRouter.post('/mappings/import', async (req, res) => {
  const rows = (req.body?.rows || []) as any[];
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows 不能为空' });
  if (rows.length > 5000) return res.status(400).json({ error: '单次导入不能超过 5000 行' });

  const clauses = await prisma.gmpClause.findMany();
  const byCode = new Map(clauses.map((c) => [c.code, c]));
  let created = 0, updated = 0, skipped = 0;
  const errors: { row: number; reason: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const iso = String(r.isoClause ?? r['ISO 13485 条款号'] ?? r['条款'] ?? '').trim();
    const isoName = String(r.isoName ?? r['ISO 条款名称'] ?? '').trim();
    const code = String(r.code ?? r['GMP 检查项编号'] ?? r['编号'] ?? '').trim();
    const level = String(r.level ?? r['级别'] ?? '').trim();
    const way = String(r.way ?? r['对应方式'] ?? '').trim() || '直接对应';
    const remark = String(r.remark ?? r['备注'] ?? '').trim();
    const enabled = r.enabled === undefined || r.enabled === '' || r.enabled === '是' ? true : !!r.enabled;

    if (!iso || !code) {
      skipped++;
      errors.push({ row: i + 1, reason: '缺少条款号/检查项编号' });
      continue;
    }
    if (!(WAYS as readonly string[]).includes(way)) {
      skipped++;
      errors.push({ row: i + 1, reason: `对应方式非法：${way}` });
      continue;
    }
    const gmp = byCode.get(code);
    if (!gmp) {
      skipped++;
      errors.push({ row: i + 1, reason: `检查项编号不存在：${code}` });
      continue;
    }
    if (level && !(LEVELS as readonly string[]).includes(level)) {
      skipped++;
      errors.push({ row: i + 1, reason: `级别非法：${level}` });
      continue;
    }
    if (level && level !== gmp.level) {
      skipped++;
      errors.push({ row: i + 1, reason: `级别与底表不符：${code} 实为「${gmp.level}」` });
      continue;
    }

    const existing = await prisma.clauseMapping.findUnique({
      where: { isoClause_gmpClauseId: { isoClause: iso, gmpClauseId: gmp.id } },
    });
    const payload = {
      isoName: isoName || null,
      way,
      enabled,
      ...(remark ? { remark } : {}),
    };
    if (existing) {
      await prisma.clauseMapping.update({ where: { id: existing.id }, data: payload });
      updated++;
    } else {
      await prisma.clauseMapping.create({ data: { isoClause: iso, gmpClauseId: gmp.id, ...payload } });
      created++;
    }
  }

  await writeLog({ req, action: 'mapping_import', detail: { created, updated, skipped } });
  res.json({ created, updated, skipped, errors: errors.slice(0, 50) });
});

/** GET /api/admin/chapters —— 章节总览（14 章，itemCount/keyCount/... 为表内现成字段） */
adminRouter.get('/chapters', async (_req, res) => {
  const list = await prisma.gmpChapter.findMany({ orderBy: { seq: 'asc' } });
  res.json(list);
});

/** GET /api/admin/gmp-clauses —— GMP 检查项主表（含章节，按 seq 排序） */
adminRouter.get('/gmp-clauses', async (_req, res) => {
  const list = await prisma.gmpClause.findMany({
    orderBy: [{ chapterCode: 'asc' }, { seq: 'asc' }],
    include: { chapter: { select: { code: true, name: true } } },
  });
  res.json(list);
});

// ================= 用户管理 =================

adminRouter.get('/users', async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
    select: { id: true, username: true, name: true, role: true, active: true, dept: true, createdAt: true },
  });
  res.json(users.map((u) => ({ ...u, hasPassword: true, createdAt: u.createdAt.toISOString() })));
});

adminRouter.post('/users', async (req, res) => {
  const { username, name, role, password, dept } = req.body || {};
  if (!username || !name || !role) return res.status(400).json({ error: 'username / name / role 必填' });
  if (!ROLES.includes(role as Role)) return res.status(400).json({ error: 'role 必须是 leader/auditor/admin' });

  const exists = await prisma.user.findUnique({ where: { username: String(username).trim() } });
  if (exists) return res.status(409).json({ error: '登录名已存在' });

  // 审核员免密；组长/管理员必须有密码
  const pwd = role === 'auditor' ? null : String(password || '');
  if (pwd !== null && pwd.length < 6) return res.status(400).json({ error: '组长/管理员密码至少 6 位' });

  const u = await prisma.user.create({
    data: {
      username: String(username).trim(),
      name: String(name).trim(),
      role,
      dept: dept || null,
      passwordHash: pwd ? hashPassword(pwd) : null,
    },
    select: { id: true, username: true, name: true, role: true, active: true, dept: true },
  });
  await writeLog({ req, action: 'user_create', target: `user:${u.id}`, detail: { username, name, role } });
  res.json(u);
});

adminRouter.patch('/users/:id', async (req, res) => {
  const { name, role, dept, active } = req.body || {};
  const target = await prisma.user.findUniqueOrThrow({ where: { id: req.params.id } });
  // 保护：不能禁用/降级最后一个启用中的管理员
  if (target.role === 'admin' && (active === false || (role && role !== 'admin'))) {
    const admins = await prisma.user.count({ where: { role: 'admin', active: true } });
    if (admins <= 1) return res.status(400).json({ error: '系统至少需保留一个启用状态的管理员' });
  }
  const u = await prisma.user.update({
    where: { id: req.params.id },
    data: {
      ...(name ? { name: String(name).trim() } : {}),
      ...(role ? { role } : {}),
      ...(dept !== undefined ? { dept: dept || null } : {}),
      ...(active !== undefined ? { active: !!active } : {}),
    },
    select: { id: true, username: true, name: true, role: true, active: true, dept: true },
  });
  await writeLog({ req, action: 'user_update', target: `user:${u.id}`, detail: req.body });
  res.json(u);
});

/** POST /api/admin/users/:id/reset-password —— 重置密码 */
adminRouter.post('/users/:id/reset-password', async (req, res) => {
  const { password } = req.body || {};
  const pwd = String(password || '');
  if (pwd.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const target = await prisma.user.findUniqueOrThrow({ where: { id: req.params.id } });
  if (target.role === 'auditor') return res.status(400).json({ error: '审核员为免密账号，无需重置密码' });
  await prisma.user.update({ where: { id: req.params.id }, data: { passwordHash: hashPassword(pwd) } });
  await writeLog({ req, action: 'user_reset_password', target: `user:${req.params.id}` });
  res.json({ ok: true });
});

adminRouter.delete('/users/:id', async (req, res) => {
  const target = await prisma.user.findUniqueOrThrow({ where: { id: req.params.id } });
  if (target.role === 'admin') {
    const admins = await prisma.user.count({ where: { role: 'admin', active: true } });
    if (admins <= 1) return res.status(400).json({ error: '不能删除最后一个管理员' });
  }
  const used = await prisma.assessment.count({ where: { auditorId: req.params.id } });
  if (used > 0) return res.status(400).json({ error: `该用户已提交 ${used} 条评估记录，建议改为「禁用」而非删除` });
  await prisma.user.delete({ where: { id: req.params.id } });
  await writeLog({ req, action: 'user_delete', target: `user:${req.params.id}`, detail: { name: target.name, role: target.role } });
  res.json({ ok: true });
});

// ================= 操作日志 =================

adminRouter.get('/logs', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(200, Math.max(1, Number(req.query.size) || 50));
  const action = (req.query.action as string) || undefined;
  const where = action ? { action } : {};
  const [total, list] = await Promise.all([
    prisma.operationLog.count({ where }),
    prisma.operationLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }),
  ]);
  const actions = await prisma.operationLog.groupBy({ by: ['action'], _count: { action: true } });
  res.json({ total, page, size, list, actions: actions.map((a) => ({ action: a.action, count: a._count.action })) });
});

/** GET /api/admin/logs/export —— 导出全部日志 CSV */
adminRouter.get('/logs/export', async (_req, res) => {
  const list = await prisma.operationLog.findMany({ orderBy: { createdAt: 'desc' }, take: 50000 });
  const csv = [
    '时间,用户,角色,操作,对象,详情,IP',
    ...list.map((l) =>
      [l.createdAt.toISOString(), l.userName || '', l.role || '', l.action, l.target || '', `"${(l.detail || '').replace(/"/g, '""')}"`, l.ip || ''].join(','),
    ),
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="operation-logs.csv"');
  res.send('﻿' + csv);
});

/** GET /api/admin/stats —— 管理端概览 */
adminRouter.get('/stats', async (_req, res) => {
  const [users, projects, mappings, logs, plans, assessments, clauses, chapters] = await Promise.all([
    prisma.user.groupBy({ by: ['role'], _count: { role: true } }),
    prisma.project.groupBy({ by: ['status'], _count: { status: true } }),
    prisma.clauseMapping.count(),
    prisma.operationLog.count(),
    prisma.auditPlan.count(),
    prisma.assessment.count(),
    prisma.gmpClause.count(),
    prisma.gmpChapter.count(),
  ]);
  res.json({
    users, projects,
    mappingTotal: mappings,
    logTotal: logs,
    planTotal: plans,
    assessmentTotal: assessments,
    clauseTotal: clauses,
    chapterTotal: chapters,
  });
});