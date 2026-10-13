<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { NAlert, NButton, NDataTable, NDropdown, NEmpty, NInput, NSelect, NSpace, NSwitch, NTag, NText, useDialog, useMessage, type DataTableColumns } from 'naive-ui';
import { ApiError } from '../api';
import {
  assignUpstream,
  channelStatusMeta,
  describeResult,
  listChannels,
  setChannelStatus,
  setChannelsStatus,
  setUpstreamChannelsStatus,
  syncChannels,
  testChannel,
  type Channel,
  type ChannelListing,
  type ChannelTestResult,
} from '../channels';
import HealthNotices from '../components/HealthNotices.vue';
import HealthTag from '../components/HealthTag.vue';
import UptimeStrip from '../components/UptimeStrip.vue';
import { HEALTH_RANK, getHealth, latency, pct, type ChannelHealth, type HealthOverview } from '../health';
import { STATUS_META, formatAgo, listUpstreams, statusLabel, usd, type Upstream } from '../upstreams';
import { useNarrow } from '../narrow';

const message = useMessage();
// 手机上不固定右侧列，否则会挡住大半个表格
const narrow = useNarrow();
const dialog = useDialog();

const listing = ref<ChannelListing | null>(null);
const upstreams = ref<Upstream[]>([]);
const loaded = ref(false);
const health = ref<HealthOverview | null>(null);
const healthById = computed(() => new Map((health.value?.channels ?? []).map((h) => [h.channelId, h])));
const syncing = ref(false);
const batchBusy = ref(false);
const busy = ref<Set<number>>(new Set());
const testing = ref<Set<number>>(new Set());
const testResults = ref<Record<number, ChannelTestResult | { error: string }>>({});
const checked = ref<number[]>([]);
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

const filters = ref<{ upstream: string | null; group: string | null; status: number | null; keyword: string; unhealthy: boolean }>({ upstream: null, group: null, status: null, keyword: '', unhealthy: false });

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : '网络错误，请稍后重试');

