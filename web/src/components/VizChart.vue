<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';

Chart.register(LineController, LineElement, PointElement, BarController, BarElement, LinearScale, CategoryScale, Tooltip, Legend, Filler);

/** 通用图表容器：config 变化即重画。高度由外层决定。 */
const props = withDefaults(defineProps<{ config: ChartConfiguration; height?: number; label: string }>(), { height: 260 });
const canvas = ref<HTMLCanvasElement | null>(null);
let chart: Chart | null = null;

function render() {
  if (!canvas.value) return;
  chart?.destroy();
  chart = new Chart(canvas.value, props.config);
}

onMounted(render);
watch(() => props.config, render);
onBeforeUnmount(() => chart?.destroy());
</script>

<template>
  <div :style="{ position: 'relative', height: `${height}px` }">
    <canvas ref="canvas" role="img" :aria-label="label" />
  </div>
</template>
