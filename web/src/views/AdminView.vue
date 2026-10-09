<script setup lang="ts">
/**
 * 管理员页：映射表 CRUD/导入导出、章节总览、用户管理、项目归档、日志
 * 分层反选模型下，章节归属与级别只存在于 GmpClause 上，
 * ClauseMapping 仅描述「ISO 条款 ↔ GMP 检查项」关系，故映射表不编辑章节与级别。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, clearSession, getStoredUser, downloadFile } from '../api';
import { FOCUS_CATEGORIES, LEVEL_COLOR, WAYS, type GmpClauseRow, type MappingsResp, type Role } from '../types';

const router = useRouter();
const user = getStoredUser();

type Tab = 'mapping' | 'chapters' | 'users' | 'projects' | 'logs';
const tab = ref<Tab>('mapping');

const mapping = ref<MappingsResp>({ total: 0, page: 1, size: 50, list: [], isoClauses: [], chapters: [], ways: WAYS });
const page = ref(1);
const filters = ref({ isoClause: '', chapterCode: '', way: '', keyword: '' });
const clauses = ref<GmpClauseRow[]>([]);
const users = ref<any[]>([]);
const ROLE_LABEL: Record<string, string> = { leader: '组长', auditor: '审核员', admin: '管理员' };
const projects = ref<any[]>([]);
const logs = ref<any>({ list: [], total: 0, actions: [] });
const stats = ref<any>(null);
const loading = ref(false);

// 新增映射表单（不再有 category / level —— 二者由 GmpClause 决定）
const newMap = ref({ isoClause: '', isoName: '', gmpClauseId: '', way: '直接对应', remark: '' });
const newUser = ref({ username: '', name: '', role: 'auditor' as Role, password: '', dept: '' });

async function loadMappings() {
  loading.value = true;
  const q = new URLSearchParams({ page: String(page.value), size: '50' });
  if (filters.value.isoClause) q.set('isoClause', filters.value.isoClause);
  if (filters.value.chapterCode) q.set('chapterCode', filters.value.chapterCode);
  if (filters.value.way) q.set('way', filters.value.way);
  if (filters.value.keyword) q.set('keyword', filters.value.keyword);
  try {
    mapping.value = await api.get<MappingsResp>(`/admin/mappings?${q}`);
  } finally {
    loading.value = false;
  }
}

async function loadUsers() {
  users.value = await api.get('/admin/users');
}
async function loadProjects() {
  projects.value = await api.get('/projects');
}
async function loadLogs() {
  logs.value = await api.get('/admin/logs?page=1&size=100');
}
async function loadStats() {
  stats.value = await api.get('/admin/stats');
}

onMounted(async () => {
  await Promise.all([loadMappings(), loadUsers(), loadProjects(), loadLogs(), loadStats()]);
  clauses.value = await api.get<GmpClauseRow[]>('/admin/gmp-clauses');
});

const selectedClause = computed(() => clauses.value.find((c) => c.id === newMap.value.gmpClauseId));

/**
 * 章节总览：由 /admin/gmp-clauses 聚合得出
 * （后端目前无独立章节统计接口，focus 由章节名与重点章节常量匹配得出）
 */
const chapterOverview = computed(() => {
  const acc = new Map<string, { code: string; name: string; itemCount: number; keyCount: number; mainCount: number; genCount: number; focus: boolean }>();
  for (const c of clauses.value) {
    const e =
      acc.get(c.chapterCode) || {
        code: c.chapterCode,
        name: c.chapter.name,
        itemCount: 0,
        keyCount: 0,
        mainCount: 0,
        genCount: 0,
        focus: FOCUS_CATEGORIES.includes(c.chapter.name),
      };
    e.itemCount += 1;
    if (c.level === '关键') e.keyCount += 1;
    else if (c.level === '主要') e.mainCount += 1;
    else e.genCount += 1;
    acc.set(c.chapterCode, e);
  }
  return [...acc.values()].sort((a, b) => a.code.localeCompare(b.code));
});

