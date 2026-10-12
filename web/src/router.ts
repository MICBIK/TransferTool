import { createRouter, createWebHistory } from 'vue-router';
import { setUnauthorizedHandler } from './api';
import { refreshSession, session } from './session';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
    {
      path: '/',
      component: () => import('./layouts/AppLayout.vue'),
      children: [
        { path: '', name: 'overview', component: () => import('./views/OverviewView.vue') },
        { path: 'channels', name: 'channels', component: () => import('./views/ChannelsView.vue') },
        { path: 'settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to) => {
  if (!session.loaded) {
    try {
      await refreshSession();
    } catch {
      // 后端暂时不可达：按未登录处理
      session.loaded = true;
    }
  }
  if (to.meta.public) return session.authenticated ? { path: '/' } : true;
  return session.authenticated ? true : { name: 'login' };
});

setUnauthorizedHandler(() => {
  session.authenticated = false;
  if (router.currentRoute.value.name !== 'login') void router.push({ name: 'login' });
});
