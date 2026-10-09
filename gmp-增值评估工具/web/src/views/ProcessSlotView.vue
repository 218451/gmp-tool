<script setup lang="ts">
/**
 * 审核员过程工作台 —— 以「200 条新版 GMP 检查项落地」为核心
 * ----------------------------------------------------------------
 * 业务口径（负责人明确）：
 *   本工具的重点是新版 GMP 指导原则 200 条检查项在企业现场是否落地。
 *   P1~P12 只是审核计划的工作包分组单位，Word 计划与记录模板的作用是
 *   揭示「同一条款会重复出现在多个过程」，供分工与去重，不是审核主体。
 *
 * 因此界面主次：
 *   第一块 = GMP 检查项（核心，直接产出报告数据）
 *   第二块 = 审核关注点（默认折叠，只作现场核查提示，不影响报告统计）
 *
 * 交互红线：
 *   1. 检查项采用「分层反选」：默认已落地，只取消勾选未落地，无提交按钮
 *   2. 关注点判定仍为点击即存，失焦自动保存
 *   3. localStorage 弱网暂存，online / visible / unload 三重兜底
 *   4. 触摸目标 ≥44px，移动端优先
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import {
  createSyncer,
  dropFocusSlot,
  enqueue,
  enqueueFocus,
  pendingTotal,
  type BatchResp,
  type ChapterResp,
  type FocusResp,
} from '../sync';
import { LEVEL_COLOR, STATUS_COLOR, STATUS_LABEL, type FocusItem, type ProcessSlot, type SlotWorkload, type Status } from '../types';

const route = useRoute();
const router = useRouter();
const projectId = String(route.params.id);

const data = ref<SlotWorkload | null>(null);
const loading = ref(true);
const pending = ref(0);
const online = ref(navigator.onLine);
const toast = ref('');
let toastTimer: number | undefined;

/** 展开的工作包 id 集合 */
const openSlots = ref<Set<string>>(new Set());
/** 展开了「核查要点」辅助块的工作包（默认折叠） */
const openFocus = ref<Set<string>>(new Set());
/** 只看未落地（审核员现场最常用的视角） */
const onlyNotLanded = ref(false);
/** 关注点记录文本框自动展开的 focusId */
const openNotes = ref<Set<string>>(new Set());
/** 正在写记录（防抖计时器） */
const noteTimers = new Map<string, number>();

/** 按筛选条件取该工作包要显示的检查项 */
const shownClauses = (slot: ProcessSlot) =>
  onlyNotLanded.value ? slot.clauses.filter((c) => c.status === 'not_landed') : slot.clauses;

const syncer = createSyncer(
  async (pid, items) => api.post<BatchResp>('/assessments/batch', { projectId: pid, items }),
  async (pid, chapterCode, status) => api.post<ChapterResp>('/assessments/chapter', { projectId: pid, chapterCode, status }),
  undefined,
  async (pid, slotId, items) => api.post<FocusResp>(`/projects/${pid}/focus-records`, { slotId, items }),
);

function showToast(msg: string) {
  toast.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = ''), 4000);
}

async function load() {
  loading.value = true;
  try {
    data.value = await api.get<SlotWorkload>(`/projects/${projectId}/process-slots`);
  } catch (e: any) {
    showToast(e.message || '加载失败');
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
  syncer.schedule(true);
});

function onQueueChange(e: Event) {
  pending.value = (e as CustomEvent).detail ?? 0;
}
function onNet() {
  online.value = navigator.onLine;
  if (online.value) syncer.schedule(true);
}

// ===== 工作包分组（按日期，同日多场并列）=====

interface SlotDay {
  date: string;
  slots: ProcessSlot[];
}

const days = computed<SlotDay[]>(() => {
  const map = new Map<string, ProcessSlot[]>();
  for (const s of data.value?.slots ?? []) {
    const arr = map.get(s.slotDate) || [];
    arr.push(s);
    map.set(s.slotDate, arr);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, slots]) => ({ date, slots }));
});

/** 按 processCode 排序（P1 < P10 < P2 用自然序） */
function sortSlots(slots: ProcessSlot[]) {
  return [...slots].sort((a, b) => a.processCode.localeCompare(b.processCode, 'zh', { numeric: true }));
}

