import { createRouter, createWebHashHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/general' },
  {
    path: '/general',
    name: 'general',
    component: () => import('../views/GeneralView.vue'),
    meta: { title: '通用' }
  },
  {
    path: '/pet',
    name: 'pet',
    component: () => import('../views/PetView.vue'),
    meta: { title: '宠物' }
  },
  {
    path: '/pomodoro',
    name: 'pomodoro',
    component: () => import('../views/PomodoroView.vue'),
    meta: { title: '专注与提醒' }
  },
  {
    path: '/todo',
    name: 'todo',
    component: () => import('../views/TodoView.vue'),
    meta: { title: '待办与便签' }
  },
  {
    path: '/clipboard',
    name: 'clipboard',
    component: () => import('../views/ClipboardView.vue'),
    meta: { title: '剪贴板历史' }
  },
  {
    path: '/monitor',
    name: 'monitor',
    component: () => import('../views/MonitorView.vue'),
    meta: { title: '系统监控' }
  }
]

/** file:// 协议下必须使用 hash 模式 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes
})
