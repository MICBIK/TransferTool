<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { ChartConfiguration, TooltipItem } from 'chart.js';
import { NAlert, NButton, NCard, NDataTable, NEmpty, NGrid, NGridItem, NRadioButton, NRadioGroup, NSpace, NTag, NText, useMessage, type DataTableColumns } from 'naive-ui';
import { ApiError } from '../api';
import { channelSummary } from '../channels';
import HealthNotices from '../components/HealthNotices.vue';
import HealthTag from '../components/HealthTag.vue';
import StatTile from '../components/StatTile.vue';
import VizChart from '../components/VizChart.vue';
import {
  HOUR_MS,
  STATUS_CRITICAL,
  STATUS_GOOD,
  assignEntities,
  axisUsd,
  bucketLabel,
  bucketMs,
  bucketRange,
  bucketStart,
  getDashboard,
  pct,
  type DashboardDays,
  type DashboardSeries,
  type Entity,
} from '../dashboard';
import { getHealth, type HealthOverview, type UpstreamRollup } from '../health';
import { useNarrow } from '../narrow';
import { STATUS_META, burnText, etaSpan, formatAgo, listUpstreams, refreshAll, usd, type Upstream } from '../upstreams';

const message = useMessage();
const narrow = useNarrow();
const days = ref<DashboardDays>(7);
const upstreams = ref<Upstream[]>([]);
const series = ref<DashboardSeries | null>(null);
const health = ref<HealthOverview | null>(null);
const channelsConfigured = ref(false);
const loaded = ref(false);
const refreshing = ref(false);
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

const RANGE_LABEL: Record<DashboardDays, string> = { 1: '近 24 小时', 7: '近 7 天', 30: '近 30 天' };

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : '网络错误，请稍后重试';
}

async function load() {
  try {
    const [list, s] = await Promise.all([listUpstreams(), getDashboard(days.value)]);
    upstreams.value = list;
    series.value = s;
    const summary = await channelSummary().catch(() => null);
    channelsConfigured.value = summary?.configured ?? false;
    health.value = channelsConfigured.value ? await getHealth().catch(() => health.value) : null;
  } catch (err) {
    if (!loaded.value) message.error(errorText(err));
  } finally {
    loaded.value = true;
    now.value = Date.now();
  }
}

async function onRefreshAll() {
  refreshing.value = true;
  try {
    await refreshAll();
    await load();
    message.success('已刷新全部上游余额');
  } catch (err) {
    message.error(errorText(err));
  } finally {
    refreshing.value = false;
  }
}

watch(days, () => void load());
onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 60_000);
});
onBeforeUnmount(() => clearInterval(timer));

// ---------- 汇总 ----------

/** 参与统计的上游：已配置（不含待配置） */
const active = computed(() => upstreams.value.filter((u) => !u.needsSetup));
const rollups = computed(() => new Map<number, UpstreamRollup>((health.value?.upstreams ?? []).map((r) => [r.upstreamId, r])));

const spendBy = computed(() => {
  const m = new Map<number, number>();
  for (const s of series.value?.spend ?? []) m.set(s.upstreamId, s.points.reduce((n, [, v]) => n + v, 0));
  return m;
});
const trafficBy = computed(() => new Map((series.value?.trafficByUpstream ?? []).map((t) => [t.upstreamId, t])));

const kpi = computed(() => {
  const withBalance = active.value.filter((u) => u.enabled && u.balanceUsd !== null && u.status !== 'unsupported');
  const total = withBalance.reduce((n, u) => n + (u.balanceUsd ?? 0), 0);
  const burning = active.value.filter((u) => u.enabled && u.burnBasis === 'estimated' && u.burnUsdPerDay !== null);
  const burn = burning.reduce((n, u) => n + (u.burnUsdPerDay ?? 0), 0);
  const spend = [...spendBy.value.values()].reduce((n, v) => n + v, 0);
  let requests = 0;
  let errors = 0;
  for (const [, r, e] of series.value?.traffic ?? []) {
    requests += r;
    errors += e;
  }
  return {
    total,
    counted: withBalance.length,
    burn,
    burnCounted: burning.length,
    spend,
    requests,
    errors,
    rate: requests > 0 ? (requests - errors) / requests : null,
  };
});

