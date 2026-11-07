<script setup lang="ts">
import { NButton, NDataTable, NInput, NPagination, NSkeleton, NTag, type DataTableColumns } from 'naive-ui';
import { h, onMounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import type { UserView } from '@hotaru/api-contract';
import { ApiError, api } from '../api/client';
import EmptyState from '../components/EmptyState.vue';
import { formatDateTime, formatRelative, initialOf, shortUuid } from '../utils/format';

const router = useRouter();

const rows = ref<UserView[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const query = ref('');
const status = ref<'all' | 'active' | 'banned'>('all');
const loading = ref(true);
const errorText = ref<string | null>(null);

const STATUS_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '正常' },
  { value: 'banned', label: '已封禁' },
] as const;

const columns: DataTableColumns<UserView> = [
  {
    title: '玩家',
    key: 'username',
    render: (row) =>
      h('div', { class: 'player' }, [
        h('span', { class: 'player__avatar', 'aria-hidden': 'true' }, initialOf(row.username)),
        h('div', { class: 'player__meta' }, [
          h('strong', row.username),
          h('code', { class: 'player__uuid' }, shortUuid(row.minecraftUuid ?? '未绑定')),
        ]),
      ]),
  },
  {
    title: '状态',
    key: 'status',
    width: 110,
    render: (row) =>
      h(
        NTag,
        { type: row.status === 'active' ? 'success' : 'error', size: 'small', round: true, bordered: false },
        { default: () => (row.status === 'active' ? '正常' : '已封禁') },
      ),
  },
  {
    title: '注册时间',
    key: 'createdAt',
    width: 170,
    render: (row) => h('span', { class: 'muted' }, formatDateTime(row.createdAt)),
  },
  {
    title: '最近登录',
    key: 'lastLoginAt',
    width: 150,
    render: (row) =>
      h('span', { class: 'muted' }, row.lastLoginAt ? formatRelative(row.lastLoginAt) : '从未登录'),
  },
  {
    title: '',
    key: 'actions',
    width: 92,
    align: 'right',
    render: (row) =>
      h(
        NButton,
        { size: 'small', secondary: true, onClick: () => void router.push(`/users/${row.id}`) },
        { default: () => '查看' },
      ),
  },
];

async function load(): Promise<void> {
  loading.value = true;
  errorText.value = null;
  try {
    const result = await api.users({
      query: query.value.trim() || undefined,
      status: status.value === 'all' ? undefined : status.value,
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
    });
    rows.value = result.users;
    total.value = result.total;
    // A filter change can leave us past the last page.
    if (rows.value.length === 0 && page.value > 1) {
      page.value = 1;
      await load();
    }
  } catch (error) {
    errorText.value = error instanceof ApiError ? error.message : (error as Error).message;
  } finally {
    loading.value = false;
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined;
watch(query, () => {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    page.value = 1;
    void load();
  }, 320);
});

watch(status, () => {
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
        <h1>用户</h1>
        <p>按用户名或 UUID 检索通过正版认证的账号，进入详情页管理权限与封禁。</p>
      </div>
      <div class="count">
        <span class="muted">共</span>
        <strong>{{ total }}</strong>
        <span class="muted">个账号</span>
      </div>
    </header>

    <section class="toolbar cozy-card rise rise-1">
      <NInput
        v-model:value="query"
        placeholder="搜索用户名，或粘贴 UUID 前缀…"
        clearable
        class="toolbar__search"
        aria-label="搜索用户"
      />
      <div class="chips" role="group" aria-label="按状态筛选">
        <button
          v-for="option in STATUS_OPTIONS"
          :key="option.value"
          type="button"
          class="chip"
          :class="{ 'chip--active': status === option.value }"
          :aria-pressed="status === option.value"
          @click="status = option.value"
        >
          {{ option.label }}
        </button>
      </div>
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
          :row-key="(row: UserView) => row.id"
          :bordered="false"
          :loading="loading"
          size="medium"
        />
        <div class="pager">
          <NPagination
            v-model:page="page"
            v-model:page-size="pageSize"
            :item-count="total"
            :page-sizes="[10, 20, 50]"
            show-size-picker
            :page-slot="6"
          />
        </div>
      </template>

      <EmptyState
        v-else
        :title="query || status !== 'all' ? '没有匹配的账号' : '还没有任何账号'"
        :description="
          query || status !== 'all'
            ? '换个关键词或清除筛选再试。'
            : '玩家在游戏内完成一次正版认证后，账号会自动出现在这里。'
        "
      >
        <NButton v-if="query || status !== 'all'" size="small" secondary @click="() => { query = ''; status = 'all' }">
          清除筛选
        </NButton>
      </EmptyState>
    </section>

    <p class="foot-note">
      提示：UUID 是唯一身份，用户名可以随 Minecraft 改名变化。
      <RouterLink to="/audit">查看相关审计记录 →</RouterLink>
    </p>
  </div>
</template>

<style scoped>
.count {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-size: 13px;
}

.count strong {
  font-size: 22px;
  letter-spacing: -0.02em;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  padding: 12px 14px;
  margin-bottom: 16px;
}

.toolbar__search {
  flex: 1 1 280px;
}

.chips {
  display: inline-flex;
  gap: 6px;
  padding: 3px;
  background: var(--bg-alt);
  border-radius: 999px;
}

.chip {
  border: none;
  background: none;
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--muted);
  padding: 6px 14px;
  border-radius: 999px;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}

.chip:hover {
  color: var(--ink);
}

.chip--active {
  background: var(--surface);
  color: var(--primary-strong);
  box-shadow: var(--shadow-soft);
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

.foot-note {
  margin-top: 14px;
  font-size: 12.5px;
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
</style>

<style>
.player {
  display: flex;
  align-items: center;
  gap: 10px;
}

.player__avatar {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: var(--primary-soft);
  color: var(--primary-strong);
  font-weight: 700;
  font-size: 13px;
  flex: none;
}

.player__meta {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
  min-width: 0;
}

.player__uuid {
  color: var(--muted);
  font-size: 11.5px;
}
</style>
