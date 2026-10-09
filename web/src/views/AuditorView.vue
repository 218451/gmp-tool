<script setup lang="ts">
/** 审核员首页：自动列出自己参与的项目 + 条款总量与异常数 */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, clearSession, getStoredUser } from '../api';
import { pendingTotal } from '../sync';
import type { MyProjectRow } from '../types';

const router = useRouter();
const rows = ref<MyProjectRow[]>([]);
const loading = ref(true);
const user = getStoredUser();
const pending = ref(0);

onMounted(async () => {
  pending.value = pendingTotal();
  window.addEventListener('gmp-queue-change', function h(e: Event) {
    pending.value = (e as CustomEvent).detail ?? 0;
  } as any);
  try {
    rows.value = await api.get<MyProjectRow[]>('/assessments/projects');
  } catch (e: any) {
    alert(e.message);
  } finally {
    loading.value = false;
  }
});

function logout() {
  clearSession();
  router.push('/login');
}
</script>

<template>
  <div class="min-h-screen bg-brand-bg">
    <header class="sticky top-0 z-10 bg-brand px-8 py-5 text-white">
      <div class="page !py-0">
        <div class="flex items-center justify-between gap-4">
          <div>
            <div class="text-xl font-semibold">{{ user?.name }}</div>
            <div class="mt-1 text-sm opacity-75">审核员 · GMP 落地采集</div>
          </div>
          <button class="btn-onbrand" @click="logout">退 出</button>
        </div>
      </div>
    </header>

    <main class="page">
      <p class="alert-warn mb-6">
        审核采用<b class="text-gray-900">默认全选已落地</b>模式：进入项目后按指导原则的章找到条款，
        只需<b class="text-gray-900">取消勾选</b>未落实的项。
      </p>

      <div v-if="loading" class="py-24 text-center text-base text-gray-400">加载中…</div>

      <div v-else-if="!rows.length" class="panel py-24 text-center">
        <p class="text-lg text-gray-600">暂未分配审核任务</p>
        <p class="mt-2 text-sm text-gray-400">
          请先在登录页注册账号（姓名须与审核计划一致），随后等待组长上传审核计划，系统会自动把您加入对应审核组。
        </p>
      </div>

      <ul v-else class="grid gap-4 lg:grid-cols-2">
        <li v-for="p in rows" :key="p.id">
          <button
            class="flex min-h-[132px] w-full flex-col justify-between rounded-2xl border border-gray-200 bg-white p-6 text-left shadow-sm transition hover:border-brand hover:shadow-md"
            @click="router.push(`/auditor/project/${p.id}`)"
          >
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0 flex-1">
                <div class="text-lg font-semibold text-gray-900">{{ p.name }}</div>
                <div class="mt-1.5 text-sm text-gray-500">审核日期 {{ (p.auditDate || '').slice(0, 10) }}</div>
              </div>
              <div class="shrink-0 text-right">
                <div class="text-3xl font-bold leading-none text-brand">
                  {{ p.total ?? 0 }}<span class="text-sm font-normal text-gray-400"> 项</span>
                </div>
                <div class="mt-1.5 text-xs text-gray-400">待审检查项</div>
              </div>
            </div>
            <div class="mt-4 flex items-center justify-between">
              <span
                v-if="(p.abnormal ?? 0) > 0"
                class="rounded-lg bg-red-50 px-3 py-1 text-sm font-semibold text-red-700"
              >
                未落地 {{ p.abnormal }} 项
              </span>
              <span v-else class="rounded-lg bg-gray-100 px-3 py-1 text-sm text-gray-600">暂无未落地</span>
              <span class="btn-ghost !min-h-[44px] !px-5 !text-sm">进入审核 ›</span>
            </div>
          </button>
        </li>
      </ul>

      <p v-if="pending" class="alert-warn mt-6">
        有 {{ pending }} 项本地暂存未上传，恢复网络后会自动同步。
      </p>
    </main>
  </div>
</template>
