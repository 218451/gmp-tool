<script setup lang="ts">
/**
 * 组长项目详情：审核组管理 + 审核计划（Excel/手动）+ 实时看板
 * ----------------------------------------------------------------
 * 看板口径（全部来自后端，与报告完全一致）：
 *   覆盖率分母 = 已分派去重条款数（planItem）
 *   覆盖率分子 = 已核实条款数（有 Assessment 记录）
 *   维度       = 审核组（审核员只是组员，工作包以组为单位下发）
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, downloadFile } from '../api';
import RedlineBanner from '../components/RedlineBanner.vue';
import EChart from '../components/EChart.vue';
import type { Board, ProjectGroup, Status } from '../types';
import { BRAND, STATUS_COLOR, STATUS_LABEL, STATUS_ORDER, pct } from '../types';

const route = useRoute();
const router = useRouter();
const id = String(route.params.id);

const board = ref<Board | null>(null);
const plans = ref<any[]>([]);
const groups = ref<ProjectGroup[]>([]);
const loading = ref(true);
const uploading = ref(false);
const adding = ref(false);
const newPlan = ref({ auditorName: '', groupName: '', isoClause: '', processName: '' });
const importMsg = ref('');
const importWarn = ref(false);

type Tab = 'board' | 'groups' | 'clauses' | 'plan';
const tab = ref<Tab>('board');

/** 三个层级的固定顺序与视觉标识（与审核员端 ChapterView 保持一致） */
const LEVEL_ORDER = ['关键', '主要', '一般'] as const;
const LEVEL_META: Record<string, { cls: string; dot: string; desc: string }> = {
  关键: { cls: 'lv-key', dot: 'bg-red-500', desc: '否决项 · 未落地即触发红线预警' },
  主要: { cls: 'lv-main', dot: 'bg-amber-500', desc: '重要项 · 影响体系有效性' },
  一般: { cls: 'lv-gen', dot: 'bg-gray-400', desc: '一般项 · 基础合规要求' },
};

