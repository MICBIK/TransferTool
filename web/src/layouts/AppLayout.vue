<script setup lang="ts">
import { computed, h, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { NButton, NDrawer, NDrawerContent, NLayout, NLayoutHeader, NLayoutSider, NMenu, type MenuOption } from 'naive-ui';
import { useNarrow } from '../narrow';
import { logout } from '../session';

const route = useRoute();
const router = useRouter();

const link = (to: string, label: string) => () => h(RouterLink, { to }, { default: () => label });
const options: MenuOption[] = [
  { key: 'overview', label: link('/', '总览') },
  { key: 'upstreams', label: link('/upstreams', '上游') },
  { key: 'channels', label: link('/channels', '渠道') },
  { key: 'settings', label: link('/settings', '设置') },
];
const active = computed(() => (String(route.name ?? '').startsWith('upstream') ? 'upstreams' : String(route.name ?? 'overview')));
const title = computed(() => {
  const name = String(route.name ?? '');
  if (name === 'settings') return '设置';
  if (name === 'channels') return '渠道';
  if (name === 'upstream-new') return '添加上游';
  if (name === 'upstream') return '上游详情';
  if (name === 'upstreams') return '上游';
  return '总览';
});

// 窄屏（手机）用抽屉菜单，切换页面后自动关闭
const narrow = useNarrow();
const drawer = ref(false);
watch(
  () => route.fullPath,
  () => (drawer.value = false),
);

async function onLogout() {
  await logout();
  await router.push({ name: 'login' });
}
</script>

<template>
  <n-layout has-sider style="height: 100%">
    <n-layout-sider v-if="!narrow" bordered :width="200" content-style="display:flex;flex-direction:column;height:100%">
      <div style="padding: 20px 24px 12px; font-size: 18px; font-weight: 600">TransferTool</div>
      <n-menu :options="options" :value="active" style="flex: 1" />
      <div style="padding: 16px">
        <n-button block secondary @click="onLogout">退出登录</n-button>
      </div>
    </n-layout-sider>
    <n-drawer v-else v-model:show="drawer" placement="left" :width="220">
      <n-drawer-content title="TransferTool" :native-scrollbar="false" body-content-style="padding: 8px 0">
        <n-menu :options="options" :value="active" />
        <div style="padding: 16px">
          <n-button block secondary @click="onLogout">退出登录</n-button>
        </div>
      </n-drawer-content>
    </n-drawer>
    <n-layout>
      <n-layout-header bordered style="padding: 14px 24px; font-weight: 500; display: flex; align-items: center; gap: 12px">
        <n-button v-if="narrow" quaternary size="small" aria-label="菜单" @click="drawer = true">☰</n-button>
        {{ title }}
      </n-layout-header>
      <n-layout :content-style="narrow ? 'padding: 16px' : 'padding: 24px'" style="height: calc(100% - 53px)">
        <router-view />
      </n-layout>
    </n-layout>
  </n-layout>
</template>
