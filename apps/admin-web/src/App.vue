<script setup lang="ts">
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppShell from './components/AppShell.vue';
import { cozyThemeOverrides } from './theme';

const route = useRoute();
const isPublic = computed(() => route.meta.public === true);
</script>

<template>
  <NConfigProvider :theme-overrides="cozyThemeOverrides">
    <NMessageProvider :max="3">
      <NDialogProvider>
        <RouterView v-if="isPublic" />
        <AppShell v-else>
          <RouterView />
        </AppShell>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
