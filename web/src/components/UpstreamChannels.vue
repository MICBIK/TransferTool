<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { NButton, NCollapse, NCollapseItem, NEmpty, NSpace, NTag, NText, useDialog, useMessage } from 'naive-ui';
import { ApiError } from '../api';
import { getUpstreamHealth, latency, pct, type ChannelDetail, type UpstreamRollup } from '../health';
import { formatAgo } from '../upstreams';
import HealthSparkline from './HealthSparkline.vue';
import HealthTag from './HealthTag.vue';
import { channelStatusMeta, describeResult, listChannels, setUpstreamChannelsStatus, type Channel, type ChannelListing } from '../channels';

const props = defineProps<{ upstreamId: number; upstreamName: string }>();
const message = useMessage();
const dialog = useDialog();

const listing = ref<ChannelListing | null>(null);
const busy = ref(false);
const rollup = ref<UpstreamRollup | null>(null);
const details = ref<Map<number, ChannelDetail>>(new Map());

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : '网络错误，请稍后重试');
const mine = computed<Channel[]>(() => (listing.value?.channels ?? []).filter((c) => c.upstreamId === props.upstreamId));
const enabled = computed(() => mine.value.filter((c) => c.status === 1));
const stopped = computed(() => mine.value.filter((c) => c.status === 2));

