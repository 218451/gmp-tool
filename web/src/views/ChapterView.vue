<script setup lang="ts">
/**
 * 审核员章节工作台 —— ★ 以《新版 GMP 检查指导原则》十四章为主线
 * ----------------------------------------------------------------
 * 业务口径（负责人明确原话）：
 *   「我们最好还是按照指导原则里面那十几章的分层来给它进行区分，
 *     而不是说 P 几 P 几的这几个过程去区分」「点开这个分层，这里面的关键项
 *      有哪些？一般项有哪些？然后默认都是已经做完的，是这样一个分层」
 *
 *   一级 = 指导原则的章（14 章），标题后用括号备注对应的 P 过程
 *   二级 = 章内按风险分层：关键项 / 主要项 / 一般项 ★ 第 5 项要求
 *   三级 = 具体检查项，默认全部已落地，只反选未落地
 *
 * 尺寸口径（第 4 项要求：整体加大放宽、按钮明显加大）：
 *   页面容器 max-w-[1280px]；返回按钮 min-h-[48px]；
 *   章头 min-h-[76px]；层头 min-h-[56px]；条款反选框 40px 见方 + 48px 触摸区
 *
 * 交互红线（沿用分层反选模型）：
 *   1. 默认全选已落地，只取消勾选未落地，无提交按钮
 *   2. 核查要点是辅助，默认折叠，标注不计入报告
 *   3. localStorage 弱网暂存，online / visible / unload 三重兜底
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { createSyncer, enqueue, pendingTotal, type BatchResp, type ChapterResp } from '../sync';
import { STATUS_COLOR, type ChapterView, type ChapterLevelGroup, type Level, type Status } from '../types';

const route = useRoute();
const router = useRouter();
const projectId = String(route.params.id);

const data = ref<ChapterView | null>(null);
const loading = ref(true);
const pending = ref(0);
const online = ref(navigator.onLine);
const toast = ref('');
let toastTimer: number | undefined;

/** 展开的章节 */
const openChapters = ref<Set<string>>(new Set());
/** 展开的「层级」块，形如 `CH03:关键` */
const openLevels = ref<Set<string>>(new Set());
/** 展开了核查要点的过程块 */
const openFocus = ref<Set<string>>(new Set());
/** 只看未落地 —— 200 条体量下的现场刚需 */
const onlyNotLanded = ref(false);
/** 只看关键项：把风险最高的层级单独提出来，评审时间紧时先过这一层 */
const onlyKey = ref(false);
/** 展开了对应说明的条款 */
const openNotes = ref<Set<string>>(new Set());

/** 三个层级的固定顺序与视觉标识：关键 → 主要 → 一般 */
const LEVEL_META: Record<string, { cls: string; dot: string; desc: string }> = {
  关键: { cls: 'lv-key', dot: 'bg-red-500', desc: '否决项 · 未落地即触发红线预警' },
  主要: { cls: 'lv-main', dot: 'bg-amber-500', desc: '重要项 · 影响体系有效性' },
  一般: { cls: 'lv-gen', dot: 'bg-gray-400', desc: '一般项 · 基础合规要求' },
};
const LEVEL_ORDER: Level[] = ['关键', '主要', '一般'];

const syncer = createSyncer(
  async (pid, items) => api.post<BatchResp>('/assessments/batch', { projectId: pid, items }),
  async () => ({ saved: 0, rejected: [] }) as unknown as ChapterResp,
  undefined,
  undefined,
);

function showToast(msg: string) {
  toast.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = ''), 4000);
}

