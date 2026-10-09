// ===== 报告路由：生成 / 复核 / 编辑 / 导出 Word =====
import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware';
import { writeLog } from '../log';
import { pruneOrphanAssessments } from '../dispatch';
import { buildReportContent } from '../report-engine';
import { generateAiInsight } from '../ai';
import { buildDocx } from '../docx';
import { requireReportProjectAccess } from '../access';

export const reportRouter = Router();
reportRouter.use(requireAuth);

/**
 * POST /api/reports/generate  body: { projectId, withAi?: boolean }
 * 重新计算统计数据 + 覆盖已有报告（保留组长已编辑的 AI 文本，除非 withAi 显式为 true）
 */
reportRouter.post('/generate', requireReportProjectAccess, requireRole('leader', 'admin'), async (req, res) => {
  const { projectId, withAi } = req.body || {};
  if (!projectId) return res.status(400).json({ error: '缺少 projectId' });

  await pruneOrphanAssessments(projectId);
  const content = await buildReportContent(projectId);

  const existing = await prisma.report.findFirst({ where: { projectId }, orderBy: { updatedAt: 'desc' } });

  let aiSummary = existing?.aiSummary ?? '';
  let aiRaw = existing?.aiRaw ?? null;
  let aiProvider = existing?.aiProvider ?? null;

  if (withAi) {
    const ai = await generateAiInsight(content);
    aiSummary = ai.summary;
    aiRaw = ai.summary;
    aiProvider = ai.provider;
  }

  const data = {
    projectId,
    contentJson: JSON.stringify(content),
    aiSummary,
    aiRaw,
    aiProvider,
    // 重新生成 => 复核状态失效，需组长重新复核
    confirmedAt: null,
    confirmedBy: null,
  };

  const report = existing
    ? await prisma.report.update({ where: { id: existing.id }, data })
    : await prisma.report.create({ data });

  await writeLog({ req, action: 'report_generate', target: `report:${report.id}`, detail: { projectId, withAi: !!withAi, redline: content.redline.triggered } });
  res.json({ ...report, content: content, aiProvider });
});

/** GET /api/reports/:id —— 报告详情（含 content 解析结果） */
reportRouter.get('/:id', requireReportProjectAccess, async (req, res) => {
  const rep = await prisma.report.findUnique({
    where: { id: req.params.id },
    include: { confirmer: { select: { name: true } }, project: { select: { name: true, auditDate: true } } },
  });
  if (!rep) return res.status(404).json({ error: '报告不存在' });
  res.json({
    ...rep,
    content: safeParse(rep.contentJson),
    confirmedByName: rep.confirmer?.name ?? null,
  });
});

/** GET /api/reports/by-project/:projectId —— 取该项目最新报告 */
reportRouter.get('/by-project/:projectId', requireReportProjectAccess, async (req, res) => {
  const rep = await prisma.report.findFirst({
    where: { projectId: req.params.projectId },
    orderBy: { updatedAt: 'desc' },
    include: { confirmer: { select: { name: true } } },
  });
  if (!rep) return res.status(404).json({ error: '该项目尚无报告，请先生成' });
  res.json({ ...rep, content: safeParse(rep.contentJson), confirmedByName: rep.confirmer?.name ?? null });
});

/** PATCH /api/reports/:id —— 组长编辑 AI 文本 / 复核 */
reportRouter.patch('/:id', requireReportProjectAccess, requireRole('leader', 'admin'), async (req, res) => {
  const { aiSummary, confirm } = req.body || {};
  const cur = await prisma.report.findUniqueOrThrow({ where: { id: req.params.id } });

  const rep = await prisma.report.update({
    where: { id: cur.id },
    data: {
      ...(aiSummary !== undefined ? { aiSummary: String(aiSummary), aiRaw: String(aiSummary) } : {}),
      ...(confirm
        ? { confirmedAt: new Date(), confirmedBy: req.user!.uid }
        : {}),
    },
  });
  await writeLog({ req, action: confirm ? 'report_confirm' : 'report_edit', target: `report:${rep.id}`, detail: { hasAiEdit: aiSummary !== undefined } });
  res.json(rep);
});

/** GET /api/reports/:id/export.docx —— 导出 Word */
reportRouter.get('/:id/export.docx', requireReportProjectAccess, requireRole('leader', 'admin', 'auditor'), async (req, res) => {
  const rep = await prisma.report.findUnique({
    where: { id: req.params.id },
    include: { confirmer: { select: { name: true } } },
  });
  if (!rep) return res.status(404).json({ error: '报告不存在' });

  const content = safeParse(rep.contentJson);
  if (!content) return res.status(500).json({ error: '报告内容解析失败，请重新生成' });

  const buffer = await buildDocx(content, rep.aiSummary || '', rep.confirmer?.name);
  await writeLog({ req, action: 'report_export_docx', target: `report:${rep.id}` });

  const filename = encodeURIComponent(`${content.project.name}-GMP落地增值评估报告.docx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="report.docx"; filename*=UTF-8''${filename}`);
  res.send(buffer);
});

function safeParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
