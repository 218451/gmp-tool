<script setup lang="ts">
/**
 * 审核员采集页 —— 分层勾选 + 反选模型
 * ----------------------------------------------------------------
 * 核心语义：默认全选「已落地」，用户只需【取消勾选】未落实的条款。
 *   - 章节层（第一层）：一屏列出可见章节，每章一个大复选框
 *       取消勾选 -> 二次确认 -> POST /api/assessments/chapter 置整章未落地
 *   - 条款层（第二层）：默认折叠，展开后每条一个复选框
 *       取消勾选 -> POST /api/assessments/batch 单条幂等覆盖
 *   - verified 由后端派生（有无 Assessment 记录），前端只负责反选
 *
 * 交互红线（产品硬约束）：
 *   1. 页面无任何文本输入框
 *   2. 无「提交」按钮 —— 点击即存
 *   3. 零文本输入、无提交按钮、点击即存
 *   4. localStorage 弱网暂存，online/visible/unload 三重兜底自动同步
 *   5. 触摸目标 ≥44px，移动端优先
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import {
  applyPendingOverlay,
  cacheWorkload,
  createSyncer,
  dropChapter,
  enqueue,
  enqueueChapter,
  pendingTotal,
  readCachedWorkload,
  type BatchResp,
  type ChapterResp,
  type RejectedItem,
} from '../sync';
import {
  LEVEL_COLOR,
  STATUS_COLOR,
  STATUS_LABEL,
  type ChapterStatus,
  type MyWorkload,
  type Status,
  type WorkGroup,
  type WorkItem,
} from '../types';

const route = useRoute();
const router = useRouter();
const projectId = String(route.params.id);

const data = ref<MyWorkload | null>(null);
const loading = ref(true);
const pending = ref(0);
const online = ref(navigator.onLine);
const offlineCache = ref(false);
/** 展开的章节 code 集合 */
const expanded = ref<Set<string>>(new Set());
/** 正在提交中的章节，避免重复点击 */
const busyChapter = ref('');
const toast = ref('');
let toastTimer: number | undefined;

const syncer = createSyncer(
  async (pid, items) => api.post<BatchResp>('/assessments/batch', { projectId: pid, items }),
  async (pid, chapterCode, status) => api.post<ChapterResp>('/assessments/chapter', { projectId: pid, chapterCode, status }),
  (rejected) => onRejected(rejected),
);

function showToast(msg: string) {
  toast.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = ''), 4000);
}

function onRejected(list: RejectedItem[]) {
  const reasons = [...new Set(list.map((r) => r.reason))].join('；');
  showToast(`${list.length} 条未保存：${reasons}`);
}

/** 弱网重载：服务端数据 + 本地未同步队列叠加 */
async function load() {
  loading.value = true;
  try {
    const d = await api.get<MyWorkload>(`/assessments/my?projectId=${projectId}`);
    data.value = applyPendingOverlay(d);
    cacheWorkload(projectId, data.value);
    offlineCache.value = false;
  } catch (e: any) {
    // 断网时回退到本地缓存 + 本地队列，保证现场可用
    const cached = readCachedWorkload(projectId);
    if (cached) {
      data.value = applyPendingOverlay(cached);
      offlineCache.value = true;
      showToast('当前网络不可用，已加载本地暂存数据');
    } else {
      showToast(e.message || '加载失败');
    }
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  load();
  pending.value = pendingTotal();
  window.addEventListener('gmp-queue-change', onQueueChange as EventListener);
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);
  // 进入页面立即尝试补传上次离线队列
  syncer.schedule(true);
});

function onQueueChange(e: Event) {
  pending.value = (e as CustomEvent).detail ?? 0;
}
function onNet() {
  online.value = navigator.onLine;
  if (online.value) syncer.schedule(true);
}

// ===== 章节层 =====

/** 章节复选框：勾选 = 已落地（无未落地项） */
function chapterChecked(g: WorkGroup) {
  return g.notLanded === 0;
}
/** 半选：有未落地项但未整章未落地 */
function chapterIndeterminate(g: WorkGroup) {
  return g.notLanded > 0 && g.notLanded < g.total;
}

function toggleExpand(code: string) {
  const s = new Set(expanded.value);
  if (s.has(code)) s.delete(code);
  else s.add(code);
  expanded.value = s;
}

