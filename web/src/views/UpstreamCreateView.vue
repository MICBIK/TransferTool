<script setup lang="ts">
import { useRouter } from 'vue-router';
import { NButton, NCard, NSpace } from 'naive-ui';
import UpstreamForm from '../components/UpstreamForm.vue';
import type { Upstream } from '../upstreams';

const router = useRouter();

function onSaved(u: Upstream) {
  void router.push(`/upstreams/${u.id}`);
}
</script>

<template>
  <n-space vertical :size="16" style="max-width: 960px">
    <router-link to="/upstreams" custom v-slot="{ navigate }"><n-button quaternary size="small" @click="navigate">← 上游</n-button></router-link>
    <n-card title="添加上游" size="small">
      <upstream-form @saved="onSaved" />
    </n-card>
  </n-space>
</template>
