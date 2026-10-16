<script setup lang="ts">
import { computed } from 'vue'
import type { ReminderTone } from '../core/reminderTone'

const props = defineProps<{
  text: string
  leaving?: boolean
  /**
   * 提醒配色与该提醒的图标；普通台词传 `null` / 不传。
   * 决定了这张气泡是"白卡片闲聊"还是"彩色提醒卡"。
   */
  tone?: ReminderTone | null
}>()

/**
 * 主色 / 底色 / 外发光走 CSS 自定义属性而不是给每档写一套类名：
 * 四档提醒的**结构完全相同**，只有三个颜色不同，类名方案会出现四份重复规则。
 */
const toneVars = computed(() =>
  props.tone
    ? {
        '--bubble-accent': props.tone.accent,
        '--bubble-tint': props.tone.tint,
        '--bubble-glow': props.tone.glow
      }
    : undefined
)
</script>

<template>
  <div
    class="bubble"
    :class="{ 'bubble--reminder': !!tone }"
    :data-leaving="leaving ? 'true' : 'false'"
    :style="toneVars"
  >
    <svg v-if="tone" class="bubble__icon" viewBox="0 0 24 24" aria-hidden="true">
      <path v-for="(d, i) in tone.paths" :key="i" :d="d" />
    </svg>
    <span class="bubble__text">{{ text }}</span>
  </div>
</template>
