/**
 * 弱网离线同步引擎（审核员端核心 · 分层反选模型）
 * ----------------------------------------------------------------
 * 现场审核常在洁净车间/屏蔽区，信号极差甚至无网。
 * 设计目标：
 * 1. 取消勾选 -> 立即写 localStorage（同步，不 await，零感知延迟）
 * 2. 600ms 防抖聚合后批量 POST /api/assessments/batch（避免每点一次打一次请求）
 * 3. 断网时队列保留在 localStorage，online / visibilitychange / beforeunload 三重兜底补传
 * 4. 幂等：服务端按 projectId+gmpClauseId upsert，重复提交不产生脏数据
 * 5. 队列唯一键 = projectId + gmpClauseId（后端唯一键已去掉 auditorId）
 * 6. 章节层单独走 POST /api/assessments/chapter；离线时进章节队列，联网后按章补传，
 *    避免用条款级 batch 粗暴覆盖（那会把整章条款都标记成「已核实」，虚增核实数）
 */

import type { MyWorkload, Status } from './types';

const QUEUE_KEY = 'gmp_pending_queue';
const CHAPTER_KEY = 'gmp_pending_chapters';
const ITEMS_KEY = 'gmp_items_cache';

/** 待同步条款条目 */
export interface PendingItem {
  projectId: string;
  gmpClauseId: string;
  status: Status;
  ts: number;
}

/** 待同步章节操作 */
export interface PendingChapter {
  projectId: string;
  chapterCode: string;
  status: 'landed' | 'partial' | 'not_landed';
  ts: number;
}

/** 服务端拒绝的条目（重试无意义，需提示用户） */
export interface RejectedItem {
  gmpClauseId: string;
  reason: string;
}

export interface FlushResult {
  ok: boolean;
  sent: number;
  rejected: RejectedItem[];
}

// ---------- 条款队列 ----------

