<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { NAlert, NButton, NDynamicTags, NForm, NFormItem, NInput, NInputNumber, NSpace, NSwitch, NRadioButton, NRadioGroup, useMessage } from 'naive-ui';
import { api, ApiError } from '../api';
import { copySecret, usd, type SecretField, type TestResult, type Upstream, type UpstreamType } from '../upstreams';

/** prefill：新建时预填（来自“发现上游”的建议） */
const props = defineProps<{ upstream?: Upstream; prefill?: { name?: string; siteUrl?: string; matchDomains?: string[] } }>();
const emit = defineEmits<{ saved: [Upstream] }>();
const message = useMessage();

const editing = computed(() => props.upstream !== undefined);

interface FormState {
  name: string;
  type: UpstreamType;
  siteUrl: string;
  credential: string;
  userId: string;
  account: string;
  password: string;
  threshold: number | null;
  emergencyThreshold: number | null;
  intervalMinutes: number | null;
  rateFactor: number | null;
  topupUrl: string;
  matchDomains: string[];
  enabled: boolean;
  note: string;
}

const form = reactive<FormState>({
  name: '',
  type: 'newapi',
  siteUrl: '',
  credential: '',
  userId: '',
  account: '',
  password: '',
  threshold: 10,
  emergencyThreshold: null,
  intervalMinutes: 10,
  rateFactor: 1,
  topupUrl: '',
  matchDomains: [],
  enabled: true,
  note: '',
});

function fill(u: Upstream) {
  Object.assign(form, {
    name: u.name,
    type: u.type,
    siteUrl: u.siteUrl,
    credential: '',
    userId: '',
    account: '',
    password: '',
    threshold: u.threshold,
    emergencyThreshold: u.emergencyThreshold,
    intervalMinutes: u.intervalMinutes,
    rateFactor: u.rateFactor,
    topupUrl: u.topupUrl ?? '',
    matchDomains: [...u.matchDomains],
    enabled: u.enabled,
    note: u.note,
  });
}
watch(() => props.upstream, (u) => u && fill(u), { immediate: true });
if (!props.upstream && props.prefill) {
  const p = props.prefill;
  if (p.name) form.name = p.name;
  if (p.siteUrl) form.siteUrl = p.siteUrl;
  if (p.matchDomains?.length) form.matchDomains = [...p.matchDomains];
}

const busy = reactive({ save: false, test: false });
const testResult = ref<TestResult | null>(null);

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : '网络错误，请稍后重试';
}

const credentialLabel = computed(() => (form.type === 'newapi' ? '访问令牌' : 'API Key'));
const topupPlaceholder = computed(() => (form.type === 'newapi' ? `留空使用 ${form.siteUrl.replace(/\/+$/, '') || '<站点>'}/console/topup` : '可选'));

function secretPlaceholder(field: SecretField): string {
  return props.upstream?.secrets[field].set ? '已设置（********），留空表示不修改' : '';
}

async function copy(field: SecretField) {
  if (!props.upstream) return;
  try {
    const value = await copySecret(props.upstream.id, field);
    await navigator.clipboard.writeText(value);
    message.success('已复制到剪贴板（本次操作已记入审计日志）');
  } catch (err) {
    message.error(err instanceof ApiError ? err.message : '无法写入剪贴板，请确认浏览器权限');
  }
}

async function test() {
  busy.test = true;
  testResult.value = null;
  try {
    testResult.value = await api<TestResult>('/api/upstreams/test', {
      body: {
        id: props.upstream?.id,
        type: form.type,
        siteUrl: form.siteUrl,
        credential: form.credential,
        userId: form.type === 'newapi' ? form.userId : undefined,
        rateFactor: form.rateFactor ?? 1,
      },
    });
  } catch (err) {
    testResult.value = { ok: false, balanceUsd: null, mode: '', kind: null, unsupported: false, error: errorText(err) };
  } finally {
    busy.test = false;
  }
}

async function save() {
  if (!form.name.trim() || !form.siteUrl.trim()) return message.warning('请填写名称和站点地址');
  if (!editing.value && !form.credential.trim()) return message.warning(`请填写${credentialLabel.value}`);
  if (form.threshold === null) return message.warning('请填写提醒阈值');
  busy.save = true;
  try {
    const common = {
      name: form.name.trim(),
      siteUrl: form.siteUrl,
      credential: form.credential,
      userId: form.type === 'newapi' ? form.userId : undefined,
      account: form.account,
      password: form.password,
      threshold: form.threshold,
      emergencyThreshold: form.emergencyThreshold,
      intervalMinutes: form.intervalMinutes ?? 10,
      rateFactor: form.rateFactor ?? 1,
      topupUrl: form.topupUrl,
      matchDomains: form.matchDomains,
      enabled: form.enabled,
      note: form.note,
    };
    const res = props.upstream
      ? await api<{ upstream: Upstream }>(`/api/upstreams/${props.upstream.id}`, { method: 'PUT', body: common })
      : await api<{ upstream: Upstream }>('/api/upstreams', { body: { ...common, type: form.type } });
    message.success(editing.value ? '已保存' : '已添加');
    testResult.value = null;
    emit('saved', res.upstream);
  } catch (err) {
    message.error(errorText(err));
  } finally {
    busy.save = false;
  }
}
</script>

