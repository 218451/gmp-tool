<script setup lang="ts">
/** 根组件：仅承载路由出口 + 全局同步提示 */
import { onMounted, onUnmounted, ref } from 'vue';
import { pendingTotal } from './sync';

const pending = ref(0);
const onQueue = (e: Event) => {
  pending.value = (e as CustomEvent).detail ?? pendingTotal();
};
onMounted(() => {
  pending.value = pendingTotal();
  window.addEventListener('gpm-queue-change', onQueue);
});
onUnmounted(() => window.removeEventListener('gpm-queue-change', onQueue));
</script>

<template>
  <router-view />

  <!-- 全局弱网提示：待同步条目数（仅审核员端出现） -->
  <div
    v-if="pending > 0"
    class="no-print fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full bg-gray-900/90 px-4 py-2 text-xs text-white shadow-lg"
  >
    <span class="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400"></span>
    {{ pending }} 项待同步，联网后自动上传
  </div>
</template>
