<script setup lang="ts">
import { NButton, useMessage } from 'naive-ui';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { authState, logout } from '../stores/auth';
import { formatDuration, initialOf, shortUuid } from '../utils/format';

const router = useRouter();
const route = useRoute();
const message = useMessage();

const NAV = [
  { name: 'dashboard', label: '概览', to: '/' },
  { name: 'users', label: '用户', to: '/users' },
  { name: 'audit', label: '审计日志', to: '/audit' },
] as const;

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
timer = setInterval(() => {
  now.value = Date.now();
}, 1000);

const remaining = computed(() => {
  const session = authState.session;
  if (!session) return 0;
  return Math.max(0, Math.round((session.expiresAt - now.value) / 1000));
});

const expiryTone = computed(() => {
  if (remaining.value <= 60) return 'danger';
  if (remaining.value <= 180) return 'warning';
  return 'calm';
});

const isActive = (name: string): boolean => {
  if (name === 'users') return route.name === 'users' || route.name === 'user-detail';
  return route.name === name;
};

watch(
  remaining,
  (value) => {
    if (value === 0) {
      message.warning('访问令牌已过期，请重新登录');
      logout();
      void router.push({ name: 'login' });
    }
  },
  { flush: 'post' },
);

function signOut(): void {
  logout();
  void router.push({ name: 'login' });
}
</script>

<template>
  <div class="shell">
    <aside class="sidebar dot-texture">
      <RouterLink class="brand" to="/">
        <span class="brand__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 17V8l8-4 8 4v9" />
            <path d="M9 17v-4h6v4" />
          </svg>
        </span>
        <span class="brand__text">
          <strong>Skymatrix</strong>
          <small>认证控制台</small>
        </span>
      </RouterLink>

      <nav class="nav" aria-label="主导航">
        <RouterLink
          v-for="item in NAV"
          :key="item.name"
          :to="item.to"
          class="nav__item"
          :class="{ 'nav__item--active': isActive(item.name) }"
          :aria-current="isActive(item.name) ? 'page' : undefined"
        >
          <span class="nav__dot" aria-hidden="true" />
          {{ item.label }}
        </RouterLink>
      </nav>

      <div class="sidebar__foot">
        <div class="token" :class="`token--${expiryTone}`">
          <span class="token__label">令牌剩余</span>
          <strong class="token__value">{{ formatDuration(remaining) }}</strong>
        </div>
        <p class="sidebar__hint">令牌由游戏内正版登录签发，到期后需重新获取。</p>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="who">
          <span class="who__avatar" aria-hidden="true">{{ initialOf(authState.session?.username ?? '') }}</span>
          <span class="who__meta">
            <strong>{{ authState.session?.username }}</strong>
            <small class="mono">{{ shortUuid(authState.session?.minecraftUuid ?? '') }}</small>
          </span>
        </div>
        <div class="topbar__actions">
          <span class="pill">{{ authState.session?.scopes.length ?? 0 }} 项权限</span>
          <NButton size="small" secondary @click="signOut">退出</NButton>
        </div>
      </header>

      <main class="content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  min-height: 100vh;
}

.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding: 22px 16px;
  border-right: 1px solid var(--border);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(234, 245, 255, 0.78));
  backdrop-filter: blur(6px);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  color: var(--ink);
  text-decoration: none;
}

.brand:hover {
  text-decoration: none;
}

.brand__mark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 11px;
  color: #fff;
  background: linear-gradient(140deg, var(--primary), var(--secondary));
  box-shadow: 0 6px 14px rgba(77, 157, 224, 0.32);
}

.brand__text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.brand__text small {
  color: var(--muted);
  font-size: 11.5px;
  letter-spacing: 0.04em;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-control);
  color: var(--ink);
  font-weight: 500;
  text-decoration: none;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}

.nav__item:hover {
  background: rgba(255, 255, 255, 0.9);
  text-decoration: none;
}

.nav__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border-strong);
  transition: background var(--dur) var(--ease), transform var(--dur) var(--ease);
}

.nav__item--active {
  background: var(--surface);
  color: var(--primary-strong);
  box-shadow: var(--shadow-soft);
}

.nav__item--active .nav__dot {
  background: var(--primary);
  transform: scale(1.35);
}

.sidebar__foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.token {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  font-size: 12px;
}

.token__label {
  color: var(--muted);
}

.token__value {
  font-variant-numeric: tabular-nums;
  color: var(--primary-strong);
}

.token--warning .token__value {
  color: var(--warning);
}

.token--danger .token__value {
  color: var(--danger);
}

.sidebar__hint {
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.5;
  padding: 0 4px;
}

.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 28px;
  border-bottom: 1px solid var(--border);
  background: rgba(246, 250, 255, 0.82);
  backdrop-filter: blur(8px);
  position: sticky;
  top: 0;
  z-index: 5;
}

.who {
  display: flex;
  align-items: center;
  gap: 10px;
}

.who__avatar {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  font-weight: 700;
  color: var(--primary-strong);
  background: var(--primary-soft);
}

.who__meta {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}

.who__meta small {
  color: var(--muted);
  font-size: 11.5px;
}

.topbar__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.content {
  padding: 26px 28px 56px;
  max-width: var(--content-max);
  width: 100%;
  margin: 0 auto;
}

@media (max-width: 860px) {
  .shell {
    grid-template-columns: minmax(0, 1fr);
  }

  .sidebar {
    position: static;
    height: auto;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }

  .nav {
    flex-direction: row;
    flex-wrap: wrap;
  }

  .sidebar__foot {
    display: none;
  }

  .topbar {
    padding: 12px 16px;
  }

  .content {
    padding: 18px 16px 40px;
  }
}
</style>