/** 章节层反选：取消勾选 = 整章置未落地（异常），需二次确认 */
async function toggleChapter(g: WorkGroup) {
  if (!data.value || busyChapter.value) return;
  const next: ChapterStatus = chapterChecked(g) ? 'not_landed' : 'landed';

  if (next === 'not_landed') {
    const ok = confirm(
      `确认取消勾选「${g.name}」？\n\n整章 ${g.total} 条将全部标记为未落地（异常），并自动生成待整改条目。\n可随时再次勾选以恢复。`,
    );
    if (!ok) return;
  }

  busyChapter.value = g.code;
  // 立即本地生效（乐观更新），保证点击零延迟
  applyChapterLocally(g, next);
  enqueueChapter({ projectId, chapterCode: g.code, status: next, ts: Date.now() });

  if (online.value) {
    try {
      await api.post<ChapterResp>('/assessments/chapter', { projectId, chapterCode: g.code, status: next });
      // 直连成功即出队，避免同步器重复补传同一条
      dropChapter(projectId, g.code);
      showToast(next === 'not_landed' ? `「${g.name}」整章已标记为未落地` : `「${g.name}」已恢复为已落地`);
      await load();
    } catch (e: any) {
      showToast(`${e.message || '保存失败'}，已暂存本地，联网后自动同步`);
    } finally {
      busyChapter.value = '';
    }
  } else {
    busyChapter.value = '';
    showToast('当前离线，操作已暂存本地，联网后自动同步');
  }
}

/** 章节状态本地写入 + 章节派生值重算 */
function applyChapterLocally(g: WorkGroup, target: ChapterStatus) {
  for (const it of g.items) {
    if (target === 'not_landed') {
      it.status = 'not_landed';
      it.abnormal = true;
    } else if (it.status === 'not_landed') {
      // 勾回章节：只清掉本章的未落地，其余状态保持
      it.status = 'landed';
      it.abnormal = false;
    }
  }
  recomputeGroup(g);
  recomputeTotals();
}

function recomputeGroup(g: WorkGroup) {
  g.total = g.items.length;
  g.notLanded = g.items.filter((i) => i.status === 'not_landed').length;
  g.partial = g.items.filter((i) => i.status === 'partial').length;
  g.status = g.notLanded === 0 && g.partial === 0 ? 'landed' : g.notLanded >= g.total ? 'not_landed' : 'partial';
}

function recomputeTotals() {
  if (!data.value) return;
  const all = data.value.groups.flatMap((g) => g.items);
  data.value.total = all.length;
  data.value.verified = all.filter((i) => i.verified).length;
  data.value.abnormal = all.filter((i) => i.abnormal).length;
}

// ===== 条款层 =====

/** 条款复选框：勾选 = 已落地。默认全勾，只需取消未落实项 */
function itemChecked(it: WorkItem) {
  return it.status !== 'not_landed';
}

/** 已取消勾选（异常）的条款在本章内置顶 */
function sortedItems(g: WorkGroup) {
  const LVL: Record<string, number> = { 关键: 0, 主要: 1, 一般: 2 };
  return [...g.items].sort((a, b) => {
    // 1) 异常优先
    const aa = a.status === 'not_landed' ? 0 : 1;
    const bb = b.status === 'not_landed' ? 0 : 1;
    if (aa !== bb) return aa - bb;
    // 2) 风险等级
    const la = LVL[a.level] ?? 9;
    const lb = LVL[b.level] ?? 9;
    if (la !== lb) return la - lb;
    // 3) 条款号自然序
    return a.code.localeCompare(b.code, 'zh', { numeric: true });
  });
}

function toggleItem(it: WorkItem) {
  if (!data.value) return;
  const next: Status = it.status === 'not_landed' ? 'landed' : 'not_landed';
  it.status = next;
  it.abnormal = next === 'not_landed';
  it.verified = true;
  const g = data.value.groups.find((x) => x.items.includes(it));
  if (g) recomputeGroup(g);
  recomputeTotals();
  enqueue({ projectId, gmpClauseId: it.id, status: next, ts: Date.now() });
  syncer.schedule();
}

/** 部分落地 / 不适用：与反选模型并存的两态标注 */
function markItem(it: WorkItem, status: 'partial' | 'na') {
  if (!data.value) return;
  it.status = it.status === status ? 'landed' : status;
  it.abnormal = false;
  it.verified = true;
  const g = data.value.groups.find((x) => x.items.includes(it));
  if (g) recomputeGroup(g);
  recomputeTotals();
  enqueue({ projectId, gmpClauseId: it.id, status: it.status, ts: Date.now() });
  syncer.schedule();
}

