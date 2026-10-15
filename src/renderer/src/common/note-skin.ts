import type { StickyColor } from '@shared/types/todo'

/**
 * 便签纸色。
 *
 * - 这是**内容色**，不是品牌色：不套 `var(--el-color-primary)`，与 Element Plus 的语义色也无关。
 *   它服务的是"一眼分出几张便签"，不是"表现出这是本产品的 UI"。
 * - **必须与设置页 `/todo` 的便签区同一份**。放 `common/` 就是为此 —— 面板和设置页会同时
 *   显示同一批便签，配色漂移会比"少一个功能"更早被看出来（理由同 `common/todo-date.ts`）。
 */
export const NOTE_SKIN: Record<StickyColor, { bg: string; border: string; label: string }> = {
  yellow: { bg: '#fffbe6', border: '#ffe58f', label: '黄' },
  green: { bg: '#f0f9eb', border: '#c2e7b0', label: '绿' },
  blue: { bg: '#eef6ff', border: '#bcdcff', label: '蓝' },
  pink: { bg: '#fff0f6', border: '#ffc2dd', label: '粉' },
  purple: { bg: '#f6f0ff', border: '#d9c7ff', label: '紫' }
}
