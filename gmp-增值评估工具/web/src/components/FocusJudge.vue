<script setup lang="ts">
/**
 * 四态判定条 —— 点击即存，无提交按钮
 * 「已落地」为默认态，再点一次其他态可回到已落地（不是取消，而是改判）。
 */
import { STATUS_COLOR, STATUS_LABEL, type FocusItem, type Status } from '../types';

const props = defineProps<{ f: FocusItem }>();
const emit = defineEmits<{ (e: 'judge', s: Status): void }>();

const ORDER: Status[] = ['landed', 'partial', 'not_landed', 'na'];
</script>

<template>
  <div class="mt-2 grid grid-cols-4 gap-1">
    <button
      v-for="s in ORDER"
      :key="s"
      class="min-h-[36px] rounded border text-[11px] transition"
      :style="
        props.f.status === s
          ? { background: STATUS_COLOR[s], borderColor: STATUS_COLOR[s], color: '#fff', fontWeight: 600 }
          : { borderColor: '#E5E7EB', color: '#6B7280' }
      "
      @click="emit('judge', s)"
    >
      {{ STATUS_LABEL[s] }}
    </button>
  </div>
</template>