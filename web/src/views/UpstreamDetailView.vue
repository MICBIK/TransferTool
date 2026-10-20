<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NAlert, NButton, NCard, NGrid, NGridItem, NPopconfirm, NRadioButton, NRadioGroup, NSpace, NTabPane, NTabs, NTag, NText, useMessage } from 'naive-ui';
import { api, ApiError } from '../api';
import BalanceChart from '../components/BalanceChart.vue';
import HealthTag from '../components/HealthTag.vue';
import StatTile from '../components/StatTile.vue';
import { getUpstreamHealth, pct, type HealthStatus } from '../health';
import UpstreamChannels from '../components/UpstreamChannels.vue';
import UpstreamForm from '../components/UpstreamForm.vue';
import MuteControl from '../components/MuteControl.vue';
import { KEY_LIMIT_HINT, STATUS_META, keyQuotaText, statusLabel, TYPE_LABEL, burnText, etaSpan, formatAgo, shortTime, getHistory, getUpstream, refreshOne, usd, type HistoryPoint, type Upstream } from '../upstreams';

const route = useRoute();
const router = useRouter();
const message = useMessage();

const upstream = ref<Upstream | null>(null);
const points = ref<HistoryPoint[]>([]);
const days = ref(7);
const refreshing = ref(false);
const missing = ref(false);

const id = computed(() => Number(route.params.id));
const channelStat = ref<{ enabled: number; total: number; rollup: HealthStatus | null; rate: number | null } | null>(null);

const balanceValue = computed(() => {
  const u = upstream.value;
  if (!u) return '—';
  if (u.needsSetup) return '待配置';
  if (u.status === 'unsupported') return '暂不支持';
  if (u.balanceUsd === null) return '未知';
  return usd(u.balanceUsd);
});
const etaColor = computed(() => {
  const u = upstream.value;
  if (!u || u.burnBasis !== 'estimated' || u.exhaustAt === null) return undefined;
  const days = (u.exhaustAt - Date.now()) / 86_400_000;
  return days < 3 ? '#d03b3b' : days < 7 ? '#c98500' : undefined;
});

/** 渠道数与健康：取不到（未连接本站等）就不显示 */
async function loadChannels() {
  try {
    const h = await getUpstreamHealth(id.value);
    let req = 0;
    let err = 0;
    for (const c of h.channels) {
      req += c.requests24h;
      err += c.errors24h;
    }
    channelStat.value = {
      enabled: h.channels.filter((c) => c.enabled).length,
      total: h.channels.length,
      rollup: h.channels.length ? h.rollup.status : null,
      rate: req > 0 ? (req - err) / req : null,
    };
  } catch {
    channelStat.value = null;
  }
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : '网络错误，请稍后重试';
}

async function loadHistory() {
  try {
    points.value = (await getHistory(id.value, days.value)).points;
  } catch (err) {
    message.error(errorText(err));
  }
}

async function load() {
  try {
    upstream.value = await getUpstream(id.value);
    missing.value = false;
    await Promise.all([loadHistory(), loadChannels()]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) missing.value = true;
    else message.error(errorText(err));
  }
}

async function onRefresh() {
  refreshing.value = true;
  try {
    upstream.value = await refreshOne(id.value);
    await loadHistory();
  } catch (err) {
    message.error(errorText(err));
  } finally {
    refreshing.value = false;
  }
}

/** 页签与地址栏的 #hash 同步：从上游列表“编辑”进来直接打开配置页签，刷新页面也停在原页签 */
type Tab = 'overview' | 'channels' | 'config';
const TABS: Tab[] = ['overview', 'channels', 'config'];
const tab = computed<Tab>({
  get: () => {
    const h = route.hash.slice(1) as Tab;
    if (TABS.includes(h)) return h;
    // 自动创建、待填密钥的上游默认打开配置页签
    return upstream.value?.needsSetup ? 'config' : 'overview';
  },
  set: (t) => void router.replace({ hash: `#${t}` }),
});
function openConfig() {
  tab.value = 'config';
}

