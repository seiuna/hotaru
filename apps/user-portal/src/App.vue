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
      <nav class="tabs" aria-label="账号入口">
        <button :class="{ active: mode === 'login' }" type="button" @click="switchMode('login')">
          登录
        </button>
        <button :class="{ active: mode === 'activate' }" type="button" @click="switchMode('activate')">
          激活
        </button>
        <button :class="{ active: mode === 'claim' }" type="button" @click="switchMode('claim')">
          认领老账号
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
        <label v-if="needsTotp">
          <span>两步验证码</span>
          <input v-model.trim="loginForm.totp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required />
        </label>
        <button class="primary" type="submit" :disabled="busy">
          {{ busy ? '登录中...' : '登录' }}
        </button>
        <button class="link-button" type="button" @click="switchMode('forgot')">忘记密码</button>
      </form>

      <form v-else-if="mode === 'activate' || mode === 'claim'" class="form" @submit.prevent="handleActivateOrClaim">
        <p class="muted">
          {{ mode === 'claim' ? '老账号需要管理员签发认领码。' : '使用管理员签发的激活码创建账号。' }}
        </p>
        <label>
          <span>{{ mode === 'claim' ? '认领码' : '激活码' }}</span>
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
        <label>
          <span>邮箱（可选）</span>
          <input v-model.trim="activateForm.email" type="email" autocomplete="email" />
          <small>用于找回密码。</small>
        </label>
        <button class="primary" type="submit" :disabled="busy">
          {{ busy ? '提交中...' : mode === 'claim' ? '认领账号' : '激活账号' }}
        </button>
      </form>

      <form v-else-if="mode === 'forgot'" class="form" @submit.prevent="handleForgot">
        <p class="muted">输入账号邮箱，我们会发送重置链接。没有邮箱的账号请让管理员处理。</p>
        <label>
          <span>邮箱</span>
          <input v-model.trim="forgotEmail" type="email" autocomplete="email" required />
        </label>
        <button class="primary" type="submit" :disabled="busy">发送重置链接</button>
        <button class="link-button" type="button" @click="switchMode('login')">返回登录</button>
      </form>

      <form v-else class="form" @submit.prevent="handleReset">
        <p class="muted">设置一个新密码。</p>
        <label>
          <span>新密码</span>
          <input v-model="resetForm.password" type="password" autocomplete="new-password" required />
          <small>至少 10 位。</small>
        </label>
        <label>
          <span>确认新密码</span>
          <input v-model="resetForm.confirmPassword" type="password" autocomplete="new-password" required />
        </label>
        <button class="primary" type="submit" :disabled="busy">重置密码</button>
      </form>
    </section>

    <section v-else class="card account">
      <div class="account__head">
        <div>
          <p class="eyebrow">当前账号</p>
          <h2>{{ account.username }}</h2>
          <p class="muted">
            {{ account.loginName }} · {{ account.status === 'active' ? '正常' : '已封禁' }} ·
            {{ account.twoFactorEnabled ? '两步验证已开启' : '两步验证未开启' }}
          </p>
          <p class="muted">邮箱：{{ account.email ?? '未设置' }}</p>
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

      <h3>账号安全</h3>
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

      <form class="form compact" @submit.prevent="handleEmail">
        <label>
          <span>设置邮箱</span>
          <input v-model.trim="emailForm.email" type="email" autocomplete="email" required />
        </label>
        <label>
          <span>当前密码</span>
          <input v-model="emailForm.password" type="password" autocomplete="current-password" required />
        </label>
        <button class="primary" type="submit" :disabled="busy">保存邮箱</button>
      </form>

      <div class="twofa">
        <template v-if="!account.twoFactorEnabled">
          <button type="button" class="ghost" @click="handleTotpSetup" :disabled="busy">
            设置两步验证
          </button>
          <template v-if="totpSetup">
            <p class="muted">把下面的密钥添加到验证器，或打开 otpauth 链接：</p>
            <code class="secret">{{ totpSetup.secret }}</code>
            <p class="muted break">{{ totpSetup.otpauthUri }}</p>
            <form class="form" @submit.prevent="handleTotpEnable">
              <label>
                <span>验证器中的 6 位验证码</span>
                <input v-model.trim="totpCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required />
              </label>
              <button class="primary" type="submit" :disabled="busy">开启两步验证</button>
            </form>
          </template>
        </template>
        <template v-else>
          <form class="form" @submit.prevent="handleTotpDisable">
            <p class="muted">关闭两步验证需要当前密码和验证器验证码。</p>
            <label>
              <span>当前密码</span>
              <input v-model="totpDisableForm.currentPassword" type="password" autocomplete="current-password" required />
            </label>
            <label>
              <span>6 位验证码</span>
              <input v-model.trim="totpDisableForm.code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required />
            </label>
            <button class="ghost danger" type="submit" :disabled="busy">关闭两步验证</button>
          </form>
        </template>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ApiError, getRefreshToken, portalApi, setTokens } from './api';
import type { AccountView } from './types';

type Mode = 'login' | 'activate' | 'claim' | 'forgot' | 'reset';

const mode = ref<Mode>('login');
const account = ref<AccountView | null>(null);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const needsTotp = ref(false);
const bindCode = ref('');
const forgotEmail = ref('');
const resetToken = ref('');
const totpSetup = ref<{ secret: string; otpauthUri: string } | null>(null);
const totpCode = ref('');

