<script setup lang="ts">
defineProps<{
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'sky' | 'mint' | 'amber';
}>();
</script>

<template>
  <article class="stat cozy-card cozy-card--interactive" :class="`stat--${tone ?? 'sky'}`">
    <span class="stat__tile" aria-hidden="true">
      <slot name="icon">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 19h16" />
          <path d="M7 19V9m5 10V5m5 14v-7" />
        </svg>
      </slot>
    </span>
    <div class="stat__body">
      <p class="stat__label">{{ label }}</p>
      <p class="stat__value">{{ value }}</p>
      <p v-if="hint" class="stat__hint">{{ hint }}</p>
    </div>
  </article>
</template>

<style scoped>
.stat {
  display: flex;
  gap: 14px;
  padding: 18px 20px;
}

.stat__tile {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  flex: none;
}

.stat--sky .stat__tile {
  color: var(--primary-strong);
  background: var(--primary-soft);
}

.stat--mint .stat__tile {
  color: #1f7a63;
  background: var(--secondary-soft);
}

.stat--amber .stat__tile {
  color: var(--warning);
  background: var(--warning-soft);
}

.stat__body {
  min-width: 0;
}

.stat__label {
  color: var(--muted);
  font-size: 12.5px;
  letter-spacing: 0.02em;
}

.stat__value {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
}

.stat__hint {
  color: var(--muted);
  font-size: 12px;
  margin-top: 2px;
}
</style>
