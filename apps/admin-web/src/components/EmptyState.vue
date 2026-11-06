<script setup lang="ts">
defineProps<{
  title: string;
  description?: string;
}>();
</script>

<template>
  <div class="empty">
    <span class="empty__art" aria-hidden="true">
      <svg viewBox="0 0 64 48" width="88" height="66" fill="none">
        <ellipse cx="32" cy="40" rx="22" ry="5" fill="#E4F1FA" />
        <rect x="12" y="14" width="40" height="22" rx="7" fill="#F2F9FF" stroke="#D3E8F6" stroke-width="1.6" />
        <path d="M20 22h12M20 28h20" stroke="#B7D7EC" stroke-width="2" stroke-linecap="round" />
        <circle cx="46" cy="12" r="4" fill="#D9EEFF" />
      </svg>
    </span>
    <p class="empty__title">{{ title }}</p>
    <p v-if="description" class="empty__desc">{{ description }}</p>
    <slot />
  </div>
</template>

<style scoped>
.empty {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 40px 20px;
  text-align: center;
}

.empty__title {
  font-weight: 600;
}

.empty__desc {
  color: var(--muted);
  font-size: 13.5px;
  max-width: 42ch;
}
</style>
