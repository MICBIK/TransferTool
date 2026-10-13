<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { NAlert, NButton, NCollapse, NCollapseItem, NDivider, NDynamicTags, NForm, NFormItem, NInput, NInputNumber, NRadioButton, NRadioGroup, NSpace, NSwitch, NText, useMessage } from 'naive-ui';
import { api, ApiError } from '../api';
import { useNarrow } from '../narrow';
import { copySecret, usd, type SecretField, type TestResult, type Upstream, type UpstreamType } from '../upstreams';

const props = defineProps<{ upstream?: Upstream }>();
// 手机上标签放在输入框上方，输入框占满宽度
const narrow = useNarrow();
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
/** 已有凭证的上游改类型：凭证含义不同，必须重填 */
const typeChanged = computed(() => props.upstream !== undefined && form.type !== props.upstream.type);
const needsCredential = computed(() => !editing.value || props.upstream?.needsSetup === true || (typeChanged.value && props.upstream?.secrets.credential.set === true));

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
        account: form.account,
        password: form.password,
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
  if (needsCredential.value && !form.credential.trim()) return message.warning(`请填写${credentialLabel.value}`);
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
      ? await api<{ upstream: Upstream }>(`/api/upstreams/${props.upstream.id}`, { method: 'PUT', body: { ...common, type: form.type } })
      : await api<{ upstream: Upstream }>('/api/upstreams', { body: { ...common, type: form.type } });
    // 填了凭证会立即刷新一次：直接告诉站长结果，不用再去找
    const u = res.upstream;
    const fresh = form.credential.trim() !== '';
    if (fresh && u.lastError) message.warning(`已保存，但查询余额失败：${u.lastError}`, { duration: 8000 });
    else if (fresh && u.balanceUsd !== null) message.success(`${editing.value ? '已保存' : '已添加'}，当前余额 ${usd(u.balanceUsd)}`);
    else message.success(editing.value ? '已保存' : '已添加');
    form.credential = '';
    form.password = '';
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
  <n-form :label-placement="narrow ? 'top' : 'left'" label-width="96" style="max-width: 720px">
    <n-alert v-if="upstream?.needsSetup" type="info" :show-icon="false" style="margin-bottom: 16px">
      这个上游是根据本站渠道自动创建的。请确认类型，然后到
      <a :href="upstream.siteUrl" target="_blank" rel="noopener noreferrer">{{ upstream.siteUrl }}</a>
      生成{{ form.type === 'newapi' ? '访问令牌（个人设置 → 生成系统访问令牌）' : ' API Key' }}，粘贴到下面保存即可开始监控余额。
    </n-alert>
    <n-divider title-placement="left" class="sec">连接</n-divider>
    <n-form-item label="名称"><n-input v-model:value="form.name" maxlength="100" placeholder="例如：某某中转站" /></n-form-item>
    <n-form-item label="类型">
      <n-radio-group v-model:value="form.type">
        <n-radio-button value="newapi">new-api</n-radio-button>
        <n-radio-button value="sub2api">sub2api</n-radio-button>
      </n-radio-group>
      <template v-if="upstream?.needsSetup" #feedback>根据站点自动识别，可能不准，请确认</template>
      <template v-else-if="typeChanged && upstream?.secrets.credential.set" #feedback>修改类型后需要重新填写{{ credentialLabel }}</template>
    </n-form-item>
    <n-form-item label="站点地址"><n-input v-model:value="form.siteUrl" placeholder="https://api.example.com" /></n-form-item>
    <n-form-item :label="credentialLabel">
      <div style="display: flex; gap: 8px; width: 100%">
        <n-input v-model:value="form.credential" type="password" show-password-on="click" autocomplete="off" :placeholder="secretPlaceholder('credential')" :style="narrow ? 'flex: 1; min-width: 0' : 'max-width: 420px; flex: 1'" />
        <n-button v-if="upstream?.secrets.credential.set" secondary @click="copy('credential')">复制已存值</n-button>
      </div>
    </n-form-item>
    <n-form-item label="账号（可选）">
      <div style="display: flex; gap: 8px; width: 100%">
        <n-input v-model:value="form.account" autocomplete="off" :placeholder="secretPlaceholder('account') || '上游站点的登录用户名'" :style="narrow ? 'flex: 1; min-width: 0' : 'max-width: 320px; flex: 1'" />
        <n-button v-if="upstream?.secrets.account.set" secondary @click="copy('account')">复制</n-button>
      </div>
    </n-form-item>
    <n-form-item label="密码（可选）">
      <div style="display: flex; gap: 8px; width: 100%">
        <n-input v-model:value="form.password" type="password" show-password-on="click" autocomplete="new-password" :placeholder="secretPlaceholder('password')" :style="narrow ? 'flex: 1; min-width: 0' : 'max-width: 320px; flex: 1'" />
        <n-button v-if="upstream?.secrets.password.set" secondary @click="copy('password')">复制</n-button>
      </div>
      <template #feedback>
        方便充值时复制登录。<template v-if="form.type === 'newapi'">新版 new-api 查余额需要用户 ID，填了账号密码会自动登录一次获取，不用手动找。</template>
      </template>
    </n-form-item>
    <n-collapse v-if="form.type === 'newapi'" :style="narrow ? 'margin: 0 0 18px' : 'margin: 4px 0 18px 96px; max-width: 624px'">
      <n-collapse-item title="高级：手动指定用户 ID" name="userId">
        <n-space :wrap="false" align="center">
          <n-input v-model:value="form.userId" autocomplete="off" placeholder="留空则自动获取" :style="{ width: '240px' }" />
          <n-button v-if="upstream?.secrets.userId.set" secondary @click="copy('userId')">复制已存值</n-button>
        </n-space>
        <n-text depth="3" style="font-size: 12px; display: block; margin-top: 6px">
          <template v-if="upstream?.secrets.userId.set">已设置，留空表示不修改。</template>
          一般不用填。只有不方便填账号密码（比如开了两步验证）时才需要：登录上游站点后按 F12，在控制台输入 <code>JSON.parse(localStorage.user).id</code>，或直接填个人页上显示的 ID（有的站是字母数字编码，照填即可）。
        </n-text>
      </n-collapse-item>
    </n-collapse>
    <n-divider title-placement="left" class="sec">提醒</n-divider>
    <n-form-item label="提醒阈值"><n-input-number v-model:value="form.threshold" :min="0" :show-button="false" style="width: 160px"><template #prefix>$</template></n-input-number></n-form-item>
    <n-form-item label="紧急阈值">
      <n-input-number v-model:value="form.emergencyThreshold" :min="0" clearable :show-button="false" placeholder="可空" style="width: 160px"><template #prefix>$</template></n-input-number>
      <span style="margin-left: 12px; opacity: 0.7">须小于提醒阈值；跌破即发，同一状态只发一次</span>
    </n-form-item>
    <n-form-item label="刷新间隔"><n-input-number v-model:value="form.intervalMinutes" :min="1" :max="1440" :precision="0" style="width: 160px"><template #suffix>分钟</template></n-input-number></n-form-item>
    <n-form-item label="汇率系数">
      <n-input-number v-model:value="form.rateFactor" :min="0.0001" :max="1000" :show-button="false" style="width: 160px" />
      <span style="margin-left: 12px; opacity: 0.7">上游显示的美元 × 系数 = 折算后的余额</span>
    </n-form-item>
    <n-divider title-placement="left" class="sec">其他</n-divider>
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

    <n-space class="actions">
      <n-button :loading="busy.test" :disabled="!form.siteUrl" @click="test">测试连接</n-button>
      <n-button type="primary" :loading="busy.save" @click="save">保存</n-button>
    </n-space>
  </n-form>
</template>

<style scoped>
.sec {
  margin: 8px 0 16px !important;
  font-size: 13px;
  color: #6b6a66;
}
/* 表单较长：保存按钮固定在可视区域底部 */
.actions {
  position: sticky;
  bottom: 0;
  z-index: 1;
  padding: 12px 0;
  background: #fff;
  border-top: 1px solid #f0efec;
}
</style>
