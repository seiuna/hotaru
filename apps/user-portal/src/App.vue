<template>
  <main class="shell">
    <header class="brand">
      <div class="brand__mark" aria-hidden="true">H</div>
      <div>
        <h1>Hotaru 用户门户</h1>
        <p>管理账号，绑定你的 Minecraft 身份。</p>
      </div>
    </header>

    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <section v-if="busy && !account" class="card">
      <p class="muted">加载中...</p>
    </section>

    <section v-else-if="!account" class="card">
      <nav class="tabs" aria-label="登录方式">
        <button :class="{ active: mode === 'login' }" type="button" @click="switchMode('login')">
          登录
        </button>
        <button :class="{ active: mode === 'activate' }" type="button" @click="switchMode('activate')">
          激活账号
        </button>
      </nav>

      <form v-if="mode === 'login'" class="form" @submit.prevent="handleLogin">
        <label>
          <span>用户名</span>
          <input v-model.trim="loginForm.username" autocomplete="username" required />
        </label>
        <label>
          <span>密码</span>
          <input v-model="loginForm.password" type="password" autocomplete="current-password" required />
        </label>
        <button class="primary" type="submit" :disabled="busy">
          {{ busy ? '登录中...' : '登录' }}
        </button>
      </form>

      <form v-else class="form" @submit.prevent="handleActivate">
        <label>
          <span>激活码</span>
          <input v-model.trim="activateForm.code" autocomplete="off" required />
        </label>
        <label>
          <span>用户名</span>
          <input v-model.trim="activateForm.username" autocomplete="username" required />
          <small>3-32 位，可使用字母、数字、点、下划线和连字符。</small>
        </label>
        <label>
          <span>密码</span>
          <input v-model="activateForm.password" type="password" autocomplete="new-password" required />
          <small>至少 10 位。</small>
        </label>
        <label>
          <span>确认密码</span>
          <input v-model="activateForm.confirmPassword" type="password" autocomplete="new-password" required />
        </label>
        <button class="primary" type="submit" :disabled="busy">
          {{ busy ? '激活中...' : '激活账号' }}
        </button>
      </form>
    </section>

    <section v-else class="card account">
      <div class="account__head">
        <div>
          <p class="eyebrow">当前账号</p>
          <h2>{{ account.username }}</h2>
          <p class="muted">{{ account.loginName }} · {{ account.status === 'active' ? '正常' : '已封禁' }}</p>
        </div>
        <button type="button" class="ghost" @click="logout">退出登录</button>
      </div>

      <h3>已绑定的 Minecraft UUID</h3>
      <p v-if="account.links.length === 0" class="muted">还没有绑定任何 UUID。</p>
      <ul v-else class="links">
        <li v-for="link in account.links" :key="link.uuid">
          <div>
            <code>{{ link.uuid }}</code>
            <span class="muted">{{ link.username }}</span>
          </div>
          <div class="links__actions">
            <span class="badge" :class="link.status">{{ link.status === 'active' ? '正常' : '已封禁' }}</span>
            <button type="button" class="ghost danger" @click="handleUnbind(link.uuid)">解绑</button>
          </div>
        </li>
      </ul>

      <form class="form compact" @submit.prevent="handleBind">
        <label>
          <span>绑定码</span>
          <input v-model.trim="bindCode" placeholder="HOTARU-XXXX-XXXX" autocomplete="off" required />
          <small>在游戏中完成登录，模组会显示一次性绑定码。</small>
        </label>
        <button class="primary" type="submit" :disabled="busy || !bindCode">绑定</button>
      </form>

      <h3>修改密码</h3>
      <form class="form compact" @submit.prevent="handlePassword">
        <label>
          <span>当前密码</span>
          <input v-model="passwordForm.currentPassword" type="password" autocomplete="current-password" required />
        </label>
        <label>
          <span>新密码</span>
          <input v-model="passwordForm.newPassword" type="password" autocomplete="new-password" required />
          <small>至少 10 位。</small>
        </label>
        <button class="primary" type="submit" :disabled="busy">更新密码</button>
      </form>
    </section>
  </main>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ApiError, getToken, portalApi, setToken } from './api';
