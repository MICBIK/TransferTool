<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { NButton, NCard, NEmpty, NGrid, NGridItem, NSpace, NTable, NTag, NText, useMessage } from 'naive-ui';
import { ApiError } from '../api';
import { channelSummary, upstreamSuggestions, type ChannelCount, type UpstreamSuggestion } from '../channels';
import HealthNotices from '../components/HealthNotices.vue';
import HealthTag from '../components/HealthTag.vue';
import { getHealth, type HealthOverview, type UpstreamRollup } from '../health';
import { STATUS_META, TYPE_LABEL, burnText, etaText, formatAgo, listUpstreams, refreshAll, refreshOne, sortUpstreams, usd, type Upstream } from '../upstreams';

const message = useMessage();
const upstreams = ref<Upstream[]>([]);
const loaded = ref(false);
const counts = ref<Map<number | null, ChannelCount>>(new Map());
const channelsConfigured = ref(false);
const health = ref<HealthOverview | null>(null);
const suggestions = ref<UpstreamSuggestion[]>([]);
const unclassified = computed(() => counts.value.get(null)?.total ?? 0);

/** 跳到“添加上游”并预填站点、名称和匹配域名 */
function addFromSuggestion(sg: UpstreamSuggestion) {
  return { path: '/upstreams/new', query: { siteUrl: sg.siteUrl, name: sg.domain.split('.')[0], domain: sg.domain } };
}
const rollups = computed(() => new Map<number, UpstreamRollup>((health.value?.upstreams ?? []).map((r) => [r.upstreamId, r])));
const refreshing = ref<Set<number> | 'all'>(new Set());
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

const sorted = computed(() => sortUpstreams(upstreams.value));

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : '网络错误，请稍后重试';
}

async function load() {
  try {
    upstreams.value = await listUpstreams();
    // 渠道数量取不到不影响余额卡片
    const s = await channelSummary().catch(() => null);
    if (s) {
      channelsConfigured.value = s.configured;
      counts.value = new Map(s.summary.map((c) => [c.upstreamId, c]));
      health.value = await getHealth().catch(() => health.value);
      suggestions.value = s.configured ? ((await upstreamSuggestions().catch(() => null))?.suggestions ?? suggestions.value) : [];
    }
  } catch (err) {
    if (!loaded.value) message.error(errorText(err));
  } finally {
    loaded.value = true;
    now.value = Date.now();
  }
}

async function onRefreshAll() {
  refreshing.value = 'all';
  try {
    upstreams.value = await refreshAll();
    message.success('已刷新');
  } catch (err) {
    message.error(errorText(err));
  } finally {
    refreshing.value = new Set();
    now.value = Date.now();
  }
}

async function onRefresh(u: Upstream) {
  refreshing.value = new Set([u.id]);
  try {
    const fresh = await refreshOne(u.id);
    upstreams.value = upstreams.value.map((x) => (x.id === fresh.id ? fresh : x));
  } catch (err) {
    message.error(errorText(err));
  } finally {
    refreshing.value = new Set();
    now.value = Date.now();
  }
}

const isRefreshing = (id: number) => refreshing.value === 'all' || refreshing.value.has(id);

