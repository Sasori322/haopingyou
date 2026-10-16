<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { PET_SCALE_DEFAULT, PET_SCALE_MAX, PET_SCALE_MIN } from '@shared/constants'
import { useSettings } from '../composables/useSettings'

const { settings, patch } = useSettings()
const autostartBusy = ref(false)

const petVisible = computed({
  get: () => settings.value?.petVisible ?? true,
  set: (value: boolean) => void patch({ petVisible: value })
})

const alwaysOnTop = computed({
  get: () => settings.value?.alwaysOnTop ?? true,
  set: (value: boolean) => void patch({ alwaysOnTop: value })
})

const reactToLoad = computed({
  get: () => settings.value?.reactToLoad ?? true,
  set: (value: boolean) => void patch({ reactToLoad: value })
})

const petScale = computed({
  // 兜底用 PET_SCALE_DEFAULT（不是 1）：设置还没读回来时，滑块应停在"新装默认值"上
  get: () => settings.value?.petScale ?? PET_SCALE_DEFAULT,
  set: (value: number) => void patch({ petScale: value })
})

const autostart = computed({
  get: () => settings.value?.autostart ?? false,
  set: (value: boolean) => void toggleAutostart(value)
})

async function toggleAutostart(value: boolean): Promise<void> {
  autostartBusy.value = true
  try {
    const actual = await window.petAPI.app.setAutostart(value)
    if (actual !== value) {
      ElMessage.warning('开机自启需要安装版才能生效')
    } else {
      ElMessage.success(value ? '已开启开机自启' : '已关闭开机自启')
    }
  } finally {
    autostartBusy.value = false
  }
}

async function confirmQuit(): Promise<void> {
  try {
    await ElMessageBox.confirm('退出后宠物会从桌面消失，托盘图标也会一并移除。', '确认退出好屏友？', {
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      type: 'warning'
    })
    window.petAPI.app.quit()
  } catch {
    // 用户取消
  }
}
</script>

<template>
  <h2 class="page-title">通用</h2>
  <p class="page-desc">改变这里的开关会立即作用于桌面上的宠物。</p>

  <el-card class="section-card" shadow="never">
    <div class="setting-row">
      <div>
        <div class="setting-row__label">在桌面显示宠物</div>
        <div class="setting-row__hint">关闭后宠物隐藏，但仍可从托盘重新唤出</div>
      </div>
      <el-switch v-model="petVisible" />
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-row__label">始终置顶</div>
        <div class="setting-row__hint">退出全屏程序后会自动重新置顶</div>
      </div>
      <el-switch v-model="alwaysOnTop" />
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-row__label">宠物大小</div>
        <div class="setting-row__hint">当前 {{ Math.round(petScale * 100) }}%</div>
      </div>
      <el-slider
        v-model="petScale"
        :min="PET_SCALE_MIN"
        :max="PET_SCALE_MAX"
        :step="0.05"
        style="width: 220px"
      />
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-row__label">跟随系统负载</div>
        <div class="setting-row__hint">系统繁忙时宠物会表现出吃力的样子（即将推出）</div>
      </div>
      <el-switch v-model="reactToLoad" />
    </div>
  </el-card>

  <el-card class="section-card" shadow="never">
    <div class="setting-row">
      <div>
        <div class="setting-row__label">开机自启</div>
        <div class="setting-row__hint">开机后静默启动，3 秒后宠物才现身，避免打扰</div>
      </div>
      <el-switch v-model="autostart" :loading="autostartBusy" />
    </div>
  </el-card>

  <el-card shadow="never">
    <div class="setting-row">
      <div>
        <div class="setting-row__label">退出好屏友</div>
        <div class="setting-row__hint">同时移除托盘图标</div>
      </div>
      <el-button type="danger" plain @click="confirmQuit">退出</el-button>
    </div>
  </el-card>
</template>