async function load() {
  loading.value = true;
  try {
    data.value = await api.get<ChapterView>(`/projects/${projectId}/chapter-view`);
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

// ===== 反选核心：默认已落地，取消勾选 = 未落地 =====

function toggleClause(c: { id: string; status: Status; verified: boolean }) {
  const next: Status = c.status === 'not_landed' ? 'landed' : 'not_landed';
  c.status = next;
  c.verified = true;
  recompute();
  enqueue({ projectId, gmpClauseId: c.id, status: next, ts: Date.now() });
  syncer.schedule();
}

/** 自上而下重算进度（就地改，避免重新拉接口造成闪烁） */
function recompute() {
  const d = data.value;
  if (!d) return;
  let verified = 0;
  let notLanded = 0;
  let partial = 0;
  for (const lv of Object.values(d.totals.byLevel)) {
    verified += lv.verified;
    notLanded += lv.notLanded;
  }
  for (const ch of d.chapters) for (const l of ch.levels) partial += l.partial;
  d.totals.verified = verified;
  d.totals.notLanded = notLanded;
  d.totals.partial = partial;
  for (const ch of d.chapters) {
    let cv = 0;
    let cn = 0;
    let cp = 0;
    for (const l of ch.levels) {
      l.verified = l.items.filter((i) => i.verified).length;
      l.notLanded = l.items.filter((i) => i.status === 'not_landed').length;
      l.partial = l.items.filter((i) => i.status === 'partial').length;
      cv += l.verified;
      cn += l.notLanded;
      cp += l.partial;
    }
    ch.verified = cv;
    ch.notLanded = cn;
    ch.partial = cp;
  }
}

// ===== 筛选与展开 =====

/**
 * 某一层在当前筛选下要展示的条款。
 * 两组筛选可叠加：只看未落地（现场刚需）+ 只看关键项（风险优先）
 */
function shownItemsByChapter(_ch: { levels: ChapterLevelGroup[] }, l: ChapterLevelGroup) {
  if (onlyKey.value && l.level !== '关键') return [];
  if (onlyNotLanded.value) return l.items.filter((i) => i.status === 'not_landed');
  return l.items;
}

function toggleChapter(code: string) {
  const s = new Set(openChapters.value);
  if (s.has(code)) s.delete(code);
  else s.add(code);
  openChapters.value = s;
}

function toggleLevel(key: string) {
  const s = new Set(openLevels.value);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  openLevels.value = s;
}

function toggleFocus(code: string) {
  const s = new Set(openFocus.value);
  if (s.has(code)) s.delete(code);
  else s.add(code);
  openFocus.value = s;
}

function toggleNote(id: string) {
  const s = new Set(openNotes.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  openNotes.value = s;
}

/** 展开全部层级 / 全部折叠 */
const allExpanded = computed(() => !!data.value && openLevels.value.size >= data.value.chapters.reduce((a, c) => a + c.levels.length, 0));
function expandAll() {
  if (!data.value) return;
  if (allExpanded.value) {
    openLevels.value = new Set();
    return;
  }
  const s = new Set<string>();
  for (const c of data.value.chapters) for (const l of c.levels) s.add(`${c.code}:${l.level}`);
  openLevels.value = s;
}

const pct = (d: number, t: number) => (t ? Math.round((d / t) * 100) : 0);

/** 章标题后的括号备注：本章条款涉及的 P 过程 */
function processNote(c: { processCodes: string[]; processNames: { code: string; name: string }[] }) {
  if (!c.processCodes.length) return '';
  return c.processCodes
    .map((p) => {
      const meta = c.processNames.find((x) => x.code === p);
      return meta?.name ? `${p} ${meta.name}` : p;
    })
    .join('、');
}

const sortProc = (a: string, b: string) => a.localeCompare(b, 'zh', { numeric: true });

// ===== 顶部汇总 =====

const totals = computed(() => {
  const t = data.value?.totals;
  return {
    chapters: t?.chapters ?? 0,
    clauses: t?.clauses ?? 0,
    verified: t?.verified ?? 0,
    notLanded: t?.notLanded ?? 0,
    partial: t?.partial ?? 0,
    key: t?.byLevel?.['关键'] ?? { total: 0, verified: 0, notLanded: 0 },
    main: t?.byLevel?.['主要'] ?? { total: 0, verified: 0, notLanded: 0 },
    general: t?.byLevel?.['一般'] ?? { total: 0, verified: 0, notLanded: 0 },
    slots: t?.slots ?? 0,
  };
});

const openChapterCount = computed(() => data.value?.chapters.filter((c) => c.verified < c.total).length ?? 0);

/** 重点章排前，其次按指导原则原顺序 */
const chapters = computed(() => {
  const list = data.value?.chapters ?? [];
  return [...list].sort((a, b) => (a.focus !== b.focus ? (a.focus ? -1 : 1) : a.seq - b.seq));
});

const fmtDate = (d: string) => (d ? d.replace(/-/g, '/') : '未排期');
</script>

<template>
  <div class="min-h-screen bg-brand-bg pb-20">
    <!-- ★ 页头：返回按钮 48px、项目名大号、层级分布横排 -->
    <header class="sticky top-0 z-20 bg-brand px-8 pb-5 pt-5 text-white">
      <div class="page !py-0">
        <div class="flex items-center justify-between gap-4">
          <button class="btn-onbrand -ml-4" @click="router.push('/auditor')">‹ 返回项目列表</button>
          <div class="flex items-center gap-3 text-sm opacity-80">
            <span :class="online ? 'text-emerald-300' : 'text-amber-300'">{{ online ? '● 在线' : '● 离线' }}</span>
            <span v-if="pending" class="text-amber-300">{{ pending }} 条待传</span>
          </div>
        </div>

        <template v-if="data && totals.clauses">
          <!-- ★ 项目名称：加大加粗，是审核员现场确认「我在哪个项目」的第一锚点 -->
          <h1 class="mt-4 text-[26px] font-bold leading-tight">{{ data.project?.name }}</h1>
          <div class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm opacity-80">
            <span>{{ data.project?.auditDate?.slice(0, 10) }}</span>
            <span>{{ totals.chapters }} 章 · {{ totals.clauses }} 项检查项 · {{ totals.slots }} 个工作包</span>
            <span v-if="data.scope.groupNames.length">我的审核组：{{ data.scope.groupNames.join('、') }}</span>
          </div>

          <!-- 主进度 -->
          <div class="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-end">
            <div>
              <div class="flex items-end justify-between">
                <div class="flex items-baseline gap-2">
                  <span class="text-[44px] font-bold leading-none">{{ totals.verified }}</span>
                  <span class="text-base opacity-75">/ {{ totals.clauses }} 项已核查</span>
                </div>
                <div class="text-right text-sm leading-relaxed">
                  <div class="text-lg font-semibold" :style="{ color: totals.notLanded ? '#fcd34d' : '#a7f3d0' }">
                    未落地 {{ totals.notLanded }} 项
                  </div>
                  <div class="opacity-75">已落地 {{ totals.clauses - totals.notLanded - totals.partial }} · 部分 {{ totals.partial }}</div>
                </div>
              </div>
              <div class="mt-2.5 h-2.5 w-full overflow-hidden rounded-full bg-white/20">
                <div class="h-full rounded-full bg-white/85 transition-all" :style="{ width: `${pct(totals.verified, totals.clauses)}%` }"></div>
              </div>
            </div>

            <!-- ★ 三层级分布：把「关键/主要/一般」的比例直接摆出来（第 5 项） -->
            <div class="grid grid-cols-3 gap-2">
              <div
                v-for="lv in LEVEL_ORDER"
                :key="lv"
                class="rounded-xl bg-white/10 px-3 py-2.5 text-center"
              >
                <div class="text-xs opacity-75">{{ lv }}项</div>
                <div class="mt-0.5 text-xl font-bold leading-none">
                  {{ (totals[{ 关键: 'key', 主要: 'main', 一般: 'general' }[lv] as 'key']).verified }}
                  <span class="text-xs font-normal opacity-70">/ {{ (totals[{ 关键: 'key', 主要: 'main', 一般: 'general' }[lv] as 'key']).total }}</span>
                </div>
              </div>
            </div>
          </div>

          <div v-if="totals.notLanded" class="mt-4 text-sm text-amber-300">
            未落地 {{ totals.notLanded }} 项将自动汇总为末次会议的待整改条目
          </div>
        </template>
      </div>
    </header>

    <main class="page">
      <div v-if="loading" class="py-24 text-center text-base text-gray-400">加载中…</div>

      <div v-else-if="!data || !data.chapters.length" class="panel py-24 text-center">
        <p class="text-lg text-gray-600">暂无分配给您的检查项</p>
        <p class="mt-2 text-sm text-gray-400">请等待组长上传 Word 版审核计划，系统会按姓名自动把您加入对应审核组</p>
      </div>

      <template v-else>
        <!-- ★ 筛选栏：按钮 48px 高 -->
        <div class="panel mb-6 flex flex-wrap items-center gap-3">
          <button
            class="btn-ghost !min-h-[48px]"
            :class="onlyNotLanded ? '!border-brand !bg-brand !text-white' : ''"
            @click="onlyNotLanded = !onlyNotLanded"
          >
            只看未落地{{ totals.notLanded ? `（${totals.notLanded}）` : '' }}
          </button>
          <button
            class="btn-ghost !min-h-[48px]"
            :class="onlyKey ? '!border-red-500 !bg-red-500 !text-white' : ''"
            @click="onlyKey = !onlyKey"
          >
            只看关键项{{ totals.key.total ? `（${totals.key.total}）` : '' }}
          </button>
          <button class="btn-ghost !min-h-[48px]" @click="expandAll">{{ allExpanded ? '全部收起' : '全部展开' }}</button>

          <span class="ml-auto text-sm text-gray-500">
            {{ openChapterCount ? `${openChapterCount} 章未走完` : '全部章节已核查完' }}
          </span>
        </div>

        <div v-if="totals.verified < totals.clauses" class="alert-warn mb-6">
          默认状态为「已落地」，只有您明确点过或填过记录的才算已核实。发现未落实项，取消勾选即可。
        </div>

        <!-- ========== 一级：指导原则章节 ========== -->
        <section v-for="c in chapters" :key="c.code" class="mb-5 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
          <!-- 章节头：min-h-[76px]，章名 18px -->
          <button class="flex min-h-[76px] w-full items-center gap-4 px-6 text-left transition hover:bg-gray-50" @click="toggleChapter(c.code)">
            <span class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-base font-bold text-brand">
              {{ c.seq }}
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-lg font-semibold text-gray-900">{{ c.name }}</span>
                <span v-if="c.focus" class="lv-key">重点章</span>
              </div>
              <!-- 括号备注：本章条款由哪几个 P 过程审 -->
              <div v-if="c.processCodes.length" class="mt-1 truncate text-sm text-gray-500">
                <span class="text-gray-400">（</span>{{ processNote(c) }}<span class="text-gray-400">）</span>
              </div>
              <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
                <span class="font-medium" :class="c.verified >= c.total ? 'text-emerald-600' : ''">已核查 {{ c.verified }}/{{ c.total }}</span>
                <span v-if="c.notLanded" class="font-semibold" :style="{ color: STATUS_COLOR.not_landed }">未落地 {{ c.notLanded }}</span>
                <template v-for="lv in LEVEL_ORDER" :key="lv">
                  <span v-if="c.levels.find((l) => l.level === lv)?.total">
                    <span class="mr-1">{{ lv }}</span>{{ c.levels.find((l) => l.level === lv)?.total }}
                  </span>
                </template>
              </div>
            </div>
            <span class="btn-ghost !min-h-[48px] shrink-0 !px-6">{{ openChapters.has(c.code) ? '收起' : '进入' }}</span>
          </button>

          <!-- ========== 二级：关键项 / 主要项 / 一般项 ========== -->
          <div v-if="openChapters.has(c.code)" class="border-t border-gray-100">
            <div class="bg-brand-bg px-6 py-2.5 text-sm leading-relaxed text-gray-600">
              指导原则本章共 {{ c.chapterTotals.all }} 条（关键 {{ c.chapterTotals.key }} / 主要 {{ c.chapterTotals.main }} / 一般 {{ c.chapterTotals.general }}）；
              本次分派给{{ data.scope.groupNames.join('、') || '本组' }} {{ c.total }} 条。
            </div>

            <template v-for="l in c.levels" :key="l.level">
              <div v-if="shownItemsByChapter(c, l).length || !(onlyNotLanded || onlyKey)">
                <!-- 层头：min-h-[56px]，层级名 16px + 分级含义说明 -->
                <button
                  class="flex min-h-[56px] w-full items-center gap-3 border-t border-gray-100 bg-gray-50 px-6 text-left transition hover:bg-gray-100"
                  @click="toggleLevel(`${c.code}:${l.level}`)"
                >
                  <span class="h-3 w-3 shrink-0 rounded-full" :class="(LEVEL_META[l.level] ?? LEVEL_META['一般']).dot"></span>
                  <span class="shrink-0 text-base font-semibold text-gray-800">{{ l.level }}项</span>
                  <span class="hidden text-xs text-gray-400 xl:inline">{{ (LEVEL_META[l.level] ?? LEVEL_META['一般']).desc }}</span>
                  <span class="text-sm text-gray-500">{{ l.total }} 条</span>
                  <span v-if="l.notLanded" class="rounded-md bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">
                    未落地 {{ l.notLanded }}
                  </span>
                  <span v-else-if="l.verified === l.total" class="rounded-md bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                    已全部落地
                  </span>
                  <span class="ml-auto shrink-0 text-sm text-gray-500">
                    已核查 {{ l.verified }}/{{ l.total }}
                    <span class="ml-1">{{ openLevels.has(`${c.code}:${l.level}`) ? '▲' : '▼' }}</span>
                  </span>
                </button>

                <!-- 三级：具体检查项 -->
                <ul v-if="openLevels.has(`${c.code}:${l.level}`)">
                  <li
                    v-for="item in shownItemsByChapter(c, l)"
                    :key="item.id"
                    class="flex items-start gap-4 border-t border-gray-100 px-6 py-4 transition hover:bg-gray-50/70"
                    :class="item.status === 'not_landed' ? 'bg-red-50/60' : ''"
                  >
                    <!-- 反选：40px 见方复选框 + 48px 触摸区 -->
                    <button
                      class="-ml-2 flex h-12 w-12 shrink-0 items-center justify-center rounded-lg transition hover:bg-gray-200/60"
                      :aria-label="item.status === 'not_landed' ? '恢复为已落地' : '标记为未落实'"
                      @click="toggleClause(item)"
                    >
                      <input
                        type="checkbox"
                        class="h-8 w-8 cursor-pointer appearance-none rounded-md border-2 border-gray-300 bg-white transition-colors checked:border-brand checked:bg-brand"
                        :checked="item.status !== 'not_landed'"
                        readonly
                        tabindex="-1"
                      />
                    </button>

                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="font-mono text-sm font-semibold text-gray-600">{{ item.code }}</span>
                        <span :class="(LEVEL_META[item.level] ?? LEVEL_META['一般']).cls">{{ item.level }}项</span>
                        <span v-if="item.specClause" class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                          规范 {{ item.specClause }}
                        </span>
                        <span
                          v-if="item.status === 'not_landed'"
                          class="rounded-md px-2 py-0.5 text-xs font-semibold text-white"
                          :style="{ background: STATUS_COLOR.not_landed }"
                        >
                          未落地
                        </span>
                        <span
                          v-else-if="!item.verified"
                          class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-400"
                          title="默认已落地，尚未显式确认"
                        >
                          待核实
                        </span>
                      </div>

                      <p class="mt-2 text-[15px] leading-relaxed" :class="item.status === 'not_landed' ? 'text-gray-500' : 'text-gray-800'">
                        {{ item.text }}
                      </p>

                      <!-- ISO 对应 + 对应说明 -->
                      <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-400">
                        <span v-if="item.isoClause.length">ISO</span>
                        <span v-for="(iso, i) in item.isoClause" :key="i" class="rounded bg-gray-100 px-2 py-0.5 text-gray-600">
                          {{ iso }} {{ item.isoNames[i] || '' }}
                        </span>
                        <span class="text-gray-400">{{ item.way }}</span>
                        <button v-if="item.note" class="font-medium text-brand" @click="toggleNote(item.id)">
                          {{ openNotes.has(item.id) ? '收起说明' : '对应说明' }}
                        </button>
                      </div>
                      <p v-if="item.note && openNotes.has(item.id)" class="mt-2 rounded-lg bg-gray-50 px-4 py-3 text-sm leading-relaxed text-gray-600">
                        {{ item.note }}
                      </p>

                      <!-- 重复提示：同一条落进多个过程/多个组 -->
                      <div
                        v-if="item.dupProcesses.length || item.dupGroupCount"
                        class="mt-2.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs leading-relaxed text-amber-800"
                      >
                        <span class="font-semibold">重复条款</span>
                        <span v-if="item.dupProcesses.length">：{{ item.dupProcesses.slice().sort(sortProc).join('、') }} 过程也审这一条</span>
                        <span v-if="item.dupGroupCount">；{{ item.dupGroups.join('、') }} 组也审这一条</span>
                        <span class="block text-amber-700/80">报告与红线统计按合并口径只算一条，不会重复计数。</span>
                      </div>
                    </div>
                  </li>
                  <li v-if="!shownItemsByChapter(c, l).length" class="border-t border-gray-100 px-6 py-6 text-center text-sm text-emerald-600">
                    该层 {{ l.total }} 项检查已全部落地
                  </li>
                </ul>
              </div>
            </template>

            <p v-if="!c.levels.length" class="px-6 py-6 text-center text-sm text-gray-400">本章未分派到您所在审核组</p>
          </div>
        </section>

        <!-- ========== 辅助：现场核查要点（默认折叠，不计入报告）========== -->
        <section v-if="data.focusBlocks.length" class="mt-8 overflow-hidden rounded-2xl border border-gray-200 bg-white">
          <div class="bg-gray-50 px-6 py-4">
            <div class="text-base font-semibold text-gray-800">现场核查要点</div>
            <div class="mt-1 text-xs text-gray-400">来自 P1~P12 过程模板 · 清单式提示，不计入报告与红线统计</div>
          </div>
          <div v-for="b in data.focusBlocks" :key="b.processCode" class="border-t border-gray-100">
            <button class="flex min-h-[56px] w-full items-center gap-3 px-6 text-left transition hover:bg-gray-50" @click="toggleFocus(b.processCode)">
              <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-sm font-bold text-brand">
                {{ b.processCode }}
              </span>
              <span class="min-w-0 flex-1 truncate text-[15px] text-gray-700">{{ b.processName }}</span>
              <span class="shrink-0 text-sm text-gray-400">
                {{ b.focusDone }}/{{ b.focusTotal }} {{ openFocus.has(b.processCode) ? '▲' : '▼' }}
              </span>
            </button>
            <div v-if="openFocus.has(b.processCode)" class="border-t border-gray-100 bg-brand-bg/50 px-6 py-4">
              <div v-if="b.processElements" class="text-sm leading-relaxed text-gray-600">{{ b.processElements }}</div>
              <div v-if="b.processScopeNote" class="mt-2 text-sm leading-relaxed text-gray-500">{{ b.processScopeNote }}</div>
              <div class="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-400">
                <span v-if="b.dates.length">排期 {{ b.dates.map(fmtDate).join('、') }}</span>
                <span v-if="b.groupNames.length">分派 {{ b.groupNames.join('、') }}</span>
                <span v-if="b.chapterCodes.length">涉及 {{ b.chapterCodes.length }} 章</span>
              </div>
              <p class="mt-2 text-xs leading-relaxed text-gray-400">
                核查要点按 P 过程模板组织，此处仅作现场清单提示。条款级判定请在上方章节内完成。
              </p>
            </div>
          </div>
        </section>

        <!-- 备用入口：按 P 过程排班视图 -->
        <div class="mt-8 flex justify-center">
          <button class="btn-ghost" @click="router.push(`/auditor/project/${projectId}/process`)">按 P 过程排班视图 ›</button>
        </div>
      </template>
    </main>

    <div v-if="toast" class="no-print fixed inset-x-0 bottom-6 z-40 px-6">
      <div class="mx-auto max-w-md rounded-xl bg-gray-900/92 px-5 py-3 text-center text-sm leading-relaxed text-white">{{ toast }}</div>
    </div>
  </div>
</template>