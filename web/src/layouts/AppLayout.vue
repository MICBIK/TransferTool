<script setup lang="ts">
import { computed, h } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { NButton, NLayout, NLayoutHeader, NLayoutSider, NMenu, type MenuOption } from 'naive-ui';
import { logout } from '../session';

const route = useRoute();
const router = useRouter();

const link = (to: string, label: string) => () => h(RouterLink, { to }, { default: () => label });
const options: MenuOption[] = [
  { key: 'overview', label: link('/', '总览') },
  { key: 'channels', label: link('/channels', '渠道') },
  { key: 'settings', label: link('/settings', '设置') },
];
const active = computed(() => String(route.name ?? 'overview'));

async function onLogout() {
  await logout();
  await router.push({ name: 'login' });
}
</script>

<template>
  <n-layout has-sider style="height: 100%">
    <n-layout-sider bordered :width="200" content-style="display:flex;flex-direction:column;height:100%">
      <div style="padding: 20px 24px 12px; font-size: 18px; font-weight: 600">TransferTool</div>
      <n-menu :options="options" :value="active" style="flex: 1" />
      <div style="padding: 16px">
        <n-button block secondary @click="onLogout">退出登录</n-button>
      </div>
    </n-layout-sider>
    <n-layout>
      <n-layout-header bordered style="padding: 14px 24px; font-weight: 500">
        {{ route.name === 'settings' ? '设置' : route.name === 'channels' ? '渠道' : '总览' }}
      </n-layout-header>
      <n-layout content-style="padding: 24px" style="height: calc(100% - 53px)">
        <router-view />
      </n-layout>
    </n-layout>
  </n-layout>
</template>
