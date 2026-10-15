<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { ReminderStatus } from '@shared/types/reminder'
import { useSettings } from '../composables/useSettings'

const { settings, patch } = useSettings()

function numberField<T extends keyof NonNullable<typeof settings.value>>(group: T, key: string) {
  return computed({
    get: () => {
      const g = settings.value?.[group] as Record<string, unknown> | undefined
      return (g?.[key] as number) ?? 0
    },
    set: (value: number) => {
      const g = settings.value?.[group] as Record<string, unknown> | undefined
      if (!g) return
      void patch({ [group]: { [key]: value } } as never)
    }
  })
}

function boolField<T extends keyof NonNullable<typeof settings.value>>(group: T, key: string) {
  return computed({
    get: () => {
      const g = settings.value?.[group] as Record<string, unknown> | undefined
      return Boolean(g?.[key])
    },
    set: (value: boolean) => {
      const g = settings.value?.[group] as Record<string, unknown> | undefined
      if (!g) return
      void patch({ [group]: { [key]: value } } as never)
    }
  })
}

const focusMin = numberField('pomodoro', 'focusMin')
const shortBreakMin = numberField('pomodoro', 'shortBreakMin')
const longBreakMin = numberField('pomodoro', 'longBreakMin')
const longBreakEvery = numberField('pomodoro', 'longBreakEvery')
const autoNext = boolField('pomodoro', 'autoNext')

const sedentaryEnabled = boolField('sedentary', 'enabled')
const remindMinutes = numberField('sedentary', 'remindMinutes')
const idleMinutes = numberField('sedentary', 'idleMinutes')

const waterEnabled = boolField('water', 'enabled')
const waterInterval = numberField('water', 'intervalMin')

// ---------------- 运行状态 ----------------
//
// 提醒这种东西"配好了"和"真的会响"是两回事，而最短的验证周期也有 5 分钟，
// 所以必须把主进程里的实时状态摊出来 —— 否则用户只能靠等。

const status = ref<ReminderStatus | null>(null)
let statusTimer: number | null = null

const waterIntervalMin = computed(
  () => settings.value?.water.intervalMin ?? DEFAULT_SETTINGS.water.intervalMin
)

async function refreshStatus(): Promise<void> {
  status.value = await window.petAPI.app.getReminderStatus()
}

async function setDnd(minutes: number | null): Promise<void> {
  status.value = await window.petAPI.app.setDnd(minutes)
}