// ---------- 需要处理 ----------

interface Issue {
  key: string;
  level: 'error' | 'warning' | 'info';
  tag: string;
  text: string;
  action: { label: string; to?: string; href?: string };
}

const issues = computed<Issue[]>(() => {
  const out: Issue[] = [];
  for (const u of upstreams.value) {
    if (!u.enabled) continue;
    if (u.needsSetup) {
      out.push({ key: `setup-${u.id}`, level: 'info', tag: '待配置', text: `${u.name}：自动创建的上游，还没填密钥`, action: { label: '填入密钥', to: `/upstreams/${u.id}#config` } });
    } else if (u.status === 'critical' || u.status === 'low') {
      const eta = u.burnBasis === 'estimated' && u.exhaustAt !== null ? `，按当前速度${etaSpan(u.exhaustAt, now.value)}后用完` : '';
      out.push({
        key: `bal-${u.id}`,
        level: u.status === 'critical' ? 'error' : 'warning',
        tag: STATUS_META[u.status].label,
        text: `${u.name}：余额 ${usd(u.balanceUsd)}，低于阈值 ${usd(u.status === 'critical' && u.emergencyThreshold !== null ? u.emergencyThreshold : u.threshold)}${eta}`,
        action: u.effectiveTopupUrl ? { label: '去充值', href: u.effectiveTopupUrl } : { label: '查看', to: `/upstreams/${u.id}` },
      });
    } else if (u.status === 'unknown') {
      out.push({ key: `err-${u.id}`, level: 'error', tag: '查询失败', text: `${u.name}：${u.lastError ?? '余额查询失败'}`, action: { label: '检查配置', to: `/upstreams/${u.id}#config` } });
    }
    const r = rollups.value.get(u.id);
    if (r && (r.status === 'down' || r.status === 'degraded')) {
      out.push({
        key: `health-${u.id}`,
        level: r.status === 'down' ? 'error' : 'warning',
        tag: r.status === 'down' ? '渠道异常' : '渠道降级',
        text: `${u.name}：近 1 小时有渠道成功率偏低`,
        action: { label: '查看渠道', to: `/upstreams/${u.id}#channels` },
      });
    }
  }
  const order = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
});

// ---------- 图表 ----------

const entities = computed<Entity[]>(() =>
  assignEntities(
    active.value.map((u) => ({ id: u.id, name: u.name })),
    (id) => (upstreams.value.find((u) => u.id === id)?.balanceUsd ?? 0) + (spendBy.value.get(id) ?? 0) * 30,
  ),
);
const colorOf = computed(() => {
  const m = new Map<number, string>();
  for (const e of entities.value) for (const id of e.ids) m.set(id, e.color);
  return m;
});

/** 去掉开头全空的部分：刚部署、数据还不满所选区间时，图表从第一条数据开始画 */
function trimLeading<T extends { data: (number | null)[] }>(labels: string[], datasets: T[]): { labels: string[]; datasets: T[] } {
  const first = labels.findIndex((_, i) => datasets.some((d) => d.data[i] !== null && d.data[i] !== 0));
  if (first <= 0) return { labels, datasets };
  return { labels: labels.slice(first), datasets: datasets.map((d) => ({ ...d, data: d.data.slice(first) })) };
}

const GRID = '#ecebe8';
const TICK = '#6b6a66';
const baseScales = (yFormat: (v: number) => string, stacked = false) => ({
  x: { stacked, grid: { display: false }, ticks: { color: TICK, maxRotation: 0, autoSkipPadding: 16 } },
  y: { stacked, beginAtZero: true, grid: { color: GRID }, border: { display: false }, ticks: { color: TICK, maxTicksLimit: 5, callback: (v: string | number) => yFormat(Number(v)) } },
});
const legend = { position: 'bottom' as const, labels: { usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 8, boxHeight: 8, color: TICK } };

