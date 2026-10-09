<script setup lang="ts">
/**
 * 组长首页 —— 一句话原则：组长只做一件事，把 Word 计划丢进来。
 *
 * 原「新建项目」表单（填企业名/日期/简称/备注 4 个字段）已删除。
 * 现在上传即自动完成：
 *   企业名称（从计划「受审核方名称」读）· 审核日期 · 认证编号
 *   → 建项目 → 建审核组 → 按 P 过程拆工作包 → 按映射表分派条款
 * 组长上传后只需看一眼「系统读到了什么」，确认或改一下名字即可。
 */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, clearSession, getStoredUser } from '../api';
import type { Project } from '../types';

const router = useRouter();
const user = getStoredUser();
const rows = ref<Project[]>([]);
const loading = ref(true);
const dragOver = ref(false);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

/** 上传成功后展示「系统自动提取了什么」，让组长确认而不是让他填 */
const result = ref<{
  project: { id: string; name: string };
  reused: boolean;
  extracted: { projectName: string; auditDate: string | null; auditEndDate: string | null; certNo: string | null; members: string[] };
  slots: number;
  groups: number;
  members: { name: string; code: string }[];
  mappingGap: string[];
  knownNoItem: string[];
  diagnostics: string[];
  error?: string;
  hints?: string[];
} | null>(null);

