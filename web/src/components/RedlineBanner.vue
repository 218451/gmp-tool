<script setup lang="ts">
/** 红线预警横幅：四个阈值实时显示，触发即高亮（阈值取后端 redline.thresholds） */
import { computed } from 'vue';
import type { Redline } from '../types';

const props = defineProps<{ redline: Redline }>();

const rules = computed(() => {
  const t = props.redline.thresholds;
  return [
    { label: '关键项不符合', value: props.redline.keyNotMet, limit: t.keyNotMet, hit: props.redline.keyNotMet >= t.keyNotMet },
    { label: '关键+主要', value: props.redline.keyPlusMainNotMet, limit: t.keyPlusMain, hit: props.redline.keyPlusMainNotMet >= t.keyPlusMain },
    { label: '一般项不符合', value: props.redline.generalNotMet, limit: t.generalNotMet, hit: props.redline.generalNotMet >= t.generalNotMet },
    { label: '总不符合', value: props.redline.totalNotMet, limit: t.totalNotMet, hit: props.redline.totalNotMet >= t.totalNotMet },
  ];
});
</script>

<template>
  <div class="border p-4" :class="redline.triggered ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-white'">
    <div class="flex items-center gap-2">
      <span
        class="inline-flex h-6 w-6 items-center justify-center rounded-full text-sm font-bold text-white"
        :class="redline.triggered ? 'bg-red-600' : 'bg-brand'"
      >
        {{ redline.triggered ? '!' : '✓' }}
      </span>
      <h3 class="text-sm font-semibold" :class="redline.triggered ? 'text-red-800' : 'text-gray-800'">
        {{ redline.triggered ? '已触发红线预警' : '红线预警未触发' }}
      </h3>
    </div>

    <div class="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
      <div
        v-for="r in rules"
        :key="r.label"
        class="border px-2 py-2"
        :class="r.hit ? 'border-red-300 bg-white' : 'border-gray-200 bg-brand-bg/40'"
      >
        <div class="text-[11px] text-gray-500">{{ r.label }}</div>
        <div class="text-lg font-bold leading-tight" :class="r.hit ? 'text-red-600' : 'text-gray-700'">
          {{ r.value }}<span class="text-xs font-normal text-gray-400">/{{ r.limit }}</span>
        </div>
      </div>
    </div>

    <ul v-if="redline.reasons.length" class="mt-3 space-y-1 text-xs text-red-700">
      <li v-for="(r, i) in redline.reasons" :key="i">· {{ r }}</li>
    </ul>
  </div>
</template>