async function onSaved(u: Upstream) {
  const wasSetup = upstream.value?.needsSetup === true;
  upstream.value = u;
  // 刚填完密钥：切到概览看余额
  if (wasSetup && !u.needsSetup) tab.value = 'overview';
  await loadHistory();
}

async function onDelete() {
  try {
    await api(`/api/upstreams/${id.value}`, { method: 'DELETE' });
    message.success('已删除');
    await router.push({ name: 'upstreams' });
  } catch (err) {
    message.error(errorText(err));
  }
}

watch(days, () => void loadHistory());
watch(id, () => void load());
onMounted(() => void load());
</script>

<template>
  <n-space v-if="missing" vertical>
    <n-alert type="warning" :show-icon="false">该上游不存在或已被删除。</n-alert>
    <router-link to="/upstreams" custom v-slot="{ navigate }"><n-button @click="navigate">返回上游列表</n-button></router-link>
  </n-space>

  <n-space v-else-if="upstream" vertical :size="16" style="max-width: 1100px">
    <n-space justify="space-between" align="center">
      <n-space align="center">
        <router-link to="/upstreams" custom v-slot="{ navigate }"><n-button quaternary size="small" @click="navigate">← 上游</n-button></router-link>
        <span style="font-size: 18px; font-weight: 600">{{ upstream.name }}</span>
        <n-tag size="small" :bordered="false">{{ TYPE_LABEL[upstream.type] }}</n-tag>
        <n-tag size="small" :type="STATUS_META[upstream.status].tag">{{ statusLabel(upstream) }}</n-tag>
        <n-tag v-if="upstream.channelsStopped && upstream.alertMutedUntil === null" size="small" :bordered="false" title="本站里它的渠道都被手动停用了，余额不足也不会再发提醒">渠道已全部停用，不提醒</n-tag>
      </n-space>
      <n-space align="center">
        <mute-control :upstream="upstream" @updated="(u) => (upstream = u)" />
        <n-button v-if="upstream.effectiveTopupUrl" type="primary" secondary tag="a" :href="upstream.effectiveTopupUrl" target="_blank" rel="noopener noreferrer">充值</n-button>
        <n-button :loading="refreshing" :disabled="!upstream.enabled || upstream.needsSetup" @click="onRefresh">立即刷新</n-button>
      </n-space>
    </n-space>

    <n-tabs v-model:value="tab" type="line" animated>
      <n-tab-pane name="overview" tab="概览">
        <n-space vertical :size="16">
          <n-alert v-if="upstream.needsSetup" type="info" :show-icon="false">
            这个上游还没配置密钥，暂时没有余额数据。
            <n-button text type="primary" style="margin-left: 8px" @click="openConfig">去填入密钥</n-button>
          </n-alert>
          <n-alert v-else-if="upstream.lastError" type="error" :show-icon="false">
            {{ upstream.lastError }}
            <n-button text type="primary" style="margin-left: 8px" @click="openConfig">去修改配置</n-button>
          </n-alert>
          <n-alert v-else-if="upstream.balanceKind === 'key_limit'" type="warning" :show-icon="false">
            {{ KEY_LIMIT_HINT }}
            <n-button text type="primary" style="margin-left: 8px" @click="openConfig">去换 Key</n-button>
          </n-alert>

          <n-grid cols="2 760:4" :x-gap="12" :y-gap="12">
            <n-grid-item>
              <stat-tile :label="upstream.balanceKind === 'key_limit' ? 'Key 剩余额度' : '余额'" :value="balanceValue" :color="STATUS_META[upstream.status].color">
                阈值 {{ usd(upstream.threshold) }}<template v-if="upstream.emergencyThreshold !== null">，紧急 {{ usd(upstream.emergencyThreshold) }}</template>
                <template v-if="upstream.balanceKind === 'key_limit'"><br /><n-text type="warning" style="font-size: 12px">{{ keyQuotaText(upstream) ?? '这是 Key 限额' }}，不是账户余额</n-text></template>
              </stat-tile>
            </n-grid-item>
            <n-grid-item>
              <stat-tile label="消耗速度" :value="upstream.burnBasis === 'estimated' && upstream.burnUsdPerDay !== null ? `${usd(upstream.burnUsdPerDay)}/天` : '—'">
                {{ upstream.burnBasis === 'estimated' ? '按最近 24 小时估算，充值不计' : burnText(upstream) }}
              </stat-tile>
            </n-grid-item>
            <n-grid-item>
              <stat-tile label="预计可用" :value="upstream.burnBasis === 'estimated' && upstream.exhaustAt !== null ? etaSpan(upstream.exhaustAt) : '—'" :color="etaColor">
                {{ upstream.burnBasis === 'estimated' && upstream.exhaustAt !== null ? `预计 ${shortTime(upstream.exhaustAt)} 用完` : upstream.burnBasis === 'no_usage' ? '近期没有消耗' : '等消耗速度算出来后显示' }}
              </stat-tile>
            </n-grid-item>
            <n-grid-item>
              <stat-tile label="渠道" :value="channelStat ? `启用 ${channelStat.enabled} / ${channelStat.total}` : '—'" :color="channelStat && channelStat.total > 0 && channelStat.enabled === 0 ? '#d03b3b' : undefined">
                <template v-if="channelStat && channelStat.rollup">
                  <health-tag :status="channelStat.rollup" style="transform: scale(0.9); transform-origin: left center" />
                  <span v-if="channelStat.rate !== null"> 24 小时成功率 {{ pct(channelStat.rate) }}</span>
                </template>
                <template v-else>本站渠道里没有指向它的渠道</template>
              </stat-tile>
            </n-grid-item>
          </n-grid>

          <n-card title="余额曲线" size="small">
            <template #header-extra>
              <n-radio-group v-model:value="days" size="small">
                <n-radio-button :value="7">近 7 天</n-radio-button>
                <n-radio-button :value="30">近 30 天</n-radio-button>
              </n-radio-group>
            </template>
            <balance-chart v-if="points.length > 1" :points="points" :threshold="upstream.threshold" :emergency-threshold="upstream.emergencyThreshold" />
            <n-text v-else depth="3">暂无足够的历史数据（至少需要两次成功刷新）</n-text>
          </n-card>
          <n-text depth="3" style="font-size: 12px">
            最后刷新 {{ formatAgo(upstream.lastCheckedAt) }}，每 {{ upstream.intervalMinutes }} 分钟自动刷新 · 最近一次提醒：{{ upstream.alertLastSentAt ? formatAgo(upstream.alertLastSentAt) : '无' }}<template v-if="upstream.alertLastResult">（{{ upstream.alertLastResult }}）</template>
          </n-text>
        </n-space>
      </n-tab-pane>

      <n-tab-pane name="channels" tab="渠道与分组">
        <upstream-channels :upstream-id="upstream.id" :upstream-name="upstream.name" />
      </n-tab-pane>

      <n-tab-pane name="config" tab="配置">
        <n-space vertical :size="16">
          <n-card size="small">
            <upstream-form :upstream="upstream" @saved="onSaved" />
          </n-card>
          <n-card title="危险操作" size="small">
            <n-popconfirm @positive-click="onDelete">
              <template #trigger><n-button type="error" secondary>删除该上游</n-button></template>
              删除后其余额历史也会一并删除。本站里还留着这个站的渠道时，同步不会再把它自动建回来；这些渠道都删掉后，再新增这个站的渠道会重新自动创建。确定吗？
            </n-popconfirm>
          </n-card>
        </n-space>
      </n-tab-pane>
    </n-tabs>
  </n-space>
</template>