const balanceConfig = computed<ChartConfiguration<'line'> | null>(() => {
  const s = series.value;
  if (!s) return null;
  const hours: number[] = [];
  for (let t = Math.floor(s.since / HOUR_MS) * HOUR_MS; t <= s.now; t += HOUR_MS) hours.push(t);
  // 每个上游按小时取值；两次快照之间沿用上一次的余额，曲线不会断开
  const perUpstream = new Map<number, (number | null)[]>();
  for (const b of s.balance) {
    const at = new Map(b.points);
    let last: number | null = null;
    perUpstream.set(
      b.upstreamId,
      hours.map((t) => {
        if (at.has(t)) last = at.get(t)!;
        return last;
      }),
    );
  }
  const datasets = entities.value.map((e) => {
    const data = hours.map((_, i) => {
      const vals = e.ids.map((id) => perUpstream.get(id)?.[i] ?? null).filter((v): v is number => v !== null);
      return vals.length ? Math.round(vals.reduce((n, v) => n + v, 0) * 100) / 100 : null;
    });
    return { label: e.label, data, borderColor: e.color, backgroundColor: e.color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.25, spanGaps: true };
  });
  return {
    type: 'line',
    data: trimLeading(hours.map((t) => bucketLabel(t, HOUR_MS, days.value)), datasets),
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: { ...baseScales(axisUsd), x: { grid: { display: false }, ticks: { color: TICK, maxRotation: 0, maxTicksLimit: narrow.value ? 4 : 8 } } },
      plugins: {
        legend,
        tooltip: { itemSort: (a: TooltipItem<'line'>, b: TooltipItem<'line'>) => Number(b.parsed.y) - Number(a.parsed.y), callbacks: { label: (c: TooltipItem<'line'>) => ` ${c.dataset.label}：${usd(c.parsed.y)}` } },
      },
    },
  };
});

const bucket = computed(() => bucketMs(days.value));
const buckets = computed(() => (series.value ? bucketRange(series.value.since, series.value.now, bucket.value) : []));

const spendConfig = computed<ChartConfiguration<'bar'> | null>(() => {
  const s = series.value;
  if (!s) return null;
  const index = new Map(buckets.value.map((t, i) => [t, i]));
  const per = new Map<number, number[]>();
  for (const sp of s.spend) {
    const arr = buckets.value.map(() => 0);
    for (const [t, v] of sp.points) {
      const i = index.get(bucketStart(t, bucket.value));
      if (i !== undefined) arr[i]! += v;
    }
    per.set(sp.upstreamId, arr);
  }
  const datasets = entities.value
    .map((e) => ({
      label: e.label,
      data: buckets.value.map((_, i) => Math.round(e.ids.reduce((n, id) => n + (per.get(id)?.[i] ?? 0), 0) * 100) / 100),
      backgroundColor: e.color,
      borderRadius: 3,
      borderSkipped: false as const,
      borderColor: '#ffffff',
      borderWidth: 1,
      maxBarThickness: 28,
    }))
    .filter((d) => d.data.some((v) => v > 0));
  return {
    type: 'bar',
    data: trimLeading(buckets.value.map((t) => bucketLabel(t, bucket.value, days.value)), datasets),
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: baseScales(axisUsd, true),
      plugins: {
        legend,
        tooltip: {
          filter: (c: TooltipItem<'bar'>) => Number(c.parsed.y) > 0,
          callbacks: {
            label: (c: TooltipItem<'bar'>) => ` ${c.dataset.label}：${usd(c.parsed.y)}`,
            footer: (items: TooltipItem<'bar'>[]) => `合计 ${usd(items.reduce((n, c) => n + Number(c.parsed.y), 0))}`,
          },
        },
      },
    },
  };
});