onMounted(() => {
  void load();
  // 后台调度器每分钟检查一次，页面同步轮询以显示最新结果
  timer = setInterval(() => void load(), 60_000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <n-space v-if="loaded" vertical :size="16">
    <n-space justify="space-between">
      <n-text depth="3">共 {{ upstreams.length }} 个上游，低于阈值或异常的排在前面</n-text>
      <n-space>
        <n-button :loading="refreshing === 'all'" :disabled="upstreams.length === 0" @click="onRefreshAll">全部立即刷新</n-button>
        <router-link to="/upstreams/new" custom v-slot="{ navigate }"><n-button type="primary" @click="navigate">添加上游</n-button></router-link>
      </n-space>
    </n-space>

    <health-notices :health="health" />

    <n-card v-if="suggestions.length > 0" size="small" :title="`从本站渠道发现 ${suggestions.length} 个尚未添加的上游`">
      <n-text depth="3" style="font-size: 13px">
        本站有 {{ unclassified }} 个渠道还没有归属上游，下面按域名分好了组。点「添加」会预填站点地址和匹配域名，选好类型并填写访问令牌或 API Key 后保存，这些渠道就会自动归类。
      </n-text>
      <n-table size="small" :bordered="false" style="margin-top: 8px">
        <thead>
          <tr><th>域名</th><th>渠道</th><th>示例</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="sg in suggestions" :key="sg.domain">
            <td>
              <div style="font-weight: 600">{{ sg.domain }}</div>
              <n-text v-if="sg.hosts.length > 1 || sg.hosts[0] !== sg.domain" depth="3" style="font-size: 12px">{{ sg.hosts.join('、') }}</n-text>
            </td>
            <td style="white-space: nowrap">启用 {{ sg.enabledCount }} / 共 {{ sg.channelCount }}</td>
            <td><n-text depth="3" style="font-size: 12px">{{ sg.sampleNames.join('、') }}{{ sg.channelCount > sg.sampleNames.length ? ' 等' : '' }}</n-text></td>
            <td style="text-align: right">
              <router-link :to="addFromSuggestion(sg)" custom v-slot="{ navigate }"><n-button size="small" type="primary" secondary @click="navigate">添加</n-button></router-link>
            </td>
          </tr>
        </tbody>
      </n-table>
    </n-card>

    <n-empty v-if="upstreams.length === 0" description="还没有上游。添加一个 new-api / sub2api 上游后，这里会显示余额与消耗速度。" style="margin-top: 60px">
      <template #extra>
        <router-link to="/upstreams/new" custom v-slot="{ navigate }"><n-button type="primary" @click="navigate">添加上游</n-button></router-link>
      </template>
    </n-empty>

    <n-grid v-else cols="1 800:2 1200:3" :x-gap="16" :y-gap="16">
      <n-grid-item v-for="u in sorted" :key="u.id">
        <n-card size="small" :style="{ borderLeft: `4px solid ${STATUS_META[u.status].color}`, opacity: u.enabled ? 1 : 0.65 }">
          <template #header>
            <router-link :to="`/upstreams/${u.id}`" style="color: inherit; text-decoration: none; font-weight: 600">{{ u.name }}</router-link>
          </template>
          <template #header-extra>
            <n-space :size="6">
              <n-tag size="small" :bordered="false">{{ TYPE_LABEL[u.type] }}</n-tag>
              <n-tag size="small" :type="STATUS_META[u.status].tag">{{ STATUS_META[u.status].label }}</n-tag>
            </n-space>
          </template>

          <div style="font-size: 28px; font-weight: 600; line-height: 1.3" :style="{ color: STATUS_META[u.status].color }">
            {{ u.status === 'unknown' ? '余额未知' : u.status === 'unsupported' ? '暂不支持订阅制' : usd(u.balanceUsd) }}
          </div>
          <n-text v-if="u.balanceKind === 'key_limit'" type="warning" style="font-size: 12px">这是 Key 限额，不是钱包余额</n-text>

          <div style="margin-top: 8px; font-size: 13px; line-height: 1.9">
            <div>
              阈值 {{ usd(u.threshold) }}<template v-if="u.emergencyThreshold !== null">，紧急 {{ usd(u.emergencyThreshold) }}</template>
            </div>
            <div v-if="u.status !== 'unsupported'">
              消耗速度 {{ burnText(u, now) }}
              <span style="margin: 0 4px">·</span>预计可用 {{ etaText(u, now) }}
            </div>
            <div v-if="channelsConfigured">
              接入渠道
              <template v-if="counts.get(u.id)">
                <n-text :type="counts.get(u.id)!.enabled === 0 ? 'error' : undefined">启用 {{ counts.get(u.id)!.enabled }} / 共 {{ counts.get(u.id)!.total }}</n-text>
              </template>
              <n-text v-else depth="3">暂无</n-text>
            </div>
            <div v-if="channelsConfigured && rollups.get(u.id)">
              渠道健康
              <health-tag :status="rollups.get(u.id)!.status" :title="'取该上游启用且有请求的渠道中最差的状态'" />
              <n-text depth="3" style="margin-left: 6px">
                {{ rollups.get(u.id)!.status === 'idle' ? (rollups.get(u.id)!.enabledChannels === 0 ? '没有启用的渠道' : '近 1 小时无请求') : `${rollups.get(u.id)!.counted} 个渠道有请求` }}
              </n-text>
            </div>
            <div>
              <n-text depth="3">最后刷新 {{ formatAgo(u.lastCheckedAt, now) }}</n-text>
            </div>
            <div v-if="u.lastError"><n-text type="error">{{ u.lastError }}</n-text></div>
          </div>

          <n-space style="margin-top: 12px" :size="8">
            <n-button v-if="u.effectiveTopupUrl" size="small" type="primary" secondary tag="a" :href="u.effectiveTopupUrl" target="_blank" rel="noopener noreferrer">充值</n-button>
            <n-button size="small" :loading="isRefreshing(u.id)" :disabled="!u.enabled" @click="onRefresh(u)">立即刷新</n-button>
            <router-link :to="`/upstreams/${u.id}`" custom v-slot="{ navigate }"><n-button size="small" quaternary @click="navigate">详情</n-button></router-link>
            <router-link :to="`/upstreams/${u.id}#config`" custom v-slot="{ navigate }"><n-button size="small" quaternary @click="navigate">编辑</n-button></router-link>
          </n-space>
        </n-card>
      </n-grid-item>
    </n-grid>
  </n-space>
</template>
