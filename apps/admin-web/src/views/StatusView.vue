<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { RouterLink } from 'vue-router';
import type { ServiceStatus } from '@hotaru/api-contract';
import { ApiError, api } from '../api/client';

const HISTORY_KEY = 'hotaru.status.history.v1';
const SAMPLES = 60;
const POLL_MS = 5000;

const SERVICES: Array<{ id: string; name: string }> = [
  { id: 'auth', name: 'Auth API' },
  { id: 'mongodb', name: 'MongoDB' },
  { id: 'redis', name: 'Redis' },
  { id: 'irc', name: 'IRC Server' },
  { id: 'admin-web', name: 'Admin Console' },
];

const services = ref<ServiceStatus[]>([]);
const history = reactive<Record<string, number[]>>({});
const loading = ref(true);
const refreshing = ref(false);
const errorText = ref<string | null>(null);
const lastUpdated = ref<Date | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

function loadHistory(): void {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    for (const { id } of SERVICES) {
      const values = Array.isArray(parsed[id])
        ? (parsed[id] as unknown[]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
        : [];
      history[id] = values.slice(-SAMPLES);
    }
  } catch {
    for (const { id } of SERVICES) history[id] = [];
  }
}

function saveHistory(): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    /* storage can be full or disabled; the in-memory curves still work */
  }
}

function record(id: string, latencyMs: number | null): void {
  if (latencyMs === null) return;
  const values = history[id] ?? [];
  values.push(latencyMs);
  if (values.length > SAMPLES) values.splice(0, values.length - SAMPLES);
  history[id] = values;
}

function placeholderServices(detail: string): ServiceStatus[] {
  return SERVICES.map((service) => ({
    ...service,
    status: service.id === 'admin-web' ? 'up' : service.id === 'auth' ? 'down' : 'degraded',
    latencyMs: null,
    detail: service.id === 'admin-web' ? '正在提供此页面' : detail,
  }));
}

async function refresh(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  const started = performance.now();
  try {
    const snapshot = await api.status();
    const roundTrip = Math.max(0, Math.round(performance.now() - started));
    const next = snapshot.services.map((service) =>
      service.id === 'auth' ? { ...service, latencyMs: roundTrip } : service,
    );
    if (!next.some((service) => service.id === 'admin-web')) {
      next.push({
        id: 'admin-web',
        name: 'Admin Console',
        status: 'up',
        latencyMs: null,
        detail: '正在提供此页面',
      });
    }
    services.value = SERVICES.map(
      (service) =>
        next.find((item) => item.id === service.id) ?? {
          ...service,
          status: 'degraded',
          latencyMs: null,
          detail: '未返回状态',
        },
    );
    for (const service of services.value) record(service.id, service.latencyMs);
    saveHistory();
    lastUpdated.value = new Date();
    errorText.value = null;
  } catch (error) {
    services.value = placeholderServices('状态接口不可达');
    errorText.value = error instanceof ApiError ? error.message : (error as Error).message;
  } finally {
    refreshing.value = false;
    loading.value = false;
  }
}

const overall = computed<'up' | 'degraded' | 'down'>(() => {
  if (services.value.some((service) => service.status === 'down')) return 'down';
  if (services.value.some((service) => service.status === 'degraded')) return 'degraded';
  return 'up';
});

const overallLabel = computed(() => {
  if (overall.value === 'up') return '所有服务可用';
  if (overall.value === 'degraded') return '部分服务降级';
  return '存在不可用服务';
});

const upCount = computed(() => services.value.filter((service) => service.status === 'up').length);

const statusLabel = (status: ServiceStatus['status']): string => {
  if (status === 'up') return '可用';
  if (status === 'degraded') return '降级';
  return '不可用';
};

const latencyText = (service: ServiceStatus): string => {
  if (service.latencyMs === null) return service.status === 'up' ? '测量中' : '未测量';
  return `${service.latencyMs} ms`;
};

const lineColors: Record<string, string> = {
  auth: '#4D9DE0',
  mongodb: '#77CDBA',
  redis: '#E0B25F',
  irc: '#B58BE0',
  'admin-web': '#8AA6B8',
};

