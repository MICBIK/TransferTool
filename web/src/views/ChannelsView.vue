<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { NAlert, NButton, NDataTable, NEmpty, NInput, NSelect, NSpace, NSwitch, NTag, NText, useDialog, useMessage, type DataTableColumns } from 'naive-ui';
import { ApiError } from '../api';
import {
  assignUpstream,
  channelStatusMeta,
  describeResult,
  listChannels,
  setChannelStatus,
  setChannelsStatus,
  syncChannels,
  testChannel,
  type Channel,
  type ChannelListing,
  type ChannelTestResult,
} from '../channels';
import HealthNotices from '../components/HealthNotices.vue';
import HealthTag from '../components/HealthTag.vue';
import { getHealth, latency, pct, type ChannelHealth, type HealthOverview } from '../health';
import { formatAgo, listUpstreams, type Upstream } from '../upstreams';
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

const filters = ref<{ upstream: string | null; group: string | null; status: number | null; keyword: string }>({ upstream: null, group: null, status: null, keyword: '' });

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : '网络错误，请稍后重试');

const channels = computed(() => listing.value?.channels ?? []);
const upstreamOptions = computed(() => [
  { label: '全部上游', value: '' },
  { label: '未归类', value: 'none' },
  ...upstreams.value.map((u) => ({ label: u.name, value: String(u.id) })),
]);
const assignOptions = computed(() => upstreams.value.map((u) => ({ label: u.name, value: u.id })));
const groupOptions = computed(() => {
  const groups = [...new Set(channels.value.flatMap((c) => c.groups))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return [{ label: '全部分组', value: '' }, ...groups.map((g) => ({ label: g, value: g }))];
});
const statusOptions = [
  { label: '全部状态', value: 0 },
  { label: '启用', value: 1 },
  { label: '已停用（手动）', value: 2 },
  { label: '自动禁用', value: 3 },
];

const filtered = computed(() => {
  const f = filters.value;
  const kw = f.keyword.trim().toLowerCase();
  return channels.value.filter((c) => {
    if (f.upstream === 'none' && c.upstreamId !== null) return false;
    if (f.upstream && f.upstream !== 'none' && String(c.upstreamId) !== f.upstream) return false;
    if (f.group && !c.groups.includes(f.group)) return false;
    if (f.status && c.status !== f.status) return false;
    if (kw && !(c.name.toLowerCase().includes(kw) || c.baseUrl.toLowerCase().includes(kw) || String(c.id) === kw)) return false;
    return true;
  });
});
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

const columns = computed<DataTableColumns<Channel>>(() => [
  { type: 'selection' },
  { title: 'ID', key: 'id', width: 56 },
  {
    title: '名称',
    key: 'name',
    minWidth: 160,
    render: (c) =>
      h('div', [
        h('div', { style: 'font-weight:500' }, c.name),
        c.baseUrl ? h(NText, { depth: 3, style: 'font-size:12px;word-break:break-all' }, { default: () => c.baseUrl }) : h(NText, { depth: 3, style: 'font-size:12px' }, { default: () => '官方默认端点' }),
      ]),
  },
  {
    title: '上游',
    key: 'upstreamId',
    width: 190,
    render: (c) =>
      h('div', { style: 'display:flex;align-items:center;gap:4px' }, [
        h(NSelect, {
          size: 'small',
          value: c.upstreamId,
          placeholder: '未归类，点此指定',
          options: assignOptions.value,
          disabled: busy.value.has(c.id) || assignOptions.value.length === 0,
          consistentMenuWidth: false,
          style: 'flex:1;min-width:0',
          onUpdateValue: (v: number) => void onAssign(c, v),
        }),
        c.upstreamId !== null ? h(RouterLink, { to: `/upstreams/${c.upstreamId}`, title: '打开该上游', style: 'text-decoration:none' }, { default: () => '↗' }) : null,
        c.manualUpstream
          ? h(NButton, { size: 'tiny', quaternary: true, title: '取消手动指定，恢复按域名自动归类', onClick: () => void onAssign(c, null) }, { default: () => '手动 ×' })
          : null,
      ]),
  },
  {
    title: '分组',
    key: 'groups',
    minWidth: 120,
    render: (c) => h(NSpace, { size: 4 }, () => c.groups.map((g) => h(NTag, { size: 'small', bordered: false }, { default: () => g }))),
  },
  {
    title: '状态',
    key: 'status',
    width: 120,
    render: (c) => {
      const m = channelStatusMeta(c.status);
      return h(NSpace, { size: 4, wrapItem: false }, () => [
        h(NTag, { size: 'small', type: m.tag }, { default: () => m.label }),
        c.autoDisabled ? h(NTag, { size: 'small', type: 'warning', bordered: false, title: '余额归零时由本工具停用，余额恢复后会自动启用' }, { default: () => '余额归零停用' }) : null,
      ]);
    },
  },
  {
    title: '健康',
    key: 'health',
    width: 150,
    render: (c) => {
      const hh: ChannelHealth | undefined = healthById.value.get(c.id);
      if (!hh) return h(NText, { depth: 3 }, { default: () => '—' });
      if (hh.status === 'idle') {
        return h('div', [
          h(HealthTag, { status: hh.status, title: '近 1 小时没有请求' }),
          hh.requests24h > 0
            ? h(NText, { depth: 3, style: 'display:block;font-size:12px' }, { default: () => `24h ${pct(hh.successRate24h)} · 最近成功 ${hh.lastSuccessAt ? formatAgo(hh.lastSuccessAt, now.value) : '无'}` })
            : null,
        ]);
      }
      return h('div', { style: 'font-size:12px;line-height:1.6', title: `近 1 小时 ${hh.requests1h - hh.errors1h}/${hh.requests1h} 次成功；最近成功 ${hh.lastSuccessAt ? formatAgo(hh.lastSuccessAt, now.value) : '无'}` }, [
        h(HealthTag, { status: hh.status }),
        h('div', `1h ${pct(hh.successRate1h)} · 24h ${pct(hh.successRate24h)}`),
        h(NText, { depth: 3 }, { default: () => `均耗时 ${latency(hh.avgLatencyMs1h ?? hh.avgLatencyMs24h)}` }),
      ]);
    },
  },
  {
    title: '优先级/权重',
    key: 'priority',
    width: 100,
    render: (c) => h('div', { style: 'font-size:12px;line-height:1.6' }, [h('div', `${c.priority} / ${c.weight}`), h(NText, { depth: 3 }, { default: () => (c.responseTimeMs > 0 ? `${c.responseTimeMs} ms` : '') })]),
  },
  {
    title: '启用',
    key: 'switch',
    width: 64,
    fixed: narrow.value ? undefined : 'right',
    render: (c) => h(NSwitch, { value: c.status === 1, loading: busy.value.has(c.id), onUpdateValue: (v: boolean) => void onToggle(c, v) }),
  },
  {
    title: '测试',
    key: 'test',
    width: 130,
    fixed: narrow.value ? undefined : 'right',
    render: (c) => {
      const r = testResults.value[c.id];
      return h('div', [
        h(NButton, { size: 'small', loading: testing.value.has(c.id), onClick: () => void onTest(c) }, { default: () => '测试' }),
        r
          ? h(
              NText,
              { type: 'error' in r ? 'error' : r.passed ? 'success' : 'error', style: 'display:block;font-size:12px;word-break:break-all' },
              { default: () => ('error' in r ? r.error : r.passed ? `通过${r.timeSeconds !== null ? `，${r.timeSeconds.toFixed(2)} 秒` : ''}` : `未通过：${r.message || '未知原因'}`) },
            )
          : null,
      ]);
    },
  },
]);

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

      <n-space justify="space-between" align="center">
        <n-text depth="3">共 {{ channels.length }} 个渠道，当前显示 {{ filtered.length }} 个 · 最近同步 {{ formatAgo(listing?.syncedAt ?? null, now) }}（每 5 分钟自动同步）</n-text>
        <n-button :loading="syncing" @click="onSync">立即同步</n-button>
      </n-space>

      <n-space :size="12">
        <n-select :value="filters.upstream ?? ''" :options="upstreamOptions" style="width: 170px" @update:value="(v: string) => (filters.upstream = v || null)" />
        <n-select :value="filters.group ?? ''" :options="groupOptions" style="width: 150px" @update:value="(v: string) => (filters.group = v || null)" />
        <n-select :value="filters.status ?? 0" :options="statusOptions" style="width: 160px" @update:value="(v: number) => (filters.status = v || null)" />
        <n-input v-model:value="filters.keyword" clearable placeholder="搜索名称 / 地址 / ID" style="width: 200px" />
      </n-space>

      <n-space align="center" :size="12">
        <n-button size="small" :disabled="filtered.length === 0" @click="checked = filtered.map((c) => c.id)">选择当前筛选结果（{{ filtered.length }}）</n-button>
        <n-button size="small" :disabled="checked.length === 0" @click="checked = []">清空选择</n-button>
        <n-text depth="3">已选 {{ checked.length }} 个</n-text>
        <n-button size="small" type="primary" secondary :disabled="checked.length === 0" :loading="batchBusy" @click="confirmBatch(true)">批量启用</n-button>
        <n-button size="small" type="error" secondary :disabled="checked.length === 0" :loading="batchBusy" @click="confirmBatch(false)">批量停用</n-button>
      </n-space>

      <n-data-table
        :columns="columns"
        :data="filtered"
        :row-key="(c: Channel) => c.id"
        :checked-row-keys="checked"
        @update:checked-row-keys="(keys: Array<string | number>) => (checked = keys as number[])"
        :pagination="{ pageSize: 50 }"
        :scroll-x="1080"
        size="small"
      />
    </template>
  </n-space>
</template>