const channels = computed(() => listing.value?.channels ?? []);
const groupOptions = computed(() => {
  const groups = [...new Set(channels.value.flatMap((c) => c.groups))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return [{ label: '全部分组', value: '' }, ...groups.map((g) => ({ label: g, value: g }))];
});

const filtered = computed(() => {
  const f = filters.value;
  const kw = f.keyword.trim().toLowerCase();
  return channels.value.filter((c) => {
    if (f.upstream === 'none' && c.upstreamId !== null) return false;
    if (f.upstream && f.upstream !== 'none' && String(c.upstreamId) !== f.upstream) return false;
    if (f.group && !c.groups.includes(f.group)) return false;
    if (f.status && c.status !== f.status) return false;
    if (f.unhealthy && !isUnhealthy(c.id)) return false;
    if (kw && !(c.name.toLowerCase().includes(kw) || c.baseUrl.toLowerCase().includes(kw) || String(c.id) === kw)) return false;
    return true;
  });
});
function isUnhealthy(id: number): boolean {
  const st = healthById.value.get(id)?.status;
  return st === 'down' || st === 'degraded';
}

/** 顶部的计数条：一眼看到启用 / 停用 / 异常 / 未归类各有多少，点击即筛选 */
const counts = computed(() => ({
  total: channels.value.length,
  enabled: channels.value.filter((c) => c.status === 1).length,
  disabled: channels.value.filter((c) => c.status !== 1).length,
  unhealthy: channels.value.filter((c) => isUnhealthy(c.id)).length,
  unassigned: channels.value.filter((c) => c.upstreamId === null).length,
}));
type Quick = 'all' | 'enabled' | 'disabled' | 'unhealthy' | 'unassigned';
const quick = computed<Quick | null>(() => {
  const f = filters.value;
  if (f.group || f.keyword) return null;
  if (!f.upstream && !f.status && !f.unhealthy) return 'all';
  if (f.status === 1 && !f.upstream && !f.unhealthy) return 'enabled';
  if (f.status === 2 && !f.upstream && !f.unhealthy) return 'disabled';
  if (f.unhealthy && !f.upstream && !f.status) return 'unhealthy';
  if (f.upstream === 'none' && !f.status && !f.unhealthy) return 'unassigned';
  return null;
});
function setQuick(q: Quick) {
  filters.value = { upstream: q === 'unassigned' ? 'none' : null, group: null, status: q === 'enabled' ? 1 : q === 'disabled' ? 2 : null, keyword: '', unhealthy: q === 'unhealthy' };
}

const checkedChannels = computed(() => channels.value.filter((c) => checked.value.includes(c.id)));

function apply(l: ChannelListing) {
  listing.value = l;
  const ids = new Set(l.channels.map((c) => c.id));
  checked.value = checked.value.filter((id) => ids.has(id));
  now.value = Date.now();
}

async function load() {
  try {
    const [l, u] = await Promise.all([listChannels(), listUpstreams()]);
    upstreams.value = u;
    apply(l);
    // 健康数据取不到不影响渠道列表
    health.value = await getHealth().catch(() => health.value);
  } catch (err) {
    if (!loaded.value) message.error(errorText(err));
  } finally {
    loaded.value = true;
  }
}

async function onSync() {
  syncing.value = true;
  try {
    const r = await syncChannels();
    apply(r);
    upstreams.value = await listUpstreams();
    if (r.result.ok)
      message.success(
        `已同步 ${r.result.total} 个渠道${r.result.removed ? `，移除 ${r.result.removed} 个已在本站删除的渠道` : ''}${r.result.autoCreated ? `，自动创建 ${r.result.autoCreated} 个待配置上游，请到「上游」页填入密钥` : ''}`,
      );
    else message.error(r.result.error ?? '同步失败');
  } catch (err) {
    message.error(errorText(err));
  } finally {
    syncing.value = false;
  }
}

function withBusy(set: typeof busy, id: number, on: boolean) {
  const next = new Set(set.value);
  if (on) next.add(id);
  else next.delete(id);
  set.value = next;
}

async function onToggle(c: Channel, enable: boolean) {
  withBusy(busy, c.id, true);
  try {
    const r = await setChannelStatus(c.id, enable ? 1 : 2);
    apply(r);
    message.success(`${c.name} 已${enable ? '启用' : '停用'}`);
  } catch (err) {
    message.error(errorText(err));
  } finally {
    withBusy(busy, c.id, false);
  }
}

async function onTest(c: Channel) {
  withBusy(testing, c.id, true);
  try {
    testResults.value = { ...testResults.value, [c.id]: await testChannel(c.id) };
    const l = await listChannels();
    apply(l);
  } catch (err) {
    testResults.value = { ...testResults.value, [c.id]: { error: errorText(err) } };
  } finally {
    withBusy(testing, c.id, false);
  }
}

async function onAssign(c: Channel, upstreamId: number | null) {
  withBusy(busy, c.id, true);
  try {
    const fresh = await assignUpstream(c.id, upstreamId);
    if (listing.value) listing.value = { ...listing.value, channels: listing.value.channels.map((x) => (x.id === fresh.id ? fresh : x)) };
    message.success(upstreamId === null ? '已恢复自动归类' : '已手动指定上游');
  } catch (err) {
    message.error(errorText(err));
  } finally {
    withBusy(busy, c.id, false);
  }
}

function confirmBatch(enable: boolean) {
  const targets = checkedChannels.value.filter((c) => (enable ? c.status !== 1 : c.status === 1));
  if (targets.length === 0) return message.info(enable ? '所选渠道都已是启用状态' : '所选渠道都已是停用状态');
  const names = targets.slice(0, 5).map((c) => c.name).join('、') + (targets.length > 5 ? ` 等 ${targets.length} 个` : '');
  dialog.warning({
    title: enable ? '批量启用渠道' : '批量停用渠道',
    content: `将${enable ? '启用' : '停用'}以下 ${targets.length} 个渠道：${names}。${enable ? '' : '停用后这些渠道将不再接收请求。'}确定吗？`,
    positiveText: enable ? '确认启用' : '确认停用',
    negativeText: '取消',
    onPositiveClick: async () => {
      batchBusy.value = true;
      try {
        const r = await setChannelsStatus(targets.map((c) => c.id), enable ? 1 : 2);
        apply(r);
        const d = describeResult(r.result, enable ? '启用' : '停用');
        if (d.ok) message.success(d.text);
        else message.warning(d.text, { duration: 8000 });
        checked.value = [];
      } catch (err) {
        message.error(errorText(err));
      } finally {
        batchBusy.value = false;
      }
    },
  });
}

// ---------- 按上游分组 ----------

interface GroupRow {
  key: string;
  kind: 'group';
  upstream: Upstream | null;
  channels: Channel[];
  worst: number;
  children: ChannelRow[];
}
interface ChannelRow {
  key: number;
  kind: 'channel';
  c: Channel;
}
type Row = GroupRow | ChannelRow;

const upstreamById = computed(() => new Map(upstreams.value.map((u) => [u.id, u])));
const rank = (c: Channel) => {
  const st = healthById.value.get(c.id)?.status;
  // 启用的渠道在前；同为启用时，异常 > 降级 > 正常 > 空闲
  return (c.status === 1 ? 0 : 10) + (st ? HEALTH_RANK[st] : 4);
};

const rows = computed<GroupRow[]>(() => {
  const by = new Map<number | null, Channel[]>();
  for (const c of filtered.value) {
    const id = c.upstreamId !== null && upstreamById.value.has(c.upstreamId) ? c.upstreamId : null;
    by.set(id, [...(by.get(id) ?? []), c]);
  }
  const groups: GroupRow[] = [...by].map(([id, list]) => {
    const sorted = [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'zh-CN'));
    return {
      key: `u-${id ?? 'none'}`,
      kind: 'group',
      upstream: id === null ? null : upstreamById.value.get(id)!,
      channels: sorted,
      worst: Math.min(...sorted.map(rank)),
      children: sorted.map((c) => ({ key: c.id, kind: 'channel', c })),
    };
  });
  // 有异常渠道的上游排前；未归类放最后
  return groups.sort((a, b) => (a.upstream === null ? 1 : 0) - (b.upstream === null ? 1 : 0) || a.worst - b.worst || (a.upstream?.name ?? '').localeCompare(b.upstream?.name ?? '', 'zh-CN'));
});
const expanded = ref<(string | number)[] | null>(null);
const expandedKeys = computed(() => expanded.value ?? rows.value.map((r) => r.key));

