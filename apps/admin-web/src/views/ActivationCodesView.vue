<script setup lang="ts">
import { NAlert, NButton, NInput, NInputNumber, NSelect, useMessage } from 'naive-ui';
import { computed, ref } from 'vue';
import type { AdminActivationCodeRequest } from '@hotaru/api-contract';
import { ApiError, api } from '../api/client';

const message = useMessage();
const type = ref<AdminActivationCodeRequest['type']>('account');
const expiresDays = ref(7);
const uuid = ref('');
const username = ref('');
const issuing = ref(false);
const issuedCode = ref('');
const errorText = ref<string | null>(null);

const typeOptions = [
  { label: '账号激活码', value: 'account' },
  { label: 'UUID 绑定码', value: 'bind' },
  { label: '老账号认领码', value: 'claim' },
];

const needsUuid = computed(() => type.value !== 'account');
const needsUsername = computed(() => type.value === 'bind');

async function issue(): Promise<void> {
  errorText.value = null;
  issuedCode.value = '';
  if (needsUuid.value && !uuid.value.trim()) {
    errorText.value = '这个类型需要 Minecraft UUID。';
    return;
  }
  issuing.value = true;
  try {
    const result = await api.issueActivationCode({
      type: type.value,
      expiresInSeconds: Math.max(60, Math.round(expiresDays.value * 86400)),
      ...(needsUuid.value ? { uuid: uuid.value.trim() } : {}),
      ...(needsUsername.value && username.value.trim() ? { username: username.value.trim() } : {}),
    });
    issuedCode.value = result.code;
    message.success('激活码已签发');
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : (error as Error).message;
  } finally {
    issuing.value = false;
  }
}

async function copyCode(): Promise<void> {
  if (!issuedCode.value) return;
  try {
    await navigator.clipboard.writeText(issuedCode.value);
    message.success('已复制到剪贴板');
  } catch {
    message.warning('复制失败，请手动选择文本');
  }
}
</script>

<template>
  <div>
    <header class="page-head rise">
      <div>
        <p class="eyebrow">Access</p>
        <h1>激活码</h1>
        <p class="muted">签发账号激活、UUID 绑定或老账号认领码。码只显示一次，签发后请立即发送。</p>
      </div>
    </header>

    <div class="grid grid--bento">
      <section class="span-6 cozy-card card rise rise-1">
        <h2>签发参数</h2>
        <div class="form">
          <label>
            <span>类型</span>
            <NSelect v-model:value="type" :options="typeOptions" />
          </label>
          <label>
            <span>有效期（天）</span>
            <NInputNumber v-model:value="expiresDays" :min="0.01" :max="365" :step="1" />
          </label>
          <label v-if="needsUuid">
            <span>Minecraft UUID</span>
            <NInput v-model:value="uuid" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
          </label>
          <label v-if="needsUsername">
            <span>Minecraft 用户名（可选）</span>
            <NInput v-model:value="username" placeholder="用于绑定后的展示" />
          </label>
          <NButton type="primary" :loading="issuing" @click="issue">签发激活码</NButton>
        </div>
        <NAlert v-if="errorText" type="error" :bordered="false">{{ errorText }}</NAlert>
      </section>

      <section class="span-6 cozy-card card rise rise-2">
        <h2>签发结果</h2>
        <p v-if="!issuedCode" class="muted">还没有签发。左侧填写参数后生成。</p>
        <template v-else>
          <p class="muted">把这串文本发给用户。它包含签名，不要修改。</p>
          <textarea class="code" :value="issuedCode" readonly rows="7" />
          <NButton type="primary" secondary @click="copyCode">复制激活码</NButton>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page-head {
  margin-bottom: 18px;
}

.page-head h1 {
  font-size: 24px;
  letter-spacing: -0.02em;
}

.eyebrow {
  color: var(--muted);
  font-size: 11.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 4px;
}

.card {
  padding: 20px 22px;
  display: grid;
  gap: 14px;
  align-content: start;
}

.card h2 {
  font-size: 15.5px;
}

.form {
  display: grid;
  gap: 14px;
}

label {
  display: grid;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
}

.code {
  width: 100%;
  min-height: 150px;
  padding: 12px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink);
  background: var(--surface-soft);
  border: 1px solid var(--border);
  border-radius: 10px;
  resize: vertical;
}
</style>
