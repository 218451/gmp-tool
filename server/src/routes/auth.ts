// ===== 认证路由：登录 / 免密登录 / 当前用户 =====
import { Router } from 'express';
import { prisma } from '../db';
import { checkPassword, hashPassword, signToken } from '../auth';
import { requireAuth } from '../middleware';
import { writeLog } from '../log';
import { isStatus, type Role } from '../types';

export const authRouter = Router();

/**
 * POST /api/auth/login
 * body: { username, password, role }
 * - 组长/管理员：校验 bcrypt 密码
 * - 审核员：走 /api/auth/login-auditor（免密），此处拒绝
 */
authRouter.post('/login', async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !role) return res.status(400).json({ error: '请填写姓名并选择角色' });
  if (role === 'auditor') return res.status(400).json({ error: '审核员请使用免密登录' });

  const user = await prisma.user.findFirst({ where: { username: String(username).trim() } });
  if (!user) {
    await writeLog({ req, action: 'login_failed', target: `user:${username}`, userName: username, role });
    return res.status(401).json({ error: '账号不存在' });
  }
  if (!user.active) return res.status(403).json({ error: '账号已被禁用，请联系管理员' });
  if (user.role !== role) return res.status(403).json({ error: '所选角色与账号角色不符' });
  if (!user.passwordHash || !checkPassword(String(password || ''), user.passwordHash)) {
    await writeLog({ req, action: 'login_failed', target: `user:${user.username}`, userId: user.id, userName: user.name, role: user.role as Role });
    return res.status(401).json({ error: '密码错误' });
  }

  const token = signToken({ uid: user.id, name: user.name, role: user.role as Role });
  await writeLog({ req, action: 'login', target: `user:${user.username}`, userId: user.id, userName: user.name, role: user.role as Role });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, username: user.username } });
});

/**
 * POST /api/auth/register —— ★ 用户自行注册（不依赖审核组长先建计划）
 *
 * 业务背景（负责人原话）：
 *   「登录页需支持用户自行注册（录入姓名等信息），不能依赖审核组长先建计划。
 *     系统要支持几十个组同时独立使用，避免互相干扰。」
 *
 * 设计要点：
 *   1. 登录名用「手机号」而非姓名。几十个组并行时不同机构可能存在同名审核员，
 *      用姓名当登录名必然冲突；手机号天然唯一，且现场都填得出。
 *   2. ★ 姓名撞上「计划自动建的免密账号」时做原地升级，不新建账号。
 *      因为 GroupMember.userId 是外键指向 User，新建账号会让已导入的
 *      组成员关系悬空 —— 这个人注册完反而看不到自己的章节。
 *      升级（改 username + 补密码）能保留所有项目里的组成员身份。
 *   3. 不允许自助注册 admin。管理员只能由现有管理员在后台创建。
 *   4. 注册成功直接签发 token，前端一步进系统，不用再登一次。
 */