function toggleSlot(id: string) {
  const s = new Set(openSlots.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  openSlots.value = s;
}

function toggleFocus(id: string) {
  const s = new Set(openFocus.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  openFocus.value = s;
}

/** 工作包内关注点：顶层在前，子项跟随父级 */
function focusTree(slot: ProcessSlot): { node: FocusItem; children: FocusItem[] }[] {
  const tops = slot.focuses.filter((f) => !f.parentId);
  return tops.map((node) => ({ node, children: slot.focuses.filter((f) => f.parentId === node.id) }));
}

// ===== 关注点判定 =====

function setFocus(slot: ProcessSlot, f: FocusItem, status: Status) {
  const next = f.status === status && status !== 'landed' ? 'landed' : status;
  f.status = next;
  f.verified = true;
  recompute(slot);
  enqueueFocus({ projectId, slotId: slot.id, focusId: f.id, status: next, note: f.note, evidence: f.evidence, ts: Date.now() });
  syncer.schedule();
  if (online.value) {
    // 轻量直连（单条即时反馈），失败留给队列
    void api
      .post<FocusResp>(`/projects/${projectId}/focus-records`, {
        slotId: slot.id,
        items: [{ focusId: f.id, status: next, note: f.note, evidence: f.evidence }],
      })
      .then(() => dropFocusSlot(projectId, slot.id))
      .catch(() => showToast('已暂存本地，联网后自动同步'));
  }
}

/** 记录文本：输入 600ms 后自动入队同步（不是提交按钮） */
function onNoteInput(slot: ProcessSlot, f: FocusItem) {
  const k = `${slot.id}:${f.id}`;
  const old = noteTimers.get(k);
  if (old) clearTimeout(old);
  noteTimers.set(
    k,
    window.setTimeout(() => {
      f.verified = true;
      enqueueFocus({ projectId, slotId: slot.id, focusId: f.id, status: f.status, note: f.note, evidence: f.evidence, ts: Date.now() });
      syncer.schedule();
    }, 600),
  );
}

function toggleNote(f: FocusItem) {
  const s = new Set(openNotes.value);
  if (s.has(f.id)) s.delete(f.id);
  else s.add(f.id);
  openNotes.value = s;
}

// ===== 检查项反选（沿用分层反选模型）=====

function toggleClause(slot: ProcessSlot, c: { id: string; status: Status; verified: boolean }) {
  const next: Status = c.status === 'not_landed' ? 'landed' : 'not_landed';
  c.status = next;
  c.verified = true;
  recompute(slot);
  enqueue({ projectId, gmpClauseId: c.id, status: next, ts: Date.now() });
  syncer.schedule();
}

function recompute(slot: ProcessSlot) {
  slot.progress = {
    clauses: { done: slot.clauses.filter((c) => c.verified).length, total: slot.clauses.length },
    focuses: { done: slot.focuses.filter((f) => f.fillable && f.verified).length, total: slot.focuses.filter((f) => f.fillable).length },
  };
}

// ===== 总进度（主：检查项；次：关注点）=====

const totals = computed(() => {
  const slots = data.value?.slots ?? [];
  const all = slots.flatMap((s) => s.clauses);
  const f = slots.reduce((a, s) => a + s.progress.focuses.total, 0);
  const fd = slots.reduce((a, s) => a + s.progress.focuses.done, 0);
  const nf = all.filter((x) => x.status === 'not_landed').length;
  return {
    c: all.length,
    cd: all.filter((x) => x.verified).length,
    cl: all.filter((x) => x.status === 'landed').length,
    cp: all.filter((x) => x.status === 'partial').length,
    f,
    fd,
    nf,
    slots: slots.length,
    // 本组重复核查的检查项（同一条落在多个过程/多个组）
    dup: all.filter((x) => x.dupProcessCount > 0 || x.dupGroupCount > 0).length,
  };
});

const pctOf = (d: number, t: number) => (t ? Math.round((d / t) * 100) : 0);

/** 检查项全部核查完才算这个工作包收尾 */
const unfinished = computed(() => (totals.value.c ? pctOf(totals.value.cd, totals.value.c) < 100 : false));

const levelBadge = (lv: string) =>
  lv === '关键' ? 'bg-red-50 text-red-700' : lv === '主要' ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-500';

const fmtDate = (d: string) => (d ? d.replace(/-/g, '/') : '未排期');
</script>

<template>
  <div class="min-h-screen bg-brand-bg pb-16">
    <header class="sticky top-0 z-20 bg-brand px-4 pb-3 pt-3 text-white">
      <div class="mx-auto max-w-[1280px]">
        <div class="flex items-center justify-between">
          <button class="btn-onbrand" @click="router.push('/auditor')">‹ 项目</button>
          <div class="flex items-center gap-2 text-[13px] opacity-80">
            <span :class="online ? 'text-emerald-300' : 'text-amber-300'">{{ online ? '● 在线' : '● 离线' }}</span>
            <span v-if="pending" class="text-amber-300">{{ pending }} 待传</span>
          </div>
        </div>

        <template v-if="data && totals.slots">
          <div class="mt-2 text-sm font-semibold">新版 GMP 落地核查</div>
          <div class="mt-0.5 text-[13px] opacity-70">{{ totals.slots }} 个工作包 · 本组需核查 {{ totals.c }} 项指导原则检查项</div>

          <!-- 主进度：检查项 -->
          <div class="mt-2.5">
            <div class="flex items-baseline justify-between">
              <div class="flex items-baseline gap-1">
                <span class="text-2xl font-bold leading-none">{{ totals.cd }}</span>
                <span class="text-xs opacity-70">/ {{ totals.c }} 项已核查</span>
              </div>
              <div class="text-right text-[13px] leading-tight">
                <div class="font-semibold" :style="{ color: totals.nf ? '#fcd34d' : '#a7f3d0' }">
                  未落地 {{ totals.nf }} 项
                </div>
                <div class="opacity-70">已落地 {{ totals.cl }} · 部分 {{ totals.cp }}</div>
              </div>
            </div>
            <div class="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/20">
              <div class="h-full rounded-full bg-white/80 transition-all" :style="{ width: `${pctOf(totals.cd, totals.c)}%` }"></div>
            </div>
          </div>
          <div v-if="totals.nf" class="mt-1.5 text-[13px] text-amber-300">
            未落地 {{ totals.nf }} 项将自动汇总为末次会议待整改条目
          </div>

          <!-- 次进度：关注点（仅参考，不计报告） -->
          <div class="mt-2 flex items-center gap-2 text-[13px] opacity-70">
            <span>辅助：核查要点 {{ totals.fd }}/{{ totals.f }}</span>
            <span class="h-px flex-1 bg-white/20"></span>
          </div>
        </template>
      </div>
    </header>

    <main class="mx-auto max-w-[1280px] px-3 pt-3">
      <div v-if="loading" class="py-20 text-center text-sm text-gray-400">加载中…</div>

      <div v-else-if="!data || !data.slots.length" class="py-20 text-center">
        <p class="text-sm text-gray-500">暂无过程工作包</p>
        <p class="mt-1 text-xs text-gray-400">请等待组长上传 Word 版审核计划并按 P 过程分派到您的审核组</p>
      </div>

      <template v-else>
        <div class="mb-3 flex items-center gap-2">
          <button
            class="min-h-[36px] rounded-full px-3 text-[13px] font-medium transition-colors"
            :class="onlyNotLanded ? 'bg-brand text-white' : 'border border-gray-300 bg-white text-gray-600'"
            @click="onlyNotLanded = !onlyNotLanded"
          >
            只看未落地{{ totals.nf ? `（${totals.nf}）` : '' }}
          </button>
          <span class="text-[13px] text-gray-400">
            {{ totals.dup ? `本组 ${totals.dup} 项与其他过程/组重复` : '本组无跨组重复' }}
          </span>
        </div>

        <div v-if="unfinished" class="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-700">
          核查尚未完成。默认状态为「已落地」，只有你明确点过或填过记录的才算已核实。
        </div>

        <!-- ========== 按日期分组 ========== -->
        <section v-for="d in days" :key="d.date" class="mb-4">
          <h2 class="mb-1.5 px-1 text-[13px] font-semibold tracking-wide text-gray-400">{{ fmtDate(d.date) }}</h2>

          <article v-for="s in sortSlots(d.slots)" :key="s.id" class="mb-2 border border-gray-200 bg-white">
            <!-- 工作包头 -->
            <button class="flex min-h-[60px] w-full items-center gap-2.5 px-3 text-left active:bg-gray-50" @click="toggleSlot(s.id)">
              <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-brand/10 font-mono text-[13px] font-bold text-brand">
                {{ s.processCode }}
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="text-[13px] font-semibold text-gray-800">{{ s.processMeta?.name || s.processName }}</span>
                  <span v-if="s.variant" class="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[13px] text-gray-600">{{ s.variant }}</span>
                </div>
                <div class="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-gray-500">
                  <span v-if="s.timeRange">{{ s.timeRange }}</span>
                  <span v-if="s.site">{{ s.site }}</span>
                  <span v-if="s.deptName">{{ s.deptName }}</span>
                  <span v-if="s.group" class="rounded bg-brand/10 px-1.5 py-0.5 text-[13px] text-brand">{{ s.group.name }}</span>
                </div>
                <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-gray-400">
                  <span class="font-medium" :class="s.progress.clauses.done >= s.progress.clauses.total ? 'text-emerald-600' : ''">
                    检查项 {{ s.progress.clauses.done }}/{{ s.progress.clauses.total }}
                  </span>
                  <span v-if="s.clauses.some((c) => c.status === 'not_landed')" class="font-medium" :style="{ color: STATUS_COLOR.not_landed }">
                    未落地 {{ s.clauses.filter((c) => c.status === 'not_landed').length }}
                  </span>
                  <span v-if="s.clauses.some((c) => c.dupProcessCount > 0 || c.dupGroupCount > 0)" class="text-amber-600">
                    含重复项
                  </span>
                  <span class="text-gray-300">·</span>
                  <span>核查要点 {{ s.progress.focuses.done }}/{{ s.progress.focuses.total }}</span>
                </div>
              </div>
              <span class="shrink-0 text-xs text-gray-400">{{ openSlots.has(s.id) ? '收起' : '进入' }}</span>
            </button>

            <!-- ========== 工作包详情 ========== -->
            <div v-if="openSlots.has(s.id)" class="border-t border-gray-100">
              <!-- 过程条款范围（只读，来自审核计划） -->
              <div v-if="s.isoText" class="border-b border-gray-100 bg-brand-bg/60 px-3 py-2 text-[13px] leading-relaxed text-gray-600">
                <span class="font-medium text-gray-700">计划条款范围：</span>{{ s.isoText }}
              </div>

              <!-- ===== 第一块：GMP 检查项（核心，反选）===== -->
              <div>
                <div class="flex items-center justify-between bg-gray-50 px-3 py-1.5">
                  <span class="text-[13px] font-semibold text-gray-600">新版 GMP 指导原则检查项</span>
                  <span class="text-[13px] text-gray-400">默认已落地 · 取消勾选 = 未落地</span>
                </div>

                <!-- 过程口径卡：这个过程到底审什么（来自 P1~P12 权威口径） -->
                <div v-if="s.processMeta" class="border-t border-gray-100 bg-brand-bg/60 px-3 py-2">
                  <div class="text-[13px] font-semibold text-brand">{{ s.processCode }} {{ s.processMeta.name }}</div>
                  <div class="mt-0.5 text-[13px] leading-relaxed text-gray-600">{{ s.processMeta.elements }}</div>
                  <div v-if="s.processMeta.scopeNote" class="mt-1 text-[13px] leading-relaxed text-gray-500">
                    {{ s.processMeta.scopeNote }}
                  </div>
                </div>

                <ul>
                  <li
                    v-for="c in shownClauses(s)"
                    :key="c.id"
                    class="flex items-start gap-2.5 border-t border-gray-100 px-3 py-2.5"
                    :class="c.status === 'not_landed' ? 'bg-red-50/50' : ''"
                  >
                    <button
                      class="-ml-1 flex h-11 w-9 shrink-0 items-center justify-center"
                      :aria-label="c.status === 'not_landed' ? '恢复为已落地' : '标记为未落实'"
                      @click="toggleClause(s, c)"
                    >
                      <input
                        type="checkbox"
                        class="h-6 w-6 cursor-pointer appearance-none rounded border-2 border-gray-300 bg-white transition-colors checked:border-brand checked:bg-brand"
                        :checked="c.status !== 'not_landed'"
                        readonly
                        tabindex="-1"
                      />
                    </button>
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-1.5">
                        <span class="font-mono text-[13px] text-gray-500">{{ c.code }}</span>
                        <span class="rounded px-1.5 py-0.5 text-[13px]" :class="levelBadge(c.level)">{{ c.level }}</span>
                        <span v-if="c.isoClause" class="rounded bg-gray-100 px-1.5 py-0.5 text-[13px] text-gray-500">
                          ISO {{ c.isoClause.replace(/^\d+:/, '') }}
                        </span>
                        <span
                          v-if="c.status === 'not_landed'"
                          class="rounded px-1.5 py-0.5 text-[13px] text-white"
                          :style="{ background: STATUS_COLOR.not_landed }"
                        >
                          未落地
                        </span>
                      </div>
                      <p class="mt-1 text-[12px] leading-relaxed" :class="c.status === 'not_landed' ? 'text-gray-500' : 'text-gray-700'">
                        {{ c.text }}
                      </p>
                      <!-- 重复标记：同一条款会落进多个过程/多个组，报告按合并口径只计一条 -->
                      <div
                        v-if="c.dupProcessCount || c.dupGroupCount"
                        class="mt-1.5 rounded border border-amber-200 bg-amber-50/70 px-2 py-1 text-[13px] leading-relaxed text-amber-800"
                      >
                        <span class="font-semibold">重复条款</span>
                        <span v-if="c.dupProcessCount">：{{ c.dupProcesses.join('、') }} 过程也审这一条</span>
                        <span v-if="c.dupGroupCount">；{{ c.dupGroups.join('、') }} 组也审这一条</span>
                        <span class="block text-amber-700/80">报告与红线统计按合并口径只算一条，不会重复计数。</span>
                      </div>
                    </div>
                  </li>
                </ul>
                <p v-if="!s.clauses.length" class="px-3 py-4 text-center text-[13px] text-gray-400">该过程未映射到 GMP 检查项</p>
                <p v-else-if="onlyNotLanded && !shownClauses(s).length" class="px-3 py-4 text-center text-[13px] text-emerald-600">
                  该工作包 {{ s.clauses.length }} 项检查已全部落地，无未落地项
                </p>
              </div>

              <!-- ===== 第二块：核查要点（辅助，默认折叠，不计入报告）===== -->
              <div class="border-b border-gray-100">
                <button class="flex min-h-[44px] w-full items-center justify-between bg-gray-50 px-3 text-left" @click="toggleFocus(s.id)">
                  <span class="text-[13px] font-semibold text-gray-600">
                    现场核查要点（辅助）
                    <span class="ml-1 font-normal text-gray-400">模板清单 · 不计入报告</span>
                  </span>
                  <span class="shrink-0 text-[13px] text-gray-400">
                    {{ s.progress.focuses.done }}/{{ s.progress.focuses.total }}
                    {{ openFocus.has(s.id) ? '▲' : '▼' }}
                  </span>
                </button>

                <div v-if="openFocus.has(s.id)">
                <ul>
                  <li v-for="{ node, children } in focusTree(s)" :key="node.id" :class="node.fillable ? '' : 'bg-gray-50/50'">
                    <!-- 容器节点 / 顶层关注点标题 -->
                    <div class="px-3 pb-1 pt-2.5">
                      <div class="flex items-center gap-1.5">
                        <span class="font-mono text-[13px] text-gray-400">{{ node.seq }}</span>
                        <span
                          class="text-[12px] font-semibold"
                          :class="node.fillable ? 'text-gray-800' : 'text-gray-500'"
                        >{{ node.title }}</span>
                        <span
                          v-if="node.fillable && node.verified"
                          class="rounded px-1.5 py-0.5 text-[13px] text-white"
                          :style="{ background: STATUS_COLOR[node.status] }"
                        >
                          {{ STATUS_LABEL[node.status] }}
                        </span>
                      </div>

                      <!-- 关注点详情条目 -->
                      <ul v-if="node.detail.length" class="mt-1 space-y-0.5">
                        <li v-for="(d, i) in node.detail" :key="i" class="flex gap-1.5 text-[13px] leading-relaxed text-gray-600">
                          <span class="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-gray-300"></span>
                          <span class="min-w-0">{{ d }}</span>
                        </li>
                      </ul>

                      <!-- 模板右栏「审核记录」要点清单：审核员逐条核查 -->
                      <div v-if="node.checklist.length" class="mt-1.5 rounded bg-brand-bg px-2 py-1.5">
                        <div class="text-[13px] font-medium text-brand/70">记录要点（模板右栏）</div>
                        <ul class="mt-0.5 space-y-0.5">
                          <li v-for="(d, i) in node.checklist" :key="i" class="flex gap-1.5 text-[13px] leading-relaxed text-gray-600">
                            <span class="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-brand/30"></span>
                            <span class="min-w-0">{{ d }}</span>
                          </li>
                        </ul>
                      </div>

                      <!-- 顶层可判定关注点：判定 + 记录（放在子项之前，保持阅读顺序） -->
                      <template v-if="node.fillable">
                        <div class="px-3 pb-1">
                          <FocusJudge :f="node" @judge="(st: Status) => setFocus(s, node, st)" />
                        </div>
                        <div class="px-3 pb-1">
                          <FocusNote :f="node" @input="onNoteInput(s, node)" @toggle="toggleNote(node)" />
                        </div>
                      </template>
                    </div>

                    <!-- 子关注点 -->
                    <ul v-if="children.length">
                      <li v-for="f in children" :key="f.id" class="border-t border-gray-100 px-3 py-2">
                        <div class="flex items-start gap-1.5">
                          <span class="mt-[3px] font-mono text-[13px] text-gray-400">{{ f.seq }}</span>
                          <div class="min-w-0 flex-1">
                            <div class="flex flex-wrap items-center gap-1.5">
                              <span class="text-[12px] font-medium text-gray-800">{{ f.title }}</span>
                              <span
                                v-if="f.verified"
                                class="rounded px-1.5 py-0.5 text-[13px] text-white"
                                :style="{ background: STATUS_COLOR[f.status] }"
                              >
                                {{ STATUS_LABEL[f.status] }}
                              </span>
                            </div>
                            <ul v-if="f.detail.length" class="mt-1 space-y-0.5">
                              <li v-for="(d, i) in f.detail" :key="i" class="flex gap-1.5 text-[13px] leading-relaxed text-gray-600">
                                <span class="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-gray-300"></span>
                                <span class="min-w-0">{{ d }}</span>
                              </li>
                            </ul>
                            <div v-if="f.checklist.length" class="mt-1 rounded bg-brand-bg px-2 py-1.5">
                              <div class="text-[13px] font-medium text-brand/70">记录要点（模板右栏）</div>
                              <ul class="mt-0.5 space-y-0.5">
                                <li v-for="(d, i) in f.checklist" :key="i" class="flex gap-1.5 text-[13px] leading-relaxed text-gray-600">
                                  <span class="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-brand/30"></span>
                                  <span class="min-w-0">{{ d }}</span>
                                </li>
                              </ul>
                            </div>
                            <FocusJudge v-if="f.fillable" :f="f" @judge="(st: Status) => setFocus(s, f, st)" />
                            <FocusNote v-if="f.fillable" :f="f" @input="onNoteInput(s, f)" @toggle="toggleNote(f)" />
                          </div>
                        </div>
                      </li>
                    </ul>
                  </li>
                </ul>

                <p v-if="!focusTree(s).length" class="px-3 py-4 text-center text-[13px] text-gray-400">该过程未配置核查要点</p>
                </div>
              </div>
            </div>
          </article>
        </section>
      </template>
    </main>

    <div v-if="toast" class="no-print fixed inset-x-0 bottom-4 z-40 px-4">
      <div class="mx-auto max-w-sm rounded-lg bg-gray-900/92 px-3 py-2.5 text-center text-xs leading-relaxed text-white">{{ toast }}</div>
    </div>
  </div>
</template>