const trafficConfig = computed<ChartConfiguration<'bar'> | null>(() => {
  const s = series.value;
  if (!s) return null;
  const index = new Map(buckets.value.map((t, i) => [t, i]));
  const ok = buckets.value.map(() => 0);
  const bad = buckets.value.map(() => 0);
  for (const [t, r, e] of s.traffic) {
    const i = index.get(bucketStart(t, bucket.value));
    if (i === undefined) continue;
    ok[i]! += r - e;
    bad[i]! += e;
  }
  const bar = { borderRadius: 3, borderSkipped: false as const, borderColor: '#ffffff', borderWidth: 1, maxBarThickness: 28 };
  return {
    type: 'bar',
    data: trimLeading(buckets.value.map((t) => bucketLabel(t, bucket.value, days.value)), [
      { label: '成功', data: ok, backgroundColor: STATUS_GOOD, ...bar },
      { label: '失败', data: bad, backgroundColor: STATUS_CRITICAL, ...bar },
    ]),
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: baseScales((v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)), true),
      plugins: {
        legend,
        tooltip: {
          callbacks: {
            label: (c: TooltipItem<'bar'>) => ` ${c.dataset.label}：${c.parsed.y} 次`,
            footer: (items: TooltipItem<'bar'>[]) => {
              const okN = Number(items.find((c) => c.datasetIndex === 0)?.parsed.y ?? 0);
              const total = items.reduce((n, c) => n + Number(c.parsed.y), 0);
              return total > 0 ? `成功率 ${pct(okN / total)}` : '无请求';
            },
          },
        },
      },
    },
  };
});

const hasSpend = computed(() => kpi.value.spend > 0);
const hasTraffic = computed(() => kpi.value.requests > 0);
const hasBalance = computed(() => (series.value?.balance ?? []).some((b) => b.points.length > 0));

// ---------- 上游概况表 ----------

const rateColor = (r: number | null) => (r === null ? TICK : r >= (health.value?.thresholds.okRate ?? 95) / 100 ? STATUS_GOOD : r >= (health.value?.thresholds.degradedRate ?? 80) / 100 ? '#c98500' : STATUS_CRITICAL);

const tableRows = computed(() =>
  [...active.value].sort((a, b) => (b.balanceUsd ?? -1) - (a.balanceUsd ?? -1)),
);

const columns = computed<DataTableColumns<Upstream>>(() => [
  {
    title: '上游',
    key: 'name',
    minWidth: 120,
    render: (u) =>
      h('span', { style: 'display:inline-flex;align-items:center;gap:8px' }, [
        h('span', { style: `width:8px;height:8px;border-radius:2px;flex:none;background:${colorOf.value.get(u.id) ?? '#8a8986'}` }),
        h(RouterLink, { to: `/upstreams/${u.id}`, style: 'color:inherit;font-weight:500' }, { default: () => u.name }),
      ]),
  },
  { title: '状态', key: 'status', width: 96, render: (u) => h(NTag, { size: 'small', type: STATUS_META[u.status].tag, bordered: false }, { default: () => STATUS_META[u.status].label }) },
  { title: '余额', key: 'balance', width: 90, align: 'right', render: (u) => h('span', { style: 'font-variant-numeric:tabular-nums' }, u.status === 'unsupported' ? '—' : usd(u.balanceUsd)) },
  { title: '消耗速度', key: 'burn', width: 110, render: (u) => h(NText, { depth: u.burnBasis === 'estimated' ? 1 : 3, style: 'font-size:13px' }, { default: () => burnText(u, now.value) }) },
  {
    title: '预计可用',
    key: 'eta',
    width: 96,
    render: (u) => {
      if (u.burnBasis !== 'estimated' || u.exhaustAt === null) return h(NText, { depth: 3 }, { default: () => '—' });
      const d = (u.exhaustAt - now.value) / (24 * HOUR_MS);
      return h(NText, { type: d < 3 ? 'error' : d < 7 ? 'warning' : undefined }, { default: () => etaSpan(u.exhaustAt!, now.value) });
    },
  },
  { title: '区间消耗', key: 'spend', width: 110, align: 'right', render: (u) => h('span', { style: 'font-variant-numeric:tabular-nums' }, usd(spendBy.value.get(u.id) ?? 0)) },
  {
    title: '请求成功率',
    key: 'rate',
    width: 150,
    render: (u) => {
      const t = trafficBy.value.get(u.id);
      if (!t || t.requests === 0) return h(NText, { depth: 3 }, { default: () => (channelsConfigured.value ? '无请求' : '—') });
      const r = (t.requests - t.errors) / t.requests;
      return h('div', { style: 'display:flex;align-items:center;gap:8px', title: `${t.requests - t.errors}/${t.requests} 次成功` }, [
        h('div', { style: 'flex:1;height:6px;border-radius:3px;background:#ecebe8;min-width:48px;overflow:hidden' }, [h('div', { style: `height:100%;width:${(r * 100).toFixed(1)}%;background:${rateColor(r)};border-radius:3px` })]),
        h('span', { style: 'font-variant-numeric:tabular-nums;font-size:13px;width:44px;text-align:right' }, pct(r)),
      ]);
    },
  },
  { title: '请求数', key: 'requests', width: 80, align: 'right', render: (u) => h('span', { style: 'font-variant-numeric:tabular-nums' }, String(trafficBy.value.get(u.id)?.requests ?? 0)) },
  {
    title: '渠道健康',
    key: 'health',
    width: 84,
    render: (u) => {
      const r = rollups.value.get(u.id);
      return r ? h(HealthTag, { status: r.status }) : h(NText, { depth: 3 }, { default: () => '—' });
    },
  },
]);
</script>

