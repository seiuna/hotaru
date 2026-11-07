import { createRouter, createWebHistory } from 'vue-router';
import { authState } from './stores/auth';
import { isTokenExpired } from './utils/jwt';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('./views/LoginView.vue'),
      meta: { public: true, title: '登录' },
    },
    {
      path: '/',
      name: 'dashboard',
      component: () => import('./views/DashboardView.vue'),
      meta: { title: '概览' },
    },
    {
      path: '/users',
      name: 'users',
      component: () => import('./views/UsersView.vue'),
      meta: { title: '用户' },
    },
    {
      path: '/users/:id',
      name: 'user-detail',
      component: () => import('./views/UserDetailView.vue'),
      meta: { title: '用户详情' },
    },
    {
      path: '/audit',
      name: 'audit',
      component: () => import('./views/AuditView.vue'),
      meta: { title: '审计日志' },
    },
    {
      path: '/activation-codes',
      name: 'activation-codes',
      component: () => import('./views/ActivationCodesView.vue'),
      meta: { title: '激活码' },
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('./views/NotFoundView.vue'),
      meta: { public: true, title: '未找到' },
    },
  ],
});

router.beforeEach((to) => {
  document.title = to.meta.title ? `${String(to.meta.title)} · Hotaru 控制台` : 'Hotaru 控制台';

  const needsAuth = to.meta.public !== true;
  if (!needsAuth) return true;

  const expired = authState.session ? isTokenExpired(authState.session.token) : true;
  if (!authState.session || expired) {
    return { name: 'login', query: to.fullPath !== '/' ? { next: to.fullPath } : {} };
  }
  return true;
});

router.afterEach(() => {
  window.scrollTo({ top: 0, behavior: 'auto' });
});
