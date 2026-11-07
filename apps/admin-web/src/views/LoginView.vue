<script setup lang="ts">
import { NButton, NInput, NSpin, useMessage } from 'naive-ui';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError } from '../api/client';
import {
  BridgeError,
  DEFAULT_BRIDGE_PORT,
  loginViaLocalBridge,
  probeLocalBridge,
} from '../services/localBridge';
import { authState, loginWithToken } from '../stores/auth';
import { decodeToken } from '../utils/jwt';

const BRIDGE_PORT = DEFAULT_BRIDGE_PORT;

const router = useRouter();
const message = useMessage();

const token = ref('');
const submitting = ref(false);
const errorText = ref<string | null>(null);
const helpOpen = ref(false);

const bridgeBusy = ref(false);
const bridgeMessage = ref<string | null>(null);
const bridgeAvailable = ref<boolean | null>(null);

/** Logs in through the mod's loopback bridge: no token to copy or paste. */
async function useBridge(): Promise<void> {
  if (bridgeBusy.value) return;
  bridgeBusy.value = true;
  bridgeMessage.value = null;
  try {
    const issued = await loginViaLocalBridge({ port: BRIDGE_PORT });
    await loginWithToken(issued.accessToken);
    message.success(`已通过本地游戏登录：${issued.profile.username}`);
    await router.push({ name: 'dashboard' });
  } catch (error) {
    bridgeMessage.value = error instanceof BridgeError ? error.message : (error as Error).message;
    if (error instanceof BridgeError && error.kind === 'unavailable') bridgeAvailable.value = false;
  } finally {
    bridgeBusy.value = false;
  }
}

const decoded = computed(() => (token.value.trim() ? decodeToken(token.value.trim()) : null));
const looksValid = computed(() => decoded.value !== null);
const expiresIn = computed(() => {
  if (!decoded.value) return null;
  const seconds = Math.round(decoded.value.exp - Date.now() / 1000);
  return seconds;
});

async function submit(): Promise<void> {
  if (submitting.value) return;
  errorText.value = null;
  submitting.value = true;
  try {
    await loginWithToken(token.value);
    message.success('已登录控制台');
    await router.push({ name: 'dashboard' });
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : (error as Error).message;
  } finally {
    submitting.value = false;
  }
}

/** Only same-app absolute paths are accepted as a post-login destination. */
function safeNext(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}

/**
 * One-time bootstrap: `/login#token=<jwt>[&next=/path]` lets an operator hand a
 * freshly minted token from a terminal to the console without retyping it.
 * The fragment never reaches a server and is stripped from history immediately.
 */
onMounted(async () => {
  bridgeAvailable.value = await probeLocalBridge({ port: BRIDGE_PORT });

  const rawHash = window.location.hash.replace(/^#/, '');
  if (!rawHash) return;

  const params = new URLSearchParams(rawHash);
  const bootstrapToken = params.get('token');
  if (!bootstrapToken) return;

  token.value = bootstrapToken;
  const next = safeNext(params.get('next'));
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);

  submitting.value = true;
  try {
    await loginWithToken(bootstrapToken);
    await router.push(next ?? { name: 'dashboard' });
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : (error as Error).message;
  } finally {
    submitting.value = false;
  }
});
</script>

