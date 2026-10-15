/**
 * 剪贴板全局快捷键的校验与注册工具。
 *
 * 设计要点（见 `docs/STATUS.md` 剪贴板历史·采集·交互）：
 * ① 快捷键字符串走 Electron Accelerator 格式（`Ctrl+Shift+V` 等）。
 * ② **「是否被占用」只能注册一下才能知道** —— `register` 在 invalid / occupied 时都返回 false，
 *       无法单点区分。这里先 format 校验、再用 register-noop + 立即 unregister 试探占用。
 * ③ 空字符串 = 禁用快捷键（用户能继续走托盘菜单入口）。
 * ④ 真正的注册（带 toggle 回调）走 `setClipboardHotkey`，调用方负责传 callback；
 *       这个工具模块只负责"hotkey 字符串"层面，不绑定到操作层。
 */
import { globalShortcut } from 'electron'
import { createLogger } from '../utils/logger'

const log = createLogger('clipHotkey')

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

let currentHotkey = ''
let currentCallback: (() => void) | null = null

/**
 * 录制期间临时挂起的旧快捷键 / 回调。
 *
 * 录制模式下不能让旧快捷键继续触发回调——否则用户在 el-input 里按下
 * "Ctrl+Shift+V" 时会同时把面板弹起来，干扰输入节奏。
 * 录制结束（成功或取消）时 `endHotkeyRecording` 把它装回去。
 */
let suspendedHotkey = ''
let suspendedCallback: (() => void) | null = null

/**
 * 录制开始：把当前 hotkey 临时解绑（保存为 suspended*），让用户在 input 里随便按
 * 都不会触发 toggle clipboard panel。已 suspend 时再调一次 noop。
 */
export function suspendHotkeyForRecording(): void {
  if (suspendedHotkey !== '') return
  if (!currentHotkey) return
  suspendedHotkey = currentHotkey
  suspendedCallback = currentCallback
  try {
    globalShortcut.unregister(currentHotkey)
  } catch (error) {
    log.warn('录制开始：注销旧快捷键失败：', currentHotkey, error)
  }
  currentHotkey = ''
  currentCallback = null
}

/**
 * 录制结束：
 *  - `newHotkey` 非空 → 把新快捷键注册上去（callback 用之前 suspend 时暂存的）
 *  - `newHotkey` 为 null → 取消录制，恢复旧值
 *
 * 这里不直接调 `setClipboardHotkey` 时机里 unregister；setClipboardHotkey 自己会判定
 * currentHotkey 是否变化，未变化直接 skip——这里恰好不要走那条分支。
 */
export function endHotkeyRecording(newHotkey: string | null): boolean {
  const restoreHotkey = suspendedHotkey
  const restoreCallback = suspendedCallback
  suspendedHotkey = ''
  suspendedCallback = null
  if (newHotkey !== null) {
    return setClipboardHotkey(newHotkey, restoreCallback ?? (() => {}))
  }
  if (restoreHotkey) {
    return setClipboardHotkey(restoreHotkey, restoreCallback ?? (() => {}))
  }
  return true
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
 * 注册 / 替换 hotkey。
 *
 * - 若 hotkey 与旧值一致则 noop（不重复 register / unregister）。
 * - 空字符串 = 禁用（清掉旧 callback，不注册新）。
 * - 注册失败：清掉 currentHotkey 标记，**但已注册的不会去 unregister**（register 自己就没成功）。
 *
 * 返回 `true` 表示调用结束后用户按这个键一定能触发 callback。
 */
export function setClipboardHotkey(hotkey: string, callback: () => void): boolean {
  const normalized = hotkey.trim()
  if (normalized === currentHotkey && currentCallback === callback) return true
  if (currentHotkey) {
    try {
      globalShortcut.unregister(currentHotkey)
    } catch (error) {
      log.warn('注销旧快捷键失败：', currentHotkey, error)
    }
    currentHotkey = ''
    currentCallback = null
  }
  if (normalized === '') return true // 禁用是合法状态，不报错
  const ok = globalShortcut.register(normalized, callback)
  if (!ok) {
    log.warn('注册快捷键失败（可能被占用）：', normalized)
    return false
  }
  currentHotkey = normalized
  currentCallback = callback
  return true
}

/** 进程退出 / 反初始化前调用，确保全局快捷键不留尾 */
export function unregisterClipboardHotkey(): void {
  if (currentHotkey) {
    try {
      globalShortcut.unregister(currentHotkey)
    } catch (error) {
      log.warn('注销快捷键失败：', currentHotkey, error)
    }
    currentHotkey = ''
    currentCallback = null
  }
}