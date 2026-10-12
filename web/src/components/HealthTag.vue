<script setup lang="ts">
import { NTag } from 'naive-ui';
import { HEALTH_META, type HealthStatus } from '../health';

defineProps<{ status: HealthStatus; title?: string }>();
</script>

<template>
  <n-tag size="small" :type="HEALTH_META[status].tag" :title="title">{{ HEALTH_META[status].label }}</n-tag>
</template>
