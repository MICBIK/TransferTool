import { reactive } from 'vue';
import { api } from './api';

interface SessionInfo {
  authenticated: boolean;
  methods: { password: boolean; emailCode: boolean };
}

export const session = reactive({
  loaded: false,
  authenticated: false,
  methods: { password: true, emailCode: false },
});

export async function refreshSession(): Promise<void> {
  const info = await api<SessionInfo>('/api/auth/session');
  session.authenticated = info.authenticated;
  session.methods = info.methods;
  session.loaded = true;
}

export async function logout(): Promise<void> {
  await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
  session.authenticated = false;
}
