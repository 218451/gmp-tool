<script setup lang="ts">
/**
 * 登录 / 注册页 —— ★ 三种身份入口，二选一即可进系统
 * ----------------------------------------------------------------
 * 设计口径（负责人明确）：
 *   「登录页需支持用户自行注册（录入姓名等信息），不能依赖审核组长先建计划。
 *     系统要支持几十个组同时独立使用，避免互相干扰。」
 *
 * 因此本页做三件事：
 *   1. 登录与注册同页切换，组长不必先去后台建账号
 *   2. 审核员入口改为「姓名 + 密码」优先、无密码者仍可姓名直进
 *      （有密码是为了几十个组并行时同名不撞号，无密码是为了现场少一步）
 *   3. 姓名不再从接口拉全库名录（那是把全体审核员名册挂在公网上），
 *      改为本地记忆 + 计划导入自动建号
 *
 * 尺寸口径：桌面端优先，按钮与输入框一律 min-h-[48px]，主操作按钮 h-14。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, authApi, setSession, clearSession } from '../api';
import type { Role } from '../types';

const router = useRouter();
const mode = ref<'login' | 'register'>('login');
const role = ref<Role>('auditor');
const username = ref('');
const password = ref('');
const regName = ref('');
const regPhone = ref('');
const regPassword = ref('');
const regOrg = ref('');
const loading = ref(false);
const error = ref('');
const notice = ref('');

const LAST_KEY = 'gmp_last_identity';

const ROLES: { key: Role; label: string; desc: string }[] = [
  // 组长在现场也要下厂填记录，因此与审核员同走一个入口
  { key: 'auditor', label: '审核员 / 组长', desc: '现场采集' },
  { key: 'leader', label: '审核组长', desc: '上传计划 · 出报告' },
  { key: 'admin', label: '系统管理员', desc: '配置与维护' },
];

function home(r: Role) {
  return r === 'auditor' ? '/auditor' : r === 'leader' ? '/leader' : '/admin';
}

function fail(msg: string, hint?: string) {
  error.value = hint ? `${msg}（${hint}）` : msg;
}

async function submit() {
  error.value = '';
  notice.value = '';
  loading.value = true;
  try {
    if (mode.value === 'register') return await doRegister();
    return await doLogin();
  } catch (e: any) {
    fail(e?.message || '操作失败');
  } finally {
    loading.value = false;
  }
}

async function doLogin() {
  if (!username.value.trim()) return fail('请填写姓名或账号');
  clearSession();
  if (role.value === 'auditor') {
    const r = await authApi.loginAuditor(username.value.trim(), password.value);
    setSession(r.token, r.user);
    localStorage.setItem(LAST_KEY, JSON.stringify({ name: r.user.name }));
    if (!r.projects?.length) {
      notice.value = '账号已登录，但还没有项目。审核员需等组长上传审核计划后才会看到章节。';
      router.push('/auditor');
      return;
    }
    // 只参与一个项目直接进项目页，减少一次点击
    if (r.projects.length === 1) router.push(`/auditor/project/${r.projects[0].id}`);
    else router.push('/auditor');
    return;
  }
  const r = await authApi.login(username.value.trim(), password.value, role.value);
  setSession(r.token, r.user);
  router.push(home(role.value));
}

async function doRegister() {
  if (!regName.value.trim()) return fail('请填写姓名');
  if (!/^\d{11}$/.test(regPhone.value.trim())) return fail('请填写 11 位手机号');
  if (regPassword.value.length < 6) return fail('密码至少 6 位');
  const r = await authApi.register({
    name: regName.value.trim(),
    phone: regPhone.value.trim(),
    password: regPassword.value,
    role: role.value === 'admin' ? 'leader' : role.value,
    org: regOrg.value.trim(),
  });
  setSession(r.token, r.user);
  localStorage.setItem(LAST_KEY, JSON.stringify({ name: r.user.name }));
  if (r.upgraded) {
    notice.value = '注册成功，并已关联到组长此前上传的审核计划。';
  } else {
    notice.value = role.value === 'leader' ? '注册成功，请上传 Word 版审核计划。' : '注册成功，请等待组长上传审核计划后登录采集。';
  }
  mode.value = 'login';
  username.value = r.user.name;
  password.value = '';
  error.value = '';
}

/** 审核员入口是否需要密码：有历史账号时提示，但不强制 */
const needPwdHint = computed(() => mode.value === 'login' && role.value === 'auditor' && !!password.value.length);

