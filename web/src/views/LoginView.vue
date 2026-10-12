<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSpace, NTabPane, NTabs, useMessage } from 'naive-ui';
import { api, ApiError } from '../api';
import { refreshSession, session } from '../session';

const router = useRouter();
const message = useMessage();

const tab = ref<'password' | 'code'>(session.methods.password ? 'password' : 'code');
const password = ref('');
const code = ref('');
const loading = ref(false);
const sending = ref(false);
const countdown = ref(0);
const error = ref('');
let timer: ReturnType<typeof setInterval> | undefined;

const codeValid = computed(() => /^\d{6}$/.test(code.value));

// 以服务端当前的登录方式为准（可能刚被修改过）
onMounted(async () => {
  await refreshSession().catch(() => undefined);
  if (!session.methods.password) tab.value = 'code';
  else if (!session.methods.emailCode) tab.value = 'password';
});

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429 && err.retryAfterSeconds) {
      const minutes = Math.ceil(err.retryAfterSeconds / 60);
      return err.retryAfterSeconds > 90 ? `${err.message}（约 ${minutes} 分钟后）` : `${err.message}（${err.retryAfterSeconds} 秒后）`;
    }
    return err.message;
  }
  return '网络错误，请稍后重试';
}

async function enter() {
  await refreshSession();
  await router.replace('/');
}

async function submitPassword() {
  if (!password.value) return;
  loading.value = true;
  error.value = '';
  try {
    await api('/api/auth/login', { body: { password: password.value } });
    await enter();
  } catch (err) {
    error.value = describe(err);
  } finally {
    loading.value = false;
  }
}

function startCountdown(seconds: number) {
  countdown.value = seconds;
  clearInterval(timer);
  timer = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) clearInterval(timer);
  }, 1000);
}

async function sendCode() {
  sending.value = true;
  error.value = '';
  try {
    // 收件人固定为站长邮箱，请求里不带任何邮箱参数
    const res = await api<{ resendAfterSeconds: number }>('/api/auth/code/request', { body: {} });
    startCountdown(res.resendAfterSeconds);
    message.success('验证码已发送到站长邮箱');
  } catch (err) {
    if (err instanceof ApiError && err.status === 429 && err.code === 'too_soon' && err.retryAfterSeconds) startCountdown(err.retryAfterSeconds);
    error.value = describe(err);
  } finally {
    sending.value = false;
  }
}

async function submitCode() {
  if (!codeValid.value) return;
  loading.value = true;
  error.value = '';
  try {
    await api('/api/auth/code/verify', { body: { code: code.value } });
    await enter();
  } catch (err) {
    error.value = describe(err);
  } finally {
    loading.value = false;
  }
}

onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div style="min-height: 100%; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box">
    <n-card title="TransferTool" style="width: 380px; max-width: 100%">
      <n-alert v-if="error" type="error" :show-icon="false" style="margin-bottom: 16px">{{ error }}</n-alert>
      <n-tabs v-model:value="tab" type="line" animated>
        <n-tab-pane v-if="session.methods.password" name="password" tab="密码登录">
          <n-form @submit.prevent="submitPassword">
            <n-form-item label="密码" :show-feedback="false">
              <n-input v-model:value="password" type="password" show-password-on="click" placeholder="请输入管理员密码" autocomplete="current-password" @keyup.enter="submitPassword" />
            </n-form-item>
            <n-button type="primary" block attr-type="submit" :loading="loading" :disabled="!password" style="margin-top: 20px" @click="submitPassword">登录</n-button>
          </n-form>
        </n-tab-pane>
        <n-tab-pane v-if="session.methods.emailCode" name="code" tab="邮件验证码">
          <n-space vertical :size="16">
            <div style="opacity: 0.7">验证码将发送到站长邮箱，有效期 5 分钟。</div>
            <n-button block secondary :loading="sending" :disabled="countdown > 0" @click="sendCode">
              {{ countdown > 0 ? `${countdown} 秒后可重新获取` : '获取验证码' }}
            </n-button>
            <n-input v-model:value="code" placeholder="6 位验证码" :maxlength="6" inputmode="numeric" autocomplete="one-time-code" @keyup.enter="submitCode" />
            <n-button type="primary" block :loading="loading" :disabled="!codeValid" @click="submitCode">登录</n-button>
          </n-space>
        </n-tab-pane>
      </n-tabs>
    </n-card>
  </div>
</template>
