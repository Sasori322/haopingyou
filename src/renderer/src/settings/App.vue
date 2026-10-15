<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const version = ref('')

const NAV = [
  { path: '/general', label: '通用' },
  { path: '/pet', label: '宠物' },
  { path: '/pomodoro', label: '专注与提醒' },
  { path: '/todo', label: '待办与便签' },
  { path: '/clipboard', label: '剪贴板历史' },
  { path: '/monitor', label: '系统监控' }
]

const activePath = computed(() => route.path)

onMounted(async () => {
  version.value = await window.petAPI.app.getVersion()
})
</script>

<template>
  <div class="app-shell">
    <aside class="app-aside">
      <div class="app-brand">
        <div class="app-brand__logo">好</div>
        <div>
          <div class="app-brand__title">好屏友</div>
          <div class="app-brand__sub">桌面宠物 v{{ version }}</div>
        </div>
      </div>
      <el-menu class="app-nav" :default-active="activePath" router>
        <el-menu-item v-for="item in NAV" :key="item.path" :index="item.path">
          {{ item.label }}
        </el-menu-item>
      </el-menu>
    </aside>
    <main class="app-main">
      <router-view />
    </main>
  </div>
</template>
