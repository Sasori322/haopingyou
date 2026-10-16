/**
 * 全局快捷键的注册与校验工具（按**槽位**分账）。
 *
 * 项目里有三个全局快捷键：`clipboard`（唤起剪贴板历史面板）、`todo`（唤起待办面板）
 * 与 `note`（新建一张桌面便签）。它们的规则完全一样，只有"按下去要做什么"不同，
 * 所以收口在这里、用槽位区分；调用方（初始化 / IPC / 设置变更）只管传槽位，
 * 不碰 `globalShortcut` 本身。
 *
 * 设计要点：
 * ① 快捷键字符串走 Electron Accelerator 格式（`Ctrl+Shift+V` 等）。
 * ② **「是否被占用」只能注册一下才知道** —— `register` 在 invalid / occupied 时都返回 false，
 *    无法单点区分。这里先 format 校验、再用 register-noop + 立即 unregister 试探占用。
 * ③ 空字符串 = 禁用该快捷键（用户能继续走托盘菜单入口）。
 * ④ 真正的注册（带回调）走 `setHotkey`；这个模块只负责"hotkey 字符串"层面，不绑定到操作层。
 * ⑤ **槽位之间互不影响**：录制便签快捷键时，剪贴板与待办那两把必须照常可用，
 *    所以"挂起 / 恢复"这套状态必须每个槽位各存一份，不能共用一组模块级变量。
 */
import { globalShortcut } from 'electron'
import { createLogger } from '../utils/logger'

const log = createLogger('hotkey')

/**
 * 快捷键槽位：key 与设置里的位置一一对应
 * （`settings.clipboard.hotkey` / `settings.todo.hotkey` / `settings.todo.noteHotkey`）
 */
export type HotkeySlot = 'clipboard' | 'todo' | 'note'

/** 仅用于日志与报错文案，别拿它做逻辑判断 */
const SLOT_LABEL: Record<HotkeySlot, string> = {
  clipboard: '剪贴板面板',
  todo: '待办面板',
  note: '桌面便签'
}

/**
 * 修饰键白名单。Electron 接受的写法见 `electron.d.ts::accelerator`，
 * 这里把几个别名也兼容进去（Ctrl / Control / Cmd / Command / CmdOrCtrl / CommandOrControl）。
 *
 * 注意：这里**只写模式串**，不是 RegExp 实例，因此没有 `^/$` 锚点、没有 `(?:` 外壳——
 * 调用方需要自己包装。`.source` 那条路线实测有 slice 偏移的 bug（`(?:...)` 的外壳长度不同），
 * 这里直白写源串更可控。
 */
const HOTKEY_MODIFIER_SRC =
  'CommandOrControl|CmdOrCtrl|Command|Cmd|Ctrl|Control|Alt|AltGr|Shift|Super|Meta'

/**
 * 允许的按键白名单。覆盖 95% 的常用键，包括功能键、媒体键、数字小键盘键与符号。
 * 与 Electron `keys` 表保持一致；新增时同步在这里加。
 */
const HOTKEY_KEY_SRC =
  '[A-Z0-9]|F(?:1[0-9]|2[0-4]|[1-9])|Tab|Plus|Space|Backspace|Delete|Insert|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|VolumeUp|VolumeDown|VolumeMute|MediaNextTrack|MediaPreviousTrack|MediaStop|MediaPlayPause|PrintScreen|Comma|Period|Semicolon|Quote|Backslash|Slash|Backquote|Minus|Equal|Numlock|Capslock|Scrolllock|num[0-9]'

/** "至少一个修饰键 + 一个按键" 的组合正则 */
const HOTKEY_FULL_RE = new RegExp(
  `^(?:(?:${HOTKEY_MODIFIER_SRC})\\+)+(?:${HOTKEY_KEY_SRC})$`,
  'i'
)

export interface HotkeyValidation {
  ok: boolean
  reason?: string
}

/** 仅校验 Electron Accelerator 字符串是否合法（不探测占用） */
export function validateHotkeyFormat(hotkey: string): HotkeyValidation {
  const text = hotkey.trim()
  if (text === '') return { ok: true } // 空串 = 禁用快捷键，合法
  if (text.length > 64) return { ok: false, reason: '太长了' }
  if (!HOTKEY_FULL_RE.test(text)) {
    return { ok: false, reason: '格式不合法（需要 修饰键 + 按键，例如 Ctrl+Shift+V）' }
  }
  return { ok: true }
}

interface SlotState {
  /** 当前已注册的快捷键；空串 = 未注册（禁用） */
  hotkey: string
  callback: (() => void) | null
  /**
   * 录制期间临时挂起的旧快捷键 / 回调。
   *
   * 录制模式下不能让旧快捷键继续触发回调——否则用户在 el-input 里按下
   * "Ctrl+Shift+V" 时会同时把面板弹起来，干扰输入节奏。
   * 录制结束（成功或取消）时 `endHotkeyRecording` 把它装回去。
   */
  suspendedHotkey: string
  suspendedCallback: (() => void) | null
}

function emptySlot(): SlotState {
  return { hotkey: '', callback: null, suspendedHotkey: '', suspendedCallback: null }
}

const slots: Record<HotkeySlot, SlotState> = {
  clipboard: emptySlot(),
  todo: emptySlot(),
  note: emptySlot()
}

