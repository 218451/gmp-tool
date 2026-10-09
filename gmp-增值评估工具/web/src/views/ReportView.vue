<script setup lang="ts">
/**
 * 报告页 —— 结构固定、数据自动填充
 * 1. 生成报告（可选是否重跑 AI）
 * 2. 红线预警 + 四状态图表 + 按章节分布 + 三大重点章节专项统计
 * 3. 异常优先清单（报告核心）：按 P0 / P1 / P2 分组展示
 * 4. 待整改清单：基于 abnormalList 派生（后端当前无独立整改接口，见汇报）
 * 5. AI 建议可编辑，组长复核；导出 Word / 打印 PDF
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, downloadFile, getStoredUser } from '../api';
import RedlineBanner from '../components/RedlineBanner.vue';
import EChart from '../components/EChart.vue';
import type { Priority, Report, ReportContent } from '../types';
import {
  FOCUS_CATEGORIES,
  LEVEL_COLOR,
  PRIORITY_COLOR,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  PRIORITY_SHORT,
  STATUS_COLOR,
  STATUS_LABEL,
  STATUS_ORDER,
  pct,
} from '../types';

const route = useRoute();
const router = useRouter();
const user = getStoredUser();
const isLeader = user?.role === 'leader' || user?.role === 'admin';

// 支持两种入口：/leader/project/:id/report 与 /report/:id
const projectId = route.path.includes('/report/') ? '' : String(route.params.id);
const reportId = route.path.includes('/report/') ? String(route.params.id) : '';

const report = ref<Report | null>(null);
const content = ref<ReportContent | null>(null);
const loading = ref(true);
const generating = ref(false);
const editing = ref(false);
const draft = ref('');
const saving = ref(false);
const canEdit = computed(() => isLeader);

/**
 * 报告内分页视图。
 * 首屏是「结论与问题」—— 负责人的报告顺序要求：先看总体评价与亟待解决的问题，
 * 再看逐条明细。明细类视图（异常/待整改/重复条款）退到后面按需查阅。
 */
type View = 'conclusion' | 'overview' | 'abnormal' | 'rectify' | 'dup';
const view = ref<View>('conclusion');
/** 异常清单：当前展开的优先级分组 */
const openPriority = ref<Priority>('P0');
/** 问题清单：当前展开的问题 id */
const openProblem = ref<string>('');

/** 评价等级配色：critical 红 / poor 橙 / acceptable·good 绿 */
const gradeColor = computed(() => {
  const g = content.value?.verdict?.grade;
  return g === 'critical' ? '#C62828' : g === 'poor' ? '#E65100' : '#2E7D32';
});
const gradeBg = computed(() => {
  const g = content.value?.verdict?.grade;
  return g === 'critical' ? '#FDECEC' : g === 'poor' ? '#FFF4E5' : '#EDF7ED';
});

async function load() {
  loading.value = true;
  try {
    const r = reportId
      ? await api.get<Report>(`/reports/${reportId}`)
      : await api.get<Report>(`/reports/by-project/${projectId}`);
    apply(r);
  } catch {
    report.value = null;
    content.value = null;
  } finally {
    loading.value = false;
  }
}

function apply(r: Report) {
  report.value = r;
  content.value = r.content || null;
  draft.value = r.aiSummary || '';
  // 默认展开最严重的问题，首屏即可看到处置建议
  const first = r.content?.problems?.[0];
  openProblem.value = first && (first.priority === 'P0' || first.priority === 'P1') ? first.id : '';
}
onMounted(load);

async function generate(withAi: boolean) {
  if (!projectId) return;
  generating.value = true;
  try {
    const r = await api.post<Report>('/reports/generate', { projectId, withAi });
    apply(r);
    if (withAi) {
      alert(r.aiProvider === 'deepseek' ? '报告与 AI 建议已生成（DeepSeek）' : '报告已生成。AI Key 未配置或调用失败，已使用规则引擎生成建议。');
    }
  } catch (e: any) {
    alert(e.message);
  } finally {
    generating.value = false;
  }
}

async function saveDraft() {
  if (!report.value) return;
  saving.value = true;
  try {
    const r = await api.patch<Report>(`/reports/${report.value.id}`, { aiSummary: draft.value });
    report.value = { ...report.value, ...r };
    editing.value = false;
    alert('已保存');
  } catch (e: any) {
    alert(e.message);
  } finally {
    saving.value = false;
  }
}

async function confirmReport() {
  if (!report.value) return;
  if (!confirm('确认复核该报告？复核后审核员若再修改勾选，报告将自动回到「待复核」状态。')) return;
  const r = await api.patch<Report>(`/reports/${report.value.id}`, { confirm: true });
  report.value = { ...report.value, ...r };
}

function exportWord() {
  if (report.value) downloadFile(`/reports/${report.value.id}/export.docx`, `${content.value?.project.name || '企业'}-GMP落地增值评估报告.docx`);
}

// ===== 异常清单（报告核心） =====

/** abnormalList 后端已按 P0→P1→P2 + 风险等级 + 条款号排好序，这里只做分组 */
const grouped = computed(() => {
  const list = content.value?.abnormalList || [];
  return PRIORITY_ORDER.map((p) => ({
    priority: p,
    label: PRIORITY_LABEL[p],
    short: PRIORITY_SHORT[p],
    color: PRIORITY_COLOR[p],
    items: list.filter((x) => x.priority === p),
  }));
});

