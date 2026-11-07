<script setup lang="ts">
import { NButton, NInput, useMessage } from 'naive-ui';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError } from '../api/client';
import { authState, loginWithPassword } from '../stores/auth';

const router = useRouter();
const message = useMessage();
const username = ref('');
const password = ref('');
const totp = ref('');
const needsTotp = ref(false);
const submitting = ref(false);
const errorText = ref<string | null>(null);

function safeNext(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}

async function submit(): Promise<void> {
  if (submitting.value) return;
  errorText.value = null;
  submitting.value = true;
  try {
    const session = await loginWithPassword({
      username: username.value.trim(),
      password: password.value,
      ...(totp.value.trim() ? { totp: totp.value.trim() } : {}),
    });
    message.success(`欢迎，${session.username}`);
    const next = safeNext(new URLSearchParams(window.location.search).get('next'));
    await router.push(next ?? { name: 'dashboard' });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'TOTP_REQUIRED') {
      needsTotp.value = true;
      errorText.value = '请输入验证器中的 6 位两步验证码。';
    } else {
      errorText.value = error instanceof ApiError ? error.message : (error as Error).message;
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login">
    <div class="login__bg dot-texture" aria-hidden="true" />

    <div class="login__grid">
      <section class="intro rise">
        <span class="pill pill--mint">MC Auth Platform</span>
        <h1>用管理员账号<br />进入控制台</h1>
        <p class="intro__lead">
          使用平台用户名和密码登录。只有具备 <code>admin:users</code> 权限的账号才能进入。
        </p>

        <ul class="intro__points">
          <li>
            <span class="dot" aria-hidden="true" />
            服务端每次请求都会重新校验权限与封禁状态
          </li>
          <li>
            <span class="dot dot--mint" aria-hidden="true" />
            支持旋转刷新令牌和 TOTP 两步验证
          </li>
          <li>
            <span class="dot dot--amber" aria-hidden="true" />
            账号密码只发送给认证服务，不会写入浏览器存储
          </li>
        </ul>

        <svg class="ornament ornament--star" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3l1.9 5.3 5.3 1.9-5.3 1.9L12 17.4l-1.9-5.3L4.8 10.2l5.3-1.9z" fill="#BFE1F7" />
        </svg>
        <svg class="ornament ornament--leaf" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 14c8 0 12-4 14-10-8 0-13 4-14 10z" fill="#CDEDE2" />
          <path d="M4 20c0-4 4-7 10-8" stroke="#9FD9C8" stroke-width="1.6" fill="none" stroke-linecap="round" />
        </svg>
      </section>

      <section class="panel cozy-card rise rise-2">
        <header class="panel__head">
          <h2>登录控制台</h2>
          <p>输入管理员账号和密码，不需要粘贴访问令牌。</p>
        </header>

        <form class="form" @submit.prevent="submit">
          <label class="field">
            <span class="field__label">用户名</span>
            <NInput
              v-model:value="username"
              placeholder="管理员用户名"
              autocomplete="username"
              :input-props="{ name: 'username' }"
              @keydown.enter.prevent
            />
          </label>
          <label class="field">
            <span class="field__label">密码</span>
            <NInput
              v-model:value="password"
              type="password"
              show-password-on="click"
              placeholder="管理员密码"
              autocomplete="current-password"
              :input-props="{ name: 'password' }"
            />
          </label>
          <label v-if="needsTotp" class="field">
            <span class="field__label">两步验证码</span>
            <NInput
              v-model:value="totp"
              placeholder="6 位验证码"
              maxlength="6"
              autocomplete="one-time-code"
              :input-props="{ inputmode: 'numeric', name: 'totp' }"
            />
          </label>

          <p v-if="errorText" class="alert" role="alert">{{ errorText }}</p>

          <NButton
            class="submit"
            type="primary"
            size="large"
            block
            native-type="submit"
            :loading="submitting"
            :disabled="!username.trim() || !password"
          >
            进入控制台
          </NButton>
        </form>
      </section>
    </div>

    <footer class="login__foot">
      <span>Hotaru 认证服务</span>
      <span class="login__foot-dot" aria-hidden="true">·</span>
      <span>状态：{{ authState.session ? '已登录' : '未登录' }}</span>
    </footer>
  </div>
</template>

<style scoped>
.login {
  position: relative;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: 40px 20px 28px;
  overflow: hidden;
}

.login__bg {
  position: absolute;
  inset: 0;
  opacity: 0.55;
  mask-image: radial-gradient(circle at 50% 40%, #000 0%, transparent 72%);
}

.login__grid {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 40px;
  align-items: center;
  width: 100%;
  max-width: 1040px;
}

.intro { position: relative; padding: 12px 8px; }
.intro h1 {
  margin: 14px 0 12px;
  font-size: clamp(30px, 3.6vw, 44px);
  line-height: 1.18;
  letter-spacing: -0.03em;
}
.intro__lead { color: var(--muted); max-width: 44ch; font-size: 15px; }
.intro__points {
  list-style: none;
  padding: 0;
  margin: 22px 0 0;
  display: grid;
  gap: 10px;
  color: var(--muted);
  font-size: 13.5px;
}
.intro__points li { display: flex; align-items: baseline; gap: 9px; }
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--primary);
  flex: none;
  transform: translateY(-1px);
}
.dot--mint { background: var(--secondary); }
.dot--amber { background: #e0b25f; }
.ornament { position: absolute; pointer-events: none; }
.ornament--star { width: 26px; top: -6px; right: 18%; opacity: 0.9; }
.ornament--leaf { width: 40px; bottom: -14px; left: -6px; opacity: 0.8; }

.panel { position: relative; padding: 28px; display: grid; gap: 20px; }
.panel__head h2 { font-size: 20px; letter-spacing: -0.01em; }
.panel__head p { color: var(--muted); font-size: 13.5px; margin-top: 4px; }
.form { display: grid; gap: 16px; }
.field { display: grid; gap: 7px; }
.field__label { font-size: 12.5px; font-weight: 600; color: var(--muted); }
.alert {
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--danger-soft);
  border: 1px solid #f3d3d9;
  color: var(--danger);
  font-size: 13px;
  line-height: 1.5;
}
.submit { margin-top: 2px; }
.login__foot {
  position: relative;
  margin-top: 34px;
  display: flex;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
}

@media (max-width: 900px) {
  .login__grid { grid-template-columns: minmax(0, 1fr); gap: 26px; max-width: 560px; }
  .intro { text-align: left; }
  .ornament--star { right: 8%; }
}
</style>