import type { AccountView } from './types';

type Mode = 'login' | 'activate';

const mode = ref<Mode>('login');
const account = ref<AccountView | null>(null);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const bindCode = ref('');

const loginForm = reactive({ username: '', password: '' });
const activateForm = reactive({
  code: '',
  username: '',
  password: '',
  confirmPassword: '',
});
const passwordForm = reactive({ currentPassword: '', newPassword: '' });

function clearMessages(): void {
  error.value = '';
  notice.value = '';
}

function switchMode(next: Mode): void {
  mode.value = next;
  clearMessages();
}

function fail(reason: unknown): void {
  error.value = reason instanceof Error ? reason.message : String(reason);
}

async function handleLogin(): Promise<void> {
  clearMessages();
  busy.value = true;
  try {
    const result = await portalApi.login({
      username: loginForm.username,
      password: loginForm.password,
    });
    setToken(result.accessToken);
    account.value = result.account;
    loginForm.password = '';
  } catch (reason) {
    fail(reason);
  } finally {
    busy.value = false;
  }
}

async function handleActivate(): Promise<void> {
  clearMessages();
  if (activateForm.password.length < 10) {
    error.value = '密码至少需要 10 位。';
    return;
  }
  if (activateForm.password !== activateForm.confirmPassword) {
    error.value = '两次输入的密码不一致。';
    return;
  }
  busy.value = true;
  try {
    await portalApi.activate({
      code: activateForm.code,
      username: activateForm.username,
      password: activateForm.password,
    });
    loginForm.username = activateForm.username;
    activateForm.code = '';
    activateForm.password = '';
    activateForm.confirmPassword = '';
    mode.value = 'login';
    notice.value = '账号已激活，请使用刚才设置的用户名和密码登录。';
  } catch (reason) {
    fail(reason);
  } finally {
    busy.value = false;
  }
}

async function handleBind(): Promise<void> {
  clearMessages();
  busy.value = true;
  try {
    const result = await portalApi.bind(bindCode.value);
    account.value = result.account;
    bindCode.value = '';
    notice.value = 'Minecraft UUID 已绑定。';
  } catch (reason) {
    fail(reason);
  } finally {
    busy.value = false;
  }
}

async function handleUnbind(uuid: string): Promise<void> {
  clearMessages();
  if (!window.confirm(`确定解绑 ${uuid} 吗？解绑后这个 UUID 将无法登录。`)) return;
  busy.value = true;
  try {
    const result = await portalApi.unbind(uuid);
    account.value = result.account;
    notice.value = 'Minecraft UUID 已解绑。';
  } catch (reason) {
    fail(reason);
  } finally {
    busy.value = false;
  }
}

async function handlePassword(): Promise<void> {
  clearMessages();
  if (passwordForm.newPassword.length < 10) {
    error.value = '新密码至少需要 10 位。';
    return;
  }
  busy.value = true;
  try {
    await portalApi.password({
      currentPassword: passwordForm.currentPassword,
      newPassword: passwordForm.newPassword,
    });
    passwordForm.currentPassword = '';
    passwordForm.newPassword = '';
    notice.value = '密码已更新。';
  } catch (reason) {
    fail(reason);
  } finally {
    busy.value = false;
  }
}

function logout(): void {
  setToken(null);
  account.value = null;
  loginForm.password = '';
  clearMessages();
}

onMounted(async () => {
  if (!getToken()) return;
  busy.value = true;
  try {
    const result = await portalApi.me();
    account.value = result.account;
  } catch (reason) {
    if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) {
      setToken(null);
    }
    fail(reason);
  } finally {
    busy.value = false;
  }
});
</script>
