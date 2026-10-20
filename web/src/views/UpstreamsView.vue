<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { NAlert, NButton, NCard, NEmpty, NGrid, NGridItem, NSpace, NTag, NText, useMessage } from 'naive-ui';
import { ApiError } from '../api';
import { channelSummary, type ChannelCount } from '../channels';
import HealthNotices from '../components/HealthNotices.vue';
import HealthTag from '../components/HealthTag.vue';
import { getHealth, type HealthOverview, type UpstreamRollup } from '../health';
import { STATUS_META, keyQuotaText, quietText, statusLabel, TYPE_LABEL, burnText, etaText, formatAgo, listUpstreams, refreshAll, refreshOne, sortUpstreams, usd, type Upstream } from '../upstreams';

const message = useMessage();
const upstreams = ref<Upstream[]>([]);
const loaded = ref(false);
const counts = ref<Map<number | null, ChannelCount>>(new Map());
const channelsConfigured = ref(false);
const health = ref<HealthOverview | null>(null);
const setupCount = computed(() => upstreams.value.filter((u) => u.needsSetup).length);
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

    <n-alert v-if="setupCount > 0" type="info" :show-icon="false">
      根据本站渠道自动创建了 {{ setupCount }} 个上游（标为“待配置”）。到对应上游站点生成访问令牌（new-api）或 API Key（sub2api），点卡片上的「填入密钥」粘贴进去，并确认类型是否正确。不需要的上游直接删除即可，之后不会再自动创建。
    </n-alert>

    <n-empty
      v-if="upstreams.length === 0"
      :description="channelsConfigured ? '还没有上游。本站渠道里没有可识别的上游域名，可以手动添加 new-api / sub2api 上游。' : '还没有上游。先在「设置 → 本站连接」连上你的 new-api，同步渠道后会按域名自动创建上游；也可以手动添加。'"
      style="margin-top: 60px"
    >
      <template #extra>
        <n-space justify="center">
          <router-link v-if="!channelsConfigured" to="/settings#site" custom v-slot="{ navigate }"><n-button type="primary" @click="navigate">去连接本站</n-button></router-link>
          <router-link to="/upstreams/new" custom v-slot="{ navigate }"><n-button :type="channelsConfigured ? 'primary' : 'default'" @click="navigate">手动添加上游</n-button></router-link>
        </n-space>
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
              <n-tag size="small" :type="STATUS_META[u.status].tag">{{ statusLabel(u) }}</n-tag>
              <n-tag v-if="quietText(u)" size="small" :bordered="false" :title="quietText(u)!">不提醒</n-tag>
            </n-space>
          </template>

          <template v-if="u.needsSetup">
            <div style="font-size: 13px; line-height: 1.9">
              <div>{{ u.siteUrl }}</div>
              <div>类型（自动识别，请确认）：{{ TYPE_LABEL[u.type] }}</div>
              <div v-if="channelsConfigured && counts.get(u.id)">接入渠道 启用 {{ counts.get(u.id)!.enabled }} / 共 {{ counts.get(u.id)!.total }}</div>
            </div>
            <n-space style="margin-top: 12px" :size="8">
              <router-link :to="`/upstreams/${u.id}#config`" custom v-slot="{ navigate }"><n-button size="small" type="primary" @click="navigate">填入密钥</n-button></router-link>
              <n-button size="small" quaternary tag="a" :href="u.siteUrl" target="_blank" rel="noopener noreferrer">打开站点</n-button>
            </n-space>
          </template>
          <template v-else>
          <div style="font-size: 28px; font-weight: 600; line-height: 1.3" :style="{ color: STATUS_META[u.status].color }">
            {{ u.status === 'unknown' ? '余额未知' : u.status === 'unsupported' ? '暂不支持订阅制' : usd(u.balanceUsd) }}
          </div>
          <n-text v-if="u.balanceKind === 'key_limit'" type="warning" style="font-size: 12px">{{ keyQuotaText(u) ?? '这是 Key 限额' }}，不是账户余额</n-text>

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
          </template>
        </n-card>
      </n-grid-item>
    </n-grid>
  </n-space>
</template>
