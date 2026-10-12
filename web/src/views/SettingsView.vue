<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NRadio,
  NSpace,
  NSwitch,
  useMessage,
} from 'naive-ui';
import { api, ApiError } from '../api';

interface SettingsView {
  loginMethod: 'password' | 'email_code' | 'both';
  adminEmail: string;
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string; passSet: boolean; from: string };
  smtpVerified: boolean;
  alertRepeatHours: number;
  autoDisableAtZero: boolean;
  emergencyPasswordConfigured: boolean;
  notice?: string;
}

const message = useMessage();

const state = reactive({
  loginMethod: 'password' as SettingsView['loginMethod'],
  adminEmail: '',
  smtp: { host: '', port: 465, secure: true, user: '', pass: '', passSet: false, from: '' },
  smtpVerified: false,
  alertRepeatHours: 6,
  autoDisableAtZero: false,
  emergencyPasswordConfigured: false,
});

const pwd = reactive({ current: '', next: '', confirm: '' });
const busy = reactive({ password: false, method: false, smtp: false, test: false, alerts: false });
const loaded = ref(false);

function apply(v: SettingsView) {
  state.loginMethod = v.loginMethod;
  state.adminEmail = v.adminEmail;
  state.smtp = { ...v.smtp, pass: '' };
  state.smtpVerified = v.smtpVerified;
  state.alertRepeatHours = v.alertRepeatHours;
  state.autoDisableAtZero = v.autoDisableAtZero;
  state.emergencyPasswordConfigured = v.emergencyPasswordConfigured;
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : '网络错误，请稍后重试';
}

async function load() {
  apply(await api<SettingsView>('/api/settings'));
  loaded.value = true;
}

async function changePassword() {
  if (pwd.next.length < 8) return message.warning('新密码至少 8 位');
  if (pwd.next !== pwd.confirm) return message.warning('两次输入的新密码不一致');
  busy.password = true;
  try {
    await api('/api/settings/password', { body: { currentPassword: pwd.current, newPassword: pwd.next } });
    pwd.current = pwd.next = pwd.confirm = '';
    message.success('密码已修改，其他设备上的登录已失效');
  } catch (err) {
    message.error(errorText(err));
  } finally {
    busy.password = false;
  }
}

async function saveMethod() {
  busy.method = true;
  try {
    const v = await api<SettingsView>('/api/settings', { method: 'PUT', body: { loginMethod: state.loginMethod } });
    apply(v);
    message.success('登录方式已保存');
  } catch (err) {
    message.error(errorText(err));
    await load();
  } finally {
    busy.method = false;
  }
}

async function saveAlerts() {
  busy.alerts = true;
  try {
    const v = await api<SettingsView>('/api/settings', {
      method: 'PUT',
      body: { alertRepeatHours: state.alertRepeatHours, autoDisableAtZero: state.autoDisableAtZero },
    });
    apply(v);
    message.success('提醒设置已保存');
  } catch (err) {
    message.error(errorText(err));
  } finally {
    busy.alerts = false;
  }
}

async function saveSmtp(): Promise<boolean> {
  busy.smtp = true;
  try {
    const { host, port, secure, user, pass, from } = state.smtp;
    const v = await api<SettingsView>('/api/settings', {
      method: 'PUT',
      body: { adminEmail: state.adminEmail.trim(), smtp: { host, port, secure, user, pass, from } },
    });
    apply(v);
    if (v.notice) message.warning(v.notice, { duration: 6000 });
    return true;
  } catch (err) {
    message.error(errorText(err));
    return false;
  } finally {
    busy.smtp = false;
  }
}

async function onSaveSmtp() {
  if (await saveSmtp()) message.success('邮件配置已保存，请发送测试邮件验证');
}

async function sendTest() {
  if (!(await saveSmtp())) return;
  busy.test = true;
  try {
    await api('/api/settings/smtp/test', { body: {} });
    message.success('测试邮件已发送到站长邮箱，请查收');
    await load();
  } catch (err) {
    message.error(errorText(err));
  } finally {
    busy.test = false;
  }
}

onMounted(() => void load().catch((err) => message.error(errorText(err))));
</script>

