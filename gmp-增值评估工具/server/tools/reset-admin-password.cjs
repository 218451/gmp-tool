// ===== 重置 admin 密码（供 重置管理员密码.cmd 调用）=====
//
// 用法：
//   node reset-admin-password.cjs "我的新密码"
//   node reset-admin-password.cjs --random    自动生成随机强密码
//
// 注意：
//   - 用户名固定是 admin（枚举值 role 为小写 admin）
//   - 改完密码需要重启服务才生效

const b = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const p = new PrismaClient();

// 生成随机强密码：8 位大写 + 8 位小写数字 + 2 位符号，打乱顺序
function randomPassword() {
  const pick = (chars, n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(chars[Math.floor(Math.random() * chars.length)]);
    }
    return out;
  };
  const all = [
    ...pick('ABCDEFGHJKLMNPQRSTUVWXYZ', 5),
    ...pick('abcdefghijkmnpqrstuvwxyz', 5),
    ...pick('23456789', 4),
    ...pick('!@#$%^&*', 2),
  ];
  // Fisher-Yates 洗牌，避免符号永远在末尾
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.join('');
}

async function main() {
  const arg = process.argv[2];
  const pwd = arg === '--random' || !arg ? randomPassword() : arg;

  if (pwd.length < 8) {
    console.error('[失败] 密码至少 8 位。当前 ' + pwd.length + ' 位。');
    process.exit(1);
  }

  // ★ 用户名固定 admin。role 枚举值是小写，不要用 where: { role: 'ADMIN' }
  const user = await p.user.findUnique({ where: { username: 'admin' } });
  if (!user) {
    console.error('[失败] 数据库里没有 admin 账号。');
    console.error('       可能库文件不对，检查 .env 里的 DATABASE_URL 指向哪个 v2.db。');
    process.exit(1);
  }

  await p.user.update({
    where: { username: 'admin' },
    data: { passwordHash: b.hashSync(pwd, 10) },
  });

  console.log('');
  console.log('  ============================================');
  console.log('   admin 密码已重置成功');
  console.log('  ============================================');
  console.log('   用户名: admin');
  console.log('   密  码: ' + pwd);
  console.log('');
  console.log('   请立刻抄下这个密码。');
  console.log('   关闭服务窗口后重新运行 打开评估工具.cmd 生效。');
  console.log('');
}

main()
  .catch((e) => {
    console.error('[失败] ' + (e && e.message ? e.message : e));
    process.exit(1);
  })
  .finally(() => p.$disconnect());