/** 展开的 note（对应说明）集合 */
const openNotes = ref<Set<string>>(new Set());
function toggleNote(id: string) {
  const s = new Set(openNotes.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  openNotes.value = s;
}

// ===== 进度 =====
const progress = computed(() => {
  const t = data.value?.total || 0;
  return t ? Math.round(((data.value?.verified || 0) / t) * 100) : 0;
});

const levelBadge = (lv: string) =>
  lv === '关键' ? 'bg-red-50 text-red-700' : lv === '主要' ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-500';
</script>

<template>
  <div class="min-h-screen bg-brand-bg pb-16">
    <!-- 顶部：项目 + 已核实/总数 · 异常 + 同步状态 -->
    <header class="sticky top-0 z-20 bg-brand px-4 pb-3 pt-3 text-white">
      <div class="mx-auto max-w-[1280px]">
        <div class="flex items-center justify-between">
          <button class="btn-onbrand" @click="router.push('/auditor')">‹ 项目</button>
          <div class="flex items-center gap-2 text-[13px] opacity-80">
            <span :class="online ? 'text-emerald-300' : 'text-amber-300'">{{ online ? '● 在线' : '● 离线' }}</span>
            <span v-if="pending" class="text-amber-300">{{ pending }} 待传</span>
          </div>
        </div>

        <template v-if="data">
          <div class="mt-2 truncate text-sm font-semibold">{{ data.project?.name }}</div>
          <div class="mt-0.5 text-[13px] opacity-70">{{ (data.project?.auditDate || '').slice(0, 10) }}</div>

          <!-- 进度：已核实 X / 共 Y · 异常 Z -->
          <div class="mt-2.5 flex items-end justify-between">
            <div class="flex items-baseline gap-1">
              <span class="text-2xl font-bold leading-none">{{ data.verified }}</span>
              <span class="text-sm opacity-70">/ {{ data.total }} 已核实</span>
            </div>
            <div class="flex items-baseline gap-1 text-xs">
              <span class="opacity-70">异常</span>
              <span class="font-bold" :style="{ color: data.abnormal ? '#F9A825' : '#fff' }">{{ data.abnormal }}</span>
            </div>
          </div>
          <div class="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/20">
            <div class="h-full rounded-full bg-white/80 transition-all" :style="{ width: `${progress}%` }"></div>
          </div>
        </template>
      </div>
    </header>

    <main class="mx-auto max-w-[1280px] px-3 pt-3">
      <div v-if="loading" class="py-20 text-center text-sm text-gray-400">加载中…</div>

      <div v-else-if="!data || !data.groups.length" class="py-20 text-center">
        <p class="text-sm text-gray-500">暂无可审核条款</p>
        <p class="mt-1 text-xs text-gray-400">请等待组长上传审核计划并分派到您的审核组</p>
      </div>

      <template v-else>
        <!-- 操作说明 -->
        <p class="mb-3 px-1 text-[13px] leading-relaxed text-gray-500">
          默认<b class="text-gray-700">全部勾选＝已落地</b>。只需<b class="text-gray-700">取消勾选</b>未落实的条款；取消章节勾选将整章标记为未落地。
        </p>

        <p v-if="offlineCache" class="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-700">
          离线模式：展示本地暂存数据，恢复网络后自动同步。
        </p>

        <!-- ========== 章节层（第一层） ========== -->
        <section v-for="g in data.groups" :key="g.code" class="mb-2 border-b border-gray-200 bg-white">
          <!-- 章节行：44px+ 大复选框 -->
          <div class="flex items-stretch">
            <button
              class="flex min-h-[56px] w-14 shrink-0 items-center justify-center border-r border-gray-100 active:bg-gray-50"
              :disabled="busyChapter === g.code"
              :aria-label="chapterChecked(g) ? '取消整章勾选' : '勾回整章'"
              @click="toggleChapter(g)"
            >
              <input
                type="checkbox"
                class="h-6 w-6 cursor-pointer appearance-none rounded border-2 border-gray-300 bg-white transition-colors checked:border-brand checked:bg-brand indeterminate:border-brand indeterminate:bg-white"
                :checked="chapterChecked(g)"
                :indeterminate="chapterIndeterminate(g)"
                readonly
                tabindex="-1"
              />
            </button>

            <button class="flex min-h-[56px] flex-1 items-center gap-2 px-3 text-left active:bg-gray-50" @click="toggleExpand(g.code)">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="truncate text-[13px] font-semibold text-gray-800">{{ g.name }}</span>
                  <span v-if="g.focus" class="shrink-0 rounded bg-brand/10 px-1 py-0.5 text-[13px] text-brand">重点</span>
                </div>
                <div class="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-gray-500">
                  <span>{{ g.total }} 条</span>
                  <span v-if="g.notLanded" class="font-medium" :style="{ color: STATUS_COLOR.not_landed }">
                    未落地 {{ g.notLanded }}
                  </span>
                  <span v-if="g.partial" class="font-medium" :style="{ color: STATUS_COLOR.partial }">部分落地 {{ g.partial }}</span>
                  <span v-if="!g.notLanded && !g.partial" class="text-emerald-700">全部已落地</span>
                </div>
              </div>
              <span class="shrink-0 text-xs text-gray-400">{{ expanded.has(g.code) ? '收起' : '展开' }}</span>
            </button>
          </div>

          <!-- ========== 条款层（第二层，默认折叠） ========== -->
          <ul v-if="expanded.has(g.code)" class="border-t border-gray-100 bg-brand-bg/60">
            <li
              v-for="it in sortedItems(g)"
              :key="it.id"
              class="flex items-start gap-2.5 border-b border-gray-100 bg-white px-3 py-3 last:border-b-0"
              :class="it.status === 'not_landed' ? 'bg-red-50/50' : ''"
            >
              <!-- 条款复选框：44px 触摸区 -->
              <button
                class="-ml-1 flex h-11 w-9 shrink-0 items-center justify-center"
                :aria-label="itemChecked(it) ? '标记为未落实' : '恢复为已落地'"
                @click="toggleItem(it)"
              >
                <input
                  type="checkbox"
                  class="h-6 w-6 cursor-pointer appearance-none rounded border-2 border-gray-300 bg-white transition-colors checked:border-brand checked:bg-brand"
                  :checked="itemChecked(it)"
                  readonly
                  tabindex="-1"
                />
              </button>

              <div class="min-w-0 flex-1">
                <!-- 条款号 + 风险等级 + 《规范》条款号 -->
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="font-mono text-[13px] text-gray-500">{{ it.code }}</span>
                  <span class="rounded px-1.5 py-0.5 text-[13px]" :class="levelBadge(it.level)">{{ it.level }}</span>
                  <span v-if="it.specClause" class="rounded bg-gray-100 px-1.5 py-0.5 text-[13px] text-gray-500">
                    《规范》{{ it.specClause }}
                  </span>
                  <span
                    v-if="it.status === 'not_landed'"
                    class="rounded px-1.5 py-0.5 text-[13px] text-white"
                    :style="{ background: STATUS_COLOR.not_landed }"
                  >
                    未落地
                  </span>
                  <span
                    v-else-if="!it.verified"
                    class="rounded bg-gray-100 px-1.5 py-0.5 text-[13px] text-gray-400"
                    title="默认已落地，尚未显式确认"
                  >
                    待核实
                  </span>
                </div>

                <!-- 条款原文 -->
                <p class="mt-1 text-[13px] leading-relaxed" :class="it.status === 'not_landed' ? 'text-gray-500' : 'text-gray-800'">
                  {{ it.text }}
                </p>

                <!-- 对应 ISO 条款 + 对应方式 + note -->
                <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-gray-400">
                  <span v-if="it.isoList.length">ISO {{ it.isoList.join(' / ') }}</span>
                  <span v-if="it.way">{{ it.way }}</span>
                  <button v-if="it.note" class="text-brand" @click="toggleNote(it.id)">
                    {{ openNotes.has(it.id) ? '收起说明' : '对应说明' }}
                  </button>
                </div>
                <p v-if="it.note && openNotes.has(it.id)" class="mt-1 rounded bg-gray-50 px-2 py-1.5 text-[13px] leading-relaxed text-gray-600">
                  {{ it.note }}
                </p>

                <!-- 部分落地 / 不适用（细粒度标注，同样点击即存） -->
                <div class="mt-2 flex gap-1.5">
                  <button
                    class="min-h-[32px] rounded border px-2.5 text-[13px] transition"
                    :style="
                      it.status === 'partial'
                        ? { background: STATUS_COLOR.partial, borderColor: STATUS_COLOR.partial, color: '#fff' }
                        : { borderColor: '#E5E7EB', color: '#6B7280' }
                    "
                    @click="markItem(it, 'partial')"
                  >
                    部分落地
                  </button>
                  <button
                    class="min-h-[32px] rounded border px-2.5 text-[13px] transition"
                    :style="
                      it.status === 'na'
                        ? { background: STATUS_COLOR.na, borderColor: STATUS_COLOR.na, color: '#fff' }
                        : { borderColor: '#E5E7EB', color: '#6B7280' }
                    "
                    @click="markItem(it, 'na')"
                  >
                    不适用
                  </button>
                </div>
              </div>
            </li>
          </ul>
        </section>

        <!-- 完成提示 -->
        <div v-if="data.abnormal === 0 && data.groups.length" class="mt-6 border border-gray-200 bg-white p-4 text-center">
          <div class="text-sm font-semibold text-gray-800">全部条款均已落地</div>
          <p class="mt-1 text-xs text-gray-500">如现场发现未落实项，取消对应勾选即可。</p>
          <button class="mt-3 btn-ghost" @click="router.push('/auditor')">
            返回项目列表
          </button>
        </div>
      </template>
    </main>

    <!-- 轻提示 -->
    <div v-if="toast" class="no-print fixed inset-x-0 bottom-4 z-40 px-4">
      <div class="mx-auto max-w-sm rounded-lg bg-gray-900/92 px-3 py-2.5 text-center text-xs leading-relaxed text-white">
        {{ toast }}
      </div>
    </div>
  </div>
</template>