<template>
  <n-form label-placement="left" label-width="110" style="max-width: 720px">
    <n-form-item label="名称"><n-input v-model:value="form.name" maxlength="100" placeholder="例如：某某中转站" /></n-form-item>
    <n-form-item label="类型">
      <n-radio-group v-model:value="form.type" :disabled="editing">
        <n-radio-button value="newapi">new-api</n-radio-button>
        <n-radio-button value="sub2api">sub2api</n-radio-button>
      </n-radio-group>
    </n-form-item>
    <n-form-item label="站点地址"><n-input v-model:value="form.siteUrl" placeholder="https://api.example.com" /></n-form-item>
    <n-form-item :label="credentialLabel">
      <n-space :wrap="false" style="width: 100%">
        <n-input v-model:value="form.credential" type="password" show-password-on="click" autocomplete="off" :placeholder="secretPlaceholder('credential')" style="min-width: 360px" />
        <n-button v-if="upstream?.secrets.credential.set" secondary @click="copy('credential')">复制已存值</n-button>
      </n-space>
    </n-form-item>
    <n-form-item v-if="form.type === 'newapi'" label="用户 ID">
      <n-space :wrap="false">
        <n-input v-model:value="form.userId" autocomplete="off" placeholder="New-Api-User，数字" :input-props="{ inputmode: 'numeric' }" :style="{ width: '240px' }" />
        <n-button v-if="upstream?.secrets.userId.set" secondary @click="copy('userId')">复制已存值</n-button>
      </n-space>
      <template v-if="upstream?.secrets.userId.set" #feedback>已设置，留空表示不修改</template>
    </n-form-item>
    <n-form-item label="账号（可选）">
      <n-space :wrap="false">
        <n-input v-model:value="form.account" autocomplete="off" :placeholder="secretPlaceholder('account') || '仅供你自己记录，不用于请求'" style="width: 320px" />
        <n-button v-if="upstream?.secrets.account.set" secondary @click="copy('account')">复制</n-button>
      </n-space>
    </n-form-item>
    <n-form-item label="密码（可选）">
      <n-space :wrap="false">
        <n-input v-model:value="form.password" type="password" show-password-on="click" autocomplete="new-password" :placeholder="secretPlaceholder('password')" style="width: 320px" />
        <n-button v-if="upstream?.secrets.password.set" secondary @click="copy('password')">复制</n-button>
      </n-space>
    </n-form-item>
    <n-form-item label="提醒阈值 (USD)"><n-input-number v-model:value="form.threshold" :min="0" :show-button="false" style="width: 160px" /></n-form-item>
    <n-form-item label="紧急阈值 (USD)">
      <n-input-number v-model:value="form.emergencyThreshold" :min="0" clearable :show-button="false" placeholder="可空" style="width: 160px" />
      <span style="margin-left: 12px; opacity: 0.7">须小于提醒阈值；跌破即发，同一状态只发一次</span>
    </n-form-item>
    <n-form-item label="刷新间隔 (分钟)"><n-input-number v-model:value="form.intervalMinutes" :min="1" :max="1440" :precision="0" style="width: 160px" /></n-form-item>
    <n-form-item label="汇率系数">
      <n-input-number v-model:value="form.rateFactor" :min="0.0001" :max="1000" :show-button="false" style="width: 160px" />
      <span style="margin-left: 12px; opacity: 0.7">上游显示的美元 × 系数 = 折算后的余额</span>
    </n-form-item>
    <n-form-item label="充值页地址"><n-input v-model:value="form.topupUrl" :placeholder="topupPlaceholder" /></n-form-item>
    <n-form-item label="匹配域名">
      <n-dynamic-tags v-model:value="form.matchDomains" />
      <template #feedback>渠道 base_url 的主机名等于（或属于其子域）这些域名时归属该上游；留空默认使用站点域名</template>
    </n-form-item>
    <n-form-item label="启用"><n-switch v-model:value="form.enabled" /></n-form-item>
    <n-form-item label="备注"><n-input v-model:value="form.note" type="textarea" maxlength="500" :autosize="{ minRows: 2, maxRows: 5 }" /></n-form-item>

    <n-alert v-if="testResult" :type="testResult.ok ? 'success' : testResult.unsupported ? 'info' : 'error'" :show-icon="false" style="margin-bottom: 16px">
      <template v-if="testResult.ok">
        连接成功，当前{{ testResult.kind === 'key_limit' ? 'Key 限额剩余' : '余额' }} {{ usd(testResult.balanceUsd) }}
        <template v-if="testResult.kind === 'key_limit'">（这是 Key 限额，不是钱包余额）</template>
      </template>
      <template v-else>{{ testResult.error ?? '连接失败' }}</template>
    </n-alert>

    <n-space>
      <n-button :loading="busy.test" :disabled="!form.siteUrl" @click="test">测试连接</n-button>
      <n-button type="primary" :loading="busy.save" @click="save">保存</n-button>
    </n-space>
  </n-form>
</template>
