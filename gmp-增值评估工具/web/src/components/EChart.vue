<script setup lang="ts">
/** 可复用 ECharts 封装：自动跟随容器尺寸、主题响应 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import * as echarts from 'echarts';

const props = withDefaults(defineProps<{ option: any; height?: string }>(), { height: '320px' });
const el = ref<HTMLDivElement | null>(null);
const chart = shallowRef<echarts.ECharts | null>(null);
let ro: ResizeObserver | null = null;

onMounted(() => {
  if (!el.value) return;
  chart.value = echarts.init(el.value, undefined, { renderer: 'canvas' });
  chart.value.setOption(props.option);
  // 移动端横竖屏切换 / 侧栏折叠时自动 resize
  ro = new ResizeObserver(() => chart.value?.resize());
  ro.observe(el.value);
});

watch(
  () => props.option,
  (o) => chart.value?.setOption(o, true),
  { deep: true },
);

onBeforeUnmount(() => {
  ro?.disconnect();
  chart.value?.dispose();
});
</script>

<template>
  <div ref="el" :style="{ width: '100%', height: props.height }"></div>
</template>
