<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { CategoryScale, Chart, Filler, Legend, LineController, LineElement, LinearScale, PointElement, Tooltip } from 'chart.js';
import type { HistoryPoint } from '../upstreams';

// 只注册用到的组件，保持打包体积
Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend, Filler);

const props = defineProps<{ points: HistoryPoint[]; threshold: number; emergencyThreshold: number | null }>();
const canvas = ref<HTMLCanvasElement | null>(null);
let chart: Chart | null = null;

const MAX_POINTS = 240;

/** 点太多时按时间桶取每桶最后一个值，避免 30 天曲线过密。 */
function downsample(points: HistoryPoint[]): HistoryPoint[] {
  if (points.length <= MAX_POINTS) return points;
  const size = Math.ceil(points.length / MAX_POINTS);
  const out: HistoryPoint[] = [];
  for (let i = 0; i < points.length; i += size) out.push(points[Math.min(i + size - 1, points.length - 1)]!);
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');
const label = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function render() {
  if (!canvas.value) return;
  const pts = downsample(props.points);
  const labels = pts.map((p) => label(p.ts));
  const datasets = [
    { label: '余额 (USD)', data: pts.map((p) => p.balanceUsd), borderColor: '#2080f0', backgroundColor: 'rgba(32,128,240,0.12)', fill: true, tension: 0.2, pointRadius: pts.length > 60 ? 0 : 3, borderWidth: 2 },
    { label: '提醒阈值', data: pts.map(() => props.threshold), borderColor: '#f0a020', borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5, fill: false },
  ];
  if (props.emergencyThreshold !== null) {
    datasets.push({ label: '紧急阈值', data: pts.map(() => props.emergencyThreshold as number), borderColor: '#d03050', borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5, fill: false } as (typeof datasets)[number]);
  }
  chart?.destroy();
  chart = new Chart(canvas.value, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: false,
      scales: {
        x: { ticks: { maxTicksLimit: 7, maxRotation: 0 } },
        y: { ticks: { callback: (v) => `$${Number(v).toFixed(2)}` } },
      },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: $${Number(ctx.parsed.y).toFixed(2)}` } },
      },
    },
  });
}

onMounted(render);
watch(() => [props.points, props.threshold, props.emergencyThreshold], render);
onBeforeUnmount(() => {
  chart?.destroy();
  chart = null;
});
</script>

<template>
  <div style="position: relative; height: 280px">
    <canvas ref="canvas" role="img" aria-label="余额变化曲线"></canvas>
  </div>
</template>
