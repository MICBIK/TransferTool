<script setup lang="ts">
import { NCard } from 'naive-ui';
import { useNarrow } from '../narrow';

/** 指标卡：标签 + 大号数值 + 一行说明（默认插槽）。总览与上游详情共用，保证同一种信息长得一样。 */
defineProps<{ label: string; value: string; color?: string }>();
const narrow = useNarrow();
</script>

<template>
  <n-card size="small" class="tile">
    <div class="label">{{ label }}</div>
    <div class="value" :class="{ narrow }" :style="{ color }">{{ value }}</div>
    <div class="sub"><slot /></div>
  </n-card>
</template>

<style scoped>
.tile {
  height: 100%;
}
.label {
  font-size: 13px;
  color: #6b6a66;
}
.value {
  font-size: 28px;
  font-weight: 600;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.value.narrow {
  font-size: 22px;
}
.sub {
  font-size: 12px;
  color: #6b6a66;
  line-height: 1.6;
}
</style>
