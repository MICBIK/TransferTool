<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
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
  healthOkRate: number;
  healthDegradedRate: number;
  emergencyPasswordConfigured: boolean;
  notice?: string;
}

const message = useMessage();

interface OwnSiteView {
  url: string;
  tokenSet: boolean;
  userIdSet: boolean;
  configured: boolean;
  sync?: { ok: boolean; error: string | null; total: number; autoCreated: number } | null;
}
const own = reactive({ url: '', token: '', userId: '', tokenSet: false, userIdSet: false, configured: false });
const ownBusy = reactive({ save: false, test: false });
const ownTest = ref<{ ok: boolean; text: string } | null>(null);

const state = reactive({
  loginMethod: 'password' as SettingsView['loginMethod'],
  adminEmail: '',
  smtp: { host: '', port: 465, secure: true, user: '', pass: '', passSet: false, from: '' },
  smtpVerified: false,
  alertRepeatHours: 6,
  autoDisableAtZero: false,
  healthOkRate: 95,
  healthDegradedRate: 80,
  emergencyPasswordConfigured: false,
});

const pwd = reactive({ current: '', next: '', confirm: '' });
const busy = reactive({ password: false, method: false, smtp: false, test: false, alerts: false, health: false });
const loaded = ref(false);

function apply(v: SettingsView) {
  state.loginMethod = v.loginMethod;
  state.adminEmail = v.adminEmail;
  state.smtp = { ...v.smtp, pass: '' };
  state.smtpVerified = v.smtpVerified;
  state.alertRepeatHours = v.alertRepeatHours;
  state.autoDisableAtZero = v.autoDisableAtZero;
  state.healthOkRate = v.healthOkRate;
  state.healthDegradedRate = v.healthDegradedRate;
  state.emergencyPasswordConfigured = v.emergencyPasswordConfigured;
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : '网络错误，请稍后重试';
}

async function load() {
  apply(await api<SettingsView>('/api/settings'));
  await loadOwn();
  loaded.value = true;
}

function applyOwn(v: OwnSiteView) {
  own.url = v.url;
  own.token = '';
  own.userId = '';
  own.tokenSet = v.tokenSet;
  own.userIdSet = v.userIdSet;
  own.configured = v.configured;
}

async function loadOwn() {
  applyOwn(await api<OwnSiteView>('/api/settings/own-site'));
}

function ownBody(clearUserId = false) {
  const body: { url: string; token?: string; userId?: string | null } = { url: own.url.trim() };
  if (own.token) body.token = own.token;
  if (clearUserId) body.userId = null;
  else if (own.userId.trim()) body.userId = own.userId.trim();
  return body;
}

async function saveOwn(clearUserId = false) {
  if (!own.url.trim()) return message.warning('请填写本站地址；要断开本站请点“断开本站”');
  if (!own.tokenSet && !own.token) return message.warning('请填写本站访问令牌');
  ownBusy.save = true;
  try {
    const v = await api<OwnSiteView>('/api/settings/own-site', { method: 'PUT', body: ownBody(clearUserId) });
    applyOwn(v);
    ownTest.value = null;
    if (v.sync && !v.sync.ok) message.warning(`已保存，但首次同步渠道失败：${v.sync.error ?? ''}`, { duration: 8000 });
    else message.success(v.sync ? `已保存，已同步 ${v.sync.total} 个渠道${v.sync.autoCreated ? `，自动创建 ${v.sync.autoCreated} 个待配置上游，请到总览填入密钥` : ''}` : '已保存');
  } catch (err) {
    message.error(errorText(err));
  } finally {
    ownBusy.save = false;
  }
}

async function testOwn() {
  ownBusy.test = true;
  ownTest.value = null;
  try {
    const body = ownBody();
    const r = await api<{ ok: boolean; total: number | null; error: string | null }>('/api/settings/own-site/test', { body });
    ownTest.value = r.ok ? { ok: true, text: `连接成功${r.total !== null ? `，本站共有 ${r.total} 个渠道` : ''}` } : { ok: false, text: r.error ?? '连接失败' };
  } catch (err) {
    ownTest.value = { ok: false, text: errorText(err) };
  } finally {
    ownBusy.test = false;
  }
}

