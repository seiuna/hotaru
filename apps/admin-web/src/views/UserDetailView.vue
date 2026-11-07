<script setup lang="ts">
import {
  NButton,
  NDataTable,
  NInput,
  NModal,
  NPopconfirm,
  NTag,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import { computed, h, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import type { AdminUserDetailResponse, SessionView } from '@hotaru/api-contract';
import type { MinecraftLinkView, Scope } from '@hotaru/shared-types';
import { ApiError, api } from '../api/client';
import EmptyState from '../components/EmptyState.vue';
import { authState, setScopes } from '../stores/auth';
import { formatDateTime, formatDuration, formatRelative, initialOf } from '../utils/format';
import {
  SCOPE_META,
  computeGrantDiff,
  isDiffEmpty,
  scopeMeta,
  toIsoOrNull,
  toLocalInputValue,
  type GrantInput,
} from '../utils/permissions';

const route = useRoute();
const router = useRouter();
const message = useMessage();

const userId = computed(() => String(route.params.id ?? ''));
const detail = ref<AdminUserDetailResponse | null>(null);
const sessions = ref<SessionView[]>([]);
const sessionTotal = ref(0);
const includeRevoked = ref(false);
const loading = ref(true);
const saving = ref(false);
const errorText = ref<string | null>(null);

const banOpen = ref(false);
const banReason = ref('');
const banning = ref(false);

interface DraftGrant {
  scope: Scope;
  enabled: boolean;
  expiresAt: string | null;
}

const draft = ref<DraftGrant[]>([]);

const originalGrants = computed<GrantInput[]>(() =>
  (detail.value?.permissions ?? []).map((permission) => ({
    scope: permission.scope,
    expiresAt: permission.expiresAt,
  })),
);

const desiredGrants = computed<GrantInput[]>(() =>
  draft.value
    .filter((grant) => grant.enabled)
    .map((grant) => ({ scope: grant.scope, expiresAt: toIsoOrNull(grant.expiresAt) })),
);

const diff = computed(() => computeGrantDiff(originalGrants.value, desiredGrants.value));
const dirty = computed(() => !isDiffEmpty(diff.value));
const isSelf = computed(() => detail.value?.user.id === authState.session?.userId);

function resetDraft(): void {
  const granted = new Map<string, string | null>(
    (detail.value?.permissions ?? []).map((p) => [p.scope, p.expiresAt] as const),
  );
  draft.value = SCOPE_META.map((meta) => ({
    scope: meta.scope,
    enabled: granted.has(meta.scope),
    expiresAt: toLocalInputValue(granted.get(meta.scope) ?? null),
  }));
}

async function load(): Promise<void> {
  loading.value = true;
  errorText.value = null;
  try {
    const [userDetail, sessionList] = await Promise.all([
      api.user(userId.value),
      api.sessions(userId.value, { limit: 20, includeRevoked: includeRevoked.value }),
    ]);
    detail.value = userDetail;
    sessions.value = sessionList.sessions;
    sessionTotal.value = sessionList.total;
    resetDraft();
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : (error as Error).message;
  } finally {
    loading.value = false;
  }
}

async function savePermissions(): Promise<void> {
  if (!detail.value || saving.value) return;
  saving.value = true;
  try {
    const result = await api.setPermissions(detail.value.user.id, {
      permissions: desiredGrants.value.map((grant) => ({
        scope: grant.scope,
        expiresAt: grant.expiresAt,
      })),
    });
    detail.value = { ...detail.value, permissions: result.permissions, scopes: result.scopes };
    resetDraft();
    message.success('权限已更新，立即生效');
    if (isSelf.value) setScopes(result.scopes);
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : (error as Error).message);
  } finally {
    saving.value = false;
  }
}

async function toggleBan(): Promise<void> {
  if (!detail.value || banning.value) return;
  banning.value = true;
  try {
    if (detail.value.user.status === 'banned') {
      const result = await api.unban(detail.value.user.id);
      detail.value = { ...detail.value, user: result.user };
      message.success('已解除封禁');
    } else {
      const result = await api.ban(detail.value.user.id, banReason.value.trim() ? { reason: banReason.value.trim() } : {});
      detail.value = { ...detail.value, user: result.user };
      message.success(`已封禁，并撤销 ${result.sessionsRevoked} 个会话`);
      banOpen.value = false;
      banReason.value = '';
      await load();
    }
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : (error as Error).message);
  } finally {
    banning.value = false;
  }
}