async function load() {
  loading.value = true;
  try {
    rows.value = await api.get<Project[]>('/projects');
  } catch (e: any) {
    alert(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function pick() {
  fileInput.value?.click();
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = ''; // 允许重复选同一文件
  if (f) await upload(f);
}

async function upload(f: File) {
  uploading.value = true;
  result.value = null;
  try {
    const fd = new FormData();
    fd.append('file', f);
    const r = await api.upload<any>('/projects/quick-import', fd);
    result.value = r;
    await load();
  } catch (e: any) {
    result.value = {
      project: { id: '', name: '' },
      reused: false,
      extracted: { projectName: '', auditDate: null, auditEndDate: null, certNo: null, members: [] },
      slots: 0,
      groups: 0,
      members: [],
      mappingGap: [],
      knownNoItem: [],
      diagnostics: [],
      error: e?.message || '上传失败',
      hints: e?.hints,
    };
  } finally {
    uploading.value = false;
  }
}

function onDrop(e: DragEvent) {
  dragOver.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (f) void upload(f);
}

function goProject() {
  if (result.value?.project.id) router.push(`/leader/project/${result.value.project.id}`);
}

function logout() {
  clearSession();
  router.push('/login');
}
</script>

<template>
  <div class="min-h-screen bg-brand-bg">
    <header class="bg-brand px-8 py-6 text-white">
      <div class="page !py-0">
        <div class="flex items-center justify-between gap-4">
          <div>
            <div class="text-xl font-semibold">{{ user?.name }}</div>
            <div class="mt-1 text-sm opacity-75">审核组长 · 上传 Word 计划即可开始</div>
          </div>
          <button class="btn-onbrand" @click="logout">退 出</button>
        </div>
      </div>
    </header>

    <main class="page">
      <!-- ========== 唯一主操作：上传 Word 计划 ========== -->
      <section class="panel mb-6">
        <h2 class="text-lg font-semibold text-gray-900">上传审核计划</h2>
        <p class="mt-2 text-sm leading-relaxed text-gray-600">
          把 <b class="text-gray-900">Word 版认证审核计划</b>拖到这里，或点下方按钮选择。
          系统会自动读出企业名称、审核日期、审核组成员，按过程拆出工作包并分配条款，<b class="text-gray-900">无需新建项目、无需填任何字段</b>。
        </p>

        <div
          class="mt-5 flex min-h-[160px] cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition"
          :class="dragOver ? 'border-brand bg-brand-bg' : 'border-gray-300 bg-gray-50 hover:border-brand-light'"
          @click="pick"
          @dragover.prevent="dragOver = true"
          @dragleave="dragOver = false"
          @drop.prevent="onDrop"
        >
          <div v-if="uploading" class="flex items-center text-base text-gray-600">
            <span class="spin"></span>正在解析计划…
          </div>
          <template v-else>
            <div class="text-lg font-medium text-gray-800">点击选择，或把 .docx 文件拖到这里</div>
            <div class="mt-2 text-sm text-gray-500">仅支持 .docx；PDF 请先用 Word 另存为 .docx</div>
          </template>
        </div>
        <input ref="fileInput" type="file" accept=".docx" class="hidden" @change="onFile" />
      </section>

      <!-- ========== 上传结果：展示系统读到了什么 ========== -->
      <section v-if="result" class="mb-6 rounded-2xl border p-6 shadow-sm" :class="result.error ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50'">
        <template v-if="result.error">
          <h3 class="text-lg font-semibold text-red-700">导入失败</h3>
          <p class="mt-2 text-sm leading-relaxed text-red-600">{{ result.error }}</p>
          <ul v-if="result.hints?.length" class="mt-2 list-inside list-disc text-sm text-red-600">
            <li v-for="(h, i) in result.hints" :key="i">{{ h }}</li>
          </ul>
          <ul v-if="result.diagnostics.length" class="mt-3 space-y-1 text-xs text-red-500">
            <li v-for="(d, i) in result.diagnostics" :key="i">· {{ d }}</li>
          </ul>
        </template>

        <template v-else>
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="min-w-0">
              <h3 class="text-lg font-semibold text-emerald-800">
                {{ result.reused ? '已更新该企业的审核计划' : '导入成功' }}
              </h3>
              <p class="mt-1 text-base text-emerald-700">{{ result.project.name }}</p>
            </div>
            <button class="btn-primary shrink-0" @click="goProject">进入项目看板</button>
          </div>

          <div class="mt-5 grid gap-3 sm:grid-cols-4">
            <div class="rounded-xl bg-white/70 px-4 py-3">
              <div class="text-xs text-gray-500">审核日期</div>
              <div class="mt-1 text-base font-medium text-gray-900">
                {{ result.extracted.auditDate || '未识别' }}
                <span v-if="result.extracted.auditEndDate" class="text-sm text-gray-400">~ {{ result.extracted.auditEndDate }}</span>
              </div>
            </div>
            <div class="rounded-xl bg-white/70 px-4 py-3">
              <div class="text-xs text-gray-500">认证编号</div>
              <div class="mt-1 truncate text-base font-medium text-gray-900">{{ result.extracted.certNo || '未识别' }}</div>
            </div>
            <div class="rounded-xl bg-white/70 px-4 py-3">
              <div class="text-xs text-gray-500">工作包</div>
              <div class="mt-1 text-base font-medium text-gray-900">{{ result.slots }} 个</div>
            </div>
            <div class="rounded-xl bg-white/70 px-4 py-3">
              <div class="text-xs text-gray-500">审核组</div>
              <div class="mt-1 text-base font-medium text-gray-900">{{ result.groups }} 个</div>
            </div>
          </div>

          <!-- 审核组成员姓名逐个成胶囊：姓名缺失这类问题当场可见 -->
          <div v-if="result.extracted.members.length" class="mt-4 text-sm text-emerald-800">
            <div class="font-medium">系统已识别审核组成员（{{ result.extracted.members.length }} 人），已自动建账号：</div>
            <div class="mt-2 flex flex-wrap gap-2">
              <span v-for="m in result.extracted.members" :key="m" class="rounded-full bg-white px-3 py-1 font-medium text-emerald-900">
                {{ m }}
              </span>
            </div>
            <div class="mt-2 text-xs text-emerald-700">审核员首次登录可在登录页自助注册，设置手机号与密码后即用本人姓名登录。</div>
          </div>

          <details v-if="result.mappingGap.length || result.knownNoItem.length" class="mt-4 rounded-xl bg-amber-50 px-4 py-3">
            <summary class="cursor-pointer text-sm font-medium text-amber-800">
              需要人工关注（{{ result.mappingGap.length }} 项映射缺口 / {{ result.knownNoItem.length }} 项法规确无对应检查项）
            </summary>
            <ul class="mt-2 space-y-1 text-xs text-amber-700">
              <li v-for="(g, i) in result.mappingGap.slice(0, 10)" :key="`g${i}`">映射缺口：{{ g }}</li>
              <li v-for="(k, i) in result.knownNoItem.slice(0, 10)" :key="`k${i}`">体系审核不得漏审：{{ k }}</li>
            </ul>
          </details>
        </template>
      </section>

      <!-- ========== 历史项目 ========== -->
      <div v-if="loading" class="py-20 text-center text-base text-gray-400">加载中…</div>

      <template v-else-if="rows.length">
        <h2 class="mb-4 text-lg font-semibold text-gray-900">我的审核项目（{{ rows.length }}）</h2>
        <ul class="grid gap-4 lg:grid-cols-2">
          <li v-for="p in rows" :key="p.id" class="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm transition hover:shadow-md">
            <div class="flex items-start justify-between gap-4">
              <button class="min-w-0 flex-1 cursor-pointer text-left" @click="router.push(`/leader/project/${p.id}`)">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-lg font-semibold text-gray-900">{{ p.name }}</span>
                  <span v-if="p.status === 'archived'" class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">已归档</span>
                </div>
                <div class="mt-1.5 text-sm text-gray-500">
                  {{ (p.auditDate || '').slice(0, 10) }}
                  <span v-if="p.clientName"> · {{ p.clientName }}</span>
                </div>
                <div class="mt-2 text-sm text-gray-500">
                  工作包 {{ p.slotCount ?? 0 }} · 审核组 {{ p._count?.groups ?? 0 }} 个 · 已核实 {{ p.verified ?? 0 }} · 未落地
                  <b :class="p.notLanded ? 'text-red-600' : ''">{{ p.notLanded ?? 0 }}</b>
                </div>
              </button>
              <button class="btn-ghost shrink-0" @click="router.push(`/leader/project/${p.id}`)">看板</button>
            </div>
            <div class="mt-4 flex items-center gap-3">
              <div class="h-2.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                <div class="h-full rounded-full bg-brand" :style="{ width: `${(p.progress ?? 0) * 100}%` }"></div>
              </div>
              <span class="shrink-0 text-sm text-gray-600">{{ Math.round((p.progress ?? 0) * 100) }}% 已核实</span>
            </div>
          </li>
        </ul>
      </template>

      <p v-else-if="!result" class="panel py-20 text-center text-base text-gray-400">
        还没有审核项目。上传一份 Word 计划就会自动建好。
      </p>
    </main>
  </div>
</template>
