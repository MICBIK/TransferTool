<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NAlert, NButton, NCard, NDescriptions, NDescriptionsItem, NPopconfirm, NRadioButton, NRadioGroup, NSpace, NTabPane, NTabs, NTag, NText, useMessage } from 'naive-ui';
import { api, ApiError } from '../api';
import BalanceChart from '../components/BalanceChart.vue';
import UpstreamChannels from '../components/UpstreamChannels.vue';
import UpstreamForm from '../components/UpstreamForm.vue';
import { STATUS_META, TYPE_LABEL, burnText, etaText, formatAgo, getHistory, getUpstream, refreshOne, usd, type HistoryPoint, type Upstream } from '../upstreams';

const route = useRoute();
const router = useRouter();
const message = useMessage();

const upstream = ref<Upstream | null>(null);
const points = ref<HistoryPoint[]>([]);
const days = ref(7);
const refreshing = ref(false);
const missing = ref(false);

const id = computed(() => Number(route.params.id));

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
    await loadHistory();
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

/** 页签与地址栏的 #hash 同步：从总览“编辑”进来直接打开配置页签，刷新页面也停在原页签 */
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
  upstream.value = u;
  await loadHistory();
}

async function onDelete() {
  try {
    await api(`/api/upstreams/${id.value}`, { method: 'DELETE' });
    message.success('已删除');
    await router.push({ name: 'overview' });
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
    <router-link to="/" custom v-slot="{ navigate }"><n-button @click="navigate">返回总览</n-button></router-link>
  </n-space>

  <n-space v-else-if="upstream" vertical :size="16" style="max-width: 960px">
    <n-space justify="space-between" align="center">
      <n-space align="center">
        <router-link to="/" custom v-slot="{ navigate }"><n-button quaternary size="small" @click="navigate">← 总览</n-button></router-link>
        <span style="font-size: 18px; font-weight: 600">{{ upstream.name }}</span>
        <n-tag size="small" :bordered="false">{{ TYPE_LABEL[upstream.type] }}</n-tag>
        <n-tag size="small" :type="STATUS_META[upstream.status].tag">{{ STATUS_META[upstream.status].label }}</n-tag>
      </n-space>
      <n-space>
        <n-button v-if="upstream.effectiveTopupUrl" type="primary" secondary tag="a" :href="upstream.effectiveTopupUrl" target="_blank" rel="noopener noreferrer">充值</n-button>
        <n-button :loading="refreshing" :disabled="!upstream.enabled || upstream.needsSetup" @click="onRefresh">立即刷新</n-button>
      </n-space>
    </n-space>

    <n-tabs v-model:value="tab" type="line" animated>
      <n-tab-pane name="overview" tab="概览">
        <n-space vertical :size="16">
          <n-card title="当前状态" size="small">
            <n-descriptions :column="2" label-placement="left" size="small">
              <n-descriptions-item :label="upstream.balanceKind === 'key_limit' ? 'Key 剩余额度' : '余额'">
                <template v-if="upstream.status === 'unsupported'">暂不支持订阅制</template>
                <template v-else-if="upstream.status === 'unknown'">余额未知（连续 {{ upstream.consecutiveFailures }} 次刷新失败）</template>
                <template v-else>{{ usd(upstream.balanceUsd) }}</template>
                <n-text v-if="upstream.balanceKind === 'key_limit'" type="warning" style="margin-left: 8px">这是 Key 限额，不是钱包余额</n-text>
              </n-descriptions-item>
              <n-descriptions-item label="阈值">{{ usd(upstream.threshold) }}<template v-if="upstream.emergencyThreshold !== null">（紧急 {{ usd(upstream.emergencyThreshold) }}）</template></n-descriptions-item>
              <n-descriptions-item label="消耗速度">{{ burnText(upstream) }}</n-descriptions-item>
              <n-descriptions-item label="预计可用">{{ etaText(upstream) }}</n-descriptions-item>
              <n-descriptions-item label="最后刷新">{{ formatAgo(upstream.lastCheckedAt) }}（每 {{ upstream.intervalMinutes }} 分钟）</n-descriptions-item>
              <n-descriptions-item label="最近一次提醒">{{ upstream.alertLastSentAt ? formatAgo(upstream.alertLastSentAt) : '无' }}<template v-if="upstream.alertLastResult">（{{ upstream.alertLastResult }}）</template></n-descriptions-item>
            </n-descriptions>
            <n-alert v-if="upstream.lastError" type="error" :show-icon="false" style="margin-top: 12px">
              {{ upstream.lastError }}
              <n-button text type="primary" style="margin-left: 8px" @click="openConfig">去修改配置</n-button>
            </n-alert>
          </n-card>

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
              删除后其余额历史也会一并删除，确定吗？
            </n-popconfirm>
          </n-card>
        </n-space>
      </n-tab-pane>
    </n-tabs>
  </n-space>
</template>