async function revokeSession(sessionId: string): Promise<void> {
  try {
    await api.revokeSession(sessionId, 'admin_revoked_from_console');
    message.success('会话已撤销');
    await load();
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : (error as Error).message);
  }
}

async function toggleLinkBan(link: MinecraftLinkView): Promise<void> {
  if (!detail.value) return;
  try {
    const result =
      link.status === 'banned'
        ? await api.unbanLink(detail.value.user.id, link.uuid)
        : await api.banLink(detail.value.user.id, link.uuid);
    detail.value = {
      ...detail.value,
      links: detail.value.links.map((item) => (item.uuid === link.uuid ? result.link : item)),
    };
    message.success(link.status === 'banned' ? '已解除 UUID 封禁' : '已封禁该 UUID');
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : (error as Error).message);
  }
}

const sessionColumns: DataTableColumns<SessionView> = [
  {
    title: '会话',
    key: 'id',
    render: (row) =>
      h('div', { class: 'sess' }, [
        h('code', { class: 'sess__id' }, row.id.slice(-8)),
        h('span', { class: 'sess__ip muted' }, row.ip ?? '未知 IP'),
      ]),
  },
  {
    title: '创建',
    key: 'createdAt',
    width: 160,
    render: (row) => h('span', { class: 'muted' }, formatDateTime(row.createdAt)),
  },
  {
    title: '状态',
    key: 'state',
    width: 150,
    render: (row) => {
      if (row.revokedAt) {
        return h(NTag, { type: 'default', size: 'small', round: true, bordered: false }, { default: () => '已撤销' });
      }
      const secondsLeft = Math.round((new Date(row.expiresAt).getTime() - Date.now()) / 1000);
      return h(
        NTag,
        { type: secondsLeft > 0 ? 'success' : 'warning', size: 'small', round: true, bordered: false },
        { default: () => (secondsLeft > 0 ? `有效 ${formatDuration(secondsLeft)}` : '已过期') },
      );
    },
  },
  {
    title: '',
    key: 'actions',
    width: 96,
    align: 'right',
    render: (row) =>
      row.revokedAt
        ? null
        : h(
            NButton,
            { size: 'small', tertiary: true, type: 'error', onClick: () => void revokeSession(row.id) },
            { default: () => '撤销' },
          ),
  },
];

watch(includeRevoked, () => void load());
onMounted(load);
</script>