/** 分组后的条款选项，便于在 200 条里快速查找 */
const clauseOptions = computed(() =>
  clauses.value.map((c) => ({
    id: c.id,
    label: `${c.code} · ${c.level} · ${c.chapter.name} · ${c.text.slice(0, 14)}`,
  })),
);

async function addMapping() {
  if (!newMap.value.isoClause || !newMap.value.gmpClauseId) return alert('请填写 ISO 条款号并选择 GMP 检查项');
  try {
    await api.post('/admin/mappings', newMap.value);
    newMap.value = { isoClause: '', isoName: '', gmpClauseId: '', way: '直接对应', remark: '' };
    await loadMappings();
    await loadStats();
  } catch (e: any) {
    alert(e.message);
  }
}

async function delMapping(m: any) {
  if (!confirm('删除该映射？删除后对应 ISO 条款将不再分派该检查项。')) return;
  await api.del(`/admin/mappings/${m.id}`);
  await loadMappings();
  await loadStats();
}

async function toggleMapping(m: any) {
  await api.patch(`/admin/mappings/${m.id}`, { enabled: !m.enabled });
  await loadMappings();
}

/** 编辑 ISO 条款名称 / 对应方式 */
const editingId = ref('');
const editRow = ref({ isoName: '', way: '直接对应', remark: '' });
function startEdit(m: any) {
  editingId.value = m.id;
  editRow.value = { isoName: m.isoName || '', way: m.way || '直接对应', remark: m.remark || '' };
}
async function saveEdit(m: any) {
  try {
    await api.patch(`/admin/mappings/${m.id}`, editRow.value);
    editingId.value = '';
    await loadMappings();
  } catch (e: any) {
    alert(e.message);
  }
}

/** 批量导入：粘贴 ISO条款号,GMP检查项编号,ISO条款名称,对应方式 */
async function importMappings() {
  const raw = prompt(
    '粘贴导入数据，每行格式：ISO条款号,GMP检查项编号,ISO条款名称,对应方式\n对应方式可留空（默认直接对应）\n例如：\n7.5.1,3.1.2,设计和开发,直接对应',
  );
  if (!raw) return;
  const rows = raw
    .trim()
    .split('\n')
    .map((l) => {
      const [isoClause, code, isoName, way] = l.split(',').map((s) => (s ?? '').trim());
      return { isoClause, code, isoName, way: way || '直接对应' };
    })
    .filter((r) => r.isoClause && r.code);
  try {
    const r = await api.post<{ created: number; updated: number; skipped: number }>('/admin/mappings/import', { rows });
    const skippedMsg = r.skipped ? `\n跳过 ${r.skipped} 条（详见服务端提示）` : '';
    alert(`新增 ${r.created} 条，更新 ${r.updated} 条，跳过 ${r.skipped} 条${skippedMsg}`);
    await loadMappings();
    await loadStats();
  } catch (e: any) {
    alert(e.message);
  }
}

async function addUser() {
  try {
    await api.post('/admin/users', newUser.value);
    newUser.value = { username: '', name: '', role: 'auditor', password: '', dept: '' };
    await loadUsers();
    await loadStats();
  } catch (e: any) {
    alert(e.message);
  }
}

async function toggleUser(u: any) {
  try {
    await api.patch(`/admin/users/${u.id}`, { active: !u.active });
    await loadUsers();
  } catch (e: any) {
    alert(e.message);
  }
}

async function resetPwd(u: any) {
  const pwd = prompt(`为「${u.name}」设置新密码（至少 6 位）`);
  if (!pwd) return;
  try {
    await api.post(`/admin/users/${u.id}/reset-password`, { password: pwd });
    alert('密码已重置');
  } catch (e: any) {
    alert(e.message);
  }
}

async function delUser(u: any) {
  if (!confirm('删除用户？已提交评估记录的用户不可删除，请改用禁用。')) return;
  try {
    await api.del(`/admin/users/${u.id}`);
    await loadUsers();
  } catch (e: any) {
    alert(e.message);
  }
}