<template>
  <n-space v-if="loaded" vertical :size="16">
    <n-empty
      v-if="upstreams.length === 0"
      :description="channelsConfigured ? '还没有上游。本站渠道里没有可识别的上游域名，可以手动添加 new-api / sub2api 上游。' : '还没有数据。先在「设置 → 本站连接」连上你的 new-api，同步渠道后会按域名自动创建上游；也可以手动添加。'"
      style="margin-top: 60px"
    >
      <template #extra>
        <n-space justify="center">
          <router-link v-if="!channelsConfigured" to="/settings#site" custom v-slot="{ navigate }"><n-button type="primary" @click="navigate">去连接本站</n-button></router-link>
          <router-link to="/upstreams/new" custom v-slot="{ navigate }"><n-button :type="channelsConfigured ? 'primary' : 'default'" @click="navigate">手动添加上游</n-button></router-link>
        </n-space>
      </template>
    </n-empty>

    <template v-else>
      <div class="toolbar">
        <n-radio-group v-model:value="days" size="small">
          <n-radio-button :value="1">24 小时</n-radio-button>
          <n-radio-button :value="7">7 天</n-radio-button>
          <n-radio-button :value="30">30 天</n-radio-button>
        </n-radio-group>
        <n-space :size="8" align="center">
          <n-text depth="3" style="font-size: 12px">每分钟自动更新</n-text>
          <n-button size="small" :loading="refreshing" @click="onRefreshAll">刷新余额</n-button>
        </n-space>
      </div>

      <n-grid cols="2 880:4" :x-gap="narrow ? 12 : 16" :y-gap="narrow ? 12 : 16">
        <n-grid-item>
          <stat-tile label="总余额" :value="usd(kpi.total)">{{ kpi.counted }} 个上游有余额数据</stat-tile>
        </n-grid-item>
        <n-grid-item>
          <stat-tile :label="`${RANGE_LABEL[days]}消耗`" :value="usd(kpi.spend)">
              <template v-if="kpi.burnCounted > 0">
                当前速度 {{ usd(kpi.burn) }}/天<template v-if="kpi.burn > 0">，总余额约可用 {{ (kpi.total / kpi.burn).toFixed(1) }} 天</template>
              </template>
              <template v-else>消耗速度收集数据中</template>
            </stat-tile>
        </n-grid-item>
        <n-grid-item>
          <stat-tile :label="`请求成功率（${RANGE_LABEL[days]}）`" :value="pct(kpi.rate)" :color="kpi.rate === null ? undefined : rateColor(kpi.rate)">
              <template v-if="kpi.requests > 0">共 {{ kpi.requests.toLocaleString() }} 次请求，失败 {{ kpi.errors.toLocaleString() }} 次</template>
              <template v-else-if="channelsConfigured">还没有请求日志</template>
              <template v-else>连接本站后显示</template>
            </stat-tile>
        </n-grid-item>
        <n-grid-item>
          <stat-tile label="需要处理" :value="String(issues.length)" :color="issues.some((i) => i.level === 'error') ? STATUS_CRITICAL : issues.length ? '#c98500' : STATUS_GOOD">{{ issues.length ? '见下方列表' : '一切正常' }}</stat-tile>
        </n-grid-item>
      </n-grid>

      <health-notices :health="health" />

      <n-card v-if="issues.length" size="small" title="需要处理">
        <div v-for="i in issues" :key="i.key" class="issue">
          <n-tag size="small" :type="i.level" :bordered="false" style="flex: none">{{ i.level === 'error' ? '✕' : i.level === 'warning' ? '!' : 'i' }} {{ i.tag }}</n-tag>
          <span class="issue-text">{{ i.text }}</span>
          <n-button v-if="i.action.href" size="tiny" secondary tag="a" :href="i.action.href" target="_blank" rel="noopener noreferrer">{{ i.action.label }}</n-button>
          <router-link v-else :to="i.action.to!" custom v-slot="{ navigate }"><n-button size="tiny" secondary @click="navigate">{{ i.action.label }}</n-button></router-link>
        </div>
      </n-card>

      <n-card size="small" title="余额趋势">
        <template #header-extra><n-text depth="3" style="font-size: 12px">按小时，取每小时最后一次查询结果</n-text></template>
        <viz-chart v-if="hasBalance && balanceConfig" :config="balanceConfig" :height="narrow ? 240 : 280" label="各上游余额趋势" />
        <n-empty v-else size="small" description="还没有余额记录，上游配置好后每次刷新都会记一笔" style="padding: 40px 0" />
      </n-card>

      <n-grid cols="1 1000:2" :x-gap="16" :y-gap="16">
        <n-grid-item>
          <n-card size="small" title="消耗">
            <template #header-extra><n-text depth="3" style="font-size: 12px">余额下降量，充值不计</n-text></template>
            <viz-chart v-if="hasSpend && spendConfig" :config="spendConfig" :height="240" label="各上游消耗" />
            <n-empty v-else size="small" :description="`${RANGE_LABEL[days]}没有记录到消耗`" style="padding: 40px 0" />
          </n-card>
        </n-grid-item>
        <n-grid-item>
          <n-card size="small" title="请求量">
            <template #header-extra><n-text depth="3" style="font-size: 12px">本站全部渠道</n-text></template>
            <viz-chart v-if="hasTraffic && trafficConfig" :config="trafficConfig" :height="240" label="本站请求成功与失败数量" />
            <n-empty v-else size="small" :description="channelsConfigured ? `${RANGE_LABEL[days]}没有请求日志` : '连接本站后显示请求量与成功率'" style="padding: 40px 0" />
          </n-card>
        </n-grid-item>
      </n-grid>

      <n-card size="small" title="各上游概况">
        <template #header-extra>
          <router-link to="/upstreams" custom v-slot="{ navigate }"><n-button size="small" quaternary @click="navigate">管理上游 →</n-button></router-link>
        </template>
        <n-data-table :columns="columns" :data="tableRows" :row-key="(u: Upstream) => u.id" size="small" :bordered="false" :scroll-x="936" />
        <n-alert v-if="upstreams.length > active.length" type="info" :show-icon="false" style="margin-top: 12px">
          另有 {{ upstreams.length - active.length }} 个待配置的上游未计入统计。
        </n-alert>
        <n-text depth="3" style="display: block; margin-top: 8px; font-size: 12px">余额最后更新 {{ formatAgo(Math.max(0, ...active.map((u) => u.lastCheckedAt ?? 0)) || null, now) }}</n-text>
      </n-card>
    </template>
  </n-space>
</template>

<style scoped>
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.issue {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid #f0efec;
}
.issue:last-child {
  border-bottom: none;
}
.issue-text {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}
</style>