<template>
  <div>
    <nav class="crumbs rise" aria-label="面包屑">
      <RouterLink to="/users">用户</RouterLink>
      <span aria-hidden="true">/</span>
      <span>{{ detail?.user.username ?? '…' }}</span>
      <NButton text size="small" class="crumbs__back" @click="router.back()">← 返回</NButton>
    </nav>

    <p v-if="errorText" class="alert" role="alert">
      {{ errorText }}
      <NButton text type="primary" size="small" @click="load">重试</NButton>
    </p>

    <template v-if="detail">
      <section class="profile cozy-card rise rise-1">
        <div class="profile__id">
          <span class="profile__avatar" aria-hidden="true">{{ initialOf(detail.user.username) }}</span>
          <div class="profile__text">
            <div class="profile__name">
              <h1>{{ detail.user.username }}</h1>
              <NTag
                :type="detail.user.status === 'active' ? 'success' : 'error'"
                size="small"
                round
                :bordered="false"
              >
                {{ detail.user.status === 'active' ? '正常' : '已封禁' }}
              </NTag>
              <span v-if="isSelf" class="pill">这是你自己</span>
            </div>
            <code class="profile__uuid">{{ detail.user.minecraftUuid ?? '无主 UUID' }}</code>
            <div class="profile__meta">
              <span>注册 {{ formatDateTime(detail.user.createdAt) }}</span>
              <span aria-hidden="true">·</span>
              <span>
                最近登录 {{ detail.user.lastLoginAt ? formatRelative(detail.user.lastLoginAt) : '从未' }}
              </span>
              <span v-if="detail.user.email" aria-hidden="true">·</span>
              <span v-if="detail.user.email">{{ detail.user.email }}</span>
            </div>
          </div>
        </div>

        <div class="profile__actions">
          <NButton v-if="detail.user.status === 'active'" type="error" secondary @click="banOpen = true">
            封禁账号
          </NButton>
          <NButton v-else secondary @click="toggleBan" :loading="banning">解除封禁</NButton>
        </div>
      </section>

      <section class="span-12 cozy-card card link-card rise rise-1">
        <header class="card__head">
          <div>
            <h2>Minecraft 绑定</h2>
            <p class="muted card__sub">一个账号可以绑定多个 UUID；封禁只影响对应的游戏身份。</p>
          </div>
          <span class="muted card__sub">{{ detail.links.length }} 个 UUID</span>
        </header>

        <p v-if="detail.links.length === 0" class="muted">这个账号还没有绑定任何 UUID。</p>
        <ul v-else class="link-list">
          <li v-for="link in detail.links" :key="link.uuid" class="link-row">
            <div class="link-row__id">
              <code>{{ link.uuid }}</code>
              <span class="muted">{{ link.username }}</span>
            </div>
            <div class="link-row__actions">
              <NTag
                :type="link.status === 'active' ? 'success' : 'error'"
                size="small"
                round
                :bordered="false"
              >
                {{ link.status === 'active' ? '正常' : '已封禁' }}
              </NTag>
              <NPopconfirm @positive-click="toggleLinkBan(link)">
                <template #trigger>
                  <NButton size="small" :type="link.status === 'active' ? 'error' : 'default'" tertiary>
                    {{ link.status === 'active' ? '封禁 UUID' : '解除封禁' }}
                  </NButton>
                </template>
                {{ link.status === 'active' ? '封禁这个 UUID？该身份会立即被登出。' : '解除这个 UUID 的封禁？' }}
              </NPopconfirm>
            </div>
          </li>
        </ul>
      </section>

      <div class="grid grid--bento">
        <section class="span-7 cozy-card card rise rise-2">
          <header class="card__head">
            <div>
              <h2>权限</h2>
              <p class="muted card__sub">保存后立即生效，已签发的令牌也会在下一次请求时受限。</p>
            </div>
            <div class="card__actions">
              <NButton size="small" tertiary :disabled="!dirty" @click="resetDraft">重置</NButton>
              <NButton size="small" type="primary" :disabled="!dirty" :loading="saving" @click="savePermissions">
                保存
              </NButton>
            </div>
          </header>

          <ul class="scopes">
            <li v-for="grant in draft" :key="grant.scope" class="scope" :class="{ 'scope--on': grant.enabled }">
              <label class="scope__main">
                <input
                  v-model="grant.enabled"
                  type="checkbox"
                  class="scope__check"
                  :aria-label="`授予 ${scopeMeta(grant.scope).label}`"
                />
                <span class="scope__text">
                  <span class="scope__label">
                    {{ scopeMeta(grant.scope).label }}
                    <code class="scope__code">{{ grant.scope }}</code>
                  </span>
                  <span class="scope__desc">{{ scopeMeta(grant.scope).description }}</span>
                </span>
              </label>
              <label v-if="grant.enabled" class="scope__expiry">
                <span class="muted">到期</span>
                <input
                  v-model="grant.expiresAt"
                  type="datetime-local"
                  class="scope__expiry-input"
                  :aria-label="`${scopeMeta(grant.scope).label} 的到期时间，留空表示永久`"
                />
              </label>
            </li>
          </ul>

          <p v-if="dirty" class="diff" aria-live="polite">
            <span v-if="diff.added.length">新增 {{ diff.added.map((s) => scopeMeta(s).label).join('、') }}</span>
            <span v-if="diff.removed.length">移除 {{ diff.removed.map((s) => scopeMeta(s).label).join('、') }}</span>
            <span v-if="diff.updated.length">调整 {{ diff.updated.map((s) => scopeMeta(s).label).join('、') }}</span>
          </p>
        </section>

        <section class="span-5 cozy-card card rise rise-2">
          <header class="card__head">
            <h2>有效权限</h2>
            <span class="muted card__sub">{{ detail.scopes.length }} 项</span>
          </header>
          <div v-if="detail.scopes.length" class="badges">
            <span v-for="scope in detail.scopes" :key="scope" class="pill pill--mint">
              {{ scopeMeta(scope).label }}
            </span>
          </div>
          <p v-else class="muted">该账号没有任何有效权限（默认拒绝）。</p>

          <div class="grants">
            <p v-for="permission in detail.permissions" :key="permission.scope" class="grants__row">
              <code>{{ permission.scope }}</code>
              <span class="muted">
                {{ permission.expiresAt ? `至 ${formatDateTime(permission.expiresAt)}` : '永久' }}
              </span>
            </p>
          </div>
        </section>

        <section class="span-12 cozy-card card rise rise-3">
          <header class="card__head">
            <div>
              <h2>登录会话</h2>
              <p class="muted card__sub">共 {{ sessionTotal }} 条，撤销后该设备的令牌立即失效。</p>
            </div>
            <label class="toggle">
              <input v-model="includeRevoked" type="checkbox" />
              显示已撤销
            </label>
          </header>

          <NDataTable
            v-if="sessions.length"
            :columns="sessionColumns"
            :data="sessions"
            :row-key="(row: SessionView) => row.id"
            :bordered="false"
            size="small"
          />
          <EmptyState v-else title="没有活跃会话" description="该账号当前没有未撤销的登录会话。" />
        </section>
      </div>
    </template>

    <div v-else-if="loading" class="cozy-card loading">
      正在加载用户…
    </div>

    <NModal v-model:show="banOpen" preset="card" style="max-width: 460px" title="封禁账号">
      <p class="muted ban-note">
        封禁会立即撤销该账号的<strong>全部会话</strong>，并在下一次请求时返回 <code>USER_BANNED</code>。
      </p>
      <NInput v-model:value="banReason" type="textarea" placeholder="原因（可选，会写入审计日志）" :rows="3" />
      <template #footer>
        <div class="ban-actions">
          <NButton secondary @click="banOpen = false">取消</NButton>
          <NButton type="error" :loading="banning" @click="toggleBan">确认封禁</NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.crumbs {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 14px;
}

