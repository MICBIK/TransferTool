<script setup lang="ts">
import { computed } from 'vue';
import { HEALTH_META, pct, type HourCell } from '../health';

/** 近 24 小时状态条：每小时一格，按成功率着色；没有请求的格子是浅灰。 */
const props = withDefaults(defineProps<{ cells: HourCell[]; okRate?: number; degradedRate?: number; height?: number }>(), { okRate: 95, degradedRate: 80, height: 18 });

const EMPTY = '#e5e4e0';
const pad = (n: number) => String(n).padStart(2, '0');

const view = computed(() => {
  const hourNow = new Date();
  hourNow.setMinutes(0, 0, 0);
  const n = props.cells.length;
  return props.cells.map((c, i) => {
    const start = new Date(hourNow.getTime() - (n - 1 - i) * 3600_000);
    const when = `${pad(start.getHours())}:00`;
    if (c.requests === 0) return { color: EMPTY, title: `${when} 没有请求` };
    const r = (c.requests - c.errors) / c.requests;
    const color = r * 100 >= props.okRate ? HEALTH_META.healthy.color : r * 100 >= props.degradedRate ? HEALTH_META.degraded.color : HEALTH_META.down.color;
    return { color, title: `${when} 成功率 ${pct(r)}（${c.requests - c.errors}/${c.requests}）` };
  });
});
</script>

<template>
  <div class="strip" :style="{ height: `${height}px` }" role="img" aria-label="近 24 小时每小时成功率">
    <span v-for="(c, i) in view" :key="i" :style="{ background: c.color }" :title="c.title" />
  </div>
</template>

<style scoped>
.strip {
  display: flex;
  gap: 2px;
  min-width: 96px;
}
.strip span {
  flex: 1;
  border-radius: 2px;
  min-width: 2px;
}
</style>