/** 注销某个槽位当前注册的键（内部使用；失败只记日志，不抛） */
function unregister(slot: HotkeySlot, hotkey: string): void {
  try {
    globalShortcut.unregister(hotkey)
  } catch (error) {
    log.warn(`${SLOT_LABEL[slot]}：注销快捷键失败：`, hotkey, error)
  }
}

/**
 * 试探 hotkey 是否可用：format 校验 + register-noop 立即 unregister。
 *
 * 注意 register-noop 的窗口极小（约 1ms），理论上另一应用可在此间抢走。
 * 实测可以接受；用户保存后真注册失败会落到 warn 日志里、设置页 / 托盘暴露入口。
 */
export function tryHotkey(hotkey: string): HotkeyValidation {
  const format = validateHotkeyFormat(hotkey)
  if (!format.ok) return format
  if (hotkey === '') return { ok: true }
  const ok = globalShortcut.register(hotkey, () => {})
  if (ok) globalShortcut.unregister(hotkey)
  return ok ? { ok: true } : { ok: false, reason: '已被其它应用占用' }
}

/**
 * 注册 / 替换某个槽位的 hotkey。
 *
 * - 若 hotkey 与旧值一致则 noop（不重复 register / unregister）。
 * - 空字符串 = 禁用（清掉旧 callback，不注册新）。
 * - 注册失败：清掉 hotkey 标记，**但已注册的不会去 unregister**（register 自己就没成功）。
 *
 * 返回 `true` 表示调用结束后用户按这个键一定能触发 callback。
 */
export function setHotkey(slot: HotkeySlot, hotkey: string, callback: () => void): boolean {
  const state = slots[slot]
  const normalized = hotkey.trim()
  if (normalized === state.hotkey && state.callback === callback) return true
  if (state.hotkey) {
    unregister(slot, state.hotkey)
    state.hotkey = ''
    state.callback = null
  }
  if (normalized === '') return true // 禁用是合法状态，不报错
  const ok = globalShortcut.register(normalized, callback)
  if (!ok) {
    log.warn(`${SLOT_LABEL[slot]}：注册快捷键失败（可能被占用）：`, normalized)
    return false
  }
  state.hotkey = normalized
  state.callback = callback
  return true
}

/**
 * 录制开始：把该槽位当前的 hotkey 临时解绑（保存为 suspended*），
 * 让用户在 input 里随便按都不会触发 toggle。已 suspend 时再调一次 noop。
 *
 * 只动传入的槽位：录制待办快捷键时剪贴板的键保持可用（它俩是两个独立设置项）。
 */
export function suspendHotkeyForRecording(slot: HotkeySlot): void {
  const state = slots[slot]
  if (state.suspendedHotkey !== '') return
  if (!state.hotkey) return
  state.suspendedHotkey = state.hotkey
  state.suspendedCallback = state.callback
  unregister(slot, state.hotkey)
  state.hotkey = ''
  state.callback = null
}

/**
 * 录制结束：
 *  - `newHotkey` 非空 → 把新快捷键注册上去（callback 用之前 suspend 时暂存的）
 *  - `newHotkey` 为 null → 取消录制，恢复旧值
 *
 * 这里能安全地直接走 `setHotkey`：suspend 时槽位已经被清空（`hotkey = ''`），
 * 所以"值没变就 skip"那条分支不会命中 —— 哪怕用户按的还是原来那个组合，
 * 也必须真的重新注册回去，否则取消一次录制就把键弄丢了。
 */
export function endHotkeyRecording(slot: HotkeySlot, newHotkey: string | null): boolean {
  const state = slots[slot]
  const restoreHotkey = state.suspendedHotkey
  const restoreCallback = state.suspendedCallback
  state.suspendedHotkey = ''
  state.suspendedCallback = null
  if (newHotkey !== null) {
    return setHotkey(slot, newHotkey, restoreCallback ?? (() => {}))
  }
  if (restoreHotkey) {
    return setHotkey(slot, restoreHotkey, restoreCallback ?? (() => {}))
  }
  return true
}

/** 进程退出 / 反初始化前调用，确保所有全局快捷键不留尾 */
export function unregisterAllHotkeys(): void {
  for (const slot of Object.keys(slots) as HotkeySlot[]) {
    const state = slots[slot]
    if (state.hotkey) {
      unregister(slot, state.hotkey)
      state.hotkey = ''
      state.callback = null
    }
  }
}

/**
 * **只给自检钩子用**：手动触发某个槽位当前挂着的回调。
 *
 * 为什么需要它：Windows 上没有任何办法从脚本里发一次**真实的**全局按键
 * （本机 `Add-Type` 与 `WScript.Shell` 都被安全策略拦住，见 `docs/STATUS.md` §四），
 * 所以"按下去到底会发生什么"这一段不可能靠模拟按键来验。
 *
 * 它与 `.tmp/hotkey-probe.cjs` 是**两半，缺一不可**：
 *  - probe 报 `TAKEN` → 证明系统层面这把键真的被本应用握住了；
 *  - `fireHotkey` → 证明槽位里存着的回调是**对的那个**（比如别把便签的键接到待办回调上）。
 *
 * 返回 `false` = 该槽位当前没有注册（键为空串，或注册时被占用而失败）。
 */
export function fireHotkey(slot: HotkeySlot): boolean {
  const callback = slots[slot].callback
  if (!callback) return false
  callback()
  return true
}
