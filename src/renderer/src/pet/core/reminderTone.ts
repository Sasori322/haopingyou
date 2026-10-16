import { isReminderKind } from '@shared/constants'
import type { ReminderKind } from '@shared/types/reminder'

/**
 * 提醒气泡的视觉身份：**一种提醒 = 一个颜色 + 一个图标**。
 *
 * ## 为什么提醒必须长得跟闲聊不一样
 * 2026-10-16 反馈：喝水 / 久坐提醒"看起来就是小猫随便说了句话"，不会引起注意。
 * 根因是三类气泡**共用同一套样式** —— 白底、无图标、3.2 秒消失，
 * 和「在的在的」在屏幕上没有任何区别，用户余光扫到也没理由回头。
 *
 * 所以这里给每种提醒一套专属标识。**颜色是主线索**（余光里认色比认字快），
 * 图标是第二线索（正面看时能立刻分清是哪件事）。
 *
 * ## 为什么不用 emoji
 * emoji 的字形、色彩、基线都跟着系统字体与 Windows 版本走，同一段文案在两台机器上
 * 可能一个彩色一个黑白，还会顶乱行高。这里用内联 SVG，**形状和颜色都由我们说了算**。
 *
 * ## 色值为什么硬编码
 * 宠物窗口刻意不引 Element Plus（见项目约定），气泡本来就跑在自己的白卡片上，
 * 不存在"跟随应用主题色"的诉求；反过来这里**必须**是四种可互相区分的语义色，
 * 套 `--el-color-primary` 反而会让四种提醒糊成一种。
 */
export interface ReminderTone {
  kind: ReminderKind
  /** 主色：图标填充、卡片描边、外发光 */
  accent: string
  /** 卡片底色：主色的极淡版，保证深色文字仍然清晰 */
  tint: string
  /** 外发光（带 alpha 的主色），用于卡片投影 */
  glow: string
  /** 24×24 viewBox 的图标路径，纯 fill，可多段 */
  paths: string[]
  /** 图标的无障碍描述（`aria-hidden` 时用不到，留给后续可访问性改造） */
  label: string
}

const TONES: Record<ReminderKind, ReminderTone> = {
  water: {
    kind: 'water',
    accent: '#2b86f0',
    tint: '#ebf4ff',
    glow: 'rgba(43, 134, 240, 0.30)',
    paths: [
      'M12 2.7a1 1 0 0 0-.79.39C10.42 4.1 5.4 10.35 5.4 14.4a6.6 6.6 0 0 0 13.2 0c0-4.05-5.02-10.3-5.81-11.31A1 1 0 0 0 12 2.7Z'
    ],
    label: '喝水提醒'
  },
  sedentary: {
    kind: 'sedentary',
    accent: '#ef8a1e',
    tint: '#fff5e8',
    glow: 'rgba(239, 138, 30, 0.30)',
    // 走动的小人：比"闹钟/沙发"更能直接表达"起身动一动"
    paths: [
      'M13.5 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
      'M9.8 8.9 7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3c1.3 1.5 3.3 2.5 5.5 2.5v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1L6 8.3V13h2V9.6l1.8-.7Z'
    ],
    label: '久坐提醒'
  },
  pomodoro: {
    kind: 'pomodoro',
    accent: '#e5484d',
    tint: '#ffefef',
    glow: 'rgba(229, 72, 77, 0.30)',
    paths: [
      'M12 4.4a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2Zm0 13.1a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11Z',
      'M11.25 7.9h1.5v4.6l3.3 1.95-.75 1.3-4.05-2.4Z'
    ],
    label: '番茄钟提醒'
  },
  todo: {
    kind: 'todo',
    accent: '#7c56f0',
    tint: '#f3eeff',
    glow: 'rgba(124, 86, 240, 0.30)',
    paths: [
      'M6.2 3.5h11.6a2.7 2.7 0 0 1 2.7 2.7v11.6a2.7 2.7 0 0 1-2.7 2.7H6.2a2.7 2.7 0 0 1-2.7-2.7V6.2a2.7 2.7 0 0 1 2.7-2.7Zm0 1.9a.8.8 0 0 0-.8.8v11.6c0 .44.36.8.8.8h11.6a.8.8 0 0 0 .8-.8V6.2a.8.8 0 0 0-.8-.8H6.2Z',
      'M10.85 15.6 7.6 12.35l1.35-1.35 1.9 1.9 4.2-4.2 1.35 1.35-5.55 5.55Z'
    ],
    label: '待办提醒'
  }
}

/**
 * 按气泡的 `reason` 取提醒配色。**非提醒类返回 `null`**，
 * 调用方据此决定走普通气泡还是提醒卡片（含宠物动作）。
 */
export function reminderToneOf(reason: string | undefined): ReminderTone | null {
  return isReminderKind(reason) ? TONES[reason] : null
}