<template>
  <n-space v-if="loaded" vertical :size="24" style="max-width: 720px">
    <n-card title="修改密码">
      <n-form label-placement="left" label-width="90">
        <n-form-item label="当前密码">
          <n-input v-model:value="pwd.current" type="password" show-password-on="click" autocomplete="current-password" />
        </n-form-item>
        <n-form-item label="新密码">
          <n-input v-model:value="pwd.next" type="password" show-password-on="click" placeholder="至少 8 位" autocomplete="new-password" />
        </n-form-item>
        <n-form-item label="确认新密码">
          <n-input v-model:value="pwd.confirm" type="password" show-password-on="click" autocomplete="new-password" />
        </n-form-item>
        <n-button type="primary" :loading="busy.password" :disabled="!pwd.current || !pwd.next" @click="changePassword">修改密码</n-button>
      </n-form>
    </n-card>

    <n-card title="登录方式">
      <n-space vertical :size="12">
        <n-radio :checked="state.loginMethod === 'password'" @update:checked="state.loginMethod = 'password'">仅密码</n-radio>
        <n-radio :checked="state.loginMethod === 'email_code'" :disabled="!state.smtpVerified" @update:checked="state.loginMethod = 'email_code'">
          仅邮件验证码
        </n-radio>
        <n-radio :checked="state.loginMethod === 'both'" :disabled="!state.smtpVerified" @update:checked="state.loginMethod = 'both'">
          密码或邮件验证码
        </n-radio>
        <n-alert v-if="!state.smtpVerified" type="info" :show-icon="false">需先在下方配置 SMTP 与站长邮箱，并成功发送测试邮件后，才能启用验证码登录。</n-alert>
        <n-alert v-if="state.loginMethod !== 'password'" type="warning" :show-icon="false">
          {{ state.emergencyPasswordConfigured ? '已配置紧急密码，SMTP 故障时仍可用它登录。' : '未配置 EMERGENCY_PASSWORD：SMTP 故障时将无法登录，建议先在环境变量中配置紧急密码。' }}
        </n-alert>
        <div><n-button type="primary" :loading="busy.method" @click="saveMethod">保存登录方式</n-button></div>
      </n-space>
    </n-card>

    <n-card title="邮件（SMTP）与站长邮箱">
      <n-form label-placement="left" label-width="90">
        <n-form-item label="站长邮箱">
          <n-input v-model:value="state.adminEmail" placeholder="验证码与提醒都发到这里" />
        </n-form-item>
        <n-form-item label="SMTP 主机"><n-input v-model:value="state.smtp.host" placeholder="smtp.example.com" /></n-form-item>
        <n-form-item label="端口"><n-input-number v-model:value="state.smtp.port" :min="1" :max="65535" :show-button="false" /></n-form-item>
        <n-form-item label="SSL/TLS"><n-switch v-model:value="state.smtp.secure" /><span style="margin-left: 12px; opacity: 0.7">465 端口开启，587 端口（STARTTLS）关闭</span></n-form-item>
        <n-form-item label="用户名"><n-input v-model:value="state.smtp.user" autocomplete="off" /></n-form-item>
        <n-form-item label="密码">
          <n-input v-model:value="state.smtp.pass" type="password" show-password-on="click" autocomplete="new-password" :placeholder="state.smtp.passSet ? '已设置，留空表示不修改' : ''" />
        </n-form-item>
        <n-form-item label="发件人"><n-input v-model:value="state.smtp.from" placeholder="TransferTool &lt;noreply@example.com&gt;" /></n-form-item>
        <n-space align="center">
          <n-button type="primary" :loading="busy.smtp" @click="onSaveSmtp">保存</n-button>
          <n-button :loading="busy.test" :disabled="!state.smtp.host || !state.smtp.from || !state.adminEmail" @click="sendTest">保存并发送测试邮件</n-button>
          <span v-if="state.smtpVerified" style="color: var(--n-success-color, #18a058)">已验证</span>
        </n-space>
      </n-form>
    </n-card>

    <n-card title="余额提醒">
      <n-form label-placement="left" label-width="120">
        <n-form-item label="重复提醒间隔">
          <n-input-number v-model:value="state.alertRepeatHours" :min="1" :max="168" :precision="0" style="width: 140px" />
          <span style="margin-left: 12px">小时（持续低于阈值时，最多每隔这么久再提醒一次；紧急阈值跌破立即发送，同一状态只发一次）</span>
        </n-form-item>
        <n-form-item label="余额归零自动停渠道">
          <n-switch v-model:value="state.autoDisableAtZero" />
          <span style="margin-left: 12px; opacity: 0.7">默认关闭。当前版本只保存此开关，实际停用渠道的动作将在接入本站渠道后生效。</span>
        </n-form-item>
        <n-alert v-if="!state.smtpVerified" type="info" :show-icon="false" style="margin-bottom: 16px">提醒邮件使用上方的 SMTP 与站长邮箱，请先发送测试邮件验证。</n-alert>
        <n-button type="primary" :loading="busy.alerts" @click="saveAlerts">保存提醒设置</n-button>
      </n-form>
    </n-card>
  </n-space>
</template>