function formatClock(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatSpan(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`
}

/** 阈值类时长优先显示分钟。用 formatSpan 会把"3 分钟"渲染成"3 分 0 秒"、把 45 秒渲染成"0.75 分钟" */
function formatThreshold(sec: number): string {
  return sec >= 60 ? `${Math.round(sec / 60)} 分钟` : `${sec} 秒`
}

const sedentaryStatusText = computed(() => {
  if (!sedentaryEnabled.value) return '已关闭，不再统计久坐时长'
  const current = status.value
  if (!current) return '读取中…'
  const item = current.sedentary
  if (!item.present) {
    // 这条要讲清楚：久坐时长统计的是"连续活跃"，不是墙上时间，离开会自动中断
    return `已判定你离开座位（空闲 ${formatSpan(item.idleSec * 1000)}）· 空闲超过 ${formatThreshold(item.awaySec)} 就暂停累计`
  }
  if (item.activeMs === 0) return '人在电脑前，开始累计'
  return `已连续活跃 ${formatSpan(item.activeMs)} / 目标 ${formatSpan(item.remindMs)}`
})

const waterStatusText = computed(() => {
  if (!waterEnabled.value) return '已关闭'
  const current = status.value
  if (!current) return '读取中…'
  const item = current.water
  if (item.nextAt === 0) return '正在排程…'
  // 人不在时不会响也不会推进，回来后立刻提醒一次 —— 这是刻意的，要说清楚
  return `下次提醒 ${formatClock(item.nextAt)}（每 ${waterIntervalMin.value} 分钟）· 你不在时会顺延到回来`
})

const dndText = computed(() => {
  const current = status.value
  if (!current) return '读取中…'
  if (current.dnd) return `免打扰中，${formatClock(current.dndUntil)} 自动恢复`
  return '未开启。免打扰只停提醒，宠物照常留在桌面上'
})

const lastText = computed(() => {
  const last = status.value?.last
  if (!last) return '本次运行还没有提醒过'
  return `${formatClock(last.at)} · ${last.body}`
})

onMounted(() => {
  void refreshStatus()
  statusTimer = window.setInterval(() => void refreshStatus(), 3000)
})

onBeforeUnmount(() => {
  if (statusTimer !== null) {
    window.clearInterval(statusTimer)
    statusTimer = null
  }
})
</script>

<template>
  <h2 class="page-title">专注与提醒</h2>
  <p class="page-desc">
    计时器由主进程持有唯一真源（保存绝对结束时间戳），因此关闭设置窗口、甚至合盖休眠都不会影响计时准确性。
    到点时系统通知、托盘提示、宠物动画三路并行提醒——「专注/勿扰模式」会抑制系统通知，所以不能只依赖它。
  </p>

  <el-card class="section-card" shadow="never" header="番茄钟">
    <div class="setting-row">
      <div class="setting-row__label">专注时长</div>
      <el-input-number v-model="focusMin" :min="1" :max="180" :step="5" /> 
      <span class="unit">分钟</span>
    </div>
    <div class="setting-row">
      <div class="setting-row__label">短休息</div>
      <el-input-number v-model="shortBreakMin" :min="1" :max="60" :step="1" />
      <span class="unit">分钟</span>
    </div>
    <div class="setting-row">
      <div class="setting-row__label">长休息</div>
      <el-input-number v-model="longBreakMin" :min="1" :max="120" :step="5" />
      <span class="unit">分钟</span>
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-row__label">长休息间隔</div>
        <div class="setting-row__hint">每完成几个番茄后进入长休息</div>
      </div>
      <el-input-number v-model="longBreakEvery" :min="1" :max="12" :step="1" />
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-row__label">自动进入下一阶段</div>
        <div class="setting-row__hint">专注结束自动开始休息，休息结束自动开始专注</div>
      </div>
      <el-switch v-model="autoNext" />
    </div>
  </el-card>

  <el-card class="section-card" shadow="never" header="久坐提醒">
    <div class="setting-row">
      <div class="setting-row__label">启用久坐提醒</div>
      <el-switch v-model="sedentaryEnabled" />
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-row__label">连续活跃多久后提醒</div>
        <div class="setting-row__hint">只统计真正在用的时间：空闲超过 {{ idleMinutes }} 分钟会暂停累计</div>
      </div>
      <el-input-number v-model="remindMinutes" :min="5" :max="240" :step="5" :disabled="!sedentaryEnabled" />
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-row__label">空闲判定阈值</div>
        <div class="setting-row__hint">离开座位后不再累计久坐时长</div>
      </div>
      <el-input-number v-model="idleMinutes" :min="1" :max="30" :step="1" :disabled="!sedentaryEnabled" />
    </div>
  </el-card>

  <el-card class="section-card" shadow="never" header="喝水提醒">
    <div class="setting-row">
      <div class="setting-row__label">启用喝水提醒</div>
      <el-switch v-model="waterEnabled" />
    </div>
    <div class="setting-row">
      <div class="setting-row__label">提醒间隔</div>
      <el-input-number v-model="waterInterval" :min="5" :max="240" :step="5" :disabled="!waterEnabled" />
    </div>
  </el-card>

  <el-card class="section-card" shadow="never" header="运行状态">
    <div class="setting-row">
      <div>
        <div class="setting-row__label">久坐计时</div>
        <div class="setting-row__hint">{{ sedentaryStatusText }}</div>
      </div>
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-row__label">喝水提醒</div>
        <div class="setting-row__hint">{{ waterStatusText }}</div>
      </div>
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-row__label">免打扰</div>
        <div class="setting-row__hint">{{ dndText }}</div>
      </div>
      <el-button v-if="status?.dnd" text type="primary" @click="setDnd(null)">
        现在恢复提醒
      </el-button>
      <el-button v-else text type="primary" @click="setDnd(60)">免打扰 1 小时</el-button>
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-row__label">最近一次提醒</div>
        <div class="setting-row__hint">{{ lastText }}</div>
      </div>
    </div>
  </el-card>
</template>

<style scoped>
.unit {
  font-size: 12.5px;
  color: #909399;
}
</style>