.crumbs__back {
  margin-left: auto;
}

.profile {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 22px 24px;
  margin-bottom: 18px;
}

.profile__id {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}

.profile__avatar {
  display: grid;
  place-items: center;
  width: 58px;
  height: 58px;
  border-radius: 18px;
  font-size: 24px;
  font-weight: 700;
  color: var(--primary-strong);
  background: linear-gradient(140deg, var(--primary-soft), var(--secondary-soft));
  flex: none;
}

.profile__name {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.profile__name h1 {
  font-size: 24px;
  letter-spacing: -0.02em;
}

.profile__uuid {
  display: block;
  color: var(--muted);
  font-size: 12px;
  margin-top: 3px;
}

.link-list {
  display: grid;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.link-card {
  margin-bottom: 18px;
}

.link-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-soft);
}

.link-row__id {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.link-row__id code {
  font-size: 12px;
  overflow-wrap: anywhere;
}

.link-row__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.profile__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--muted);
  font-size: 12.5px;
  margin-top: 6px;
}

.card {
  padding: 20px 22px;
  display: grid;
  gap: 14px;
  align-content: start;
}

.card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.card__head h2 {
  font-size: 15.5px;
}

.card__sub {
  font-size: 12.5px;
  margin-top: 3px;
}

.card__actions {
  display: flex;
  gap: 8px;
  flex: none;
}

.scopes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}

.scope {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface-soft);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}

.scope--on {
  border-color: var(--border-strong);
  background: #fff;
}

.scope__main {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex: 1 1 320px;
  cursor: pointer;
}

.scope__check {
  width: 18px;
  height: 18px;
  margin-top: 2px;
  accent-color: var(--primary-strong);
  flex: none;
}

.scope__text {
  display: grid;
  gap: 2px;
}

.scope__label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-weight: 600;
  font-size: 13.5px;
}

.scope__code {
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 400;
}

.scope__desc {
  color: var(--muted);
  font-size: 12.5px;
}

.scope__expiry {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.scope__expiry-input {
  font: inherit;
  font-size: 12px;
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--ink);
}

.scope__expiry-input:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.diff {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--primary-soft);
  color: var(--primary-strong);
  font-size: 12.5px;
}

.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.grants {
  display: grid;
  gap: 6px;
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}

.grants__row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12.5px;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--muted);
  cursor: pointer;
}

.loading {
  padding: 28px;
  color: var(--muted);
}

.alert {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 14px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--danger-soft);
  border: 1px solid #f3d3d9;
  color: var(--danger);
  font-size: 13px;
}

.ban-note {
  font-size: 13px;
  margin-bottom: 10px;
}

.ban-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>

<style>
.sess {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}

.sess__id {
  font-size: 12.5px;
  color: var(--ink);
}

.sess__ip {
  font-size: 11.5px;
}
</style>
