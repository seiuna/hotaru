<script setup lang="ts">
import { NButton } from 'naive-ui';
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <div class="not-found">
    <svg viewBox="0 0 80 60" width="120" height="90" fill="none" aria-hidden="true">
      <ellipse cx="40" cy="52" rx="26" ry="5" fill="#E4F1FA" />
      <rect x="16" y="16" width="48" height="28" rx="9" fill="#F2F9FF" stroke="#D3E8F6" stroke-width="1.8" />
      <path d="M30 30h20" stroke="#B7D7EC" stroke-width="2.4" stroke-linecap="round" />
      <circle cx="60" cy="14" r="5" fill="#D9EEFF" />
    </svg>
    <h1>页面不存在</h1>
    <p class="muted">链接可能已经失效，或者你输入的地址有误。</p>
    <NButton type="primary" @click="router.push('/')">回到概览</NButton>
  </div>
</template>

<style scoped>
.not-found {
  min-height: 100vh;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 10px;
  text-align: center;
  padding: 24px;
}

.not-found h1 {
  font-size: 22px;
  letter-spacing: -0.01em;
}
</style>
