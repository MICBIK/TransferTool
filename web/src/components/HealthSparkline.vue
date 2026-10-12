<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { CategoryScale, Chart, Filler, LineController, LineElement, LinearScale, PointElement, Tooltip } from 'chart.js';
import type { TrendPoint } from '../health';
import { HEALTH_META } from '../health';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Filler);

const props = defineProps<{ points: TrendPoint[] }>();
const canvas = ref<HTMLCanvasElement | null>(null);
let chart: Chart | null = null;

const pad = (n: number) => String(n).padStart(2, '0');
const label = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function render() {
  if (!canvas.value) return;
  chart?.destroy();
  const pts = props.points;
  chart = new Chart(canvas.value, {
    type: 'line',
    data: {
      labels: pts.map((p) => label(p.start)),
      datasets: [
        {
          label: '成功率',
          // 该时间槽没有请求时留空（断线），而不是画成 0%
          data: pts.map((p) => (p.successRate === null ? null : Math.round(p.successRate * 1000) / 10)),
          borderColor: HEALTH_META.healthy.color,
          backgroundColor: 'rgba(24,160,88,0.12)',
          fill: true,
          tension: 0.2,
          pointRadius: 1.5,
          borderWidth: 1.5,
          spanGaps: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { display: false },
        y: { min: 0, max: 100, ticks: { stepSize: 50, callback: (v) => `${v}%`, font: { size: 10 } }, grid: { display: true } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const p = pts[ctx.dataIndex]!;
              return `成功率 ${ctx.parsed.y}%（${p.requests - p.errors}/${p.requests} 次成功）`;
            },
          },
        },
      },
    },
  });
}

onMounted(render);
watch(() => props.points, render);
onBeforeUnmount(() => {
  chart?.destroy();
  chart = null;
});
</script>

<template>
  <div style="position: relative; height: 84px">
    <canvas ref="canvas" role="img" aria-label="近 24 小时成功率趋势"></canvas>
  </div>
</template>