function sparkline(id: string, width = 128, height = 40): string {
  const values = history[id] ?? [];
  if (values.length < 2) return '';
  const max = Math.max(...values, 10);
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - (value / max) * (height - 6) - 3;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

const chartLines = computed(() => {
  const series = SERVICES.filter((service) => service.id !== 'admin-web');
  const maxLength = Math.max(...series.map((service) => history[service.id]?.length ?? 0), 0);
  const maxValue = Math.max(
    ...series.flatMap((service) => history[service.id] ?? []),
    10,
  );
  return series.map((service) => {
    const values = history[service.id] ?? [];
    const points = values
      .map((value, index) => {
        const x = maxLength <= 1 ? 300 : (index / (maxLength - 1)) * 600;
        const y = 168 - (value / maxValue) * 148;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    return { ...service, color: lineColors[service.id] ?? '#8AA6B8', points };
  });
});

const hasChartData = computed(() => chartLines.value.some((line) => line.points.length > 0));

onMounted(() => {
  loadHistory();
  void refresh();
  timer = setInterval(() => void refresh(), POLL_MS);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <main class="status-page">
    <header class="status-head">
      <RouterLink class="brand" to="/status">
        <span class="brand__mark" aria-hidden="true">H</span>
        <span>
          <strong>Hotaru</strong>
          <small>服务状态</small>
        </span>
      </RouterLink>
      <div class="head-actions">
        <span class="public-pill">无需登录</span>
        <button type="button" class="refresh" :disabled="refreshing" @click="refresh">
          {{ refreshing ? '刷新中…' : '立即刷新' }}
        </button>
      </div>
    </header>

    <section class="hero" :class="`hero--${overall}`">
      <div>
        <p class="eyebrow">Overall status</p>
        <h1>{{ overallLabel }}</h1>
        <p class="hero__note">
          每 5 秒自动探测一次。曲线保留当前浏览器最近 {{ SAMPLES }} 次延迟采样。
        </p>
      </div>
      <div class="hero__stats">
        <strong>{{ upCount }}<span>/{{ services.length }}</span></strong>
        <small>服务可用</small>
        <small>{{ lastUpdated ? `更新于 ${lastUpdated.toLocaleTimeString()}` : '正在采样…' }}</small>
      </div>
    </section>

    <p v-if="errorText" class="alert" role="alert">{{ errorText }}</p>

    <section class="service-grid" :class="{ 'service-grid--loading': loading }">
      <article v-for="service in services" :key="service.id" class="service-card" :class="`service-card--${service.status}`">
        <header class="service-card__head">
          <span class="status-dot" aria-hidden="true" />
          <h2>{{ service.name }}</h2>
          <span class="status-label">{{ statusLabel(service.status) }}</span>
        </header>
        <p class="latency">{{ latencyText(service) }}</p>
        <p class="detail">{{ service.detail ?? '依赖检查正常' }}</p>
        <svg class="spark" viewBox="0 0 128 40" preserveAspectRatio="none" aria-hidden="true">
          <polyline
            v-if="sparkline(service.id)"
            :points="sparkline(service.id)"
            fill="none"
            :stroke="lineColors[service.id]"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </article>
    </section>

    <section class="trend-card">
      <header class="trend-card__head">
        <div>
          <p class="eyebrow">Latency trend</p>
          <h2>延迟趋势</h2>
        </div>
        <span class="trend-card__hint">毫秒 · 最近 {{ SAMPLES }} 次采样</span>
      </header>

      <div class="chart-wrap">
        <svg v-if="hasChartData" class="chart" viewBox="0 0 600 180" preserveAspectRatio="none" role="img" aria-label="服务延迟趋势">
          <line v-for="y in [20, 57, 94, 131, 168]" :key="y" x1="0" :y1="y" x2="600" :y2="y" class="grid-line" />
          <polyline
            v-for="line in chartLines"
            :key="line.id"
            :points="line.points"
            fill="none"
            :stroke="line.color"
            stroke-width="2.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <p v-else class="chart-empty">正在等待足够的延迟采样…</p>
      </div>

      <div class="legend">
        <span v-for="line in chartLines" :key="line.id" class="legend__item">
          <i :style="{ background: line.color }" aria-hidden="true" />
          {{ line.name }}
        </span>
      </div>
    </section>

    <footer class="status-foot">
      <span>Hotaru 认证服务 · 数据来自公开健康探测</span>
      <RouterLink to="/login">管理员登录</RouterLink>
    </footer>
  </main>
</template>

<style scoped>
.status-page {
  width: min(1120px, calc(100% - 40px));
  margin: 0 auto;
  padding: 34px 0 44px;
}

.status-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 24px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  color: var(--ink);
  text-decoration: none;
}

.brand__mark {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  color: #fff;
  background: linear-gradient(140deg, var(--primary), var(--secondary));
  font-size: 19px;
  font-weight: 700;
}

.brand span:last-child {
  display: grid;
  gap: 1px;
}

.brand strong { font-size: 16px; }
.brand small { color: var(--muted); font-size: 11.5px; letter-spacing: 0.04em; }

.head-actions {
  display: flex;
  align-items: center;
  gap: 9px;
}

.public-pill {
  padding: 5px 10px;
  border-radius: 999px;
  color: #23624f;
  background: #e8f8f2;
  font-size: 12px;
}

.refresh {
  padding: 8px 13px;
  color: var(--primary-strong);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 9px;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.refresh:hover { border-color: var(--border-strong); }
.refresh:disabled { opacity: 0.55; cursor: wait; }

.hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 28px 30px;
  margin-bottom: 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.hero--up { border-left: 5px solid #58b99d; }
.hero--degraded { border-left: 5px solid #e0b25f; }
.hero--down { border-left: 5px solid #c95a67; }

.eyebrow {
  color: var(--muted);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 5px;
}

.hero h1 {
  font-size: clamp(25px, 3vw, 34px);
  letter-spacing: -0.03em;
}

.hero__note {
  margin-top: 7px;
  color: var(--muted);
  font-size: 13px;
}

.hero__stats {
  display: grid;
  justify-items: end;
  gap: 2px;
  flex: none;
}

.hero__stats strong {
  font-size: 30px;
  letter-spacing: -0.03em;
}

.hero__stats strong span {
  color: var(--muted);
  font-size: 18px;
  font-weight: 500;
}

.hero__stats small {
  color: var(--muted);
  font-size: 11.5px;
}

.alert {
  margin: 0 0 16px;
  padding: 10px 12px;
  border-radius: 10px;
  color: var(--danger);
  background: var(--danger-soft);
  border: 1px solid #f3d3d9;
  font-size: 13px;
}

.service-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}

.service-card {
  display: grid;
  gap: 5px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 13px;
  background: var(--surface);
  box-shadow: 0 5px 16px rgba(55, 109, 148, 0.05);
}

.service-card--up { border-top: 3px solid #58b99d; }
.service-card--degraded { border-top: 3px solid #e0b25f; }
.service-card--down { border-top: 3px solid #c95a67; }

.service-card__head {
  display: flex;
  align-items: center;
  gap: 7px;
}

.service-card__head h2 {
  font-size: 13.5px;
  flex: 1;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #58b99d;
  box-shadow: 0 0 0 3px rgba(88, 185, 157, 0.13);
}

.service-card--degraded .status-dot { background: #e0b25f; box-shadow: 0 0 0 3px rgba(224, 178, 95, 0.14); }
.service-card--down .status-dot { background: #c95a67; box-shadow: 0 0 0 3px rgba(201, 90, 103, 0.13); }

.status-label {
  color: var(--muted);
  font-size: 11px;
}

.latency {
  font-size: 21px;
  font-weight: 650;
  letter-spacing: -0.02em;
}

.detail {
  min-height: 16px;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.spark {
  width: 100%;
  height: 40px;
  margin-top: 5px;
  overflow: visible;
}

.trend-card {
  padding: 20px 22px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.trend-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.trend-card__head h2 { font-size: 16px; }
.trend-card__hint { color: var(--muted); font-size: 11.5px; }

.chart-wrap {
  margin-top: 12px;
  height: 190px;
  border-radius: 10px;
  background: linear-gradient(180deg, #fbfdff, #f5fbff);
  overflow: hidden;
}

.chart {
  display: block;
  width: 100%;
  height: 190px;
}

.grid-line {
  stroke: #e7f1f7;
  stroke-width: 1;
}

.chart-empty {
  display: grid;
  place-items: center;
  height: 100%;
  color: var(--muted);
  font-size: 12px;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 10px;
  color: var(--muted);
  font-size: 11.5px;
}

.legend__item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.legend__item i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-foot {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-top: 22px;
  color: var(--muted);
  font-size: 11.5px;
}

.status-foot a {
  color: var(--primary-strong);
  text-decoration: none;
}

.status-foot a:hover { text-decoration: underline; }

@media (max-width: 680px) {
  .status-page { width: min(100% - 24px, 1120px); padding-top: 20px; }
  .status-head { align-items: flex-start; }
  .public-pill { display: none; }
  .hero { align-items: flex-start; padding: 22px; }
  .hero__stats { justify-items: end; }
  .trend-card__hint { display: none; }
}
</style>