function confirmUpstream(u: Upstream, enable: boolean) {
  dialog.warning({
    title: `${enable ? '启用' : '停用'} ${u.name} 的全部渠道`,
    content: enable ? '将启用该上游名下所有已停用的渠道。确定吗？' : '停用后这些渠道将不再接收请求。确定吗？',
    positiveText: enable ? '确认启用' : '确认停用',
    negativeText: '取消',
    onPositiveClick: async () => {
      batchBusy.value = true;
      try {
        const r = await setUpstreamChannelsStatus(u.id, enable ? 1 : 2);
        apply(r);
        const d = describeResult(r.result, enable ? '启用' : '停用');
        if (d.ok) message.success(d.text);
        else message.warning(d.text, { duration: 8000 });
      } catch (err) {
        message.error(errorText(err));
      } finally {
        batchBusy.value = false;
      }
    },
  });
}

const thresholds = computed(() => health.value?.thresholds ?? { okRate: 95, degradedRate: 80 });

function renderGroup(g: GroupRow) {
  const u = g.upstream;
  const on = g.channels.filter((c) => c.status === 1).length;
  const bad = g.channels.filter((c) => isUnhealthy(c.id)).length;
  const left = u
    ? [
        h(RouterLink, { to: `/upstreams/${u.id}`, style: 'color:inherit;font-weight:600;font-size:14px' }, { default: () => u.name }),
        h(NTag, { size: 'small', bordered: false, type: STATUS_META[u.status].tag }, { default: () => statusLabel(u) }),
        u.status !== 'unsupported' && u.balanceUsd !== null ? h('span', { style: `font-variant-numeric:tabular-nums;color:${STATUS_META[u.status].color};font-weight:500` }, usd(u.balanceUsd)) : null,
      ]
    : [h('span', { style: 'font-weight:600;font-size:14px;color:#c98500' }, '未归类'), h(NText, { depth: 3, style: 'font-size:12px' }, { default: () => '没匹配到上游，可在右侧「改上游」里指定' })];
  const stats = h(NText, { depth: 3, style: 'font-size:12px' }, { default: () => `启用 ${on} / 共 ${g.channels.length}` });
  return h('div', { class: 'group-head' }, [
    h('div', { class: 'group-left' }, [...left, stats, bad ? h(NTag, { size: 'small', type: 'error', bordered: false }, { default: () => `${bad} 个异常` }) : null]),
    u
      ? h('div', { class: 'group-actions' }, [
          h(NButton, { size: 'tiny', quaternary: true, type: 'primary', disabled: on === g.channels.length || batchBusy.value, onClick: () => confirmUpstream(u, true) }, { default: () => '全部启用' }),
          h(NButton, { size: 'tiny', quaternary: true, type: 'error', disabled: on === 0 || batchBusy.value, onClick: () => confirmUpstream(u, false) }, { default: () => '全部停用' }),
        ])
      : null,
  ]);
}

