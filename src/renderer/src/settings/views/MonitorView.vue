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
    指标由主进程用 systeminformation 采集（CPU 1 秒、内存 2 秒、网速 1 秒），采集结果做指数平滑并加滞回判定，
    避免瞬时尖峰让宠物疯狂抖动。没有任何窗口订阅时会自动停止采集。
  </p>

  <el-card class="section-card" shadow="never">
    <div class="setting-row">
      <div>
        <div class="setting-row__label">启用系统监控</div>
        <div class="setting-row__hint">关闭后宠物不再随系统负载变化，主进程停止轮询</div>
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

  <el-card shadow="never">
    <div class="placeholder-note">
      负载映射关系（计划）：CPU 与内存按 6:4 加权后做指数平滑，负载超过 78 进入「吃力」状态、
      低于 60 退出，中间区间保持现状；任何由负载引起的切换至少停留 5 秒。
      网络持续大于 2MB/s 时宠物会小跑起来。
    </div>
  </el-card>
</template>
