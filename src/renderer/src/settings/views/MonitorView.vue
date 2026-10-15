<script setup lang="ts">
import { useSettings } from '../composables/useSettings'

const { settings, patch } = useSettings()

type SwitchValue = string | number | boolean

function toggle(key: 'enabled' | 'showTopProcess', value: SwitchValue): void {
  void patch({ monitor: { [key]: Boolean(value) } } as never)
}
</script>

<template>
  <h2 class="page-title">系统监控</h2>
  <p class="page-desc">
    宠物会随电脑的运行状态变化：忙碌时显得吃力，大流量下载时小跑起来。（即将推出）
  </p>

  <el-card class="section-card" shadow="never">
    <div class="setting-row">
      <div>
        <div class="setting-row__label">启用系统监控</div>
        <div class="setting-row__hint">关闭后宠物不再随电脑状态变化</div>
      </div>
      <el-switch
        :model-value="settings?.monitor.enabled ?? false"
        @update:model-value="(v: SwitchValue) => toggle('enabled', v)"
      />
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-row__label">显示占用最高的进程</div>
        <div class="setting-row__hint">涉及进程信息，默认关闭</div>
      </div>
      <el-switch
        :model-value="settings?.monitor.showTopProcess ?? false"
        :disabled="!(settings?.monitor.enabled ?? false)"
        @update:model-value="(v: SwitchValue) => toggle('showTopProcess', v)"
      />
    </div>
  </el-card>
</template>