function renderHealth(c: Channel) {
  const hh: ChannelHealth | undefined = healthById.value.get(c.id);
  if (!hh) return h(NText, { depth: 3 }, { default: () => '—' });
  const tip = `近 1 小时 ${pct(hh.successRate1h)}（${hh.requests1h - hh.errors1h}/${hh.requests1h}）；24 小时 ${pct(hh.successRate24h)}；最近成功 ${hh.lastSuccessAt ? formatAgo(hh.lastSuccessAt, now.value) : '无'}`;
  return h('div', { class: 'health', title: tip }, [
    h(HealthTag, { status: hh.status }),
    hh.hourly ? h(UptimeStrip, { cells: hh.hourly, okRate: thresholds.value.okRate, degradedRate: thresholds.value.degradedRate, style: 'flex:1' }) : null,
    h('span', { class: 'rate', style: `color:${hh.requests24h ? '#333' : '#aaa'}` }, pct(hh.successRate24h)),
  ]);
}

function upstreamMenu(c: Channel) {
  const opts = [
    ...upstreams.value.filter((u) => u.id !== c.upstreamId).map((u) => ({ label: `移到 ${u.name}`, key: u.id })),
    ...(c.manualUpstream ? [{ type: 'divider', key: 'd' }, { label: '恢复按域名自动归类', key: 'auto' }] : []),
  ];
  return h(
    NDropdown,
    { trigger: 'click', options: opts, scrollable: true, style: 'max-height:320px', onSelect: (k: number | 'auto') => void onAssign(c, k === 'auto' ? null : k) },
    { default: () => h(NButton, { size: 'tiny', quaternary: true, disabled: busy.value.has(c.id) || opts.length === 0 }, { default: () => (c.upstreamId === null ? '指定上游' : '改上游') }) },
  );
}

