/** ===== 路由：按角色分流 + 登录守卫 ===== */
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { getToken, getStoredUser } from './api';
import type { Role } from './types';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/login' },
  { path: '/login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  { path: '/auditor', component: () => import('./views/AuditorView.vue'), meta: { roles: ['auditor'] } },
  // ★ 主入口：按《新版 GMP 检查指导原则》十四章分层（章节为主线，P 过程为括号备注）
  { path: '/auditor/project/:id', component: () => import('./views/ChapterView.vue'), meta: { roles: ['auditor', 'leader', 'admin'] } },
  // 备用入口：按 P 过程排班视图（组长看分工与排期时用）
  { path: '/auditor/project/:id/process', component: () => import('./views/ProcessSlotView.vue'), meta: { roles: ['auditor', 'leader', 'admin'] } },
  // 备用入口：纯条款反选视图（不按章节分组时使用）
  { path: '/auditor/project/:id/clauses', component: () => import('./views/AuditorProjectView.vue'), meta: { roles: ['auditor'] } },
  { path: '/leader', component: () => import('./views/LeaderView.vue'), meta: { roles: ['leader', 'admin'] } },
  { path: '/leader/project/:id', component: () => import('./views/LeaderProjectView.vue'), meta: { roles: ['leader', 'admin'] } },
  { path: '/leader/project/:id/report', component: () => import('./views/ReportView.vue'), meta: { roles: ['leader', 'admin', 'auditor'] } },
  { path: '/admin', component: () => import('./views/AdminView.vue'), meta: { roles: ['admin'] } },
  // 可选：独立报告分享页 /report/:id
  { path: '/report/:id', component: () => import('./views/ReportView.vue'), meta: { roles: ['leader', 'admin', 'auditor'] } },
  { path: '/:pathMatch(.*)*', redirect: '/login' },
];

export const router = createRouter({
  history: createWebHashHistory(), // hash 模式：静态部署到 Nginx 免配置 rewrite
  routes,
});

router.beforeEach((to) => {
  const token = getToken();
  const user = getStoredUser();

  if (to.meta.public) return true;
  if (!token || !user) return '/login';

  const roles = to.meta.roles as Role[] | undefined;
  if (roles && !roles.includes(user.role)) {
    // 角色不匹配 -> 回到各自首页
    return user.role === 'auditor' ? '/auditor' : user.role === 'leader' ? '/leader' : '/admin';
  }
  return true;
});