authRouter.post('/register', async (req, res) => {
  const name = String(req.body?.name || '').replace(/\s+/g, '').trim();
  const phone = String(req.body?.phone || '').replace(/\s+/g, '').trim();
  const password = String(req.body?.password || '');
  const role = String(req.body?.role || 'auditor');
  const org = String(req.body?.org || '').trim();

  if (!name) return res.status(400).json({ error: '请填写姓名' });
  if (!/^[\u4e00-\u9fa5·]{2,6}$/.test(name)) return res.status(400).json({ error: '姓名应为 2~6 个汉字' });
  if (!/^\d{11}$/.test(phone)) return res.status(400).json({ error: '请填写 11 位手机号，作为登录账号' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (!['auditor', 'leader'].includes(role)) {
    return res.status(400).json({ error: '角色只能是审核员或组长' });
  }

  // 手机号已被占用：可能是重复注册，也可能是同一人的免密账号等待「认领」
  const byPhone = await prisma.user.findUnique({ where: { username: phone } });
  if (byPhone) {
    return res.status(409).json({
      error: '该手机号已注册，请直接登录',
      hint: byPhone.name === name ? '' : '若手机号填错，请核对后重试',
    });
  }

  // 计划自动建过同名免密账号 → 原地升级，保留全部项目组成员身份
  const legacy = await prisma.user.findFirst({
    where: { name, role: { in: ['auditor', 'leader'] } },
    orderBy: { createdAt: 'asc' },
  });

  const passwordHash = hashPassword(password);
  const user = legacy
    ? await prisma.user.update({
        where: { id: legacy.id },
        data: { username: phone, passwordHash, role, dept: org || legacy.dept, active: true },
      })
    : await prisma.user.create({
        data: { username: phone, name, role, passwordHash, dept: org || null, active: true },
      });

  await writeLog({
    req,
    action: 'register',
    target: `user:${user.username}`,
    userId: user.id,
    userName: user.name,
    role: role as Role,
    detail: { upgradedFromLegacy: !!legacy, org: org || null },
  });

  const token = signToken({ uid: user.id, name: user.name, role: role as Role });
  res.json({
    ok: true,
    upgraded: !!legacy,
    token,
    user: { id: user.id, name: user.name, role: user.role, username: user.username },
  });
});

/**
 * POST /api/auth/login-auditor  —— 审核员登录
 * body: { name, password? }
 * 返回该审核员参与的所有项目（供前端自动进入最近一个）
 *
 * 说明：组内「组长」在真实审核计划里同样要下现场填记录，
 * 因此这里放开 leader 角色，不限定 auditor。登录后仍按其所在审核组限定可见范围。
 *
 * 密码策略（配合自助注册）：
 *   有密码的账号（自行注册过）→ 姓名 + 密码，避免几十个组并行时同名撞号
 *   无密码的账号（计划自动建号）→ 保持姓名免密，现场少一步
 *   同名多人且都无密码 → 拒绝并提示，避免登进别人的账号
 */
authRouter.post('/login-auditor', async (req, res) => {
  const name = String(req.body?.name || '').replace(/\s+/g, '').trim();
  const password = String(req.body?.password || '');
  if (!name) return res.status(400).json({ error: '请输入姓名' });

  const candidates = await prisma.user.findMany({
    where: { name, role: { in: ['auditor', 'leader'] } },
    select: { id: true, name: true, role: true, username: true, passwordHash: true, active: true },
  });
  if (!candidates.length) {
    return res.status(401).json({
      error: '未找到该姓名的账号',
      hint: '请先在登录页点「注册账号」登记姓名与手机号',
    });
  }

  let user = candidates[0];
  if (candidates.length > 1) {
    // 同名多人：只有能通过密码确认的那一位可以登录
    const hit = password
      ? candidates.find((c) => c.passwordHash && checkPassword(password, c.passwordHash))
      : null;
    if (!hit) {
      const needPw = candidates.filter((c) => c.passwordHash).length;
      return res.status(401).json({
        error: candidates.length > 1 ? `库中有 ${candidates.length} 位同名人员，请填写密码以确认身份` : '请填写密码',
        hint: needPw ? '该姓名已注册过，请填写注册时设置的密码' : undefined,
      });
    }
    user = hit;
  } else if (user.passwordHash) {
    if (!password) {
      return res.status(401).json({ error: '该账号已注册过，请填写密码', hint: '只需首次输入，之后浏览器会记住' });
    }
    if (!checkPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: '密码错误' });
    }
  }
  if (!user.active) return res.status(403).json({ error: '账号已被禁用，请联系管理员' });

  const token = signToken({ uid: user.id, name: user.name, role: 'auditor' });
  // 可见项目 = 该审核员作为组成员参与的审核组所属项目（★ 项目隔离在此收口）
  const projects = await prisma.project.findMany({
    where: { status: 'active', groups: { some: { members: { some: { userId: user.id } } } } },
    select: { id: true, name: true, auditDate: true, status: true },
    orderBy: { auditDate: 'desc' },
  });
  // 附带其在各项目的审核组名，前端用于标题展示
  const groupNames = await prisma.auditGroup.findMany({
    where: { members: { some: { userId: user.id } } },
    select: { projectId: true, name: true },
  });
  const groupByProject = new Map(groupNames.map((g) => [g.projectId, g.name]));
  const uniq = projects.map((p) => ({ ...p, groupName: groupByProject.get(p.id) ?? null }));

  await writeLog({ req, action: 'login_auditor', target: `user:${user.username}`, userId: user.id, userName: user.name, role: 'auditor' });
  res.json({
    token,
    user: { id: user.id, name: user.name, role: 'auditor', username: user.username },
    projects: uniq,
  });
});

/** GET /api/auth/me —— 校验 token 并返回当前用户 */
/**
 * GET /api/auth/auditor-names —— 免密登录可选姓名清单
 *
 * ★ 隐私与隔离：接口需要登录态，且只返回「当前用户自己」的名字。
 *   早期版本公开返回全库所有审核员姓名，几十个组并行时等于把
 *   全体审核人员名册挂在公网上，任何人输入接口地址即可拉取。
 *   现在改为：登录后查自己的名字（前端用于预填），
 *   现场点选姓名由「输入框 + 计划导入时自动建号」承担，不再依赖公开名录。
 */
authRouter.get('/auditor-names', requireAuth, async (req, res) => {
  const u = await prisma.user.findUnique({
    where: { id: req.user!.uid },
    select: { name: true, role: true, active: true },
  });
  if (!u || !u.active) return res.status(401).json({ error: '账号不存在或已禁用' });
  res.json({ names: [u.name], self: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const u = await prisma.user.findUnique({ where: { id: req.user!.uid } });
  if (!u || !u.active) return res.status(401).json({ error: '账号不存在或已禁用' });
  res.json({ id: u.id, name: u.name, role: u.role, username: u.username, dept: u.dept });
});

/** POST /api/auth/password —— 当前用户自助改密（审核员除外） */
authRouter.post('/password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  if (req.user!.role === 'auditor') return res.status(403).json({ error: '审核员账号无密码，请联系管理员' });

  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.uid } });
  if (u.passwordHash && !checkPassword(String(oldPassword || ''), u.passwordHash)) {
    return res.status(401).json({ error: '原密码错误' });
  }
  await prisma.user.update({ where: { id: u.id }, data: { passwordHash: hashPassword(String(newPassword)) } });
  await writeLog({ req, action: 'change_password', target: `user:${u.username}` });
  res.json({ ok: true });
});

export { isStatus };
