import type { StickyColor } from '@shared/types/todo'

/**
 * 便签纸色。
 *
 * - 这是**内容色**，不是品牌色：不套 `var(--el-color-primary)`，与 Element Plus 的语义色也无关。
 *   它服务的是"一眼分出几张便签"，不是"表现出这是本产品的 UI"。
 * - **必须与设置页 `/todo` 的便签区、桌面便签窗口同一份**。放 `common/` 就是为此 ——
 *   三处会同时显示同一批便签，配色漂移会比"少一个功能"更早被看出来（理由同 `common/todo-date.ts`）。
 * - 三个色分别服务三种用法：`bg` / `border` 是**纸面**（要大、要淡，别抢正文），
 *   `dot` 是**取色圆点**（要小、要饱和，否则五个点在一张淡纸上根本分不出谁是谁）。
 */
export const NOTE_SKIN: Record<
  StickyColor,
  { bg: string; border: string; dot: string; label: string }
> = {
  yellow: { bg: '#fffbe6', border: '#ffe58f', dot: '#ffd666', label: '黄' },
  green: { bg: '#f0f9eb', border: '#c2e7b0', dot: '#95d475', label: '绿' },
  blue: { bg: '#eef6ff', border: '#bcdcff', dot: '#74b5ff', label: '蓝' },
  pink: { bg: '#fff0f6', border: '#ffc2dd', dot: '#ffa8cd', label: '粉' },
  purple: { bg: '#f6f0ff', border: '#d9c7ff', dot: '#b79bff', label: '紫' }
}