onMounted(() => {
  try {
    const last = JSON.parse(localStorage.getItem(LAST_KEY) || '{}');
    if (last?.name) username.value = last.name;
  } catch {
    /* 本地记忆损坏时忽略即可 */
  }
});

function switchMode(m: 'login' | 'register') {
  mode.value = m;
  error.value = '';
  notice.value = '';
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center px-6 py-12">
    <div class="w-full max-w-lg">
      <div class="mb-8 text-center">
        <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand text-xl font-bold text-white">GMP</div>
        <h1 class="text-2xl font-semibold tracking-wide text-gray-800">新版 GMP 落地增值评估工具</h1>
        <p class="mt-2 text-sm text-gray-500">ISO 13485 现场审核 · 条款落地核查与报告</p>
      </div>

      <!-- 登录 / 注册 切换 -->
      <div class="mb-5 grid grid-cols-2 gap-2 rounded-xl bg-gray-100 p-1.5">
        <button
          type="button"
          class="h-12 rounded-lg text-base font-medium transition"
          :class="mode === 'login' ? 'bg-white text-brand shadow-sm' : 'text-gray-500 hover:text-gray-700'"
          @click="switchMode('login')"
        >
          登录
        </button>
        <button
          type="button"
          class="h-12 rounded-lg text-base font-medium transition"
          :class="mode === 'register' ? 'bg-white text-brand shadow-sm' : 'text-gray-500 hover:text-gray-700'"
          @click="switchMode('register')"
        >
          注册账号
        </button>
      </div>

      <div class="rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
        <!-- 角色选择 -->
        <label class="mb-2 block text-sm font-medium text-gray-700">选择角色</label>
        <div class="mb-6 grid grid-cols-3 gap-2.5">
          <button
            v-for="r in ROLES"
            :key="r.key"
            type="button"
            class="h-[68px] rounded-xl border-2 px-2 py-2 transition"
            :class="role === r.key ? 'border-brand bg-brand/5 text-brand' : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'"
            @click="role = r.key"
          >
            <div class="text-sm font-semibold leading-tight">{{ r.label }}</div>
            <div class="mt-1 text-[11px] opacity-80">{{ r.desc }}</div>
          </button>
        </div>

        <!-- ============ 登录表单 ============ -->
        <template v-if="mode === 'login'">
          <label class="mb-2 block text-sm font-medium text-gray-700">
            {{ role === 'auditor' ? '姓名' : '账号' }}
          </label>
          <input
            v-model="username"
            type="text"
            autocomplete="name"
            :placeholder="role === 'auditor' ? '请输入你的真实姓名' : '管理员 admin / 组长账号'"
            class="mb-5 h-14 w-full rounded-xl border-2 border-gray-200 px-4 text-base outline-none transition focus:border-brand focus:ring-4 focus:ring-brand/10"
            @keyup.enter="submit"
          />

          <label class="mb-2 block text-sm font-medium text-gray-700">
            密码
            <span v-if="role === 'auditor'" class="ml-1 text-xs font-normal text-gray-400">（计划自动建号者可留空）</span>
          </label>
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="注册时设置的密码"
            class="h-14 w-full rounded-xl border-2 border-gray-200 px-4 text-base outline-none transition focus:border-brand focus:ring-4 focus:ring-brand/10"
            @keyup.enter="submit"
          />
          <p v-if="needPwdHint" class="mt-2 text-xs text-gray-400">已填写密码。若该账号尚未设置密码，可清空本框直接进入。</p>

          <p v-if="error" class="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-relaxed text-red-700">
            {{ error }}
          </p>
          <p v-if="notice" class="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-relaxed text-emerald-700">
            {{ notice }}
          </p>

          <button
            type="button"
            class="mt-6 h-14 w-full rounded-xl bg-brand text-lg font-semibold text-white transition hover:bg-brand-light active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="loading"
            @click="submit"
          >
            {{ loading ? '处理中…' : role === 'auditor' ? '进入审核' : '登 录' }}
          </button>

          <p class="mt-4 text-center text-sm text-gray-500">
            还没有账号？
            <button type="button" class="font-semibold text-brand underline underline-offset-2" @click="switchMode('register')">
              立即注册
            </button>
          </p>
        </template>

        <!-- ============ 注册表单 ============ -->
        <template v-else>
          <div class="grid gap-5 sm:grid-cols-2">
            <div class="sm:col-span-2">
              <label class="mb-2 block text-sm font-medium text-gray-700">姓名 <span class="text-red-500">*</span></label>
              <input
                v-model="regName"
                type="text"
                autocomplete="name"
                placeholder="与审核计划一致的实名"
                class="h-14 w-full rounded-xl border-2 border-gray-200 px-4 text-base outline-none transition focus:border-brand focus:ring-4 focus:ring-brand/10"
              />
              <p class="mt-1.5 text-xs text-gray-400">必须与审核计划里的姓名一致，否则无法自动关联到您的审核组</p>
            </div>

            <div>
              <label class="mb-2 block text-sm font-medium text-gray-700">手机号 <span class="text-red-500">*</span></label>
              <input
                v-model="regPhone"
                type="tel"
                inputmode="numeric"
                autocomplete="tel"
                maxlength="11"
                placeholder="11 位手机号"
                class="h-14 w-full rounded-xl border-2 border-gray-200 px-4 text-base outline-none transition focus:border-brand focus:ring-4 focus:ring-brand/10"
              />
              <p class="mt-1.5 text-xs text-gray-400">作为登录账号</p>
            </div>

            <div>
              <label class="mb-2 block text-sm font-medium text-gray-700">密码 <span class="text-red-500">*</span></label>
              <input
                v-model="regPassword"
                type="password"
                autocomplete="new-password"
                placeholder="至少 6 位"
                class="h-14 w-full rounded-xl border-2 border-gray-200 px-4 text-base outline-none transition focus:border-brand focus:ring-4 focus:ring-brand/10"
                @keyup.enter="submit"
              />
            </div>

            <div class="sm:col-span-2">
              <label class="mb-2 block text-sm font-medium text-gray-700">单位 / 部门（选填）</label>
              <input
                v-model="regOrg"
                type="text"
                placeholder="如：华光认证审核部"
                class="h-14 w-full rounded-xl border-2 border-gray-200 px-4 text-base outline-none transition focus:border-brand focus:ring-4 focus:ring-brand/10"
                @keyup.enter="submit"
              />
            </div>
          </div>

          <p v-if="error" class="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-relaxed text-red-700">
            {{ error }}
          </p>
          <p v-if="notice" class="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-relaxed text-emerald-700">
            {{ notice }}
          </p>

          <button
            type="button"
            class="mt-6 h-14 w-full rounded-xl bg-brand text-lg font-semibold text-white transition hover:bg-brand-light active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="loading"
            @click="submit"
          >
            {{ loading ? '注册中…' : '注册并进入' }}
          </button>

          <p class="mt-4 text-center text-sm text-gray-500">
            已有账号？
            <button type="button" class="font-semibold text-brand underline underline-offset-2" @click="switchMode('login')">
              返回登录
            </button>
          </p>
        </template>
      </div>

      <div class="mt-6 space-y-2 rounded-xl border border-gray-200 bg-white/70 p-5 text-xs leading-relaxed text-gray-500">
        <div><b class="text-gray-700">审核员</b>：注册后等待组长上传 Word 审核计划，系统按姓名自动把您加入对应审核组。</div>
        <div><b class="text-gray-700">审核组长</b>：注册后直接上传 Word 版审核计划，企业名称与分工由系统自动识别。</div>
        <div><b class="text-gray-700">数据隔离</b>：每个项目（受审核企业）数据独立，您只能看到自己参与的项目。</div>
        <div class="text-gray-400">系统管理员账号 admin，由系统维护方提供，不对外自助注册。</div>
      </div>
    </div>
  </div>
</template>