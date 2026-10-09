/**
 * 真实 HTTP 接口验证：Word 导入 → 审核员免密登录 → 取工作包 → 提交关注点
 * 运行：npx tsx prisma/http-check.ts "D:/某路径/审核计划.docx"
 */
import { existsSync } from 'node:fs';
const API = 'http://127.0.0.1:' + (process.env.CHECK_PORT || '8780') + '/api';
/**
 * ★ 审核计划文件路径从命令行参数或环境变量读取，不再写死本机绝对路径。
 *   用法：npx tsx prisma/http-check.ts "D:/某路径/某企业审核计划.docx"
 *   或：  set PLAN_FILE=D:/某路径/某企业审核计划.docx
 * 为什么要改：真实计划含企业名与审核员姓名，属客户资料，
 *   仓库里既不该出现绝对路径，也不该出现客户名称。
 */
const FILE = process.argv[2] || process.env.PLAN_FILE || '';
if (!FILE) {
  console.error('请传入审核计划文件路径：npx tsx prisma/http-check.ts "D:/路径/审核计划.docx"');
  process.exit(1);
}
if (!existsSync(FILE)) {
  console.error('文件不存在：' + FILE);
  process.exit(1);
}

const j = async (p: string, opt: RequestInit = {}, token?: string) => {
  const r = await fetch(API + p, {
    ...opt,
    headers: {
      ...(opt.body && !(opt.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const t = await r.text();
  try {
    return { ok: r.ok, status: r.status, data: JSON.parse(t) };
  } catch {
    return { ok: r.ok, status: r.status, data: t };
  }
};

async function main() {
  // 1. 组长登录
  const login = await j('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: process.env.CHECK_USER || 'zhangwei', password: process.env.CHECK_PWD || '', role: process.env.CHECK_ROLE || 'leader' }),
  });
  console.log(`[1] 组长登录：${login.ok ? 'OK' : '失败 ' + JSON.stringify(login.data)}`);
  const lt: string = login.data.token;
  void lt;

  // 2. 建项目
  const ps = await j(
    '/projects',
    { method: 'POST', body: JSON.stringify({ name: `【HTTP检查】示例企业 ${Date.now().toString(36)}`, auditDate: new Date('2026-10-12T00:00:00Z').toISOString() }) },
    lt,
  );
  const pid: string = ps.data.id;
  console.log(`[2] 建项目：${ps.ok ? 'OK ' + pid : '失败 ' + JSON.stringify(ps.data)}`);

  // 3. 上传 Word 计划
  const buf = (await import('node:fs')).readFileSync(FILE);
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(buf)]), 'plan.docx');
  const up = await j(`/projects/${pid}/plans/word`, { method: 'POST', body: fd }, lt);
  console.log(`[3] Word 导入：${up.ok ? 'OK' : '失败'} 工作包 ${up.data.slots} · 检查项 ${up.data.imported} · 组 ${(up.data.groups || []).join('/')}`);
  console.log(`    自动建号：${(up.data.unmatchedMembers || []).length} 人无账号 · mappingGap ${(up.data.mappingGap || []).length} · knownNoItem ${(up.data.knownNoItem || []).length} · dual9001 ${(up.data.dual9001 || []).length}`);
  if (up.data.warning) console.log(`    告警：${up.data.warning}`);

  // 4. 审核员免密登录（用真实计划里的姓名）
  const al = await j('/auth/login-auditor', { method: 'POST', body: JSON.stringify({ name: '示例审核员' }) });
  console.log(`[4] 审核员免密登录「示例审核员」：${al.ok ? 'OK' : '失败 ' + JSON.stringify(al.data)} · 可见项目 ${al.data.projects?.length ?? 0}`);
  const at: string = al.data.token;

  // 5. 取过程工作包
  const slots = await j(`/projects/${pid}/process-slots`, {}, at);
  const list = slots.data.slots || [];
  console.log(`[5] GET process-slots：${slots.ok ? 'OK' : '失败'} 共 ${list.length} 个工作包`);
  for (const s of list.slice(0, 5)) {
    console.log(
      `    ${s.slotDate} ${s.timeRange} ${s.processCode} ${String(s.processName).slice(0, 12).padEnd(13)} ${s.group?.name} 审核员=${s.auditorName} | 关注点 ${s.focuses.length}(可判定${s.progress.focuses.total}) 检查项 ${s.clauses.length} 进度=${JSON.stringify(s.progress)}`,
    );
    const f = s.focuses.find((x: any) => x.fillable);
    if (f) {
      console.log(`      首条关注点：${f.seq} ${String(f.title).slice(0, 22)} detail=${f.detail.length}条 记录要点=${f.checklist.length}条 status=${f.status} verified=${f.verified}`);
      if (f.detail[0]) console.log(`        detail[0]: ${String(f.detail[0]||'').slice(0, 50)}`);
      console.log(`        checklist[0]: ${String(f.checklist[0]||'（无）').slice(0, 46)}`);
    }
  }

  // 6. 提交关注点判定
  const target = list.find((s: any) => s.focuses.some((f: any) => f.fillable));
  if (!target) throw new Error('无含可判定关注点的工作包');
  const focus = target.focuses.find((f: any) => f.fillable);
  const sv = await j(
    `/projects/${pid}/focus-records`,
    {
      method: 'POST',
      body: JSON.stringify({
        slotId: target.id,
        items: [{ focusId: focus.id, status: 'not_landed', note: '【HTTP检查】现场核查发现程序文件缺少审批签字', evidence: ['QP-013 Rev.5', '批记录 B260301'] }],
      }),
    },
    at,
  );
  console.log(`[6] POST focus-records：${sv.ok ? 'OK' : '失败'} 保存 ${sv.data.saved} 条 · 拒绝 ${sv.data.rejected?.length ?? 0}`);

  // 7. 回读确认落库
  const again = await j(`/projects/${pid}/process-slots`, {}, at);
  const t2 = (again.data.slots || []).find((s: any) => s.id === target.id);
  const f2 = t2.focuses.find((x: any) => x.id === focus.id);
  console.log(`[7] 回读：${f2.status} · verified=${f2.verified} · 记录「${String(f2.note).slice(0, 24)}」 · 证据 ${f2.evidence.length} 条`);
  console.log(`    工作包进度：关注点 ${t2.progress.focuses.done}/${t2.progress.focuses.total} · 检查项 ${t2.progress.clauses.done}/${t2.progress.clauses.total}`);

  // 8. 越权校验：杜超（B组）不应看到 A组工作包
  const dl = await j('/auth/login-auditor', { method: 'POST', body: JSON.stringify({ name: '杜超' }) });
  if (dl.ok) {
    const ds = await j(`/projects/${pid}/process-slots`, {}, dl.data.token);
    const mine = (ds.data.slots || []).map((s: any) => s.group?.name);
    const leak = (ds.data.slots || []).filter((s: any) => s.group?.name !== 'B组').length;
    console.log(`[8] 越权校验：杜超看到 ${ds.data.slots.length} 个工作包，全部 B组=${leak === 0}（组别：${[...new Set(mine)].join('/')}）`);
    // 尝试改 A 组工作包
    const bad = await j(
      `/projects/${pid}/focus-records`,
      { method: 'POST', body: JSON.stringify({ slotId: target.id, items: [{ focusId: focus.id, status: 'landed' }] }) },
      dl.data.token,
    );
    console.log(`    杜超改 A组工作包 → HTTP ${bad.status} ${bad.data.error || ''}（期望 403）`);
  }

  // 9. 清理
  const del = await j(`/projects/${pid}`, { method: 'DELETE' }, lt);
  console.log(`[9] 清理测试项目：${del.ok ? 'OK' : del.status + ' ' + JSON.stringify(del.data)}`);
}

main().catch((e) => {
  console.error('失败：', e);
  process.exit(1);
});