/** 按分组聚合：一个渠道可属于多个分组 */
const groups = computed(() => {
  const acc = new Map<string, { total: number; enabled: number }>();
  for (const c of mine.value) {
    for (const g of c.groups.length > 0 ? c.groups : ['（无分组）']) {
      const e = acc.get(g) ?? { total: 0, enabled: 0 };
      e.total++;
      if (c.status === 1) e.enabled++;
      acc.set(g, e);
    }
  }
  return [...acc].map(([name, v]) => ({ name, ...v })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
});

async function load() {
  try {
    listing.value = await listChannels();
  } catch (err) {
    message.error(errorText(err));
    return;
  }
  // 健康数据取不到不影响渠道列表
  try {
    const h = await getUpstreamHealth(props.upstreamId);
    rollup.value = h.rollup;
    details.value = new Map(h.channels.map((c) => [c.channelId, c]));
  } catch {
    rollup.value = null;
    details.value = new Map();
  }
}

function confirm(enable: boolean) {
  const n = (enable ? stopped : enabled).value.length;
  if (n === 0) return message.info(enable ? '没有需要启用的渠道（本站自动禁用的渠道不会被启用）' : '该上游的渠道都已停用');
  dialog.warning({
    title: enable ? '一键启用该上游全部渠道' : '一键停用该上游全部渠道',
    content: enable
      ? `将启用「${props.upstreamName}」下 ${n} 个已停用的渠道（本站因报错自动禁用的渠道不会被启用）。确定吗？`
      : `将停用「${props.upstreamName}」下 ${n} 个启用中的渠道，停用后它们不再接收请求。确定吗？`,
    positiveText: enable ? '确认启用' : '确认停用',
    negativeText: '取消',
    onPositiveClick: async () => {
      busy.value = true;
      try {
        const r = await setUpstreamChannelsStatus(props.upstreamId, enable ? 1 : 2);
        listing.value = r;
        const d = describeResult(r.result, enable ? '启用' : '停用');
        if (d.ok) message.success(d.text);
        else message.warning(d.text, { duration: 8000 });
      } catch (err) {
        message.error(errorText(err));
      } finally {
        busy.value = false;
      }
    },
  });
}

watch(() => props.upstreamId, () => void load());
onMounted(() => void load());
</script>

<template>
  <n-space v-if="listing && !listing.configured" vertical>
    <n-text depth="3">尚未配置本站，无法显示接入的渠道。</n-text>
    <router-link to="/settings" custom v-slot="{ navigate }"><n-button size="small" @click="navigate">前往设置</n-button></router-link>
  </n-space>
  <n-empty v-else-if="listing && mine.length === 0" description="暂无渠道归属于该上游。渠道按 base_url 的域名匹配上游的“匹配域名”，也可以在渠道页手动指定。" />
  <n-space v-else-if="listing" vertical :size="14">
    <n-space justify="space-between" align="center">
      <n-text>共 {{ mine.length }} 个渠道，启用 {{ enabled.length }} 个</n-text>
      <n-space>
        <n-button size="small" type="primary" secondary :loading="busy" :disabled="stopped.length === 0" @click="confirm(true)">一键启用全部</n-button>
        <n-button size="small" type="error" secondary :loading="busy" :disabled="enabled.length === 0" @click="confirm(false)">一键停用全部</n-button>
      </n-space>
    </n-space>

    <div>
      <n-text depth="3" style="font-size: 12px">分组（启用 / 总数）</n-text>
      <n-space :size="6" style="margin-top: 4px">
        <n-tag v-for="g in groups" :key="g.name" size="small" :type="g.enabled === 0 ? 'default' : 'success'" :bordered="false">{{ g.name }} {{ g.enabled }}/{{ g.total }}</n-tag>
      </n-space>
    </div>

    <n-space v-if="rollup" align="center" :size="8">
      <n-text depth="3" style="font-size: 12px">渠道整体健康</n-text>
      <health-tag :status="rollup.status" />
      <n-text depth="3" style="font-size: 12px">取启用且有请求的渠道中最差的状态；趋势图为近 24 小时成功率（空白处表示该时段没有请求）</n-text>
    </n-space>

    <div v-for="c in mine" :key="c.id" style="border-top: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.2)); padding-top: 10px">
      <div style="display: flex; gap: 8px; align-items: center; font-size: 13px; flex-wrap: wrap">
        <n-tag size="small" :type="channelStatusMeta(c.status).tag">{{ channelStatusMeta(c.status).label }}</n-tag>
        <span>{{ c.name }}</span>
        <n-text depth="3">#{{ c.id }} · {{ c.groups.join('、') || '无分组' }}</n-text>
        <n-tag v-if="c.autoDisabled" size="small" type="warning" :bordered="false">余额归零停用</n-tag>
        <health-tag v-if="details.get(c.id)" :status="details.get(c.id)!.status" />
      </div>
      <template v-if="details.get(c.id)">
        <div style="font-size: 12px; margin-top: 4px">
          成功率 1h {{ pct(details.get(c.id)!.successRate1h) }} · 24h {{ pct(details.get(c.id)!.successRate24h) }}
          <n-text depth="3">
            · 均耗时 {{ latency(details.get(c.id)!.avgLatencyMs1h ?? details.get(c.id)!.avgLatencyMs24h) }} · 24h 请求 {{ details.get(c.id)!.requests24h }}（错误 {{ details.get(c.id)!.errors24h }}）· 最近成功
            {{ details.get(c.id)!.lastSuccessAt ? formatAgo(details.get(c.id)!.lastSuccessAt) : '无' }}
          </n-text>
        </div>
        <template v-if="details.get(c.id)!.requests24h > 0">
          <health-sparkline :points="details.get(c.id)!.trend" style="margin-top: 4px; max-width: 560px" />
          <n-collapse v-if="details.get(c.id)!.errors.length > 0" style="margin-top: 4px">
            <n-collapse-item :title="`错误 Top ${details.get(c.id)!.errors.length}（近 24 小时）`" :name="c.id">
              <div v-for="e in details.get(c.id)!.errors" :key="e.message" style="font-size: 12px; display: flex; gap: 8px">
                <n-tag size="small" type="error" :bordered="false">{{ e.count }} 次</n-tag>
                <span style="word-break: break-all">{{ e.message }}</span>
              </div>
            </n-collapse-item>
          </n-collapse>
        </template>
      </template>
    </div>
  </n-space>
</template>