async function disconnectOwn() {
  ownBusy.save = true;
  try {
    applyOwn(await api<OwnSiteView>('/api/settings/own-site', { method: 'PUT', body: { url: '' } }));
    ownTest.value = null;
    message.success('已断开本站（已缓存的渠道数据保留，重新连接后会刷新）');
  } catch (err) {
    message.error(errorText(err));
  } finally {
    ownBusy.save = false;
  }
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

async function saveHealth() {
  busy.health = true;
  try {
    const v = await api<SettingsView>('/api/settings', { method: 'PUT', body: { healthOkRate: state.healthOkRate, healthDegradedRate: state.healthDegradedRate } });
    apply(v);
    message.success('健康阈值已保存');
  } catch (err) {
    message.error(errorText(err));
  } finally {
    busy.health = false;
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

/** 测试邮件按钮不可用时告诉用户缺什么 */
const testBlocker = computed(() => {
  const missing: string[] = [];
  if (!state.adminEmail.trim()) missing.push('站长邮箱');
  if (!state.smtp.host.trim()) missing.push('SMTP 主机');
  if (!state.smtp.from.trim()) missing.push('发件人');
  return missing.length ? `请先填写${missing.join('、')}` : '';
});

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
        <n-form-item label="发件人">
          <n-input v-model:value="state.smtp.from" placeholder="TransferTool &lt;noreply@example.com&gt;" />
          <template #feedback>域名需在 SMTP 服务商处验证过（如 Resend 要求发件域名已验证）</template>
        </n-form-item>
        <n-space align="center">
          <n-button type="primary" :loading="busy.smtp" @click="onSaveSmtp">保存</n-button>
          <n-button :loading="busy.test" :disabled="testBlocker !== ''" @click="sendTest">保存并发送测试邮件</n-button>
          <span v-if="state.smtpVerified" style="color: var(--n-success-color, #18a058)">已验证</span>
          <span v-else-if="testBlocker" style="opacity: 0.7">{{ testBlocker }}</span>
        </n-space>
      </n-form>
    </n-card>

    <n-card title="本站（new-api）连接">
      <n-form label-placement="left" label-width="90">
        <n-form-item label="本站地址"><n-input v-model:value="own.url" placeholder="https://your-site.example.com" /></n-form-item>
        <n-form-item label="访问令牌">
          <n-input v-model:value="own.token" type="password" show-password-on="click" autocomplete="new-password" :placeholder="own.tokenSet ? '已设置，留空表示不修改' : '本站的访问令牌'" />
        </n-form-item>
        <n-form-item label="用户 ID">
          <n-input v-model:value="own.userId" autocomplete="off" :placeholder="own.userIdSet ? '已设置，留空表示不修改' : '可选；旧版本站需要（New-Api-User）'" style="max-width: 280px" />
          <n-button v-if="own.userIdSet" style="margin-left: 8px" size="small" :disabled="ownBusy.save" @click="saveOwn(true)">清除</n-button>
        </n-form-item>
        <n-alert type="info" :show-icon="false" style="margin-bottom: 16px">
          建议使用带范围的令牌，只授予：渠道读取、渠道操作、log:read。权限不足时，“测试连接”或操作会提示缺少的具体权限。本工具只读取渠道的基本信息，不会请求或保存渠道密钥（key）。
        </n-alert>
        <n-space align="center">
          <n-button type="primary" :loading="ownBusy.save" @click="saveOwn()">保存</n-button>
          <n-button :loading="ownBusy.test" :disabled="!own.url.trim() || (!own.tokenSet && !own.token)" @click="testOwn">测试连接</n-button>
          <n-button v-if="own.configured" quaternary type="error" :disabled="ownBusy.save" @click="disconnectOwn">断开本站</n-button>
        </n-space>
        <n-alert v-if="ownTest" :type="ownTest.ok ? 'success' : 'error'" :show-icon="false" style="margin-top: 12px">{{ ownTest.text }}</n-alert>
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
          <span style="margin-left: 12px; opacity: 0.7">默认关闭。打开后，上游余额（查询成功时）≤ 0 会批量停用该上游当前启用的渠道，并记录哪些是本工具停的；余额回升到 0 以上时只恢复这些渠道。需先配置上方本站连接，所有动作写入审计日志。</span>
        </n-form-item>
        <n-alert v-if="!state.smtpVerified" type="info" :show-icon="false" style="margin-bottom: 16px">提醒邮件使用上方的 SMTP 与站长邮箱，请先发送测试邮件验证。</n-alert>
        <n-button type="primary" :loading="busy.alerts" @click="saveAlerts">保存提醒设置</n-button>
      </n-form>
    </n-card>

    <n-card title="渠道健康">
      <n-form label-placement="left" label-width="120">
        <n-form-item label="“正常”成功率">
          <n-input-number v-model:value="state.healthOkRate" :min="2" :max="100" :precision="0" style="width: 140px" />
          <span style="margin-left: 12px">% 及以上（近 1 小时成功率）</span>
        </n-form-item>
        <n-form-item label="“降级”成功率">
          <n-input-number v-model:value="state.healthDegradedRate" :min="1" :max="99" :precision="0" style="width: 140px" />
          <span style="margin-left: 12px">% 及以上为降级，低于此值为异常；近 30 分钟有请求却没有一次成功也判为异常；近 1 小时没有请求为空闲</span>
        </n-form-item>
        <n-alert type="info" :show-icon="false" style="margin-bottom: 16px">
          健康数据来自本站的使用日志与错误日志（令牌需要 log:read 权限，本站需开启错误日志记录）。本工具每 5 分钟拉取一次并只保存聚合结果（保留 30 天），不保存原始日志。
        </n-alert>
        <n-button type="primary" :loading="busy.health" @click="saveHealth">保存健康阈值</n-button>
      </n-form>
    </n-card>
  </n-space>
</template>
