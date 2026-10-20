<script setup lang="ts">
import { ref } from 'vue';
import { NButton, NDropdown, NTag, useMessage } from 'naive-ui';
import { ApiError } from '../api';
import { MUTE_OPTIONS, muteText, muteUpstream, type MuteMode, type Upstream } from '../upstreams';

/** 提醒静音：未静音时是「忽略」下拉，静音中显示截止时间和「恢复提醒」。 */
const props = withDefaults(defineProps<{ upstream: Upstream; label?: string; size?: 'tiny' | 'small' | 'medium' }>(), { label: '忽略提醒', size: 'small' });
const emit = defineEmits<{ updated: [Upstream] }>();
const message = useMessage();
const busy = ref(false);

async function set(mode: MuteMode) {
  busy.value = true;
  try {
    const u = await muteUpstream(props.upstream.id, mode);
    emit('updated', u);
    message.success(mode === 'off' ? `已恢复 ${u.name} 的提醒` : `${muteText(u)}：不发邮件，也不出现在「需要处理」里`);
  } catch (err) {
    message.error(err instanceof ApiError ? err.message : '网络错误，请稍后重试');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <span v-if="upstream.alertMutedUntil !== null" class="muted">
    <n-tag size="small" :bordered="false">{{ muteText(upstream) }}</n-tag>
    <n-button :size="size" text type="primary" :loading="busy" @click="set('off')">恢复提醒</n-button>
  </span>
  <n-dropdown v-else trigger="click" :options="MUTE_OPTIONS" @select="(k: MuteMode) => set(k)">
    <n-button :size="size" quaternary :loading="busy">{{ label }}</n-button>
  </n-dropdown>
</template>

<style scoped>
.muted {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
</style>