async function load() {
  loading.value = true;
  try {
    const [b, p, g, tree] = await Promise.all([
      api.get<Board>(`/projects/${id}/board`),
      api.get<any[]>(`/projects/${id}/plans`),
      api.get<ProjectGroup[]>(`/projects/${id}/groups`),
      // ★ 第 5 项：全量条款树（指导原则 200 条全表，按关键/主要/一般三级）
      // 用 /clause-tree 而不是 /rows：/rows 只含本次计划覆盖的条款，
      // 组长看不到全表就无法判断「这次计划漏审了哪一章」。
      api.get<ClauseTree>(`/projects/${id}/clause-tree`),
    ]);
    board.value = b;
    plans.value = p;
    groups.value = g;
    clauseTree.value = tree;
  } catch (e: any) {
    alert(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

// ===== 条款分级（第 5 项）=====

/** GET /projects/:id/clause-tree 的结构（章 → 层 → 条 三级） */
interface ClauseTreeNode {
  gmpClauseId: string;
  code: string;
  text: string;
  specClause: string;
  chapterCode: string;
  chapterName: string;
  chapterSeq: number;
  chapterFocus: boolean;
  level: string;
  /** 是否被本次审核计划覆盖 */
  inPlan: boolean;
  status: Status;
  verified: boolean;
  groupNames: string[];
  processCodes: string[];
}
interface ClauseTreeLevel {
  level: string;
  total: number;
  inPlan: number;
  notLanded: number;
  clauses: ClauseTreeNode[];
}
interface ClauseTreeChapter {
  code: string;
  name: string;
  seq: number;
  focus: boolean;
  total: number;
  inPlan: number;
  notLanded: number;
  levels: ClauseTreeLevel[];
}
interface ClauseTree {
  totals: {
    all: number; inPlan: number; key: number; main: number; gen: number;
    keyInPlan: number; notLanded: number;
  };
  chapters: ClauseTreeChapter[];
}

/** 全量条款树（拉一次，前端分级展示用） */
const clauseTree = ref<ClauseTree>({
  totals: { all: 0, inPlan: 0, key: 0, main: 0, gen: 0, keyInPlan: 0, notLanded: 0 },
  chapters: [],
});

/** 只看本次计划覆盖的条款（默认开：组长第一眼要看的是本次审了什么） */
const onlyInPlan = ref(true);
/** 只看未落地（现场刚需） */
const onlyNotLanded = ref(false);
/** 点层级总览卡只看该层 */
const levelFilter = ref<string>('');

/** 三个层级的总量 / 计划内 / 未落地 —— 直接由后端 totals汇总，避免前端重算口径 */
const levelTotals = computed(() => {
  const t = clauseTree.value.totals;
  return {
    关键: { total: t.key, inPlan: t.keyInPlan, notLanded: 0 },
    主要: { total: t.main, inPlan: 0, notLanded: 0 },
    一般: { total: t.gen, inPlan: 0, notLanded: 0 },
  } as Record<string, { total: number; inPlan: number; notLanded: number }>;
});

/** 计划内/未落地数按层累加（后端只给了总计，逐层需要自己加） */
const levelAgg = computed(() => {
  const out: Record<string, { inPlan: number; notLanded: number }> = {
    关键: { inPlan: 0, notLanded: 0 },
    主要: { inPlan: 0, notLanded: 0 },
    一般: { inPlan: 0, notLanded: 0 },
  };
  for (const ch of clauseTree.value.chapters) {
    for (const lv of ch.levels) {
      const b = out[lv.level];
      if (!b) continue;
      b.inPlan += lv.inPlan;
      b.notLanded += lv.notLanded;
    }
  }
  return out;
});

/** 章 → 层 → 条款 的三级结构（重点章排前，其余按指导原则原顺序） */
const clauseChapters = computed(() => {
  return clauseTree.value.chapters
    .map((c) => {
      const levels = c.levels
        .filter((l) => (levelFilter.value ? l.level === levelFilter.value : true))
        .map((l) => ({
          ...l,
          clauses: l.clauses.filter((n) => {
            if (onlyInPlan.value && !n.inPlan) return false;
            if (onlyNotLanded.value && n.status !== 'not_landed') return false;
            return true;
          }),
        }))
        .filter((l) => l.clauses.length > 0);
      return { ...c, levels, shown: levels.reduce((s, l) => s + l.clauses.length, 0) };
    })
    .filter((c) => c.shown > 0);
});

/** 下钻展开的章（可多开；单开在 200 条规模下翻阅太慢） */
const openChapters = ref<string[]>([]);
function toggleClauseChapter(code: string) {
  const i = openChapters.value.indexOf(code);
  if (i >= 0) openChapters.value.splice(i, 1);
  else openChapters.value.push(code);
}
function isChapterOpen(code: string) {
  return openChapters.value.includes(code);
}
/** 全部展开 / 全部收起 */
function toggleExpandAll() {
  openChapters.value = openChapters.value.length === clauseChapters.value.length ? [] : clauseChapters.value.map((c) => c.code);
}
const allExpanded = computed(
  () => clauseChapters.value.length > 0 && openChapters.value.length === clauseChapters.value.length,
);

async function refresh() {
  loading.value = true;
  await load();
}

// ---- Excel 导入（可选「审核组」列） ----
async function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  uploading.value = true;
  importMsg.value = '';
  try {
    const r = await api.upload<any>(`/projects/${id}/plans/excel`, fd);
    const parts = [`导入 ${r.imported} 行，自动分派 ${r.dispatchTotal} 个检查项`];
    if (r.groupsCreated?.length) parts.push(`新建审核组：${r.groupsCreated.join('、')}`);
    if (r.errors?.length) parts.push(`${r.errors.length} 行被跳过`);
    if (r.unmatchedClauses?.length) parts.push(`以下条款在映射表中无对应检查项，请到管理员页补充：${r.unmatchedClauses.join('、')}`);
    if (r.dedupedClauses?.length) parts.push(`${r.dedupedClauses.length} 个条款的检查项已被同组其他条款覆盖（正常）`);
    importMsg.value = parts.join('；');
    importWarn.value = (r.unmatchedClauses?.length || 0) > 0;
    if (r.warning) alert(r.warning);
    await refresh();
  } catch (e: any) {
    alert(e.message);
  } finally {
    uploading.value = false;
    input.value = '';
  }
}

// ---- 手动加行 ----
async function addPlan() {
  try {
    const r = await api.post<any>(`/projects/${id}/plans`, newPlan.value);
    if (!r.auditorMatched) alert('未找到同名审核员，计划已保存但未分派。请让管理员创建同名账号后重新导入。');
    newPlan.value = { auditorName: '', groupName: '', isoClause: '', processName: '' };
    adding.value = false;
    await refresh();
  } catch (e: any) {
    alert(e.message);
  }
}

async function delPlan(p: any) {
  if (
    !confirm(
      `删除该计划行？\n审核组：${p.groupName}\n审核员：${p.auditorName}\n条款：${p.isoClause} ${p.processName}\n已分派 ${p.itemCount} 个检查项，相关勾选将一并清除。`,
    )
  )
    return;
  await api.del(`/projects/${id}/plans/${p.id}`);
  await refresh();
}

// ---- 图表 ----
/** 四状态占比（配色与后端固定一致，na 为灰色） */
const statusPie = computed(() => {
  if (!board.value) return {};
  const c = board.value.totals;
  return {
    tooltip: { trigger: 'item' },
    legend: { bottom: 0, itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 11 } },
    series: [
      {
        type: 'pie',
        radius: ['48%', '70%'],
        center: ['50%', '42%'],
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: { formatter: '{b}\n{c}', fontSize: 11 },
        data: STATUS_ORDER.map((s: Status) => ({ name: STATUS_LABEL[s], value: c[s], itemStyle: { color: STATUS_COLOR[s] } })),
      },
    ],
  };
});

/** 各审核组核实进度 */
const groupBar = computed(() => {
  const rows = board.value?.groups || [];
  return {
    grid: { left: 90, right: 46, top: 20, bottom: 30 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%', fontSize: 10 } },
    yAxis: { type: 'category', inverse: true, data: rows.map((g) => g.name), axisLabel: { fontSize: 11 } },
    series: [
      {
        name: '已核实率',
        type: 'bar',
        barWidth: 13,
        data: rows.map((g) => g.progress * 100),
        itemStyle: { color: BRAND, borderRadius: [0, 3, 3, 0] },
        label: { show: true, position: 'right', formatter: (p: any) => `${p.value}%`, fontSize: 10 },
      },
    ],
  };
});

/** 组内未落地数 */
const groupAbnormalBar = computed(() => {
  const rows = board.value?.groups || [];
  return {
    grid: { left: 90, right: 30, top: 20, bottom: 30 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'value', axisLabel: { fontSize: 10 }, minInterval: 1 },
    yAxis: { type: 'category', inverse: true, data: rows.map((g) => g.name), axisLabel: { fontSize: 11 } },
    series: [
      {
        name: '未落地',
        type: 'bar',
        barWidth: 13,
        data: rows.map((g) => g.notLanded),
        itemStyle: { color: STATUS_COLOR.not_landed, borderRadius: [0, 3, 3, 0] },
        label: { show: true, position: 'right', fontSize: 10 },
      },
    ],
  };
});

/** 展开某个审核组查看章节分层 */
const openGroup = ref<string>('');
function toggleGroup(gid: string) {
  openGroup.value = openGroup.value === gid ? '' : gid;
}

const abnormalTop = computed(() => (board.value?.abnormalList || []).slice(0, 10));
</script>

<template>
  <div class="min-h-screen bg-brand-bg">
    <!-- ★ 页头：返回按钮与「生成报告」按钮均 48px 高，项目名加大 -->
    <header class="bg-brand px-8 py-6 text-white">
      <div class="page !py-0">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <button class="btn-onbrand -ml-4" @click="router.push('/leader')">‹ 返回项目列表</button>
          <div class="flex items-center gap-3">
            <button class="btn-onbrand" @click="router.push(`/auditor/project/${id}`)">以审核员视角查看</button>
            <!-- ★ 主操作：生成 / 查看报告 -->
            <button
              class="inline-flex min-h-[48px] items-center justify-center rounded-xl bg-white px-6 text-base font-semibold text-brand transition hover:bg-brand-bg active:scale-[0.985]"
              @click="router.push(`/leader/project/${id}/report`)"
            >
              生成 / 查看报告
            </button>
          </div>
        </div>
        <h1 class="mt-5 text-[26px] font-bold leading-tight">{{ board?.project?.name || '加载中' }}</h1>
        <div class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm opacity-75">
          <span>审核日期 {{ (board?.project?.auditDate || '').slice(0, 10) }}</span>
          <span v-if="board?.project?.clientName">{{ board.project.clientName }}</span>
          <span v-if="board?.project?.remark">{{ board.project.remark }}</span>
        </div>
      </div>
    </header>

    <div class="page">
      <!-- Tab：48px 高 -->
      <div class="mb-6 flex gap-3">
        <button
          v-for="t in [
            { k: 'board', l: '实时看板' },
            { k: 'groups', l: '审核组' },
            { k: 'clauses', l: '条款分级' },
            { k: 'plan', l: '审核计划' },
          ]"
          :key="t.k"
          class="btn-ghost !px-7"
          :class="tab === t.k ? '!border-brand !bg-brand !text-white' : ''"
          @click="tab = t.k as Tab"
        >
          {{ t.l }}
        </button>
      </div>

      <div v-if="loading" class="py-24 text-center text-base text-gray-400">加载中…</div>

      <!-- ========== 实时看板 ========== -->
      <div v-else-if="tab === 'board' && board" class="space-y-6">
        <RedlineBanner :redline="board.redline" />

        <!-- 条款覆盖率 -->
        <div class="panel">
          <div class="flex items-baseline justify-between">
            <span class="text-base text-gray-600">条款核实进度（已核实 / 已分派）</span>
            <span class="text-3xl font-bold text-brand">
              {{ board.coverage.verified }}<span class="text-base font-normal text-gray-400">/{{ board.coverage.assigned }}</span>
            </span>
          </div>
          <div class="mt-3 h-2.5 overflow-hidden rounded-full bg-gray-100">
            <div class="h-full rounded-full bg-brand transition-all" :style="{ width: `${board.coverage.rate * 100}%` }"></div>
          </div>
          <p class="mt-3 text-sm text-gray-500">
            映射表可覆盖但尚未分派：{{ board.coverage.unassigned }} 条 —— 计划尚未覆盖全部检查项。
          </p>
        </div>

        <!-- 四状态总览 -->
        <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <div v-for="s in STATUS_ORDER" :key="s" class="panel">
            <div class="flex items-center gap-2 text-sm text-gray-600">
              <span class="h-3 w-3 rounded-sm" :style="{ background: STATUS_COLOR[s] }"></span>{{ STATUS_LABEL[s] }}
            </div>
            <div class="mt-2 text-3xl font-bold" :style="{ color: STATUS_COLOR[s] }">{{ board.totals[s] }}</div>
          </div>
        </div>

        <!-- 顶部三个数字 -->
        <div class="panel grid grid-cols-3 gap-4 text-center">
          <div>
            <div class="text-sm text-gray-500">检查项总数</div>
            <div class="mt-1 text-3xl font-bold text-gray-800">{{ board.totals.total }}</div>
          </div>
          <div class="border-x border-gray-100">
            <div class="text-sm text-gray-500">已核实</div>
            <div class="mt-1 text-3xl font-bold" :style="{ color: STATUS_COLOR.landed }">{{ board.totals.verified }}</div>
          </div>
          <div>
            <div class="text-sm text-gray-500">异常</div>
            <div class="mt-1 text-3xl font-bold" :style="{ color: STATUS_COLOR.not_landed }">{{ board.totals.abnormal }}</div>
          </div>
        </div>

        <div class="grid gap-6 lg:grid-cols-2">
          <div class="panel">
            <h3 class="mb-3 text-base font-semibold text-gray-800">四状态占比</h3>
            <EChart :option="statusPie" height="320px" />
          </div>
          <div class="panel">
            <h3 class="mb-3 text-base font-semibold text-gray-800">各审核组核实进度</h3>
            <EChart :option="groupBar" height="320px" />
          </div>
        </div>

        <!-- 审核组进度表 -->
        <div class="panel">
          <h3 class="mb-4 text-base font-semibold text-gray-800">审核组进度与条款覆盖</h3>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[720px] text-sm">
              <thead class="border-b-2 border-gray-200 text-gray-500">
                <tr>
                  <th class="px-4 py-3 text-left">审核组</th>
                  <th class="px-3 py-3 text-left">组员</th>
                  <th class="px-3 py-3 text-right">已分派</th>
                  <th class="px-3 py-3 text-right">已核实</th>
                  <th class="px-3 py-3 text-right">未落地</th>
                  <th class="px-4 py-3 text-right">核实率</th>
                </tr>
              </thead>
              <tbody class="text-gray-700">
                <tr v-if="!board.groups.length">
                  <td colspan="6" class="px-4 py-10 text-center text-gray-400">尚无审核组，请上传审核计划</td>
                </tr>
                <tr v-for="g in board.groups" :key="g.groupId" class="border-b border-gray-100">
                  <td class="px-4 py-3">
                    <span class="font-semibold">{{ g.name }}</span>
                    <div v-if="g.leaderName" class="text-xs text-gray-400">组长 {{ g.leaderName }}</div>
                  </td>
                  <td class="px-3 py-3 text-sm text-gray-600">{{ g.members.map((m) => m.name).join('、') || '—' }}</td>
                  <td class="px-3 py-3 text-right">{{ g.total }}</td>
                  <td class="px-3 py-3 text-right">{{ g.verified }}</td>
                  <td class="px-3 py-3 text-right font-semibold" :style="{ color: g.notLanded ? STATUS_COLOR.not_landed : '#ccc' }">
                    {{ g.notLanded }}
                  </td>
                  <td class="px-4 py-3 text-right">{{ pct(g.progress) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="panel">
          <h3 class="mb-3 text-base font-semibold text-gray-800">各审核组未落地条款数</h3>
          <EChart :option="groupAbnormalBar" height="280px" />
        </div>

        <!-- 异常速览 -->
        <div v-if="abnormalTop.length" class="panel">
          <div class="mb-4 flex items-center justify-between">
            <h3 class="text-base font-semibold text-gray-800">待处理异常（Top 10）</h3>
            <button class="btn-ghost !min-h-[44px] !px-5 !text-sm" @click="router.push(`/leader/project/${id}/report`)">完整清单 ›</button>
          </div>
          <ul class="space-y-2">
            <li v-for="x in abnormalTop" :key="x.code" class="flex items-start gap-3 border-b border-gray-100 pb-2.5 last:border-0">
              <span class="shrink-0 rounded px-2 py-0.5 text-xs font-semibold text-white" :style="{ background: STATUS_COLOR.not_landed }">
                {{ x.priority }}
              </span>
              <span class="shrink-0 font-mono text-sm text-gray-500">{{ x.code }}</span>
              <span class="shrink-0 text-sm text-gray-400">{{ x.chapterName }}</span>
              <span class="min-w-0 flex-1 text-sm">{{ x.text }}</span>
            </li>
          </ul>
        </div>

        <div class="flex flex-wrap gap-3">
          <button class="btn-ghost" @click="refresh">刷新看板</button>
          <button class="btn-ghost" @click="downloadFile(`/assessments/export?projectId=${id}`, `勾选结果-${id}.csv`)">
            导出勾选结果 CSV
          </button>
          <button class="btn-ghost" @click="downloadFile(`/projects/${id}/export`, `项目数据-${id}.json`)">导出项目数据</button>
        </div>
      </div>

      <!-- ========== 审核组 ========== -->
      <div v-else-if="tab === 'groups'" class="space-y-4">
        <p class="alert-warn">
          审核组是分配与可见范围的最小单位，组内成员共享同一条款集合。审核组在上传审核计划时按组内代号自动创建，成员姓名取自计划里的「审核组成员」表。
        </p>

        <div v-if="!groups.length" class="panel py-16 text-center text-base text-gray-400">
          尚无审核组，请先上传审核计划
        </div>

        <section v-for="g in groups" :key="g.id" class="overflow-hidden rounded-2xl border border-gray-200 bg-white">
          <button class="flex min-h-[88px] w-full items-center justify-between gap-4 px-6 text-left transition hover:bg-gray-50" @click="toggleGroup(g.id)">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-3">
                <span class="text-lg font-semibold text-gray-900">{{ g.name }}</span>
                <span class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{{ g.total }} 条</span>
                <span v-if="g.leaderName" class="rounded bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">组长 {{ g.leaderName }}</span>
              </div>
              <!-- ★ 成员姓名逐个成胶囊，D 组姓名缺失这类问题一眼可见 -->
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <span class="text-sm text-gray-500">组员</span>
                <template v-if="g.members.length">
                  <span
                    v-for="m in g.members"
                    :key="m.id"
                    class="rounded-full px-3 py-1 text-sm font-medium"
                    :class="m.role === 'leader' ? 'bg-brand text-white' : 'bg-gray-100 text-gray-700'"
                  >
                    {{ m.name }}
                  </span>
                </template>
                <span v-else class="rounded bg-red-50 px-3 py-1 text-sm text-red-600">未识别到组员</span>
              </div>
              <div class="mt-3 flex items-center gap-3">
                <div class="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                  <div class="h-full rounded-full bg-brand" :style="{ width: `${g.total ? (g.verified / g.total) * 100 : 0}%` }"></div>
                </div>
                <span class="shrink-0 text-sm text-gray-500">
                  已核实 {{ g.verified }}/{{ g.total }}
                  <span v-if="g.abnormal" class="ml-2 font-semibold" :style="{ color: STATUS_COLOR.not_landed }">异常 {{ g.abnormal }}</span>
                </span>
              </div>
            </div>
            <span class="btn-ghost !min-h-[48px] shrink-0 !px-6">{{ openGroup === g.id ? '收起' : '按章展开' }}</span>
          </button>

          <ul v-if="openGroup === g.id" class="border-t border-gray-100 bg-brand-bg/50">
            <li v-for="c in g.groups" :key="c.code" class="border-b border-gray-100 bg-white px-6 py-3 last:border-0">
              <div class="flex items-center justify-between gap-3">
                <span class="min-w-0 flex-1 truncate text-[15px] text-gray-800">
                  {{ c.name }}
                  <span v-if="c.focus" class="ml-2 rounded bg-brand/10 px-2 py-0.5 text-xs text-brand">重点</span>
                </span>
                <span class="shrink-0 text-sm text-gray-500">{{ c.total }} 条</span>
                <span
                  class="shrink-0 text-sm font-semibold"
                  :style="{ color: c.notLanded ? STATUS_COLOR.not_landed : STATUS_COLOR.landed }"
                >
                  {{ c.notLanded ? `未落地 ${c.notLanded}` : '已落地' }}
                </span>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <!-- ========== 条款分级（第 5 项：按关键/主要/一般分级，不平铺） ========== -->
      <div v-else-if="tab === 'clauses'" class="space-y-6">
        <div class="alert-warn">
          指导原则全表共 <b>{{ clauseTree.totals.all }}</b> 项，按原有风险分级展示：
          <b class="text-red-700">关键项 {{ clauseTree.totals.key }}</b>（否决项，未落地即触发红线预警）、
          <b class="text-amber-700">主要项 {{ clauseTree.totals.main }}</b>（影响体系有效性）、
          <b>一般项 {{ clauseTree.totals.gen }}</b>（基础合规要求）。
          本次审核计划实际覆盖 <b>{{ clauseTree.totals.inPlan }}</b> 项。
        </div>

        <!-- 筛选条 -->
        <div class="panel flex flex-wrap items-center gap-4">
          <label class="inline-flex min-h-[48px] cursor-pointer items-center gap-3 rounded-xl border-2 px-4 text-[15px] font-medium transition-colors"
                 :class="onlyInPlan ? 'border-brand bg-brand/5 text-brand' : 'border-gray-200 text-gray-600'">
            <input type="checkbox" v-model="onlyInPlan" class="h-6 w-6" />
            只看本次计划覆盖的条款
          </label>
          <label class="inline-flex min-h-[48px] cursor-pointer items-center gap-3 rounded-xl border-2 px-4 text-[15px] font-medium transition-colors"
                 :class="onlyNotLanded ? 'border-red-400 bg-red-50 text-red-700' : 'border-gray-200 text-gray-600'">
            <input type="checkbox" v-model="onlyNotLanded" class="h-6 w-6" />
            只看未落地
          </label>
          <button v-if="levelFilter" class="btn-ghost !min-h-[48px]" @click="levelFilter = ''">
            清除层级筛选（{{ levelFilter }}）
          </button>
          <button class="btn-ghost !min-h-[48px] ml-auto" @click="toggleExpandAll">
            {{ allExpanded ? '全部收起' : '全部展开' }}
          </button>
        </div>

        <!-- 三级总览卡（点一下只看该层） -->
        <div class="grid gap-4 md:grid-cols-3">
          <button
            v-for="lv in LEVEL_ORDER"
            :key="lv"
            class="panel min-h-[176px] text-left transition hover:shadow-md"
            :class="levelFilter === lv ? 'ring-2 ring-brand' : ''"
            @click="levelFilter = levelFilter === lv ? '' : lv"
          >
            <div class="flex items-center justify-between gap-2">
              <span :class="(LEVEL_META[lv] ?? LEVEL_META['一般']).cls">{{ lv }}项</span>
              <span class="text-[13px] text-gray-400">{{ (LEVEL_META[lv] ?? LEVEL_META['一般']).desc }}</span>
            </div>
            <div class="mt-3 flex items-end gap-2">
              <span class="text-4xl font-bold text-gray-900">{{ levelTotals[lv].total }}</span>
              <span class="pb-1 text-sm text-gray-500">项</span>
            </div>
            <div class="mt-3 h-2.5 overflow-hidden rounded-full bg-gray-100">
              <div class="h-full rounded-full bg-brand"
                   :style="{ width: `${levelTotals[lv].total ? (levelAgg[lv].inPlan / levelTotals[lv].total) * 100 : 0}%` }"></div>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-x-3 text-sm">
              <span class="text-gray-500">计划覆盖 {{ levelAgg[lv].inPlan }}</span>
              <span v-if="levelAgg[lv].notLanded" class="font-semibold" :style="{ color: STATUS_COLOR.not_landed }">
                未落地 {{ levelAgg[lv].notLanded }}
              </span>
            </div>
          </button>
        </div>

        <!-- 章 → 层 → 条款 三级下钻 -->
        <p v-if="!clauseChapters.length" class="panel py-12 text-center text-base text-gray-500">
          当前筛选条件下没有条款。可取消「只看本次计划覆盖的条款」查看指导原则全表。
        </p>

        <section
          v-for="c in clauseChapters"
          :key="c.code"
          class="overflow-hidden rounded-2xl border border-gray-200 bg-white"
        >
          <button
            class="flex min-h-[76px] w-full items-center gap-4 px-6 text-left transition hover:bg-gray-50"
            @click="toggleClauseChapter(c.code)"
          >
            <span class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-base font-bold text-brand">
              {{ c.seq }}
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-lg font-semibold text-gray-900">{{ c.name }}</span>
                <span v-if="c.focus" class="lv-key">重点章</span>
              </div>
              <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-500">
                <span>共 {{ c.total }} 项 · 本次覆盖 {{ c.inPlan }} 项</span>
                <template v-for="lv in LEVEL_ORDER" :key="lv">
                  <span v-if="c.levels.find((l) => l.level === lv)">
                    {{ lv }} {{ c.levels.find((l) => l.level === lv)!.clauses.length }}
                  </span>
                </template>
                <span v-if="c.notLanded" class="font-semibold" :style="{ color: STATUS_COLOR.not_landed }">未落地 {{ c.notLanded }}</span>
              </div>
            </div>
            <span class="btn-ghost !min-h-[48px] shrink-0 !px-6">{{ isChapterOpen(c.code) ? '收起' : '展开' }}</span>
          </button>

          <div v-if="isChapterOpen(c.code)" class="border-t border-gray-100">
            <template v-for="lv in LEVEL_ORDER" :key="lv">
              <div v-for="l in c.levels.filter((x) => x.level === lv)" :key="lv">
                <!-- 层头 -->
                <div class="flex min-h-[52px] flex-wrap items-center gap-3 border-t border-gray-100 bg-gray-50 px-6">
                  <span class="h-3 w-3 shrink-0 rounded-full" :class="(LEVEL_META[lv] ?? LEVEL_META['一般']).dot"></span>
                  <span class="text-base font-semibold text-gray-800">{{ lv }}项</span>
                  <span class="text-sm text-gray-500">{{ l.clauses.length }} 条</span>
                  <span class="text-sm text-gray-500">{{ (LEVEL_META[lv] ?? LEVEL_META['一般']).desc }}</span>
                  <span v-if="l.notLanded" class="ml-auto text-sm font-semibold" :style="{ color: STATUS_COLOR.not_landed }">
                    未落地 {{ l.notLanded }}
                  </span>
                </div>
                <ul>
                  <li
                    v-for="it in l.clauses"
                    :key="it.code"
                    class="flex items-start gap-4 border-t border-gray-100 px-6 py-4"
                    :class="it.status === 'not_landed' ? 'bg-red-50/60' : ''"
                  >
                    <span class="w-20 shrink-0 pt-0.5 font-mono text-sm font-semibold text-gray-500">{{ it.code }}</span>
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <span v-if="it.specClause" class="rounded bg-gray-100 px-2 py-0.5 text-[13px] text-gray-500">规范 {{ it.specClause }}</span>
                        <span v-for="g in it.groupNames" :key="g" class="rounded bg-brand/10 px-2 py-0.5 text-[13px] text-brand">{{ g }}</span>
                        <span
                          v-if="it.inPlan"
                          class="rounded px-2 py-0.5 text-[13px] font-medium text-white"
                          :style="{ background: STATUS_COLOR[it.status] }"
                        >
                          {{ STATUS_LABEL[it.status] }}{{ it.verified ? '' : '（待核实）' }}
                        </span>
                        <span v-else class="rounded bg-gray-100 px-2 py-0.5 text-[13px] text-gray-500">本次计划未覆盖</span>
                      </div>
                      <p class="mt-2 text-[15px] leading-relaxed text-gray-800">{{ it.text }}</p>
                    </div>
                  </li>
                </ul>
              </div>
            </template>
          </div>
        </section>
      </div>

      <!-- ========== 审核计划 ========== -->
      <div v-else class="space-y-6">
        <div class="panel">
          <h3 class="text-base font-semibold text-gray-900">上传审核计划 Excel</h3>
          <p class="mt-1.5 text-sm leading-relaxed text-gray-600">
            列：审核组(可选) | 审核员姓名 | ISO 13485 条款号 | 过程名称。填「审核组」列则同名人员归为一组；不填则按「审核组·姓名」一人一组。导入后系统按映射表自动把检查项分派到对应审核组。
          </p>
          <label class="btn-primary mt-4 cursor-pointer !min-h-[52px] !px-6 !text-base">
            {{ uploading ? '解析中…' : '选择 Excel 文件' }}
            <input type="file" accept=".xlsx,.xls" class="hidden" :disabled="uploading" @change="onFile" />
          </label>
          <p
            v-if="importMsg"
            class="mt-4 rounded-xl px-5 py-3.5 text-sm"
            :class="importWarn ? 'alert-warn' : 'alert-ok'"
          >
            {{ importMsg }}
          </p>
        </div>

        <div class="panel">
          <div class="mb-4 flex items-center justify-between">
            <h3 class="text-base font-semibold text-gray-900">计划清单（{{ plans.length }} 条）</h3>
            <button class="btn-ghost !min-h-[44px]" @click="adding = !adding">+ 手动加行</button>
          </div>

          <div v-if="adding" class="mb-4 grid gap-3 bg-brand-bg/50 p-4 md:grid-cols-5">
            <input v-model="newPlan.groupName" class="field-sm" placeholder="审核组（选填）如 A 组" />
            <input v-model="newPlan.auditorName" class="field-sm" placeholder="审核员姓名" />
            <input v-model="newPlan.isoClause" class="field-sm" placeholder="ISO 条款 如 7.5.1" />
            <input v-model="newPlan.processName" class="field-sm" placeholder="过程名称" />
            <button class="btn-primary !min-h-[48px]" @click="addPlan">添加</button>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full min-w-[760px] text-sm">
              <thead class="border-b-2 border-gray-200 text-gray-500">
                <tr>
                  <th class="px-4 py-3 text-left">审核组</th>
                  <th class="px-3 py-3 text-left">审核员</th>
                  <th class="px-3 py-3 text-left">ISO 条款</th>
                  <th class="px-3 py-3 text-left">过程名称</th>
                  <th class="px-3 py-3 text-right">已分派</th>
                  <th class="px-4 py-3 text-right">操作</th>
                </tr>
              </thead>
              <tbody class="text-gray-700">
                <tr v-if="!plans.length">
                  <td colspan="6" class="px-4 py-10 text-center text-gray-400">暂无计划，请上传 Excel 或手动加行</td>
                </tr>
                <tr v-for="p in plans" :key="p.id" class="border-b border-gray-100">
                  <td class="px-4 py-3">{{ p.groupName }}</td>
                  <td class="px-3 py-3">
                    {{ p.auditorName }}
                    <span v-if="p.assignedGroups?.length" class="ml-1 text-xs text-gray-400">
                      （{{ p.assignedGroups.join('、') }}）
                    </span>
                  </td>
                  <td class="px-3 py-3 font-mono">{{ p.isoClause }}</td>
                  <td class="px-3 py-3">{{ p.processName }}</td>
                  <td class="px-3 py-3 text-right" :class="p.itemCount === 0 ? 'text-amber-600' : ''">{{ p.itemCount }}</td>
                  <td class="px-4 py-3 text-right">
                    <button class="font-medium text-red-600" @click="delPlan(p)">删除</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="mt-3 text-sm text-gray-500">
            「已分派」为 0 时：该 ISO 条款在映射表中无对应检查项（需管理员补充映射），或这些检查项已被同组其他条款覆盖（属正常）。
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