export function readQueue(): PendingItem[] {
  try {
    const s = localStorage.getItem(QUEUE_KEY);
    return s ? (JSON.parse(s) as PendingItem[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(q: PendingItem[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  emitQueueChange();
}

/** 入队（同一 projectId+gmpClauseId 覆盖旧值，避免队列膨胀） */
export function enqueue(item: PendingItem) {
  const q = readQueue();
  const i = q.findIndex((x) => x.projectId === item.projectId && x.gmpClauseId === item.gmpClauseId);
  if (i >= 0) q[i] = item;
  else q.push(item);
  writeQueue(q);
}

// ---------- 章节队列 ----------

export function readChapterQueue(): PendingChapter[] {
  try {
    const s = localStorage.getItem(CHAPTER_KEY);
    return s ? (JSON.parse(s) as PendingChapter[]) : [];
  } catch {
    return [];
  }
}

function writeChapterQueue(q: PendingChapter[]) {
  localStorage.setItem(CHAPTER_KEY, JSON.stringify(q));
  emitQueueChange();
}

/** 入队章节操作（同一 projectId+chapterCode 覆盖） */
export function enqueueChapter(item: PendingChapter) {
  const q = readChapterQueue();
  const i = q.findIndex((x) => x.projectId === item.projectId && x.chapterCode === item.chapterCode);
  if (i >= 0) q[i] = item;
  else q.push(item);
  writeChapterQueue(q);
}

/** 移除指定章节的待传记录（直连提交成功后调用，避免重复补传） */
export function dropChapter(projectId: string, chapterCode: string) {
  const q = readChapterQueue().filter((x) => !(x.projectId === projectId && x.chapterCode === chapterCode));
  writeChapterQueue(q);
}

function emitQueueChange() {
  window.dispatchEvent(
    new CustomEvent('gmp-queue-change', {
      detail: readQueue().length + readChapterQueue().length + readFocusQueue().length,
    }),
  );
}

/** 待传总数（条款 + 章节 + 关注点） */
export function pendingTotal(): number {
  return readQueue().length + readChapterQueue().length + readFocusQueue().length;
}

// ---------- 工作包本地缓存（断网时二次进入页面仍可渲染） ----------

export function cacheWorkload(projectId: string, data: MyWorkload) {
  localStorage.setItem(`${ITEMS_KEY}_${projectId}`, JSON.stringify(data));
}

export function readCachedWorkload(projectId: string): MyWorkload | null {
  try {
    const s = localStorage.getItem(`${ITEMS_KEY}_${projectId}`);
    return s ? (JSON.parse(s) as MyWorkload) : null;
  } catch {
    return null;
  }
}

/**
 * 把本地未同步的队列叠加到服务端返回的工作包上。
 * 现场弱网下用户看到的必须是「我刚才点的」，而不是服务端的旧值。
 */
export function applyPendingOverlay(data: MyWorkload): MyWorkload {
  const clauseMap = new Map<string, Status>();
  for (const it of readQueue()) {
    if (it.projectId !== data.projectId) continue;
    clauseMap.set(it.gmpClauseId, it.status);
  }
  const chapterMap = new Map<string, 'landed' | 'partial' | 'not_landed'>();
  for (const c of readChapterQueue()) {
    if (c.projectId !== data.projectId) continue;
    chapterMap.set(c.chapterCode, c.status);
  }
  if (!clauseMap.size && !chapterMap.size) return data;

  for (const g of data.groups) {
    const chTarget = chapterMap.get(g.code);
    for (const it of g.items) {
      const local = clauseMap.get(it.id);
      if (local) {
        it.status = local;
        it.abnormal = local === 'not_landed';
        it.verified = true;
      } else if (chTarget === 'not_landed') {
        it.status = 'not_landed';
        it.abnormal = true;
        it.verified = true;
      } else if (chTarget) {
        // 章节被勾回：只清掉本章的未落地，其余保持
        if (it.status === 'not_landed') {
          it.status = 'landed';
          it.abnormal = false;
        }
      }
    }
    // 重算章节派生值
    g.notLanded = g.items.filter((i) => i.status === 'not_landed').length;
    g.partial = g.items.filter((i) => i.status === 'partial').length;
    g.total = g.items.length;
    g.status =
      g.notLanded === 0 && g.partial === 0 ? 'landed' : g.notLanded >= g.total ? 'not_landed' : 'partial';
  }
  const all = data.groups.flatMap((g) => g.items);
  data.total = all.length;
  data.verified = all.filter((i) => i.verified).length;
  data.abnormal = all.filter((i) => i.abnormal).length;
  return data;
}

/** 条款层批量提交返回体 */
export interface BatchResp {
  ok: boolean;
  accepted: string[];
  rejected: RejectedItem[];
  rectify?: { added: number; removed: number; total: number };
  syncedAt: string;
}

export interface ChapterResp {
  ok: boolean;
  touched: number;
  rectify?: { added: number; removed: number; total: number };
}

// ---------- 关注点队列（A 方案）----------

const FOCUS_KEY = 'gmp_pending_focus';

/** 待同步的审核关注点判定（含现场记录文本，提交频率低于条款层） */
export interface PendingFocus {
  projectId: string;
  slotId: string;
  focusId: string;
  status: Status;
  note: string;
  evidence: string[];
  ts: number;
}

export function readFocusQueue(): PendingFocus[] {
  try {
    const s = localStorage.getItem(FOCUS_KEY);
    return s ? (JSON.parse(s) as PendingFocus[]) : [];
  } catch {
    return [];
  }
}

function writeFocusQueue(q: PendingFocus[]) {
  localStorage.setItem(FOCUS_KEY, JSON.stringify(q));
  emitQueueChange();
}

/** 入队关注点判定（projectId+slotId+focusId 覆盖，避免队列膨胀） */
export function enqueueFocus(item: PendingFocus) {
  const q = readFocusQueue();
  const i = q.findIndex((x) => x.projectId === item.projectId && x.slotId === item.slotId && x.focusId === item.focusId);
  if (i >= 0) q[i] = item;
  else q.push(item);
  writeFocusQueue(q);
}

/** 按工作包批量出队（直连提交成功后调用） */
export function dropFocusSlot(projectId: string, slotId: string) {
  writeFocusQueue(readFocusQueue().filter((x) => !(x.projectId === projectId && x.slotId === slotId)));
}

export interface FocusResp {
  saved: number;
  rejected: { focusId: string; reason: string }[];
}

/**
 * 队列同步器：单例语义（模块级共享队列），由页面注入 API 实现便于解耦。
 * @param batchFn   POST /assessments/batch
 * @param chapterFn POST /assessments/chapter
 * @param onRejected 被服务端拒绝的条目回调（用于提示）
 */
export function createSyncer(
  batchFn: (projectId: string, items: { gmpClauseId: string; status: Status }[]) => Promise<BatchResp>,
  chapterFn: (projectId: string, chapterCode: string, status: 'landed' | 'partial' | 'not_landed') => Promise<ChapterResp>,
  onRejected?: (items: RejectedItem[]) => void,
  /** A 方案：关注点批量提交（可选，未注入则关注点队列只入队不同步） */
  focusFn?: (projectId: string, slotId: string, items: { focusId: string; status: Status; note: string; evidence: string[] }[]) => Promise<FocusResp>,
) {
  let timer: number | null = null;
  let syncing = false;

  async function flush(force = false): Promise<FlushResult> {
    if (syncing) return { ok: false, sent: 0, rejected: [] };
    if (!navigator.onLine && !force) return { ok: false, sent: 0, rejected: [] };

    syncing = true;
    let sent = 0;
    const rejected: RejectedItem[] = [];
    try {
      // ---- 1. 章节层优先（粒度粗，先把整章意图落地）----
      const chapters = readChapterQueue();
      for (const c of chapters) {
        try {
          await chapterFn(c.projectId, c.chapterCode, c.status);
          const cur = readChapterQueue();
          writeChapterQueue(
            cur.filter((x) => !(x.projectId === c.projectId && x.chapterCode === c.chapterCode && x.status === c.status)),
          );
        } catch (e) {
          console.warn('[sync] 章节同步失败，保留待重试', c, e);
          if (force) break;
        }
      }

      // ---- 2. 条款层批量（按项目分组，单次上限 500 条）----
      const queue = readQueue();
      const byProject = new Map<string, PendingItem[]>();
      for (const it of queue) {
        const arr = byProject.get(it.projectId) || [];
        arr.push(it);
        byProject.set(it.projectId, arr);
      }

      for (const [projectId, items] of byProject) {
        // 后端单次上限 500 条，超出则分片
        for (let i = 0; i < items.length; i += 500) {
          const slice = items.slice(i, i + 500);
          const payloadKeys = slice.map((x) => `${x.projectId}|${x.gmpClauseId}|${x.status}`);
          try {
            const r = await batchFn(projectId, slice.map((x) => ({ gmpClauseId: x.gmpClauseId, status: x.status })));
            sent += slice.length;
            if (r?.rejected?.length) rejected.push(...r.rejected);
            const cur = readQueue();
            writeQueue(cur.filter((x) => !payloadKeys.includes(`${x.projectId}|${x.gmpClauseId}|${x.status}`)));
          } catch (e) {
            console.warn('[sync] 条款同步失败，队列保留待下次重试', e);
            if (force) break;
          }
        }
      }
      // ---- 3. 关注点层（按工作包聚合，note 文本较大故单独成批）----
      if (focusFn) {
        const fq = readFocusQueue();
        const bySlot = new Map<string, PendingFocus[]>();
        for (const f of fq) {
          const k = `${f.projectId}|${f.slotId}`;
          const arr = bySlot.get(k) || [];
          arr.push(f);
          bySlot.set(k, arr);
        }
        for (const [k, items] of bySlot) {
          const [projectId, slotId] = k.split('|');
          try {
            await focusFn(
              projectId,
              slotId,
              items.map((x) => ({ focusId: x.focusId, status: x.status, note: x.note, evidence: x.evidence })),
            );
            writeFocusQueue(readFocusQueue().filter((x) => !(x.projectId === projectId && x.slotId === slotId)));
          } catch (e) {
            console.warn('[sync] 关注点同步失败，队列保留待下次重试', e);
            if (force) break;
          }
        }
      }
      return { ok: true, sent, rejected };
    } finally {
      syncing = false;
      emitQueueChange();
      if (rejected.length) onRejected?.(rejected);
    }
  }

  /** 调度同步：防抖 600ms（force=true 时立即执行） */
  function schedule(force = false) {
    if (force) {
      void flush(true);
      return;
    }
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(() => void flush(true), 600);
  }

  if (typeof window !== 'undefined') {
    // 兜底 1：网络恢复
    window.addEventListener('online', () => schedule(true));
    // 兜底 2：页面重新可见（走出屏蔽区）
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') schedule(true);
    });
    // 兜底 3：页面关闭前尽力补传（keepalive fetch，sendBeacon 带不了 Authorization 头）
    window.addEventListener('beforeunload', () => {
      if (!navigator.onLine) return;
      const token = localStorage.getItem('gmp_token') || '';
      const post = (p: string, body: unknown) => {
        void fetch(`/api${p}`, {
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      };
      for (const c of readChapterQueue()) post('/assessments/chapter', { projectId: c.projectId, chapterCode: c.chapterCode, status: c.status });
      const byProject = new Map<string, PendingItem[]>();
      for (const it of readQueue()) {
        const arr = byProject.get(it.projectId) || [];
        arr.push(it);
        byProject.set(it.projectId, arr);
      }
      for (const [projectId, items] of byProject) {
        post('/assessments/batch', { projectId, items: items.map((i) => ({ gmpClauseId: i.gmpClauseId, status: i.status })) });
      }
      const fBySlot = new Map<string, PendingFocus[]>();
      for (const f of readFocusQueue()) {
        const k = `${f.projectId}|${f.slotId}`;
        const arr = fBySlot.get(k) || [];
        arr.push(f);
        fBySlot.set(k, arr);
      }
      for (const [k, items] of fBySlot) {
        const [projectId, slotId] = k.split('|');
        post(`/projects/${projectId}/focus-records`, {
          slotId,
          items: items.map((i) => ({ focusId: i.focusId, status: i.status, note: i.note, evidence: i.evidence })),
        });
      }
    });
  }

  return { flush, schedule, get pending() { return pendingTotal(); } };
}