const SPAN = 99;
const allColumns = computed<DataTableColumns<Row>>(() => [
  { type: 'selection' },
  {
    title: '渠道',
    key: 'name',
    minWidth: 200,
    colSpan: (r) => (r.kind === 'group' ? SPAN : 1),
    render: (r) => {
      if (r.kind === 'group') return renderGroup(r);
      const c = r.c;
      // 树形表格会在前面放一个展开占位，名称块要与它同行
      return h('div', { style: 'display:inline-block;vertical-align:middle;width:calc(100% - 48px);min-width:0' }, [
        h('div', { style: `font-weight:500;${c.status === 1 ? '' : 'color:#999'}` }, [
          c.name,
          h(NText, { depth: 3, style: 'font-size:12px;margin-left:6px;font-weight:400' }, { default: () => `#${c.id}` }),
          c.manualUpstream ? h(NTag, { size: 'tiny', bordered: false, style: 'margin-left:6px', title: '上游是手动指定的' }, { default: () => '手动' }) : null,
        ]),
        // 手机上把状态条放到名称下方，不用横向滚动也能看到
        narrow.value ? h('div', { style: 'margin-top:4px' }, [renderHealth(c)]) : h(NText, { depth: 3, style: 'display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', title: c.baseUrl }, { default: () => c.baseUrl || '官方默认端点' }),
      ]);
    },
  },
  { title: '近 24 小时', key: 'health', width: 240, render: (r) => (r.kind === 'channel' ? renderHealth(r.c) : null) },
  {
    title: '耗时',
    key: 'latency',
    width: 72,
    render: (r) => {
      if (r.kind !== 'channel') return null;
      const hh = healthById.value.get(r.c.id);
      return h('span', { style: 'font-size:12px;font-variant-numeric:tabular-nums' }, latency(hh?.avgLatencyMs1h ?? hh?.avgLatencyMs24h ?? null));
    },
  },
  {
    title: '分组',
    key: 'groups',
    minWidth: 110,
    render: (r) => (r.kind === 'channel' ? h(NSpace, { size: 4 }, () => r.c.groups.map((g) => h(NTag, { size: 'small', bordered: false }, { default: () => g }))) : null),
  },
  { title: '优先级/权重', key: 'priority', width: 104, render: (r) => (r.kind === 'channel' ? h('span', { style: 'font-size:12px' }, `${r.c.priority} · ${r.c.weight}`) : null) },
  {
    title: '启用',
    key: 'switch',
    width: 92,
    render: (r) => {
      if (r.kind !== 'channel') return null;
      const c = r.c;
      return h('div', { style: 'display:flex;flex-direction:column;align-items:flex-start;gap:2px' }, [
        h('div', { style: 'display:flex;align-items:center;gap:6px' }, [
          h(NSwitch, { size: 'small', value: c.status === 1, loading: busy.value.has(c.id), onUpdateValue: (v: boolean) => void onToggle(c, v) }),
          c.status !== 1 ? h(NText, { depth: 3, style: 'font-size:12px' }, { default: () => channelStatusMeta(c.status).label }) : null,
        ]),
        c.autoDisabled ? h(NTag, { size: 'tiny', type: 'warning', bordered: false, title: '余额归零时由本工具停用，余额恢复后会自动启用' }, { default: () => '余额归零停用' }) : null,
      ]);
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 150,
    render: (r) => {
      if (r.kind !== 'channel') return null;
      const c = r.c;
      const t = testResults.value[c.id];
      return h('div', [
        h('div', { style: 'display:flex;gap:2px' }, [h(NButton, { size: 'tiny', quaternary: true, type: 'primary', loading: testing.value.has(c.id), onClick: () => void onTest(c) }, { default: () => '测试' }), upstreamMenu(c)]),
        t
          ? h(
              NText,
              { type: 'error' in t ? 'error' : t.passed ? 'success' : 'error', style: 'display:block;font-size:12px;word-break:break-all' },
              { default: () => ('error' in t ? t.error : t.passed ? `通过${t.timeSeconds !== null ? `，${t.timeSeconds.toFixed(2)} 秒` : ''}` : `未通过：${t.message || '未知原因'}`) },
            )
          : null,
      ]);
    },
  },
]);

/** 手机上去掉耗时、分组、优先级列，状态条并入名称列，让启用开关留在一屏内 */
const NARROW_HIDDEN = new Set(['health', 'latency', 'groups', 'priority']);
const columns = computed(() => (narrow.value ? allColumns.value.filter((c) => !('key' in c) || !NARROW_HIDDEN.has(String(c.key))) : allColumns.value));
const checkedKeys = computed(() => [...checked.value]);
function onChecked(keys: Array<string | number>) {
  checked.value = keys.filter((k): k is number => typeof k === 'number');
}

onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 60_000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <n-space v-if="loaded" vertical :size="16">
    <n-empty v-if="listing && !listing.configured" description="还没有配置本站。到“设置”页填写本站地址与访问令牌后，这里会列出本站的全部渠道。" style="margin-top: 60px">
      <template #extra>
        <router-link to="/settings" custom v-slot="{ navigate }"><n-button type="primary" @click="navigate">前往设置</n-button></router-link>
      </template>
    </n-empty>

    <template v-else>
      <n-alert v-if="listing?.lastError" type="error" :show-icon="false">最近一次同步失败：{{ listing.lastError }}（下方为上次成功同步的缓存数据）</n-alert>
      <health-notices :health="health" />

      <div class="head">
        <div class="quick">
          <button :class="{ on: quick === 'all' }" @click="setQuick('all')">全部 <b>{{ counts.total }}</b></button>
          <button :class="{ on: quick === 'unhealthy' }" :disabled="counts.unhealthy === 0" @click="setQuick('unhealthy')">异常 / 降级 <b :class="{ bad: counts.unhealthy > 0 }">{{ counts.unhealthy }}</b></button>
          <button :class="{ on: quick === 'enabled' }" @click="setQuick('enabled')">启用 <b class="good">{{ counts.enabled }}</b></button>
          <button :class="{ on: quick === 'disabled' }" @click="setQuick('disabled')">已停用 <b>{{ counts.disabled }}</b></button>
          <button v-if="counts.unassigned > 0" :class="{ on: quick === 'unassigned' }" @click="setQuick('unassigned')">未归类 <b class="warn">{{ counts.unassigned }}</b></button>
        </div>
        <div class="filters">
          <n-input v-model:value="filters.keyword" size="small" clearable placeholder="搜索名称 / 地址 / ID" :style="{ width: narrow ? 'calc(50vw - 22px)' : '180px' }" />
          <n-select :value="filters.group ?? ''" size="small" :options="groupOptions" :style="{ width: narrow ? 'calc(50vw - 22px)' : '130px' }" @update:value="(v: string) => (filters.group = v || null)" />
          <n-button size="small" :loading="syncing" :title="`同步于 ${formatAgo(listing?.syncedAt ?? null, now)}，每 5 分钟自动同步`" @click="onSync">同步渠道</n-button>
        </div>
      </div>

      <div v-if="checked.length > 0" class="selbar">
        <span>已选 <b>{{ checked.length }}</b> 个渠道</span>
        <n-button size="small" type="primary" :loading="batchBusy" @click="confirmBatch(true)">启用</n-button>
        <n-button size="small" type="error" secondary :loading="batchBusy" @click="confirmBatch(false)">停用</n-button>
        <n-button size="small" quaternary @click="checked = []">取消选择</n-button>
      </div>

      <n-data-table
        :columns="columns"
        :data="rows"
        :row-key="(r: Row) => r.key"
        :checked-row-keys="checkedKeys"
        :expanded-row-keys="expandedKeys"
        :row-class-name="(r: Row) => (r.kind === 'group' ? 'group-row' : '')"
        :scroll-x="narrow ? 470 : 1000"
        size="small"
        @update:checked-row-keys="onChecked"
        @update:expanded-row-keys="(k: Array<string | number>) => (expanded = k)"
      />
      <n-text depth="3" style="font-size: 12px">
        <template v-if="filtered.length !== channels.length">显示 {{ filtered.length }} / {{ channels.length }} 个渠道 · </template>
        状态条每格 1 小时，绿 / 黄 / 红 = 正常 / 降级 / 异常，灰色 = 没有请求 · 渠道同步于 {{ formatAgo(listing?.syncedAt ?? null, now) }}
      </n-text>
    </template>
  </n-space>
</template>

<style scoped>
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.selbar {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  background: #eef6ff;
  border: 1px solid #c9e0fb;
  font-size: 13px;
}
.selbar span {
  margin-right: 4px;
}
:deep(.group-row td) {
  background: #f7f7f5 !important;
}
:deep(.group-head) {
  display: inline-flex;
  width: calc(100% - 32px);
  vertical-align: middle;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
:deep(.group-left) {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
:deep(.health) {
  display: flex;
  align-items: center;
  gap: 8px;
}
:deep(.health .rate) {
  width: 44px;
  text-align: right;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.quick {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.quick button {
  border: 1px solid #e5e4e0;
  background: #fff;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 13px;
  color: #52514e;
  cursor: pointer;
}
.quick button:disabled {
  cursor: default;
  opacity: 0.6;
}
.quick button.on {
  border-color: #18a058;
  color: #18a058;
  background: #f0faf4;
}
.quick b {
  margin-left: 4px;
  font-variant-numeric: tabular-nums;
}
.quick b.good {
  color: #0ca30c;
}
.quick b.bad {
  color: #d03b3b;
}
.quick b.warn {
  color: #c98500;
}
</style>