<template>
  <div class="login">
    <div class="login__bg dot-texture" aria-hidden="true" />

    <div class="login__grid">
      <section class="intro rise">
        <span class="pill pill--mint">MC Auth Platform</span>
        <h1>用游戏账号<br />进入控制台</h1>
        <p class="intro__lead">
          令牌由 Minecraft 正版握手签发。本页面<strong>不收集密码</strong>，令牌只保存在当前标签页。
        </p>

        <ul class="intro__points">
          <li>
            <span class="dot" aria-hidden="true" />
            服务端每次请求都会重新校验权限与封禁状态
          </li>
          <li>
            <span class="dot dot--mint" aria-hidden="true" />
            令牌默认 15 分钟有效，过期后退出登录
          </li>
          <li>
            <span class="dot dot--amber" aria-hidden="true" />
            需要 <code>admin:users</code> 权限才能进入
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
          <p>推荐直接通过本地游戏登录：浏览器无法自己完成正版握手，由模组代劳。</p>
        </header>

        <div class="bridge">
          <NButton type="primary" size="large" block :loading="bridgeBusy" @click="useBridge">
            通过本地游戏登录
          </NButton>
          <p class="bridge__hint">
            <template v-if="bridgeAvailable === true">
              已检测到本地认证服务（127.0.0.1:{{ BRIDGE_PORT }}）。点击后请在游戏内确认。
            </template>
            <template v-else-if="bridgeAvailable === false">
              未检测到本地认证服务（127.0.0.1:{{ BRIDGE_PORT }}）。请先启动游戏与 Hotaru 模组，或使用下方令牌。
            </template>
            <template v-else>正在检测本地认证服务…</template>
          </p>
          <p v-if="bridgeMessage" class="alert" role="alert">{{ bridgeMessage }}</p>
        </div>

        <div class="or"><span>或粘贴访问令牌</span></div>

        <label class="field">
          <span class="field__label">Access Token（JWT）</span>          <NInput
            v-model:value="token"
            type="textarea"
            placeholder="eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9…"
            :autosize="{ minRows: 4, maxRows: 8 }"
            spellcheck="false"
            @keydown.ctrl.enter="submit"
          />
        </label>

        <p v-if="token && !looksValid" class="hint hint--warn">这段内容不是可解析的 JWT，请检查是否复制完整。</p>
        <p v-else-if="decoded && expiresIn !== null && expiresIn <= 0" class="hint hint--warn">令牌已过期，请重新获取。</p>
        <p v-else-if="decoded" class="hint hint--ok">
          已识别账号 <code>{{ decoded.minecraft_uuid }}</code>，剩余 {{ Math.max(0, expiresIn ?? 0) }} 秒
        </p>

        <p v-if="errorText" class="alert" role="alert">{{ errorText }}</p>

        <NButton
          class="submit"
          type="primary"
          size="large"
          block
          :loading="submitting"
          :disabled="!token.trim()"
          @click="submit"
        >
          进入控制台
        </NButton>

        <button type="button" class="disclosure" :aria-expanded="helpOpen" @click="helpOpen = !helpOpen">
          {{ helpOpen ? '收起' : '令牌从哪里来？' }}
        </button>

        <div v-if="helpOpen" class="help">
          <ol>
            <li>在游戏内完成一次正版认证（Fabric 客户端 + <code>fabric-sdk-java</code>）。</li>
            <li>从返回结果中取出 <code>accessToken</code>（不要用 refreshToken）。</li>
            <li>首次使用前，需要该账号具备 <code>admin:users</code>：</li>
          </ol>
          <pre><code>pnpm --filter @hotaru/auth-server admin:seed -- --uuid &lt;你的UUID&gt;</code></pre>
          <p class="help__note">令牌等同于账号访问凭证，不要粘贴到不受信任的页面。</p>
        </div>

        <div v-if="submitting" class="loading-overlay" aria-live="polite">
          <NSpin size="small" />
          <span>正在校验令牌…</span>
        </div>
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

.intro {
  position: relative;
  padding: 12px 8px;
}

.intro h1 {
  margin: 14px 0 12px;
  font-size: clamp(30px, 3.6vw, 44px);
  line-height: 1.18;
  letter-spacing: -0.03em;
}

.intro__lead {
  color: var(--muted);
  max-width: 44ch;
  font-size: 15px;
}

.intro__lead strong {
  color: var(--ink);
}

.intro__points {
  list-style: none;
  padding: 0;
  margin: 22px 0 0;
  display: grid;
  gap: 10px;
  color: var(--muted);
  font-size: 13.5px;
}

.intro__points li {
  display: flex;
  align-items: baseline;
  gap: 9px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--primary);
  flex: none;
  transform: translateY(-1px);
}

.dot--mint {
  background: var(--secondary);
}

.dot--amber {
  background: #e0b25f;
}

.ornament {
  position: absolute;
  pointer-events: none;
}

.ornament--star {
  width: 26px;
  top: -6px;
  right: 18%;
  opacity: 0.9;
}

.ornament--leaf {
  width: 40px;
  bottom: -14px;
  left: -6px;
  opacity: 0.8;
}

.panel {
  position: relative;
  padding: 28px;
  display: grid;
  gap: 16px;
}

.panel__head h2 {
  font-size: 20px;
  letter-spacing: -0.01em;
}

.panel__head p {
  color: var(--muted);
  font-size: 13.5px;
  margin-top: 4px;
}

.bridge {
  display: grid;
  gap: 8px;
}

.bridge__hint {
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.55;
}

.or {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--muted);
  font-size: 12px;
}

.or::before,
.or::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}

.field {
  display: grid;
  gap: 7px;
}

.field__label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--muted);
}

.hint {
  font-size: 12.5px;
  margin: 0;
}

.hint--ok {
  color: #1f7a63;
}

.hint--warn {
  color: var(--warning);
}

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

.submit {
  margin-top: 2px;
}

.disclosure {
  justify-self: start;
  border: none;
  background: none;
  padding: 2px 0;
  color: var(--primary-strong);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.help {
  border-top: 1px dashed var(--border);
  padding-top: 14px;
  color: var(--muted);
  font-size: 13px;
  display: grid;
  gap: 8px;
}

.help ol {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 6px;
}

.help pre {
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--bg-alt);
  border: 1px solid var(--border);
  overflow-x: auto;
  color: var(--ink);
}

.help__note {
  font-size: 12px;
}

.loading-overlay {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-card);
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 13px;
  color: var(--muted);
}

.login__foot {
  position: relative;
  margin-top: 34px;
  display: flex;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
}

@media (max-width: 900px) {
  .login__grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 26px;
    max-width: 560px;
  }

  .intro {
    text-align: left;
  }

  .ornament--star {
    right: 8%;
  }
}
</style>
