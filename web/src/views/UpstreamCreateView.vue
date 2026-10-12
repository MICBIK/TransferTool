<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NCard, NSpace } from 'naive-ui';
import UpstreamForm from '../components/UpstreamForm.vue';
import type { Upstream } from '../upstreams';

const router = useRouter();
const route = useRoute();
const q = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : undefined);
// 从总览“发现的上游”跳转过来时预填站点地址、名称与匹配域名
const prefill = computed(() => ({ name: q('name'), siteUrl: q('siteUrl'), matchDomains: q('domain') ? [q('domain')!] : undefined }));
function onSaved(u: Upstream) {
  void router.push(`/upstreams/${u.id}`);
}
</script>

<template>
  <n-space vertical :size="16" style="max-width: 960px">
    <router-link to="/" custom v-slot="{ navigate }"><n-button quaternary size="small" @click="navigate">← 总览</n-button></router-link>
    <n-card title="添加上游" size="small">
      <upstream-form :prefill="prefill" @saved="onSaved" />
    </n-card>
  </n-space>
</template>
