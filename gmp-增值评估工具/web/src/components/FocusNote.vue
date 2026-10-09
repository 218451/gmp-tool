<script setup lang="ts">
/**
 * 现场记录框（A 方案的核心新增能力）
 * ----------------------------------------------------------------
 * 审核记录模板右栏本来就是给审核员写字的，网页端必须保留这个能力，
 * 否则这套模板的专业价值就丢了。
 * 保存方式：输入即入 localStorage 队列，600ms 防抖后自动同步（无提交按钮）。
 */
import { ref } from 'vue';
import type { FocusItem } from '../types';

const props = defineProps<{ f: FocusItem }>();
const emit = defineEmits<{ (e: 'input'): void; (e: 'toggle'): void }>();

const open = ref(!!props.f.note);
const evidenceText = ref(props.f.evidence.join('\n'));

function onInput() {
  emit('input');
}

function onEvidence() {
  props.f.evidence = evidenceText.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  emit('input');
}
</script>

<template>
  <div class="mt-2">
    <button
      v-if="!open"
      class="flex min-h-[32px] w-full items-center justify-between rounded border border-dashed border-gray-300 px-2 text-[11px] text-gray-500 active:bg-gray-50"
      @click="emit('toggle')"
    >
      <span>{{ props.f.note ? '编辑记录' : '＋ 记录现场情况' }}</span>
      <span v-if="props.f.note" class="text-gray-400">已填 {{ props.f.note.length }} 字</span>
    </button>

    <div v-else class="space-y-1.5">
      <textarea
        :value="props.f.note"
        rows="3"
        :placeholder="props.f.checklist.length ? `对照上方「记录要点」逐条落实情况，例如：\\n${props.f.checklist[0].slice(0, 28)}… → 已核实，证据 QP-013 Rev.5` : '现场观察到的客观事实：访谈对象、文件编号、记录数据、偏差表现…'"
        class="w-full resize-y rounded border border-gray-300 px-2 py-1.5 text-[12px] leading-relaxed text-gray-800 outline-none focus:border-brand"
        @input="(e: Event) => { props.f.note = (e.target as HTMLTextAreaElement).value; onInput(); }"
      ></textarea>
      <details class="text-[11px]">
        <summary class="cursor-pointer select-none text-gray-500">
          客观证据（文件号/记录号，一行一条）
          <span v-if="props.f.evidence.length" class="text-gray-400">· 已填 {{ props.f.evidence.length }} 条</span>
        </summary>
        <textarea
          v-model="evidenceText"
          rows="2"
          placeholder="如：&#10;QP-013 Rev.5&#10;批生产记录 B260301"
          class="mt-1 w-full resize-y rounded border border-gray-300 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-gray-700 outline-none focus:border-brand"
          @blur="onEvidence"
        ></textarea>
      </details>
      <button class="min-h-[30px] rounded border border-gray-300 px-3 text-[11px] text-gray-600 active:bg-gray-50" @click="emit('toggle')">
        收起记录
      </button>
    </div>
  </div>
</template>