/** 跨组/跨过程重复分派：报告口径说明 + 分歧清单 */
const dupStat = computed(() => {
  const c = content.value?.crossGroup;
  return {
    dupClauseCount: c?.dupClauseCount ?? 0,
    refCount: c?.refCount ?? 0,
    conflictCount: c?.conflictCount ?? 0,
    conflictList: c?.conflictList ?? [],
  };
});
const dupRows = computed(() => content.value?.crossGroup?.dupList ?? []);

/** 待整改清单：与 abnormalList 一一对应（后端 syncRectifications 按此生成整改条目） */
const rectifyRows = computed(() =>
  (content.value?.abnormalList || []).map((x, i) => ({
    no: i + 1,
    ...x,
    status: 'open' as const,
  })),
);

const rectifyByPriority = computed(() =>
  PRIORITY_ORDER.map((p) => ({
    priority: p,
    label: PRIORITY_LABEL[p],
    color: PRIORITY_COLOR[p],
    rows: rectifyRows.value.filter((r) => r.priority === p),
  })),
);

const levelBadge = (lv: string) =>
  lv === '关键' ? 'bg-red-50 text-red-700' : lv === '主要' ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-500';

// ===== 图表配置 =====

/** 按章节堆叠柱状图：四状态固定配色（na 为灰色 #9E9E9E） */
const chapterChart = computed(() => {
  if (!content.value) return {};
  const rows = content.value.byChapter;
  return {
    grid: { left: 128, right: 24, top: 30, bottom: 24 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { top: 0, textStyle: { fontSize: 11 } },
    xAxis: { type: 'value', axisLabel: { fontSize: 10 } },
    yAxis: {
      type: 'category',
      data: rows.map((r) => r.name),
      axisLabel: { fontSize: 10, width: 118, overflow: 'truncate' },
      inverse: true,
    },
    series: STATUS_ORDER.map((s) => ({
      name: STATUS_LABEL[s],
      type: 'bar',
      stack: 'total',
      barWidth: 13,
      itemStyle: { color: STATUS_COLOR[s] },
      data: rows.map((r) => r.counts[s]),
    })),
  };
});

/** 三大重点章节专项统计（真实全名） */
const focusChart = computed(() => {
  if (!content.value) return {};
  const rows = content.value.focus.filter((f) => FOCUS_CATEGORIES.includes(f.category) || f.total > 0);
  return {
    grid: { left: 96, right: 30, top: 30, bottom: 24 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { top: 0, textStyle: { fontSize: 11 } },
    xAxis: { type: 'value', axisLabel: { fontSize: 10 } },
    yAxis: {
      type: 'category',
      inverse: true,
      data: rows.map((f) => f.category),
      axisLabel: { fontSize: 10, width: 88, overflow: 'truncate' },
    },
    series: STATUS_ORDER.map((s) => ({
      name: STATUS_LABEL[s],
      type: 'bar',
      stack: 'total',
      barWidth: 13,
      itemStyle: { color: STATUS_COLOR[s] },
      data: rows.map((f) => f.counts[s]),
    })),
  };
});
</script>

<template>
  <div class="min-h-screen bg-brand-bg">
    <!-- ★ 第 4 项：页头加高、容器放宽到 1280px，返回与重生成按钮改成大号可点区 -->
    <header class="no-print bg-brand px-8 py-6 text-white">
      <div class="page !py-0">
        <div class="flex items-center justify-between gap-4">
          <button class="btn-onbrand shrink-0" @click="router.back()">‹ 返回</button>
          <div class="min-w-0 flex-1 px-2">
            <div class="truncate text-center text-xl font-bold">{{ content?.project?.name || '增值评估报告' }}</div>
            <div class="mt-0.5 truncate text-center text-sm opacity-75">
              {{ content?.project?.auditDate || '尚未生成' }}
            </div>
          </div>
          <div v-if="projectId" class="flex shrink-0 gap-3">
            <button class="btn-onbrand" :disabled="generating" @click="generate(false)">
              {{ generating ? '生成中…' : '重新统计' }}
            </button>
            <button class="btn-onbrand" :disabled="generating" @click="generate(true)">重新生成 AI</button>
          </div>
        </div>
      </div>
    </header>

    <!-- ★ 正文容器放宽：max-w-4xl(896px) → 1280px，现场读报告不再挤成窄条 -->
    <main class="print-break mx-auto max-w-[1280px] px-8 py-6">
      <div v-if="loading" class="py-16 text-center text-base text-gray-400">加载中…</div>

      <div v-else-if="!content" class="py-20 text-center">
        <p class="text-lg font-medium text-gray-600">尚未生成报告</p>
        <p class="mx-auto mt-2 max-w-lg text-[15px] leading-relaxed text-gray-500">
          报告将汇总未落地条款、亟待解决的问题与总体评价，生成后可导出 Word 或存为 PDF。
        </p>
        <button v-if="canEdit && projectId" class="btn-primary mt-6" :disabled="generating" @click="generate(true)">
          <span v-if="generating" class="spin"></span>
          {{ generating ? '生成中…' : '生成报告' }}
        </button>
      </div>

      <template v-else>
        <!-- 报告头 -->
        <div class="print-break mb-4 border border-gray-200 bg-white p-5 text-center">
          <h1 class="text-2xl font-bold text-gray-900">新版 GMP 落地增值评估报告</h1>
          <p class="mt-2 text-lg font-medium text-gray-600">{{ content.project.name }}　|　{{ content.project.auditDate }}</p>
          <div class="mt-4 flex flex-wrap items-center justify-center gap-2 text-sm">
            <span
              class="rounded-full px-2.5 py-1"
              :class="report?.confirmedAt ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'"
            >
              {{
                report?.confirmedAt
                  ? `已复核 · ${report.confirmedByName || ''} ${new Date(report.confirmedAt).toLocaleString('zh-CN')}`
                  : '待组长复核'
              }}
            </span>
            <span v-if="report?.aiProvider" class="rounded-full bg-gray-100 px-2.5 py-1 text-gray-500">
              AI：{{ report.aiProvider === 'deepseek' ? 'DeepSeek' : '规则引擎' }}
            </span>
            <span class="rounded-full bg-gray-100 px-2.5 py-1 text-gray-500">
              生成于 {{ new Date(content.generatedAt).toLocaleString('zh-CN') }}
            </span>
          </div>
        </div>

        <!-- 红线预警 -->
        <div class="print-break mb-4"><RedlineBanner :redline="content.redline" /></div>

        <!-- 总览数字 -->
        <div class="print-break mb-5 grid grid-cols-3 gap-3 border border-gray-200 bg-white p-5 text-center sm:grid-cols-7">
          <div>
            <div class="text-sm text-gray-500">检查项</div>
            <div class="mt-1 text-3xl font-bold text-gray-800">{{ content.totals.total }}</div>
          </div>
          <div>
            <div class="text-sm text-gray-500">已核实</div>
            <div class="mt-1 text-3xl font-bold" :style="{ color: STATUS_COLOR.landed }">{{ content.totals.verified }}</div>
          </div>
          <div>
            <div class="text-sm text-gray-500">异常</div>
            <div class="mt-1 text-3xl font-bold" :style="{ color: STATUS_COLOR.not_landed }">{{ content.totals.abnormal }}</div>
          </div>
          <div v-for="s in STATUS_ORDER" :key="s">
            <div class="text-sm text-gray-500">{{ STATUS_LABEL[s] }}</div>
            <div class="mt-1 text-3xl font-bold" :style="{ color: STATUS_COLOR[s] }">{{ content.totals[s] }}</div>
          </div>
        </div>

        <!-- 视图切换：★ 第 4 项 改成大号标签页，现场一眼能找到「未落地清单」 -->
        <div class="no-print mb-5 flex flex-wrap gap-3">
          <button
            v-for="t in [
              { k: 'conclusion', l: '结论与问题' },
              { k: 'overview', l: '数据总览' },
              { k: 'abnormal', l: `未落地清单 ${content.abnormalList.length}` },
              { k: 'rectify', l: `待整改清单 ${content.abnormalList.length}` },
              { k: 'dup', l: `重复条款 ${(content.crossGroup?.conflictCount || 0) + (content.crossGroup?.dupClauseCount || 0)}` },
            ]"
            :key="t.k"
            class="inline-flex min-h-[48px] items-center rounded-xl px-5 text-[15px] font-medium transition-colors"
            :class="view === t.k ? 'bg-brand text-white' : 'border-2 border-gray-200 bg-white text-gray-600 hover:border-gray-300'"
            @click="view = t.k as View"
          >
            {{ t.l }}
          </button>
        </div>

        <!-- ================= 结论与问题（首屏） ================= -->
        <section v-if="view === 'conclusion'" class="print-break space-y-4">
          <!-- 总体评价 -->
          <div v-if="content.verdict" class="border border-gray-200 bg-white">
            <div
              class="border-l-4 px-4 py-3"
              :style="{ borderColor: gradeColor, background: gradeBg }"
            >
              <div class="text-[13px] font-semibold" :style="{ color: gradeColor }">总体评价</div>
              <div class="mt-1 text-sm font-semibold leading-relaxed text-gray-800">{{ content.verdict.headline }}</div>
              <div class="mt-1 text-right text-[13px] font-medium" :style="{ color: gradeColor }">
                {{ content.verdict.gradeLabel }}
              </div>
            </div>

            <!-- 关键指标 -->
            <div class="grid grid-cols-3 divide-x divide-gray-100 border-t border-gray-100 sm:grid-cols-6">
              <div v-for="m in content.verdict.metrics" :key="m.label" class="px-2 py-2.5 text-center">
                <div class="text-[13px] text-gray-400">{{ m.label }}</div>
                <div class="mt-0.5 text-sm font-bold text-gray-800">{{ m.value }}</div>
              </div>
            </div>

            <!-- 评价正文 -->
            <div class="space-y-2 border-t border-gray-100 px-4 py-3">
              <p v-for="(p, i) in content.verdict.paragraphs" :key="i" class="text-[13px] leading-relaxed text-gray-600">
                {{ p }}
              </p>
            </div>
          </div>

          <!-- 核查口径提示：防止把「默认已落地」误读为「审核确认已落地」 -->
          <div
            v-if="content.totals.total - content.totals.verified > 0"
            class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] leading-relaxed text-amber-800"
          >
            核查口径：{{ content.totals.total - content.totals.verified }} 项为「默认已落地·待核实」（未被反选），
            不等同于「审核确认已落地」，落地率可能被高估。
          </div>

          <!-- 亟待解决的问题 -->
          <div class="border border-gray-200 bg-white">
            <div class="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
              <span class="text-sm font-semibold text-gray-800">亟待解决的问题</span>
              <span class="text-[13px] text-gray-400">
                归并口径：同章节 + 同优先级合并为一个问题
              </span>
            </div>

            <div v-if="!content.problems?.length" class="px-4 py-10 text-center text-sm text-emerald-600">
              本次核查未发现未落地条款，无需列入整改。
            </div>

            <ul v-else class="divide-y divide-gray-100">
              <li v-for="p in content.problems" :key="p.id">
                <button
                  class="flex min-h-[56px] w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-gray-50"
                  @click="openProblem = openProblem === p.id ? '' : p.id"
                >
                  <span
                    class="shrink-0 rounded px-2 py-1 text-[13px] font-bold text-white"
                    :style="{ background: p.priority === 'P0' ? '#C62828' : p.priority === 'P1' ? '#E65100' : '#5D4037' }"
                  >
                    {{ p.priority }}
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span class="font-mono text-[13px] text-gray-400">{{ p.id }}</span>
                      <span class="text-sm font-semibold text-gray-800">{{ p.title }}</span>
                    </div>
                    <div class="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-[13px] text-gray-400">
                      <span>{{ p.clauseCount }} 项条款</span>
                      <span v-if="p.keyCount" class="font-medium text-red-600">关键项 {{ p.keyCount }}</span>
                      <span v-if="p.groupNames.length">{{ p.groupNames.join('/') }}</span>
                      <span v-if="p.hasConflict" class="font-medium text-amber-600">组间判定不一致</span>
                    </div>
                  </div>
                  <span class="shrink-0 text-[13px] text-gray-400">{{ openProblem === p.id ? '收起' : '展开' }}</span>
                </button>

                <div v-if="openProblem === p.id" class="border-t border-gray-100 bg-gray-50/60 px-4 py-3">
                  <dl class="space-y-1.5 text-[13px] leading-relaxed">
                    <div class="flex gap-2">
                      <dt class="w-16 shrink-0 text-gray-400">问题定性</dt>
                      <dd class="text-gray-700">{{ p.nature }}</dd>
                    </div>
                    <div class="flex gap-2">
                      <dt class="w-16 shrink-0 text-gray-400">判定依据</dt>
                      <dd class="text-gray-700">{{ p.basis }}</dd>
                    </div>
                    <div v-if="p.processCodes.length" class="flex gap-2">
                      <dt class="w-16 shrink-0 text-gray-400">涉及过程</dt>
                      <dd class="text-gray-700">{{ p.processCodes.join('、') }}</dd>
                    </div>
                    <div class="flex gap-2">
                      <dt class="w-16 shrink-0 text-gray-400">涉及条款</dt>
                      <dd class="font-mono text-gray-700">{{ p.clauseCodes.join('、') }}</dd>
                    </div>
                  </dl>
                  <div class="mt-2.5">
                    <div class="text-[13px] font-semibold text-gray-600">处置建议</div>
                    <ul class="mt-1 space-y-1">
                      <li
                        v-for="(a, i) in p.actions"
                        :key="i"
                        class="flex gap-1.5 text-[13px] leading-relaxed text-gray-600"
                      >
                        <span class="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-gray-400"></span>
                        <span>{{ a }}</span>
                      </li>
                    </ul>
                  </div>
                </div>
              </li>
            </ul>
          </div>
        </section>

        <!-- ================= 异常优先清单（明细） ================= -->
        <section v-else-if="view === 'abnormal'" class="print-break space-y-4">
          <p class="text-[13px] leading-relaxed text-gray-500">
            优先级派生口径：<b class="text-gray-700">P0</b> = 关键项未落地或所在章节被整章取消勾选；<b class="text-gray-700">P1</b> = 主要项未落地；<b
              class="text-gray-700"
            >P2</b> = 一般项未落地。同级按风险等级、条款号排序。
          </p>

          <div v-if="!content.abnormalList.length" class="border border-gray-200 bg-white p-8 text-center text-sm text-gray-400">
            本次审核未发现未落地条款，全部检查项均已落地。
          </div>

          <section v-for="g in grouped" v-show="g.items.length" :key="g.priority" class="border border-gray-200 bg-white">
            <button
              class="flex w-full items-center justify-between gap-3 border-b border-gray-100 px-4 py-3 text-left"
              @click="openPriority = g.priority"
            >
              <div class="flex min-w-0 items-center gap-2">
                <span class="shrink-0 rounded px-2 py-0.5 text-[13px] font-bold text-white" :style="{ background: g.color }">
                  {{ g.priority }}
                </span>
                <span class="truncate text-sm font-semibold text-gray-800">{{ g.short }}</span>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <span class="text-lg font-bold" :style="{ color: g.color }">{{ g.items.length }}</span>
                <span class="text-[13px] text-gray-400">{{ openPriority === g.priority ? '收起' : '展开' }}</span>
              </div>
            </button>

            <ul v-if="openPriority === g.priority" class="divide-y divide-gray-100">
              <li v-for="x in g.items" :key="x.code" class="px-4 py-3">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="font-mono text-[13px] text-gray-500">{{ x.code }}</span>
                  <span class="rounded px-1.5 py-0.5 text-[13px]" :class="levelBadge(x.level)">{{ x.level }}</span>
                  <span class="rounded bg-gray-100 px-1.5 py-0.5 text-[13px] text-gray-500">{{ x.chapterName }}</span>
                  <span v-if="x.specClause" class="rounded bg-gray-100 px-1.5 py-0.5 text-[13px] text-gray-500">
                    《规范》{{ x.specClause }}
                  </span>
                  <span v-if="x.groupNames?.length" class="rounded bg-brand/10 px-1.5 py-0.5 text-[13px] text-brand">
                    {{ x.groupNames.join('/') }}
                  </span>
                  <span
                    v-if="x.groupCount > 1"
                    class="rounded bg-amber-50 px-1.5 py-0.5 text-[13px] text-amber-700"
                    title="该项被多个审核组分别审核，报告按合并口径只计一条"
                  >
                    跨 {{ x.groupCount }} 组
                  </span>
                  <span
                    v-if="x.conflict"
                    class="rounded px-1.5 py-0.5 text-[13px] text-white"
                    style="background: #f9a825"
                    title="各组判定不一致，须在末次会议当面澄清"
                  >
                    判定不一致
                  </span>
                </div>
                <p class="mt-1 text-sm leading-relaxed text-gray-800">{{ x.text }}</p>
                <p v-if="x.isoList.length" class="mt-1 text-[13px] text-gray-400">ISO 13485：{{ x.isoList.join(' / ') }}</p>
              </li>
            </ul>
          </section>
        </section>

        <!-- ================= 待整改清单 ================= -->
        <section v-else-if="view === 'rectify'" class="print-break space-y-4">
          <p class="text-[13px] leading-relaxed text-gray-500">
            未落地条款由后端自动汇总为待整改条目（本页与后端整改清单同源，条款被重新勾回落地后自动移除）。
          </p>

          <div v-if="!rectifyRows.length" class="border border-gray-200 bg-white p-8 text-center text-sm text-gray-400">
            无待整改事项。
          </div>

          <section v-for="g in rectifyByPriority" v-show="g.rows.length" :key="g.priority" class="border border-gray-200 bg-white p-4">
            <div class="mb-3 flex items-center gap-2 border-b border-gray-100 pb-2">
              <span class="rounded px-2 py-0.5 text-[13px] font-bold text-white" :style="{ background: g.color }">{{ g.priority }}</span>
              <span class="text-sm font-semibold text-gray-800">{{ g.label }}</span>
              <span class="ml-auto text-[13px] text-gray-500">{{ g.rows.length }} 项</span>
            </div>
            <div class="-mx-4 overflow-x-auto sm:mx-0">
              <table class="w-full min-w-[640px] text-[13px]">
                <thead class="border-b border-gray-200 text-gray-500">
                  <tr>
                    <th class="px-4 py-2 text-left">#</th>
                    <th class="px-2 py-2 text-left">条款号</th>
                    <th class="px-2 py-2 text-left">章节</th>
                    <th class="px-2 py-2 text-center">级别</th>
                    <th class="px-2 py-2 text-left">整改要求</th>
                    <th class="px-2 py-2 text-left">责任组</th>
                    <th class="px-4 py-2 text-center">状态</th>
                  </tr>
                </thead>
                <tbody class="text-gray-700">
                  <tr v-for="r in g.rows" :key="r.no" class="border-b border-gray-100 align-top">
                    <td class="px-4 py-2 text-gray-400">{{ r.no }}</td>
                    <td class="px-2 py-2 font-mono">{{ r.code }}</td>
                    <td class="px-2 py-2 text-[13px] text-gray-500">{{ r.chapterName }}</td>
                    <td class="px-2 py-2 text-center">
                      <span
                        class="rounded px-1.5 py-0.5 text-[13px]"
                        :style="{ background: `${LEVEL_COLOR[r.level]}1A`, color: LEVEL_COLOR[r.level] }"
                      >
                        {{ r.level }}
                      </span>
                    </td>
                    <td class="px-2 py-2">{{ r.text }}</td>
                    <td class="px-2 py-2 text-[13px] text-gray-500">{{ r.groupNames?.join('/') || '—' }}</td>
                    <td class="px-4 py-2 text-center text-[13px] text-gray-500">待整改</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </section>

        <!-- ================= 重复条款与判定分歧 ================= -->
        <section v-else-if="view === 'dup'" class="print-break space-y-4">
          <div class="border border-gray-200 bg-white p-4">
            <h2 class="mb-1 text-sm font-semibold">重复条款与组间判定分歧</h2>
            <p class="text-[13px] leading-relaxed text-gray-500">
              同一个 ISO 条款会同时落进多个 P 过程，因此工作包里必然出现重复引用。
              <b class="text-gray-700">本页说明重复是怎么处理的</b>：报告与红线统计一律按
              <b class="text-gray-700">检查项唯一</b>归并——一条不符合只计一次，不会因被多个组审过而被放大。
              组间判定不一致的条目已单列，必须在末次会议当面澄清。
            </p>

            <div class="mt-3 grid grid-cols-3 gap-3">
              <div class="rounded bg-brand-bg px-3 py-2">
                <div class="text-[13px] text-gray-500">重复分派的检查项</div>
                <div class="mt-0.5 text-xl font-bold text-brand">{{ dupStat.dupClauseCount }}</div>
              </div>
              <div class="rounded bg-brand-bg px-3 py-2">
                <div class="text-[13px] text-gray-500">工作包引用次数</div>
                <div class="mt-0.5 text-xl font-bold text-gray-700">{{ dupStat.refCount }}</div>
              </div>
              <div class="rounded px-3 py-2" :class="dupStat.conflictCount ? 'bg-amber-50' : 'bg-brand-bg'">
                <div class="text-[13px] text-gray-500">判定不一致</div>
                <div class="mt-0.5 text-xl font-bold" :class="dupStat.conflictCount ? 'text-amber-700' : 'text-gray-400'">
                  {{ dupStat.conflictCount }}
                </div>
              </div>
            </div>
            <p class="mt-2 text-[13px] text-gray-400">
              压缩比：{{ dupStat.refCount }} 次引用合并为 {{ dupStat.dupClauseCount }} 条唯一检查项
            </p>
          </div>

          <div v-if="!dupStat.conflictCount" class="border border-emerald-200 bg-emerald-50 p-6 text-center text-sm text-emerald-700">
            各审核组对重复条款的判定完全一致，无须澄清。
          </div>

          <section v-else class="border border-amber-300 bg-white">
            <div class="border-b border-amber-200 bg-amber-50 px-4 py-2.5">
              <span class="text-sm font-semibold text-amber-900">判定不一致清单（末次会议须逐条澄清）</span>
              <p class="mt-0.5 text-[13px] text-amber-800">
                同一检查项被多个组分别判定为不一致。报告已取最严重判定为准，但结论须当面确认。
              </p>
            </div>
            <ul>
              <li v-for="c in dupStat.conflictList" :key="c.code" class="border-b border-gray-100 px-4 py-3 last:border-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-mono text-[13px] text-gray-500">{{ c.code }}</span>
                  <span
                    class="rounded px-1.5 py-0.5 text-[13px]"
                    :style="{ background: `${LEVEL_COLOR[c.level]}1A`, color: LEVEL_COLOR[c.level] }"
                  >
                    {{ c.level }}
                  </span>
                  <span class="rounded px-1.5 py-0.5 text-[13px] text-white" :style="{ background: STATUS_COLOR[c.status] }">
                    合并判定：{{ STATUS_LABEL[c.status] }}
                  </span>
                </div>
                <p class="mt-1 text-[13px] leading-relaxed text-gray-700">{{ c.text }}</p>
                <div class="mt-1.5 flex flex-wrap gap-1.5">
                  <span
                    v-for="d in c.detail"
                    :key="d.groupName"
                    class="rounded border px-2 py-0.5 text-[13px]"
                    :style="{
                      borderColor: STATUS_COLOR[d.status],
                      color: STATUS_COLOR[d.status],
                      background: `${STATUS_COLOR[d.status]}14`,
                    }"
                  >
                    {{ d.groupName }}：{{ STATUS_LABEL[d.status] }}
                  </span>
                </div>
              </li>
            </ul>
          </section>

          <!-- 重复分派明细（按重复次数降序） -->
          <section v-if="dupRows.length" class="border border-gray-200 bg-white">
            <div class="border-b border-gray-100 px-4 py-2.5">
              <span class="text-sm font-semibold text-gray-800">跨过程重复分派明细</span>
              <p class="mt-0.5 text-[13px] text-gray-500">
                下列检查项在多个 P 过程中被重复引用。按检查项去重后实际只剩一条，故报告不重复计。
              </p>
            </div>
            <div class="-mx-4 overflow-x-auto sm:mx-0">
              <table class="w-full min-w-[560px] text-[13px]">
                <thead class="border-b border-gray-200 text-gray-500">
                  <tr>
                    <th class="px-4 py-2 text-left">条款号</th>
                    <th class="px-2 py-2 text-center">级别</th>
                    <th class="px-2 py-2 text-left">内容</th>
                    <th class="px-2 py-2 text-left">涉及过程</th>
                    <th class="px-2 py-2 text-center">审核组</th>
                    <th class="px-4 py-2 text-center">合并判定</th>
                  </tr>
                </thead>
                <tbody class="text-gray-700">
                  <tr v-for="r in dupRows" :key="r.code" class="border-b border-gray-100 align-top">
                    <td class="px-4 py-2 font-mono">{{ r.code }}</td>
                    <td class="px-2 py-2 text-center">
                      <span
                        class="rounded px-1.5 py-0.5 text-[13px]"
                        :style="{ background: `${LEVEL_COLOR[r.level]}1A`, color: LEVEL_COLOR[r.level] }"
                      >
                        {{ r.level }}
                      </span>
                    </td>
                    <td class="px-2 py-2">{{ r.text }}</td>
                    <td class="px-2 py-2">
                      <span
                        v-for="p in r.processCodes"
                        :key="p"
                        class="mr-1 inline-block rounded bg-brand/10 px-1.5 py-0.5 text-[13px] text-brand"
                      >
                        {{ p }}
                      </span>
                    </td>
                    <td class="px-2 py-2 text-center">
                      <span v-if="r.groupCount > 1" class="rounded bg-amber-50 px-1.5 py-0.5 text-[13px] text-amber-700">
                        {{ r.groupCount }} 组
                      </span>
                      <span v-else class="text-gray-300">—</span>
                    </td>
                    <td class="px-4 py-2 text-center">
                      <span class="rounded px-1.5 py-0.5 text-[13px] text-white" :style="{ background: STATUS_COLOR[r.status] }">
                        {{ STATUS_LABEL[r.status] }}
                      </span>
                      <span v-if="r.conflict" class="ml-1 rounded bg-[#f9a825] px-1.5 py-0.5 text-[13px] text-white">分歧</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </section>

        <template v-else>
          <!-- 按章节的四状态分布 -->
          <div class="print-break mb-4 border border-gray-200 bg-white p-4">
            <h2 class="mb-2 text-sm font-semibold">按 GMP 章节的四状态分布</h2>
            <EChart :option="chapterChart" height="420px" />
          </div>

          <!-- 章节汇总表 -->
          <div class="print-break mb-4 border border-gray-200 bg-white p-4">
            <h2 class="mb-2 text-sm font-semibold">章节汇总表</h2>
            <div class="-mx-4 overflow-x-auto sm:mx-0">
              <table class="w-full min-w-[620px] text-[13px]">
                <thead class="border-b border-gray-200 text-gray-500">
                  <tr>
                    <th class="px-4 py-2 text-left">GMP 章节</th>
                    <th class="px-2 py-2 text-right">总数</th>
                    <th v-for="s in STATUS_ORDER" :key="s" class="px-2 py-2 text-right">{{ STATUS_LABEL[s] }}</th>
                    <th class="px-4 py-2 text-right">落地率</th>
                  </tr>
                </thead>
                <tbody class="text-gray-700">
                  <tr v-for="r in content.byChapter" :key="r.code" class="border-b border-gray-100">
                    <td class="px-4 py-1.5">
                      {{ r.name }}
                      <span v-if="r.focus" class="ml-1 rounded bg-brand/10 px-1 text-[13px] text-brand">重点</span>
                    </td>
                    <td class="px-2 py-1.5 text-right">{{ r.total }}</td>
                    <td
                      v-for="s in STATUS_ORDER"
                      :key="s"
                      class="px-2 py-1.5 text-right"
                      :style="{ color: r.counts[s] ? STATUS_COLOR[s] : '#ccc' }"
                    >
                      {{ r.counts[s] }}
                    </td>
                    <td class="px-4 py-1.5 text-right font-medium">{{ pct(r.rate) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 三大重点章节专项统计（真实全名） -->
          <div class="print-break mb-4 border border-gray-200 bg-white p-4">
            <h2 class="mb-1 text-sm font-semibold">三大重点章节专项统计</h2>
            <p class="mb-3 text-[13px] text-gray-500">{{ FOCUS_CATEGORIES.join(' / ') }} —— 认证审核的高风险领域，单独列出便于快速定位问题。</p>
            <div class="grid gap-4 lg:grid-cols-2">
              <div class="space-y-2">
                <div v-for="f in content.focus" :key="f.category" class="border border-gray-100 p-3">
                  <div class="flex items-center justify-between text-[13px]">
                    <span class="font-medium text-gray-700">{{ f.category }}</span>
                    <span class="text-gray-500">{{ f.total }} 项 · 落地率 <b class="text-brand">{{ pct(f.rate) }}</b></span>
                  </div>
                  <div class="mt-2 flex h-2.5 overflow-hidden rounded-full bg-gray-100">
                    <div
                      v-for="s in STATUS_ORDER"
                      :key="s"
                      :style="{ width: `${f.total ? (f.counts[s] / f.total) * 100 : 0}%`, background: STATUS_COLOR[s] }"
                    ></div>
                  </div>
                  <div class="mt-1.5 flex flex-wrap gap-3 text-[13px] text-gray-500">
                    <span v-for="s in STATUS_ORDER" :key="s">{{ STATUS_LABEL[s] }} {{ f.counts[s] }}</span>
                  </div>
                </div>
              </div>
              <EChart :option="focusChart" height="280px" />
            </div>
          </div>

          <!-- 风险等级 / 审核组 -->
          <div class="print-break mb-4 grid gap-4 lg:grid-cols-2">
            <div class="border border-gray-200 bg-white p-4">
              <h2 class="mb-2 text-sm font-semibold">风险等级分布</h2>
              <div class="-mx-4 overflow-x-auto sm:mx-0">
                <table class="w-full min-w-[300px] text-[13px]">
                  <thead class="border-b border-gray-200 text-gray-500">
                    <tr>
                      <th class="px-4 py-2 text-left">等级</th>
                      <th class="px-2 py-2 text-right">总数</th>
                      <th class="px-4 py-2 text-right">未落地</th>
                    </tr>
                  </thead>
                  <tbody class="text-gray-700">
                    <tr v-for="l in content.byLevel" :key="l.level" class="border-b border-gray-100">
                      <td class="px-4 py-1.5">
                        <span
                          class="rounded px-1.5 py-0.5 text-[13px]"
                          :style="{ background: `${LEVEL_COLOR[l.level]}1A`, color: LEVEL_COLOR[l.level] }"
                        >
                          {{ l.level }}
                        </span>
                      </td>
                      <td class="px-2 py-1.5 text-right">{{ l.total }}</td>
                      <td class="px-4 py-1.5 text-right font-medium" :style="{ color: l.notMet ? STATUS_COLOR.not_landed : '#ccc' }">
                        {{ l.notMet }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="border border-gray-200 bg-white p-4">
              <h2 class="mb-2 text-sm font-semibold">审核组进度</h2>
              <div class="-mx-4 overflow-x-auto sm:mx-0">
                <table class="w-full min-w-[340px] text-[13px]">
                  <thead class="border-b border-gray-200 text-gray-500">
                    <tr>
                      <th class="px-4 py-2 text-left">审核组</th>
                      <th class="px-2 py-2 text-right">分派</th>
                      <th class="px-2 py-2 text-right">已核实</th>
                      <th class="px-4 py-2 text-right">异常</th>
                    </tr>
                  </thead>
                  <tbody class="text-gray-700">
                    <tr v-for="g in content.byGroup" :key="g.groupName" class="border-b border-gray-100">
                      <td class="px-4 py-1.5">{{ g.groupName }}</td>
                      <td class="px-2 py-1.5 text-right">{{ g.total }}</td>
                      <td class="px-2 py-1.5 text-right">{{ g.verified }}</td>
                      <td class="px-4 py-1.5 text-right font-medium" :style="{ color: g.abnormal ? STATUS_COLOR.not_landed : '#ccc' }">
                        {{ g.abnormal }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </template>

        <!-- AI 结论与建议 -->
        <div class="print-break mb-6 border border-gray-200 bg-white p-4">
          <div class="mb-2 flex items-center justify-between">
            <h2 class="text-sm font-semibold">审核组结论与增值建议</h2>
            <button
              v-if="canEdit && !editing"
              class="no-print rounded-lg border border-gray-200 px-2.5 py-1 text-[13px] text-brand"
              @click="editing = true"
            >
              编辑
            </button>
          </div>

          <template v-if="editing">
            <textarea
              v-model="draft"
              rows="14"
              class="w-full rounded-lg border border-gray-200 p-3 text-[13px] leading-relaxed outline-none focus:border-brand"
            ></textarea>
            <div class="no-print mt-2 flex gap-2">
              <button class="rounded-lg bg-brand px-3 py-1.5 text-[13px] text-white" :disabled="saving" @click="saveDraft">保存</button>
              <button class="rounded-lg border border-gray-200 px-3 py-1.5 text-[13px]" @click="editing = false">取消</button>
            </div>
          </template>
          <div v-else class="whitespace-pre-wrap text-[13px] leading-relaxed text-gray-700">
            {{ report?.aiSummary || '（暂无内容，可点击右上角「重新生成 AI」）' }}
          </div>
        </div>

        <!-- 声明 -->
        <p class="print-break mb-8 border border-gray-200 bg-white p-3 text-[13px] leading-relaxed text-gray-500">
          本报告依据 ISO 13485:2016 及《医疗器械生产质量管理规范》现场审核记录自动生成。条款默认判定为「已落地」，经审核员反选确认的未落地项构成异常清单；
          仅作为认证审核组的增值评估与技术支持材料，不构成对受审核方产品注册、体系认证或其他行政许可结果的承诺。
        </p>

        <!-- 操作栏 -->
        <!-- ★ 第 4 项：底部操作栏按钮加高到 56px，文字提到 16px -->
        <div class="no-print fixed inset-x-0 bottom-0 z-20 border-t border-gray-200 bg-white/95 px-8 py-4 backdrop-blur">
          <div class="mx-auto flex max-w-[1280px] gap-4">
            <button class="btn-ghost flex-1" @click="exportWord">导出 Word</button>
            <button class="btn-ghost flex-1" onclick="window.print()">打印 / 存 PDF</button>
            <button v-if="canEdit && !report?.confirmedAt" class="btn-primary flex-1" @click="confirmReport">
              复核确认
            </button>
            <span
              v-else-if="report?.confirmedAt"
              class="flex min-h-[48px] flex-1 items-center justify-center rounded-xl bg-emerald-50 text-base font-medium text-emerald-700"
            >
              已复核
            </span>
          </div>
        </div>
        <!-- 底部操作栏是fixed，给正文留出等高空白，避免最后一段被压住 -->
        <div class="no-print h-24" aria-hidden="true"></div>
      </template>
    </main>
  </div>
</template>
