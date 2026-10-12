<script setup lang="ts">
import { NAlert } from 'naive-ui';
import type { HealthOverview } from '../health';
import { formatAgo } from '../upstreams';

defineProps<{ health: HealthOverview | null }>();
</script>

<template>
  <template v-if="health && health.ingest.configured">
    <n-alert v-if="health.ingest.lastError" type="warning" :show-icon="false">
      本站日志拉取失败：{{ health.ingest.lastError }}。健康状态可能已过期（上次成功 {{ formatAgo(health.ingest.lastSuccessAt) }}），将在下一轮自动重试。
    </n-alert>
    <n-alert v-if="health.missingErrorLogs" type="info" :show-icon="false">
      近 24 小时只拉取到消费日志、没有任何错误日志，成功率可能被高估。请确认本站已开启错误日志记录。
    </n-alert>
  </template>
</template>
