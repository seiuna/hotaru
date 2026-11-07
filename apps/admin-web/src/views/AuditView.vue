<script setup lang="ts">
import { NButton, NDataTable, NInput, NPagination, NSelect, NSkeleton, type DataTableColumns } from 'naive-ui';
import { h, onMounted, ref, watch } from 'vue';
import type { AuditLogView } from '@hotaru/api-contract';
import { ApiError, api } from '../api/client';
import EmptyState from '../components/EmptyState.vue';
import { formatDateTime, formatRelative } from '../utils/format';

const rows = ref<AuditLogView[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const event = ref<string | null>(null);
const actorId = ref('');
const loading = ref(true);
const errorText = ref<string | null>(null);

/** The events the backend actually emits, with human labels. */
const EVENT_OPTIONS = [
  { label: '全部事件', value: '' },
  { label: 'auth.session.created — 登录成功', value: 'auth.session.created' },
  { label: 'auth.session.refreshed — 令牌续期', value: 'auth.session.refreshed' },
  { label: 'auth.session.revoked — 会话撤销', value: 'auth.session.revoked' },
  { label: 'auth.refresh.reused — 刷新令牌重放', value: 'auth.refresh.reused' },
  { label: 'auth.challenge.created — 发起挑战', value: 'auth.challenge.created' },
  { label: 'auth.challenge.rejected — 挑战被拒', value: 'auth.challenge.rejected' },
  { label: 'auth.login.banned — 封禁账号尝试登录', value: 'auth.login.banned' },
  { label: 'user.permissions.updated — 权限变更', value: 'user.permissions.updated' },
  { label: 'user.banned — 封禁', value: 'user.banned' },
  { label: 'user.unbanned — 解封', value: 'user.unbanned' },
];

function eventTone(name: string): string {
  if (name.startsWith('auth.refresh.reused') || name === 'user.banned' || name === 'auth.login.banned') return 'danger';
  if (name.includes('revoked') || name.includes('rejected')) return 'warning';
  if (name.startsWith('user.')) return 'mint';
  return 'sky';
}

const columns: DataTableColumns<AuditLogView> = [
  {
    title: '时间',
    key: 'createdAt',
    width: 190,
    render: (row) =>
      h('div', { class: 'time' }, [
        h('strong', formatRelative(row.createdAt)),
        h('span', { class: 'muted time__abs' }, formatDateTime(row.createdAt)),
      ]),
  },
  {
    title: '事件',
    key: 'event',
    render: (row) =>
      h('div', { class: 'event' }, [
        h('span', { class: `event__dot event__dot--${eventTone(row.event)}`, 'aria-hidden': 'true' }),
        h('code', { class: 'event__name' }, row.event),
      ]),
  },
  {
    title: '操作者',
    key: 'actorId',
    width: 200,
    render: (row) =>
      h('div', { class: 'actor' }, [
        h('span', { class: 'actor__type' }, row.actorType === 'admin' ? '管理员' : row.actorType === 'user' ? '用户' : '系统'),
        h('code', { class: 'actor__id muted' }, row.actorId ? row.actorId.slice(-8) : '—'),
      ]),
  },
  {
    title: '目标',
    key: 'targetId',
    width: 180,
    render: (row) =>
      h('span', { class: 'muted' }, row.targetId ? `${row.targetType ?? 'object'} ${row.targetId.slice(-8)}` : '—'),
  },
  {
    title: 'IP',
    key: 'ip',
    width: 140,
    render: (row) => h('span', { class: 'muted mono' }, row.ip ?? '—'),
  },
  {
    title: '详情',
    key: 'metadata',
    render: (row) =>
      row.metadata
        ? h('code', { class: 'meta' }, JSON.stringify(row.metadata).slice(0, 64) + (JSON.stringify(row.metadata).length > 64 ? '…' : ''))
        : h('span', { class: 'muted' }, '—'),
  },
];

async function load(): Promise<void> {
  loading.value = true;
  errorText.value = null;
  try {
    const result = await api.auditLogs({
      ...(event.value ? { event: event.value } : {}),
      ...(actorId.value.trim() ? { actorId: actorId.value.trim() } : {}),
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
    });
    rows.value = result.logs;
    total.value = result.total;
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : (error as Error).message;
  } finally {
    loading.value = false;
  }
}

function applyActorFilter(): void {
  page.value = 1;
  void load();
}

watch(event, () => {
  page.value = 1;
  void load();
});

watch([page, pageSize], () => void load());

onMounted(load);
</script>

<template>
  <div>
    <header class="page-header rise">
      <div>
        <h1>审计日志</h1>
        <p>登录、授权、封禁与会话撤销的完整记录，最新在前。</p>
      </div>
      <NButton secondary :loading="loading" @click="load">刷新</NButton>
    </header>

    <section class="toolbar cozy-card rise rise-1">
      <NSelect
        v-model:value="event"
        :options="EVENT_OPTIONS"
        class="toolbar__event"
        placeholder="全部事件"
        clearable
        aria-label="按事件筛选"
      />
      <NInput
        v-model:value="actorId"
        placeholder="按操作者 ObjectId 精确筛选（可留空）"
        class="toolbar__actor"
        clearable
        aria-label="按操作者筛选"
        @keydown.enter="applyActorFilter"
      />
      <NButton secondary @click="applyActorFilter">应用</NButton>
    </section>

    <p v-if="errorText" class="alert" role="alert">
      {{ errorText }}
      <NButton text type="primary" size="small" @click="load">重试</NButton>
    </p>

    <section class="table-card cozy-card rise rise-2">
      <NSkeleton v-if="loading && rows.length === 0" text :repeat="6" class="skeleton" />
      <template v-else-if="rows.length > 0">
        <NDataTable
          :columns="columns"
          :data="rows"
          :row-key="(row: AuditLogView) => row.id"
          :bordered="false"
          :loading="loading"
          size="small"
        />
        <div class="pager">
          <NPagination
            v-model:page="page"
            v-model:page-size="pageSize"
            :item-count="total"
            :page-sizes="[20, 50, 100]"
            show-size-picker
            :page-slot="6"
          />
        </div>
      </template>
      <EmptyState
        v-else
        title="没有匹配的审计事件"
        description="换一个事件类型，或清空操作者筛选后再试。"
      />
    </section>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  padding: 12px 14px;
  margin-bottom: 16px;
}

.toolbar__event {
  width: 320px;
}

.toolbar__actor {
  flex: 1 1 260px;
}

.table-card {
  padding: 6px 6px 0;
  overflow: hidden;
}

.skeleton {
  padding: 20px;
}

.pager {
  display: flex;
  justify-content: flex-end;
  padding: 12px 12px 14px;
  border-top: 1px solid var(--border);
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
</style>

<style>
.time {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}

.time__abs {
  font-size: 11px;
}

.event {
  display: flex;
  align-items: center;
  gap: 8px;
}

.event__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}

.event__dot--sky {
  background: var(--primary);
}

.event__dot--mint {
  background: var(--secondary);
}

.event__dot--warning {
  background: #d9a24a;
}

.event__dot--danger {
  background: #cf6b7d;
}

.event__name {
  font-size: 12.5px;
}

.actor {
  display: flex;
  align-items: center;
  gap: 8px;
}

.actor__type {
  font-size: 12px;
  color: var(--muted);
}

.actor__id {
  font-size: 11.5px;
}

.meta {
  font-size: 11.5px;
  color: var(--muted);
}
</style>
