// ===== 服务入口 =====
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { config, hasDeepSeek } from './config';
import { prisma } from './db';
import { authRouter } from './routes/auth';
import { projectRouter } from './routes/projects';
import { assessmentRouter } from './routes/assessments';
import { reportRouter } from './routes/reports';
import { adminRouter } from './routes/admin';
import { rectifyRouter } from './routes/rectifications';
import { processRouter } from './routes/processes';
import { chapterViewRouter } from './routes/chapter-view';

const app = express();

app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') }));
app.use(express.json({ limit: '5mb' }));

// 健康检查（Docker healthcheck 使用）
app.get('/api/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: 'up', ai: hasDeepSeek() ? 'deepseek' : 'fallback', time: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false, db: 'down' });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/projects', projectRouter);
app.use('/api/assessments', assessmentRouter);
app.use('/api/reports', reportRouter);
app.use('/api/admin', adminRouter);
app.use('/api/rectifications', rectifyRouter);
// /api/processes 与 /api/projects/:pid/process-slots、focus-records
app.use('/api', processRouter);
// /api/projects/:pid/chapter-view —— 审核员按指导原则十四章分层的工作台
app.use('/api', chapterViewRouter);

// ===== 静态前端托管 =====
// 前端用 hash 路由，无需 rewrite，直接把 index.html 兜底到根路径即可。
// 这样开发与生产都是同一个地址：后端端口直接就是登录页，不用再单独开前端。
const webDist = [
  path.resolve(__dirname, '../../web/dist'), // 运行 dist/index.js
  path.resolve(__dirname, '../../../web/dist'), // tsx 直跑 src/index.ts
].find((p) => fs.existsSync(path.join(p, 'index.html')));

if (webDist) {
  // Vite 产物带内容哈希，可长缓存；index.html 不缓存，否则改版后浏览器拿不到新包名
  app.use(express.static(webDist, { index: false, maxAge: '1h', immutable: true }));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(webDist, 'index.html'));
  });
  console.log(`[gmp-audit-server] 已托管前端：${webDist}`);
} else {
  console.warn('[gmp-audit-server] 未找到 web/dist，仅提供 API。请先执行 cd web && npm run build');
}

// 统一错误处理
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', err);
  res.status(500).json({ error: err?.message || '服务器内部错误' });
});

app.listen(config.port, () => {
  console.log(`[gmp-audit-server] 已启动 http://localhost:${config.port}`);
  console.log(`[gmp-audit-server] AI 模式：${hasDeepSeek() ? 'DeepSeek 已配置' : '未配置 Key，使用规则引擎降级'}`);
});
