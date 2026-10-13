<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { CategoryScale, Chart, Filler, Legend, LineController, LineElement, LinearScale, PointElement, Tooltip } from 'chart.js';
import { SERIES_COLORS, STATUS_CRITICAL, axisUsd } from '../dashboard';
import { useNarrow } from '../narrow';
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

const narrow = useNarrow();
const TICK = '#6b6a66';

function render() {
  if (!canvas.value) return;
  const pts = downsample(props.points);
  const labels = pts.map((p) => label(p.ts));
  const flat = (v: number) => pts.map(() => v);
  const datasets = [
    { label: '余额', data: pts.map((p) => p.balanceUsd), borderColor: SERIES_COLORS[0], backgroundColor: 'rgba(42,120,214,0.08)', fill: true, tension: 0.25, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2, borderDash: [] as number[] },
    { label: '提醒阈值', data: flat(props.threshold), borderColor: '#c98500', backgroundColor: '#c98500', borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 0, borderWidth: 1.5, fill: false, tension: 0 },
  ];
  if (props.emergencyThreshold !== null) {
    datasets.push({ label: '紧急阈值', data: flat(props.emergencyThreshold), borderColor: STATUS_CRITICAL, backgroundColor: STATUS_CRITICAL, borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 0, borderWidth: 1.5, fill: false, tension: 0 });
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
        x: { grid: { display: false }, ticks: { color: TICK, maxTicksLimit: narrow.value ? 4 : 7, maxRotation: 0, callback: (_v, i) => (narrow.value ? labels[i]?.slice(0, 5) : labels[i]) } },
        y: { beginAtZero: true, grid: { color: '#ecebe8' }, border: { display: false }, ticks: { color: TICK, maxTicksLimit: 5, callback: (v) => axisUsd(Number(v)) } },
      },
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, pointStyle: 'line', color: TICK } },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}：$${Number(ctx.parsed.y).toFixed(2)}` } },
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
  <div :style="{ position: 'relative', height: narrow ? '220px' : '280px' }">
    <canvas ref="canvas" role="img" aria-label="余额变化曲线"></canvas>
  </div>
</template>