async function archiveProject(p: any) {
  if (!confirm(`${p.status === 'archived' ? '恢复' : '归档'}项目「${p.name}」？`)) return;
  await (p.status === 'archived' ? api.post(`/projects/${p.id}/restore`) : api.del(`/projects/${p.id}`));
  await loadProjects();
}

function logout() {
  clearSession();
  router.push('/login');
}
</script>

<template>
  <div class="min-h-screen bg-brand-bg pb-24">
    <!-- ★ 第 4 项：管理员后台同样放宽到 1280px，按钮加大 -->
    <header class="bg-brand px-8 py-6 text-white">
      <div class="page !py-0">
        <div class="flex items-center justify-between gap-4">
          <div>
            <div class="text-xl font-semibold">{{ user?.name }}</div>
            <div class="mt-1 text-sm opacity-75">管理员 · 系统配置</div>
          </div>
          <button class="btn-onbrand" @click="logout">退 出</button>
        </div>
      </div>
    </header>

    <div class="page">
      <!-- 概览 -->
      <div v-if="stats" class="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div class="panel p-5 text-center">
          <div class="text-sm text-gray-500">用户</div>
          <div class="mt-1 text-3xl font-bold text-gray-800">{{ stats.users.reduce((s: number, u: any) => s + u._count.role, 0) }}</div>
        </div>
        <div class="panel p-5 text-center">
          <div class="text-sm text-gray-500">映射条目</div>
          <div class="mt-1 text-3xl font-bold text-brand">{{ stats.mappingTotal }}</div>
        </div>
        <div class="panel p-5 text-center">
          <div class="text-sm text-gray-500">检查项</div>
          <div class="mt-1 text-3xl font-bold text-gray-800">{{ stats.clauseTotal }}</div>
        </div>
        <div class="panel p-5 text-center">
          <div class="text-sm text-gray-500">操作日志</div>
          <div class="mt-1 text-3xl font-bold text-gray-800">{{ stats.logTotal }}</div>
        </div>
      </div>

      <!-- Tab -->
      <div class="mb-5 flex flex-wrap gap-3">
        <button
          v-for="t in [
            { k: 'mapping', l: '映射表' },
            { k: 'chapters', l: '章节总览' },
            { k: 'users', l: '用户' },
            { k: 'projects', l: '项目归档' },
            { k: 'logs', l: '操作日志' },
          ]"
          :key="t.k"
          class="inline-flex min-h-[48px] items-center rounded-xl px-5 text-[15px] font-medium transition-colors"
          :class="tab === t.k ? 'bg-brand text-white' : 'border-2 border-gray-200 bg-white text-gray-600 hover:border-gray-300'"
          @click="tab = t.k as Tab"
        >
          {{ t.l }}
        </button>
      </div>

      <!-- ============ 映射表 ============ -->
      <section v-if="tab === 'mapping'" class="space-y-4">
        <div class="border border-gray-200 bg-white p-4">
          <h3 class="mb-1 text-sm font-semibold">新增映射（ISO 13485 条款 → GMP 检查项）</h3>
          <p class="mb-3 text-[13px] text-gray-500">
            章节归属与风险级别均取自检查项底表，此处无需填写；「对应方式」与「ISO 条款名称」仅影响展示与判定口径说明。
          </p>
          <div class="grid gap-2 sm:grid-cols-5">
            <input
              v-model="newMap.isoClause"
              class="field"
              placeholder="ISO 条款 如 7.5.1"
            />
            <input v-model="newMap.isoName" class="field" placeholder="ISO 条款名称（选填）" />
            <select v-model="newMap.gmpClauseId" class="field">
              <option value="">选择 GMP 检查项</option>
              <option v-for="c in clauseOptions" :key="c.id" :value="c.id">{{ c.label }}</option>
            </select>
            <select v-model="newMap.way" class="field">
              <option v-for="w in WAYS" :key="w" :value="w">{{ w }}</option>
            </select>
            <button class="btn-primary !min-h-[44px] !px-5 !text-[15px]" @click="addMapping">添加</button>
          </div>
          <p v-if="selectedClause" class="mt-2 text-[13px] text-gray-500">
            已选：<b class="text-gray-700">{{ selectedClause.code }}</b> · {{ selectedClause.chapter.name }} · {{ selectedClause.level }} ·
            《规范》{{ selectedClause.specClause }}
          </p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button class="btn-ghost !min-h-[44px] !px-5 !text-[15px]" @click="loadMappings">查询</button>
            <button class="btn-ghost !min-h-[44px] !px-5 !text-[15px]" @click="importMappings">批量导入</button>
            <button
              class="btn-ghost !min-h-[44px] !px-5 !text-[15px] !text-brand"
              @click="downloadFile('/admin/mappings/export.xlsx', '映射表.xlsx')"
            >
              导出 Excel
            </button>
          </div>
        </div>

        <div class="border border-gray-200 bg-white p-4">
          <div class="mb-3 grid gap-2 sm:grid-cols-5">
            <select v-model="filters.isoClause" class="field">
              <option value="">全部 ISO 条款</option>
              <option v-for="c in mapping.isoClauses" :key="c" :value="c">{{ c }}</option>
            </select>
            <select v-model="filters.chapterCode" class="field">
              <option value="">全部章节</option>
              <option v-for="c in mapping.chapters" :key="c.code" :value="c.code">{{ c.name }}</option>
            </select>
            <select v-model="filters.way" class="field">
              <option value="">全部对应方式</option>
              <option v-for="w in WAYS" :key="w" :value="w">{{ w }}</option>
            </select>
            <input
              v-model="filters.keyword"
              class="field"
              placeholder="搜索原文/条款号/ISO名称"
              @keyup.enter="((page = 1), loadMappings())"
            />
            <button class="btn-ghost !min-h-[44px] !px-5 !text-[15px]" @click="((page = 1), loadMappings())">筛选</button>
          </div>

          <div class="-mx-4 overflow-x-auto sm:mx-0">
            <table class="w-full min-w-[820px] text-[13px]">
              <thead class="border-b border-gray-200 text-gray-500">
                <tr>
                  <th class="px-4 py-2 text-left">ISO 条款</th>
                  <th class="px-2 py-2 text-left">ISO 名称</th>
                  <th class="px-2 py-2 text-left">检查项</th>
                  <th class="px-2 py-2 text-left">章节</th>
                  <th class="px-2 py-2 text-center">级别</th>
                  <th class="px-2 py-2 text-center">对应方式</th>
                  <th class="px-2 py-2 text-center">启用</th>
                  <th class="px-4 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody class="text-gray-700">
                <tr v-if="loading"><td colspan="8" class="px-4 py-8 text-center text-gray-400">加载中…</td></tr>
                <tr v-else-if="!mapping.list.length">
                  <td colspan="8" class="px-4 py-8 text-center text-gray-400">无匹配记录</td>
                </tr>
                <template v-for="m in mapping.list" :key="m.id">
                  <!-- 正常行 -->
                  <tr v-if="editingId !== m.id" class="border-b border-gray-100">
                    <td class="px-4 py-1.5 font-mono">{{ m.isoClause }}</td>
                    <td class="px-2 py-1.5 text-gray-500">{{ m.isoName || '—' }}</td>
                    <td class="px-2 py-1.5">
                      <span class="font-mono text-gray-400">{{ m.gmpClause.code }}</span>
                      <div class="text-[13px] text-gray-600">{{ m.gmpClause.text.slice(0, 30) }}…</div>
                    </td>
                    <td class="px-2 py-1.5">
                      <div class="text-gray-700">{{ m.gmpClause.chapter.name }}</div>
                      <div class="font-mono text-[12px] text-gray-400">{{ m.gmpClause.chapterCode }}</div>
                    </td>
                    <td class="px-2 py-1.5 text-center">
                      <span
                        class="rounded px-1.5 py-0.5 text-[12px]"
                        :style="{
                          background: `${LEVEL_COLOR[m.gmpClause.level]}1A`,
                          color: LEVEL_COLOR[m.gmpClause.level],
                        }"
                      >
                        {{ m.gmpClause.level }}
                      </span>
                    </td>
                    <td class="px-2 py-1.5 text-center text-[13px]">{{ m.way }}</td>
                    <td class="px-2 py-1.5 text-center">
                      <button
                        class="rounded-md px-2.5 py-1 text-[12px]"
                        :class="m.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-400'"
                        @click="toggleMapping(m)"
                      >
                        {{ m.enabled ? '是' : '否' }}
                      </button>
                    </td>
                    <td class="px-4 py-1.5 text-right">
                      <button class="mr-3 inline-flex min-h-[36px] items-center px-1 font-medium text-brand" @click="startEdit(m)">编辑</button>
                      <button class="inline-flex min-h-[36px] items-center px-1 font-medium text-red-500" @click="delMapping(m)">删除</button>
                    </td>
                  </tr>
                  <!-- 编辑行 -->
                  <tr v-else class="border-b border-gray-100 bg-brand-bg/40">
                    <td class="px-4 py-2 font-mono">{{ m.isoClause }}</td>
                    <td class="px-2 py-2">
                      <input v-model="editRow.isoName" class="field-sm" placeholder="ISO 名称" />
                    </td>
                    <td class="px-2 py-2 text-gray-500">{{ m.gmpClause.code }}</td>
                    <td class="px-2 py-2 text-gray-500">{{ m.gmpClause.chapter.name }}</td>
                    <td class="px-2 py-2 text-center text-gray-500">{{ m.gmpClause.level }}</td>
                    <td class="px-2 py-2">
                      <select v-model="editRow.way" class="rounded border border-gray-200 px-1.5 py-1 text-[13px]">
                        <option v-for="w in WAYS" :key="w" :value="w">{{ w }}</option>
                      </select>
                    </td>
                    <td class="px-2 py-2 text-center text-gray-400">—</td>
                    <td class="px-4 py-2 text-right">
                      <button class="mr-3 inline-flex min-h-[36px] items-center px-1 font-medium text-brand" @click="saveEdit(m)">保存</button>
                      <button class="inline-flex min-h-[36px] items-center px-1 text-gray-500" @click="editingId = ''">取消</button>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
          <div class="mt-3 flex items-center justify-between text-[13px] text-gray-500">
            <span>共 {{ mapping.total }} 条，第 {{ page }} 页</span>
            <div class="flex gap-2">
              <button
                class="min-h-[36px] rounded-lg border border-gray-200 px-3 disabled:opacity-40"
                :disabled="page <= 1"
                @click="page--; loadMappings()"
              >
                上一页
              </button>
              <button
                class="min-h-[36px] rounded-lg border border-gray-200 px-3 disabled:opacity-40"
                :disabled="page * mapping.size >= mapping.total"
                @click="page++; loadMappings()"
              >
                下一页
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- ============ 章节总览 ============ -->
      <section v-else-if="tab === 'chapters'" class="space-y-4">
        <p class="text-[13px] leading-relaxed text-gray-500">
          14 个章节是审核员界面的第一层勾选单元。itemCount / keyCount / mainCount / genCount 反映风险分布，重点章节（focus）需单独统计落地率。
        </p>
        <div class="border border-gray-200 bg-white p-4">
          <div class="-mx-4 overflow-x-auto sm:mx-0">
            <table class="w-full min-w-[520px] text-[13px]">
              <thead class="border-b border-gray-200 text-gray-500">
                <tr>
                  <th class="px-4 py-2 text-left">章节号</th>
                  <th class="px-2 py-2 text-left">章节名称</th>
                  <th class="px-2 py-2 text-right">条款数</th>
                  <th class="px-2 py-2 text-right">关键</th>
                  <th class="px-2 py-2 text-right">主要</th>
                  <th class="px-2 py-2 text-right">一般</th>
                  <th class="px-4 py-2 text-center">重点</th>
                </tr>
              </thead>
              <tbody class="text-gray-700">
                <tr v-if="!chapterOverview.length">
                  <td colspan="7" class="px-4 py-8 text-center text-gray-400">加载中…</td>
                </tr>
                <tr v-for="c in chapterOverview" :key="c.code" class="border-b border-gray-100">
                  <td class="px-4 py-2 font-mono text-gray-400">{{ c.code }}</td>
                  <td class="px-2 py-2">{{ c.name }}</td>
                  <td class="px-2 py-2 text-right font-medium">{{ c.itemCount }}</td>
                  <td class="px-2 py-2 text-right" :style="{ color: c.keyCount ? LEVEL_COLOR['关键'] : '#ccc' }">{{ c.keyCount }}</td>
                  <td class="px-2 py-2 text-right" :style="{ color: c.mainCount ? LEVEL_COLOR['主要'] : '#ccc' }">{{ c.mainCount }}</td>
                  <td class="px-2 py-2 text-right text-gray-500">{{ c.genCount }}</td>
                  <td class="px-4 py-2 text-center">
                    <span v-if="c.focus" class="rounded bg-brand/10 px-1.5 py-0.5 text-[12px] text-brand">重点</span>
                    <span v-else class="text-gray-300">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="mt-3 flex flex-wrap gap-4 border-t border-gray-100 pt-3 text-[13px] text-gray-500">
            <span>章节合计 <b class="text-gray-800">{{ chapterOverview.length }}</b> 章</span>
            <span>条款合计 <b class="text-gray-800">{{ chapterOverview.reduce((s, c) => s + c.itemCount, 0) }}</b> 条</span>
            <span>关键项 <b class="text-gray-800">{{ chapterOverview.reduce((s, c) => s + c.keyCount, 0) }}</b> 条</span>
            <span>主要项 <b class="text-gray-800">{{ chapterOverview.reduce((s, c) => s + c.mainCount, 0) }}</b> 条</span>
          </div>
        </div>
      </section>

      <!-- ============ 用户 ============ -->
      <section v-else-if="tab === 'users'" class="space-y-4">
        <div class="border border-gray-200 bg-white p-4">
          <h3 class="mb-3 text-sm font-semibold">新增用户</h3>
          <div class="grid gap-2 sm:grid-cols-5">
            <input v-model="newUser.username" class="field" placeholder="登录名" />
            <input v-model="newUser.name" class="field" placeholder="真实姓名" />
            <select v-model="newUser.role" class="field">
              <option value="auditor">审核员（免密）</option>
              <option value="leader">组长</option>
              <option value="admin">管理员</option>
            </select>
            <input
              v-if="newUser.role !== 'auditor'"
              v-model="newUser.password"
              class="field"
              placeholder="初始密码（≥6位）"
            />
            <input v-else class="field text-gray-400" value="免密登录" disabled />
            <button class="btn-primary !min-h-[44px] !px-5 !text-[15px]" @click="addUser">添加</button>
          </div>
          <p class="mt-2 text-[13px] text-gray-400">
            审核员免密登录，登录名建议与姓名一致，便于审核计划按姓名自动归入审核组。
          </p>
        </div>

        <div class="border border-gray-200 bg-white p-4">
          <div class="-mx-4 overflow-x-auto sm:mx-0">
            <table class="w-full min-w-[520px] text-[13px]">
              <thead class="border-b border-gray-200 text-gray-500">
                <tr>
                  <th class="px-4 py-2 text-left">登录名</th>
                  <th class="px-2 py-2 text-left">姓名</th>
                  <th class="px-2 py-2 text-center">角色</th>
                  <th class="px-2 py-2 text-center">状态</th>
                  <th class="px-4 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody class="text-gray-700">
                <tr v-for="u in users" :key="u.id" class="border-b border-gray-100">
                  <td class="px-4 py-2 font-mono">{{ u.username }}</td>
                  <td class="px-2 py-2">{{ u.name }}</td>
                  <td class="px-2 py-2 text-center">{{ ROLE_LABEL[u.role] || u.role }}</td>
                  <td class="px-2 py-2 text-center">
                    <button
                      class="rounded-md px-2.5 py-1 text-[12px]"
                      :class="u.active ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-400'"
                      @click="toggleUser(u)"
                    >
                      {{ u.active ? '启用' : '禁用' }}
                    </button>
                  </td>
                  <td class="px-4 py-2 text-right">
                    <button v-if="u.role !== 'auditor'" class="mr-3 inline-flex min-h-[36px] items-center px-1 font-medium text-brand" @click="resetPwd(u)">重置密码</button>
                    <button class="inline-flex min-h-[36px] items-center px-1 font-medium text-red-500" @click="delUser(u)">删除</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- ============ 项目归档 ============ -->
      <section v-else-if="tab === 'projects'" class="border border-gray-200 bg-white p-4">
        <h3 class="mb-3 text-sm font-semibold">全部项目</h3>
        <div class="-mx-4 overflow-x-auto sm:mx-0">
          <table class="w-full min-w-[620px] text-[13px]">
            <thead class="border-b border-gray-200 text-gray-500">
              <tr>
                <th class="px-4 py-2 text-left">企业名称</th>
                <th class="px-2 py-2 text-left">审核日期</th>
                <th class="px-2 py-2 text-center">状态</th>
                <th class="px-2 py-2 text-right">已分派</th>
                <th class="px-2 py-2 text-right">未落地</th>
                <th class="px-4 py-2 text-right">操作</th>
              </tr>
            </thead>
            <tbody class="text-gray-700">
              <tr v-for="p in projects" :key="p.id" class="border-b border-gray-100">
                <td class="px-4 py-2">{{ p.name }}</td>
                <td class="px-2 py-2">{{ (p.auditDate || '').slice(0, 10) }}</td>
                <td class="px-2 py-2 text-center">{{ p.status === 'archived' ? '已归档' : '进行中' }}</td>
                <td class="px-2 py-2 text-right">{{ p.assignedTotal ?? 0 }}</td>
                <td class="px-2 py-2 text-right" :style="{ color: p.notLanded ? LEVEL_COLOR['关键'] : '#ccc' }">{{ p.notLanded ?? 0 }}</td>
                <td class="px-4 py-2 text-right">
                  <button class="mr-3 inline-flex min-h-[36px] items-center px-1 font-medium text-brand" @click="router.push(`/leader/project/${p.id}`)">查看</button>
                  <button class="mr-3 inline-flex min-h-[36px] items-center px-1 text-gray-500" @click="downloadFile(`/projects/${p.id}/export`, `项目-${p.id}.json`)">导出</button>
                  <button class="text-brand" @click="archiveProject(p)">{{ p.status === 'archived' ? '恢复' : '归档' }}</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ============ 日志 ============ -->
      <section v-else class="border border-gray-200 bg-white p-4">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="text-sm font-semibold">操作日志（共 {{ logs.total }} 条）</h3>
          <button
            class="btn-ghost !min-h-[44px] !px-5 !text-[15px] !text-brand"
            @click="downloadFile('/admin/logs/export', '操作日志.csv')"
          >
            导出 CSV
          </button>
        </div>
        <div class="-mx-4 overflow-x-auto sm:mx-0">
          <table class="w-full min-w-[620px] text-[13px]">
            <thead class="border-b border-gray-200 text-gray-500">
              <tr>
                <th class="px-4 py-2 text-left">时间</th>
                <th class="px-2 py-2 text-left">用户</th>
                <th class="px-2 py-2 text-left">操作</th>
                <th class="px-2 py-2 text-left">对象</th>
                <th class="px-4 py-2 text-left">详情</th>
              </tr>
            </thead>
            <tbody class="text-gray-700">
              <tr v-for="l in logs.list" :key="l.id" class="border-b border-gray-100">
                <td class="whitespace-nowrap px-4 py-1.5 text-gray-500">{{ new Date(l.createdAt).toLocaleString('zh-CN') }}</td>
                <td class="px-2 py-1.5">{{ l.userName || '—' }}</td>
                <td class="px-2 py-1.5 font-mono text-[12px]">{{ l.action }}</td>
                <td class="px-2 py-1.5 text-[12px] text-gray-400">{{ l.target }}</td>
                <td class="max-w-[240px] truncate px-4 py-1.5 text-[12px] text-gray-400">{{ l.detail }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>
