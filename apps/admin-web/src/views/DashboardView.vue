<script setup lang="ts">
import { NButton, NSkeleton, NTag } from 'naive-ui';
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import type { AdminStatsResponse, AuditLogListResponse } from '@skymatrix/api-contract';
import EmptyState from '../components/EmptyState.vue';
import StatCard from '../components/StatCard.vue';
import { ApiError, api } from '../api/client';
import { authState } from '../stores/auth';
import { formatRelative } from '../utils/format';
import { scopeMeta } from '../utils/permissions';

const stats = ref<AdminStatsResponse | null>(null);
const recent = ref<AuditLogListResponse | null>(null);
const health = ref<{ status: 'ok' | 'degraded'; checks: Record<string, 'ok' | 'fail'> } | null>(null);
const loading = ref(true);
const errorText = ref<string | null>(null);

const greeting = computed(() => {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 18) return '下午好';
  return '晚上好';
});

const bannedRatio = computed(() => {
  const total = stats.value?.users.total ?? 0;
  if (total === 0) return 0;
  return Math.round(((stats.value?.users.banned ?? 0) / total) * 100);
});

async function load(): Promise<void> {
  loading.value = true;
  errorText.value = null;
  try {
    const [statsResult, auditResult, healthResult] = await Promise.all([
      api.stats(),
      api.auditLogs({ limit: 6 }),
      api.healthReady().catch(() => null),
    ]);
    stats.value = statsResult;
    recent.value = auditResult;
    health.value = healthResult;
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : (error as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <header class="page-header rise">
      <div>
        <h1>{{ greeting }}，{{ authState.session?.username }}</h1>
        <p>这里是 Skymatrix 认证服务的运营概览，数据实时来自 MongoDB 与 Redis。</p>
      </div>
      <NButton secondary :loading="loading" @click="load">刷新</NButton>
    </header>

    <p v-if="errorText" class="alert" role="alert">
      {{ errorText }}
      <NButton text type="primary" size="small" @click="load">重试</NButton>
    </p>

    <div class="grid grid--bento">
      <div class="span-3 stat-slot rise rise-1">
        <StatCard v-if="stats" label="用户总数" :value="stats.users.total" hint="所有通过正版认证的账号" tone="sky" />
        <div v-else class="cozy-card skeleton"><NSkeleton height="64px" /></div>
      </div>
      <div class="span-3 rise rise-1">
        <StatCard
          v-if="stats"
          label="活跃会话"
          :value="stats.sessions.active"
          hint="未撤销且未过期的登录会话"
          tone="mint"
        />
        <div v-else class="cozy-card skeleton"><NSkeleton height="64px" /></div>
      </div>
      <div class="span-3 rise rise-2">
        <StatCard
          v-if="stats"
          label="24 小时审计事件"
          :value="stats.audit.last24h"
          hint="登录、授权、封禁等安全动作"
          tone="amber"
        />
        <div v-else class="cozy-card skeleton"><NSkeleton height="64px" /></div>
      </div>
      <div class="span-3 rise rise-2">
        <StatCard
          v-if="stats"
          label="权限授予"
          :value="stats.permissions.total"
          :hint="`覆盖 ${stats.users.total} 个账号的 scope`"
          tone="sky"
        />
        <div v-else class="cozy-card skeleton"><NSkeleton height="64px" /></div>
      </div>

      <article class="span-7 cozy-card card rise rise-2">
        <header class="card__head">
          <h2>用户构成</h2>
          <RouterLink to="/users" class="card__link">查看全部用户 →</RouterLink>
        </header>

        <div v-if="stats" class="composition">
          <div class="composition__bar" role="img" :aria-label="`活跃 ${stats.users.active}，封禁 ${stats.users.banned}`">
            <span class="composition__fill composition__fill--active" :style="{ flexGrow: stats.users.active || 0.0001 }" />
            <span class="composition__fill composition__fill--banned" :style="{ flexGrow: stats.users.banned || 0.0001 }" />
          </div>
          <div class="composition__legend">
            <span><i class="swatch swatch--active" aria-hidden="true" />正常 {{ stats.users.active }}</span>
            <span><i class="swatch swatch--banned" aria-hidden="true" />封禁 {{ stats.users.banned }}</span>
            <span class="composition__rate">封禁率 {{ bannedRatio }}%</span>
          </div>
          <p class="composition__note">
            正版认证只证明账号归属，能否使用服务由权限表决定；封禁会同时撤销该账号的全部会话。
          </p>
        </div>
        <NSkeleton v-else text :repeat="3" />
      </article>

      <article class="span-5 cozy-card card rise rise-3">
        <header class="card__head">
          <h2>最近审计</h2>
          <RouterLink to="/audit" class="card__link">完整日志 →</RouterLink>
        </header>

        <ul v-if="recent && recent.logs.length > 0" class="feed">
          <li v-for="log in recent.logs" :key="log.id" class="feed__item">
            <span class="feed__dot" aria-hidden="true" />
            <div class="feed__body">
              <p class="feed__event">{{ log.event }}</p>
              <p class="feed__meta">
                {{ log.actorType === 'system' ? '系统' : log.actorId ?? '未知操作者' }} ·
                {{ formatRelative(log.createdAt) }}
              </p>
            </div>
          </li>
        </ul>
        <EmptyState v-else-if="recent" title="还没有审计事件" description="管理员操作与登录记录会出现在这里。" />
        <NSkeleton v-else text :repeat="4" />
      </article>

      <article class="span-5 cozy-card card rise rise-3">
        <header class="card__head">
          <h2>依赖状态</h2>
        </header>
        <ul v-if="health" class="deps">
          <li v-for="(state, name) in health.checks" :key="name" class="deps__item">
            <span class="deps__name mono">{{ name }}</span>
            <NTag :type="state === 'ok' ? 'success' : 'error'" size="small" round>
              {{ state === 'ok' ? '正常' : '异常' }}
            </NTag>
          </li>
          <li class="deps__item deps__item--muted">
            <span class="deps__name">Mojang 会话服务</span>
            <span class="muted">仅在登录时访问</span>
          </li>
        </ul>
        <p v-else class="muted">健康检查不可用。</p>
      </article>

      <article class="span-7 cozy-card card rise rise-3">
        <header class="card__head">
          <h2>当前身份</h2>
        </header>
        <div class="identity">
          <div class="identity__row">
            <span class="muted">账号</span>
            <strong>{{ authState.session?.username }}</strong>
          </div>
          <div class="identity__row">
            <span class="muted">UUID</span>
            <code>{{ authState.session?.minecraftUuid }}</code>
          </div>
          <div class="identity__row">
            <span class="muted">权限</span>
            <span class="identity__scopes">
              <span v-for="scope in authState.session?.scopes" :key="scope" class="pill pill--mint">
                {{ scopeMeta(scope).label }}
              </span>
            </span>
          </div>
          <p class="identity__note">
            权限每次请求都会从数据库重新计算，因此撤销会立刻生效，无需等待令牌过期。
          </p>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.span-3 {
  grid-column: span 3;
}

@media (max-width: 1080px) {
  .span-3 {
    grid-column: span 6;
  }
}

@media (max-width: 640px) {
  .span-3 {
    grid-column: span 12;
  }
}

.skeleton {
  padding: 18px 20px;
}

.card {
  padding: 20px 22px;
  display: grid;
  gap: 14px;
  align-content: start;
}

.card__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.card__head h2 {
  font-size: 15.5px;
  letter-spacing: -0.01em;
}

.card__link {
  font-size: 12.5px;
}

.composition {
  display: grid;
  gap: 12px;
}

.composition__bar {
  display: flex;
  gap: 4px;
  height: 12px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--bg-alt);
}

.composition__fill {
  display: block;
  border-radius: 999px;
}

.composition__fill--active {
  background: linear-gradient(90deg, var(--primary), #7fc4ec);
}

.composition__fill--banned {
  background: #e6a2ad;
}

.composition__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 12.5px;
  color: var(--muted);
}

.composition__legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.swatch {
  width: 9px;
  height: 9px;
  border-radius: 3px;
}

.swatch--active {
  background: var(--primary);
}

.swatch--banned {
  background: #e6a2ad;
}

.composition__rate {
  margin-left: auto;
  color: var(--ink);
  font-weight: 600;
}

.composition__note {
  font-size: 12.5px;
  color: var(--muted);
}

.feed {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 12px;
}

.feed__item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.feed__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--secondary);
  margin-top: 7px;
  flex: none;
}

.feed__event {
  font-size: 13px;
  font-weight: 600;
  font-family: var(--font-mono);
}

.feed__meta {
  color: var(--muted);
  font-size: 12px;
}

.deps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}

.deps__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--surface-soft);
  border: 1px solid var(--border);
}

.deps__item--muted {
  background: transparent;
  border-style: dashed;
  font-size: 12.5px;
}

.deps__name {
  font-size: 13px;
}

.identity {
  display: grid;
  gap: 10px;
}

.identity__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  font-size: 13px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--border);
}

.identity__scopes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}

.identity__note {
  font-size: 12.5px;
  color: var(--muted);
}

.alert {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 18px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--danger-soft);
  border: 1px solid #f3d3d9;
  color: var(--danger);
  font-size: 13px;
}
</style>