const loginForm = reactive({ username: '', password: '', totp: '' });
const activateForm = reactive({
  code: '',
  username: '',
  password: '',
  confirmPassword: '',
  email: '',
});
const resetForm = reactive({ password: '', confirmPassword: '' });
const passwordForm = reactive({ currentPassword: '', newPassword: '' });
const emailForm = reactive({ email: '', password: '' });
const totpDisableForm = reactive({ currentPassword: '', code: '' });

function clearMessages(): void {
  error.value = '';
  notice.value = '';
}

function switchMode(next: Mode): void {
  mode.value = next;
  clearMessages();
}

function fail(reason: unknown): void {
  if (reason instanceof ApiError && reason.code === 'TOTP_REQUIRED') {
    needsTotp.value = true;
    error.value = '请输入两步验证码。';
    return;
  }
  error.value = reason instanceof Error ? reason.message : String(reason);
}

async function handleLogin(): Promise<void> {
  clearMessages();
  busy.value = true;
  try {
    const result = await portalApi.login({
      username: loginForm.username,
      password: loginForm.password,
      ...(loginForm.totp ? { totp: loginForm.totp } : {}),
    });
    setTokens(result.accessToken, result.refreshToken);
    account.value = result.account;
    needsTotp.value = false;
    loginForm.password = '';
    loginForm.totp = '';
  } catch (reason) {
    fail(reason);
  } finally {
    busy.value = false;
  }
}

async function handleActivateOrClaim(): Promise<void> {
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
    const body = {
      code: activateForm.code,
      username: activateForm.username,
      password: activateForm.password,
      ...(activateForm.email ? { email: activateForm.email } : {}),
    };
    const wasClaim = mode.value === 'claim';
    if (wasClaim) await portalApi.claim(body);
    else await portalApi.activate(body);
    loginForm.username = activateForm.username;
    activateForm.code = '';
    activateForm.password = '';
    activateForm.confirmPassword = '';
    activateForm.email = '';
    mode.value = 'login';
    notice.value = wasClaim ? '老账号已认领，请登录。' : '账号已就绪，请登录。';
  } catch (reason) {
    fail(reason);
  } finally {
    busy.value = false;
  }
}

async function handleForgot(): Promise<void> {
  clearMessages();
  busy.value = true;
  try {
    await portalApi.forgot(forgotEmail.value);
    notice.value = '如果该邮箱存在，重置链接已发送。';
  } catch (reason) {
    fail(reason);
  } finally {
    busy.value = false;
  }
}

async function handleReset(): Promise<void> {
  clearMessages();
  if (resetForm.password.length < 10) {
    error.value = '新密码至少需要 10 位。';
    return;
  }
  if (resetForm.password !== resetForm.confirmPassword) {
    error.value = '两次输入的密码不一致。';
    return;
  }
  busy.value = true;
  try {
    await portalApi.reset({ token: resetToken.value, newPassword: resetForm.password });
    resetForm.password = '';
    resetForm.confirmPassword = '';
    mode.value = 'login';
    notice.value = '密码已重置，请使用新密码登录。';
    window.history.replaceState({}, '', '/');
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

async function handleEmail(): Promise<void> {
  clearMessages();
  busy.value = true;
  try {
    const result = await portalApi.email({ email: emailForm.email, password: emailForm.password });
    account.value = result.account;
    emailForm.password = '';
    notice.value = '邮箱已保存。';
  } catch (reason) {
    fail(reason);
  } finally {
    busy.value = false;
  }
}

async function handleTotpSetup(): Promise<void> {
  clearMessages();
  busy.value = true;
  try {
    totpSetup.value = await portalApi.totpSetup();
  } catch (reason) {
    fail(reason);
  } finally {
    busy.value = false;
  }
}

async function handleTotpEnable(): Promise<void> {
  clearMessages();
  busy.value = true;
  try {
    const result = await portalApi.totpEnable(totpCode.value);
    account.value = result.account;
    totpSetup.value = null;
    totpCode.value = '';
    notice.value = '两步验证已开启。';
  } catch (reason) {
    fail(reason);
  } finally {
    busy.value = false;
  }
}

async function handleTotpDisable(): Promise<void> {
  clearMessages();
  busy.value = true;
  try {
    const result = await portalApi.totpDisable({
      currentPassword: totpDisableForm.currentPassword,
      code: totpDisableForm.code,
    });
    account.value = result.account;
    totpDisableForm.currentPassword = '';
    totpDisableForm.code = '';
    notice.value = '两步验证已关闭。';
  } catch (reason) {
    fail(reason);
  } finally {
    busy.value = false;
  }
}

function logout(): void {
  setTokens(null, null);
  account.value = null;
  loginForm.password = '';
  loginForm.totp = '';
  needsTotp.value = false;
  clearMessages();
  mode.value = 'login';
}

onMounted(async () => {
  const token = new URLSearchParams(window.location.search).get('resetToken');
  if (token) {
    resetToken.value = token;
    mode.value = 'reset';
  }

  if (resetToken.value) return;
  if (!getRefreshToken()) return;
  busy.value = true;
  try {
    const result = await portalApi.me();
    account.value = result.account;
  } catch (reason) {
    setTokens(null, null);
    fail(reason);
  } finally {
    busy.value = false;
  }
});
</script>
