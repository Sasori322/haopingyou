import { app, ipcMain } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { PET_NAME_MAX, PET_SCALE_MAX, PET_SCALE_MIN } from '../../shared/constants'
import { IPC } from '../../shared/ipc'
import type { PetState } from '../../shared/types/pet'
import type { AppSettings } from '../../shared/types/settings'
import {
  NOTE_TEXT_MAX,
  STICKY_COLORS,
  TODO_DUE_MAX,
  TODO_DUE_MIN,
  TODO_PRIORITIES,
  TODO_TAGS_MAX,
  TODO_TAG_MAX,
  TODO_TITLE_MAX
} from '../../shared/types/todo'
import type {
  StickyColor,
  StickyDraft,
  StickyPatch,
  TodoDraft,
  TodoPatch,
  TodoPriority
} from '../../shared/types/todo'
import {
  clearClipboard,
  clipboardStatus,
  deleteClipboard,
  initClipboard,
  listClipboard,
  pauseClipboard,
  pickStorageDir,
  refreshClipboardStorage,
  refreshClipboardWatcher,
  setClipboard,
  togglePinClipboard,
  validateStorageDir
} from '../clipboard'
import {
  endHotkeyRecording,
  setClipboardHotkey,
  suspendHotkeyForRecording,
  tryHotkey,
  validateHotkeyFormat
} from '../clipboard/clipboardHotkey'
import { petApp } from '../pet/petApp'
import { listPetSummaries, toReloadPayload } from '../pet/petLibrary'
import { initTodo, todoAfterWrite, todoRepo, todoSnapshot } from '../todo'
import { todoReminder } from '../todo/todoReminder'
import { getPetWindow, setPetVisible } from '../windows/petWindow'
import { broadcast, openSettingsWindow } from '../windows/settingsWindow'
import { openClipboardPanel, toggleClipboardPanel } from '../windows/clipboardWindow'
import { openTodoPanel } from '../windows/todoPanelWindow'
import { clamp } from '../utils/clamp'
import { createLogger } from '../utils/logger'
import { getAutostart, setAutostart } from './autostart'
import { gazeWatcher } from './gazeWatcher'
import { immersiveWatcher } from './immersiveWatcher'
import { notifier } from './notifier'
import { reminderScheduler } from './reminderScheduler'
import { getSettings, patchSettings } from './settingsService'
import { popupPetMenu, refreshTray } from './tray'

const log = createLogger('ipc')

const PET_STATES: readonly PetState[] = [
  'idle',
  'walk',
  'sleep',
  'eat',
  'drag',
  'click',
  'focus',
  'rest',
  'hot'
]

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function asNumber(value: unknown, min: number, max: number): number | null {
  return isFiniteNumber(value) ? clamp(value, min, max) : null
}

function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function asState(value: unknown): PetState | null {
  return typeof value === 'string' && (PET_STATES as readonly string[]).includes(value)
    ? (value as PetState)
    : null
}

function asString(value: unknown, maxLen = 200): string | null {
  return typeof value === 'string' && value.length <= maxLen ? value : null
}

/**
 * 解析结果包装：用来表达"合法值是 null"与"输入不合法"的差别。
 * 直接用裸 null 当哨兵会分不清这两种情形（截止时间字段合法地就可以是 null）。
 */
type Parsed<T> = { ok: true; value: T } | { ok: false }

/**
 * 进程名单的字符集白名单。
 *
 * 名单会被拼进 PowerShell 辅助进程的脚本里（用它查进程是否在跑），所以这里是**注入面**：
 * 只放行字母数字与 `._*?-`（`*`/`?` 是为了支持通配），引号、空格、分号、反引号一律丢弃。
 * 收紧到这一步之后，辅助进程侧连转义都不需要了。
 */
const PROCESS_NAME_PATTERN = /^[a-z0-9._*?-]{1,64}$/

function asProcessList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const unique = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.trim().toLowerCase()
    if (!PROCESS_NAME_PATTERN.test(name)) continue
    unique.add(name)
    if (unique.size >= 8) break
  }
  return [...unique]
}

/**
 * 关键字白名单：
 * 关键字会被 watcher 用 `RegExp(keyword.join('|'), 'i')` 拼成正则（regex 重写过 escape）。
 * 字符集收紧到数字字母 + 中文 + `._*?-`；每条 ≤ 32 字、≤ 24 条；最短 2 字避免过宽。
 *
 * 注意：即使做了字符集收紧也**别相信关键字可以阻止密码**——
 * "password 123456" 不命中关键字照样会被录入。我们没承诺"绝对不记录密码"。
 */
const KEYWORD_PATTERN = /^[\w.*?\-一-鿿]{2,32}$/u

/**
 * 存储目录白名单：
 * - Windows 文件名禁用字符集（`\\ / : * ? " < > |`）直接拒收——这些路径本来就不会被系统接受；
 * - 控制字符（≤0x1F）排除，否则路径含 \0 / \n 会让 fs API 直接抛错；
 * - 限制到 260 字：Windows MAX_PATH 是 / 故意保留超长路径给真正需要的人；
 * - 必须为绝对路径由 `path.isAbsolute` 在 sanitize 阶段补一刀。
 */
// 仅禁掉 Windows 文件名系统真不允许的字符；盘符分隔符 ":"、"\" 与 "/" 必须放开，
// 否则任何 D:\xxx 都过不了——上一个版本曾因为禁了这三者导致合法路径被静默拒绝。
const STORAGE_DIR_PATTERN = /^[^\x00-\x1F*?"<>|]{1,260}$/

function asKeywordList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const unique = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const word = item.trim()
    if (!KEYWORD_PATTERN.test(word)) continue
    unique.add(word)
    if (unique.size >= 24) break
  }
  return [...unique]
}

// ---------------- 待办与便签 ----------------

/** 标签字符集：字母数字、下划线、短横、中文。**不含空格与标点**，避免标签退化成一句话 */
const TODO_TAG_PATTERN = /^[\w\-一-鿿]{1,16}$/u

/**
 * 待办标题。会进系统通知正文（`「标题」到截止时间了`），所以：
 * ① 换行/制表符一律压成空格 —— 一个换行就能把通知正文的版式顶坏；
 * ② 控制字符（≤0x1F、0x7F）直接删掉；
 * ③ 首尾留白去掉，纯空白视为无效。
 */
function asTodoTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length === 0 || text.length > TODO_TITLE_MAX) return null
  return text
}

/** 便签正文允许保留换行（便签就是要能分行的），只清掉换行以外的控制字符 */
function asNoteText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
  if (text.length === 0 || text.length > NOTE_TEXT_MAX) return null
  return text
}

function asTodoPriority(value: unknown): TodoPriority | null {
  return typeof value === 'string' && (TODO_PRIORITIES as readonly string[]).includes(value)
    ? (value as TodoPriority)
    : null
}

function asStickyColor(value: unknown): StickyColor | null {
  return typeof value === 'string' && (STICKY_COLORS as readonly string[]).includes(value)
    ? (value as StickyColor)
    : null
}

/** 标签列表：逐条查模式、去重、封顶 TODO_TAGS_MAX 条。非数组 → null（调用方自行决定是"清空"还是"忽略"） */
function asTodoTags(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const unique = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const tag = item.trim()
    if (!TODO_TAG_PATTERN.test(tag)) continue
    unique.add(tag.length > TODO_TAG_MAX ? tag.slice(0, TODO_TAG_MAX) : tag)
    if (unique.size >= TODO_TAGS_MAX) break
  }
  return [...unique]
}

/**
 * 截止时间。用 `Parsed` 包一层是因为这个字段**合法地可以是 null**（= 没有截止时间），
 * 而其它非法输入也要被识别出来 —— 光看返回值区分不了"用户清空了截止时间"和"传了个垃圾进来"。
 * 区间 2000–2100 用来挡住 0、NaN、2699 年这类脏值。
 */
function parseDueAt(value: unknown): Parsed<number | null> {
  if (value === null || value === undefined) return { ok: true, value: null }
  if (!isFiniteNumber(value)) return { ok: false }
  if (value < TODO_DUE_MIN || value > TODO_DUE_MAX) return { ok: false }
  return { ok: true, value: Math.round(value) }
}

function asTodoDraft(value: unknown): TodoDraft | null {
  if (typeof value !== 'object' || value === null) return null
  const input = value as Record<string, unknown>
  const title = asTodoTitle(input.title)
  if (title === null) {
    log.warn('待办被拒：标题为空或过长')
    return null
  }
  const dueAt = parseDueAt(input.dueAt)
  if (!dueAt.ok) {
    log.warn('待办被拒：截止时间不合法', input.dueAt)
    return null
  }
  return {
    title,
    priority: asTodoPriority(input.priority) ?? 'normal',
    tags: asTodoTags(input.tags) ?? [],
    dueAt: dueAt.value
  }
}

/**
 * 局部更新。
 *
 * ⚠️ 与 `sanitizeSettingsPatch` 的关键区别：这里**必须区分"字段没传"和"字段传了但非法"**。
 * 没传 = 不改；传了非法 = 整条请求丢掉（`asTodoPatch` 返回 null）。
 * 如果沿用设置那套"非法就跳过"，用户把标题清空再保存时会拿到一个"什么都没发生"的假成功。
 *
 * 返回 null 的所有情形都是"拒绝整条请求"；空对象 `{}` 是合法的 no-op。
 */
function asTodoPatch(value: unknown): TodoPatch | null {
  if (typeof value !== 'object' || value === null) return null
  const input = value as Record<string, unknown>
  const patch: TodoPatch = {}
  if (input.title !== undefined) {
    const title = asTodoTitle(input.title)
    if (title === null) {
      log.warn('待办更新被拒：标题非法')
      return null
    }
    patch.title = title
  }
  if (input.priority !== undefined) {
    const priority = asTodoPriority(input.priority)
    if (priority === null) return null
    patch.priority = priority
  }
  if (input.tags !== undefined) {
    const tags = asTodoTags(input.tags)
    if (tags === null) return null
    patch.tags = tags
  }
  if (input.dueAt !== undefined) {
    const dueAt = parseDueAt(input.dueAt)
    if (!dueAt.ok) return null
    patch.dueAt = dueAt.value
  }
  return patch
}

function asStickyDraft(value: unknown): StickyDraft | null {
  if (typeof value !== 'object' || value === null) return null
  const input = value as Record<string, unknown>
  const text = asNoteText(input.text)
  if (text === null) {
    log.warn('便签被拒：正文为空或过长')
    return null
  }
  return { text, color: asStickyColor(input.color) ?? 'yellow' }
}

function asStickyPatch(value: unknown): StickyPatch | null {
  if (typeof value !== 'object' || value === null) return null
  const input = value as Record<string, unknown>
  const patch: StickyPatch = {}
  if (input.text !== undefined) {
    const text = asNoteText(input.text)
    if (text === null) return null
    patch.text = text
  }
  if (input.color !== undefined) {
    const color = asStickyColor(input.color)
    if (color === null) return null
    patch.color = color
  }
  return patch
}

/** 白名单式校验 settings:patch，未知键一律丢弃，数值一律夹紧到合理区间 */
function sanitizeSettingsPatch(raw: unknown): Partial<AppSettings> {
  if (typeof raw !== 'object' || raw === null) return {}
  const input = raw as Record<string, unknown>
  const out: Partial<AppSettings> = {}

  const activePetId = asString(input.activePetId, 64)
  if (activePetId !== null) out.activePetId = activePetId

  // 宠物自定义昵称：key 是宠物 id（与 activePetId 同口径），值是用户输入的名字。
  // 两点讲究：① 先剥掉控制字符再 trim —— 名字会进托盘 tooltip 和通知标题，一个换行就把版式顶坏；
  // ② 空串是**合法值**，语义为「恢复 manifest 默认昵称」，所以不能把空值过滤掉。
  const petNames = input.petNames as Record<string, unknown> | undefined
  if (petNames && typeof petNames === 'object' && !Array.isArray(petNames)) {
    const next: Record<string, string> = {}
    for (const [id, value] of Object.entries(petNames)) {
      if (typeof value !== 'string') continue
      if (id.length === 0 || id.length > 64) continue
      const text = value.replace(/[\u0000-\u001F\u007F]/g, '').trim()
      if (text.length > PET_NAME_MAX) {
        log.warn('宠物昵称被拒：过长', id, text.length, '字')
        continue
      }
      next[id] = text
    }
    if (Object.keys(next).length > 0) out.petNames = next
  }

  const petVisible = asBool(input.petVisible)
  if (petVisible !== null) out.petVisible = petVisible
  const alwaysOnTop = asBool(input.alwaysOnTop)
  if (alwaysOnTop !== null) out.alwaysOnTop = alwaysOnTop
  const autostart = asBool(input.autostart)
  if (autostart !== null) out.autostart = autostart
  const reactToLoad = asBool(input.reactToLoad)
  if (reactToLoad !== null) out.reactToLoad = reactToLoad
  const petScale = asNumber(input.petScale, PET_SCALE_MIN, PET_SCALE_MAX)
  if (petScale !== null) out.petScale = petScale

  const gaze = input.gaze as Record<string, unknown> | undefined
  if (gaze && typeof gaze === 'object') {
    const next: Partial<AppSettings['gaze']> = {}
    const enabled = asBool(gaze.enabled)
    if (enabled !== null) next.enabled = enabled
    const flipFacing = asBool(gaze.flipFacing)
    if (flipFacing !== null) next.flipFacing = flipFacing
    const range = asNumber(gaze.range, 100, 1200)
    if (range !== null) next.range = Math.round(range)
    if (Object.keys(next).length > 0) out.gaze = next as AppSettings['gaze']
  }

  const immersive = input.immersive as Record<string, unknown> | undefined
  if (immersive && typeof immersive === 'object') {
    const next: Partial<AppSettings['immersive']> = {}
    const enabled = asBool(immersive.enabled)
    if (enabled !== null) next.enabled = enabled
    const autoDetect = asBool(immersive.autoDetect)
    if (autoDetect !== null) next.autoDetect = autoDetect
    const processes = asProcessList(immersive.processes)
    if (processes !== null) next.processes = processes
    if (Object.keys(next).length > 0) out.immersive = next as AppSettings['immersive']
  }

  const pomodoro = input.pomodoro as Record<string, unknown> | undefined
  if (pomodoro && typeof pomodoro === 'object') {
    const next: Partial<AppSettings['pomodoro']> = {}
    const focusMin = asNumber(pomodoro.focusMin, 1, 180)
    if (focusMin !== null) next.focusMin = Math.round(focusMin)
    const shortBreakMin = asNumber(pomodoro.shortBreakMin, 1, 60)
    if (shortBreakMin !== null) next.shortBreakMin = Math.round(shortBreakMin)
    const longBreakMin = asNumber(pomodoro.longBreakMin, 1, 120)
    if (longBreakMin !== null) next.longBreakMin = Math.round(longBreakMin)
    const longBreakEvery = asNumber(pomodoro.longBreakEvery, 1, 12)
    if (longBreakEvery !== null) next.longBreakEvery = Math.round(longBreakEvery)
    const autoNext = asBool(pomodoro.autoNext)
    if (autoNext !== null) next.autoNext = autoNext
    const sound = asBool(pomodoro.sound)
    if (sound !== null) next.sound = sound
    if (Object.keys(next).length > 0) out.pomodoro = next as AppSettings['pomodoro']
  }

  const sedentary = input.sedentary as Record<string, unknown> | undefined
  if (sedentary && typeof sedentary === 'object') {
    const next: Partial<AppSettings['sedentary']> = {}
    const enabled = asBool(sedentary.enabled)
    if (enabled !== null) next.enabled = enabled
    const idleMinutes = asNumber(sedentary.idleMinutes, 1, 30)
    if (idleMinutes !== null) next.idleMinutes = Math.round(idleMinutes)
    const remindMinutes = asNumber(sedentary.remindMinutes, 5, 240)
    if (remindMinutes !== null) next.remindMinutes = Math.round(remindMinutes)
    if (Object.keys(next).length > 0) out.sedentary = next as AppSettings['sedentary']
  }

  const water = input.water as Record<string, unknown> | undefined
  if (water && typeof water === 'object') {
    const next: Partial<AppSettings['water']> = {}
    const enabled = asBool(water.enabled)
    if (enabled !== null) next.enabled = enabled
    const intervalMin = asNumber(water.intervalMin, 5, 240)
    if (intervalMin !== null) next.intervalMin = Math.round(intervalMin)
    if (Object.keys(next).length > 0) out.water = next as AppSettings['water']
  }

  const monitor = input.monitor as Record<string, unknown> | undefined
  if (monitor && typeof monitor === 'object') {
    const next: Partial<AppSettings['monitor']> = {}
    const enabled = asBool(monitor.enabled)
    if (enabled !== null) next.enabled = enabled
    const showTopProcess = asBool(monitor.showTopProcess)
    if (showTopProcess !== null) next.showTopProcess = showTopProcess
    if (Object.keys(next).length > 0) out.monitor = next as AppSettings['monitor']
  }

  const clipboard = input.clipboard as Record<string, unknown> | undefined
  if (clipboard && typeof clipboard === 'object') {
    const next: Partial<AppSettings['clipboard']> = {}
    const enabled = asBool(clipboard.enabled)
    if (enabled !== null) next.enabled = enabled
    const listenImages = asBool(clipboard.listenImages)
    if (listenImages !== null) next.listenImages = listenImages
    const excludeKeywords = asKeywordList(clipboard.excludeKeywords)
    if (excludeKeywords !== null) next.excludeKeywords = excludeKeywords
    // 存储目录：必须绝对、≤260 字符、字符集收紧（防止特殊字符把协议注入进 NAS 偷看）。
    // 先用 path.normalize 把 '/' 转成 '\'：Windows 上 dialog 偶发返回正斜杠路径，
    // 不提前规范化会让字符类把正常路径误拒掉、再被默默丢——界面一直显示默认目录。
    // 失败不再"默默丢弃"，主进程打 warn，让真有问题时不必再靠日志自检一步步推。
    const storageDirRaw = clipboard.storageDir
    if (storageDirRaw !== undefined) {
      if (storageDirRaw === null) {
        next.storageDir = null
      } else if (typeof storageDirRaw === 'string') {
        const text = path.normalize(storageDirRaw.trim())
        if (text === '' || text === '.') {
          next.storageDir = null
        } else if (text.length > 260) {
          log.warn('剪贴板存储目录被拒：路径过长', text.length, '字')
        } else if (!path.isAbsolute(text)) {
          log.warn('剪贴板存储目录被拒：非绝对路径', text)
        } else if (!STORAGE_DIR_PATTERN.test(text)) {
          log.warn('剪贴板存储目录被拒：含不允许字符', text)
        } else {
          next.storageDir = text
        }
      } else {
        log.warn('剪贴板存储目录被拒：非字符串')
      }
    }
    // 快捷键：format 校验（详细原因由专门的 IPC 返回，这里只挡下明显错误）
    const hotkeyRaw = clipboard.hotkey
    if (hotkeyRaw !== undefined && typeof hotkeyRaw === 'string') {
      const text = hotkeyRaw.trim()
      if (text === '') {
        next.hotkey = ''
      } else if (text.length <= 64 && validateHotkeyFormat(text).ok) {
        next.hotkey = text
      }
    }
    if (Object.keys(next).length > 0) out.clipboard = next as AppSettings['clipboard']
  }

  return out
}

function applySideEffects(settings: AppSettings): void {
  const win = getPetWindow()
  if (win) {
    win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver')
    setPetVisible(settings.petVisible)
  }
  if (settings.activePetId && settings.activePetId !== petApp.currentPetId) {
    petApp.loadPet(settings.activePetId)
  }
  // 两个跟随设置的采样器都是幂等的，改完设置直接刷新即可
  gazeWatcher.refresh()
  immersiveWatcher.refresh()
  // 提醒的阈值也来自设置，改完要立刻按新阈值重排（否则要等下一个 tick 才跟上）
  reminderScheduler.refresh()
  // 剪贴板：开关 / 黑名单 / 采图 / 存储目录 / 快捷键都可能变化
  refreshClipboardStorage()   // 切换目录就重建 store + watcher
  setClipboardHotkey(
    settings.clipboard.hotkey,
    toggleClipboardPanel
  )
  refreshClipboardWatcher()   // 热更新由 store 重启触发
  refreshTray()
}

export function registerIpc(): void {
  // ---------- 穿透 / 拖拽 ----------
  ipcMain.on(IPC.PET_SET_IGNORE_MOUSE, (_event: IpcMainEvent, ignore: unknown) => {
    const value = asBool(ignore)
    if (value === null) return
    petApp.controller.requestIgnoreMouse(value)
  })

  ipcMain.on(IPC.PET_DRAG_START, (_event: IpcMainEvent, offset: unknown) => {
    const point = offset as { x?: unknown; y?: unknown } | undefined
    const x = asNumber(point?.x, -10000, 10000)
    const y = asNumber(point?.y, -10000, 10000)
    if (x === null || y === null) return
    petApp.handleDragStart({ x, y })
  })

  ipcMain.on(IPC.PET_DRAG_MOVE, (_event: IpcMainEvent, pos: unknown) => {
    const point = pos as { x?: unknown; y?: unknown } | undefined
    const x = asNumber(point?.x, -100000, 100000)
    const y = asNumber(point?.y, -100000, 100000)
    if (x === null || y === null) return
    petApp.controller.dragMove({ x, y })
  })

  ipcMain.on(IPC.PET_DRAG_END, () => {
    petApp.handleDragEnd()
  })

  ipcMain.on(IPC.PET_STATE_CHANGED, (_event: IpcMainEvent, state: unknown) => {
    const value = asState(state)
    if (value === null) return
    petApp.handleRendererState(value)
  })

  // 菜单位置交给系统在当前光标处决定，渲染层不传坐标（详见 popupPetMenu 的注释）
  ipcMain.on(IPC.PET_POPUP_MENU, () => {
    popupPetMenu()
  })

  ipcMain.on(IPC.PET_REQUEST_SPEAK, (_event: IpcMainEvent, payload: unknown) => {
    const input = payload as { reason?: unknown; text?: unknown } | undefined
    const reason = asString(input?.reason, 40) ?? petApp.currentState
    const text = asString(input?.text, 120)
    petApp.speak(reason, text ?? undefined)
  })

  ipcMain.on(IPC.PET_REQUEST_STATE, (_event: IpcMainEvent, payload: unknown) => {
    const input = payload as { state?: unknown } | undefined
    const state = asState(input?.state)
    if (state === null) return
    petApp.setState(state, 'renderer')
  })

  // ---------- 查询 ----------
  ipcMain.handle(IPC.PET_GET_GEOMETRY, () => petApp.controller.getGeometry())

  ipcMain.handle(IPC.PET_LIST, () => listPetSummaries())

  ipcMain.handle(IPC.PET_GET_ACTIVE, () => {
    const summaries = listPetSummaries()
    const record = summaries.find((pet) => pet.id === petApp.currentPetId) ?? null
    if (!record) return toReloadPayload(null)
    return {
      petId: record.id,
      manifest: petApp.manifest,
      hasAssets: record.hasAssets
    }
  })

  ipcMain.handle(IPC.PET_SET_ACTIVE, (_event: IpcMainInvokeEvent, petId: unknown) => {
    const id = asString(petId, 64)
    if (id === null) return
    patchSettings({ activePetId: id })
    petApp.loadPet(id)
    petApp.idle()
    broadcast(IPC.SETTINGS_CHANGED, getSettings())
    refreshTray()
  })

  // ---------- 设置 ----------
  ipcMain.handle(IPC.SETTINGS_GET, () => getSettings())

  ipcMain.handle(IPC.SETTINGS_PATCH, (_event: IpcMainInvokeEvent, patch: unknown) => {
    const sanitized = sanitizeSettingsPatch(patch)
    const next = patchSettings(sanitized)
    // 用户主动把宠物调出来看：给一个豁免窗口，别让自动躲开下一个 tick 又把它藏回去
    if (sanitized.petVisible === true) immersiveWatcher.suppress()
    applySideEffects(next)
    broadcast(IPC.SETTINGS_CHANGED, next)
    log.info('设置已更新', Object.keys(sanitized))
    return next
  })

  ipcMain.handle(IPC.APP_GET_IMMERSIVE_STATUS, () => immersiveWatcher.status())

  ipcMain.handle(IPC.APP_GET_REMINDER_STATUS, () => reminderScheduler.status())

  ipcMain.handle(IPC.APP_SET_DND, (_event: IpcMainInvokeEvent, minutes: unknown) => {
    // 只接受 null（立刻恢复）或 1–1440 分钟，其余一律当恢复处理，避免渲染层传个 NaN 把免打扰卡死
    const value = minutes === null ? null : asNumber(minutes, 1, 1440)
    notifier.snooze(value === null ? null : Math.round(value))
    reminderScheduler.refresh()
    return reminderScheduler.status()
  })

  // ---------- 应用级 ----------
  ipcMain.handle(IPC.APP_GET_VERSION, () => app.getVersion())
  ipcMain.handle(IPC.APP_GET_AUTOSTART, () => getAutostart())
  ipcMain.handle(IPC.APP_SET_AUTOSTART, (_event: IpcMainInvokeEvent, enabled: unknown) => {
    const value = asBool(enabled)
    if (value === null) return getAutostart()
    const actual = setAutostart(value)
    const next = patchSettings({ autostart: actual })
    refreshTray()
    broadcast(IPC.SETTINGS_CHANGED, next)
    return actual
  })

  ipcMain.on(IPC.APP_OPEN_SETTINGS, () => openSettingsWindow())
  ipcMain.on(IPC.APP_SHOW_PET, () => {
    patchSettings({ petVisible: true })
    setPetVisible(true)
    immersiveWatcher.suppress()
    refreshTray()
  })
  ipcMain.on(IPC.APP_HIDE_PET, () => {
    patchSettings({ petVisible: false })
    setPetVisible(false)
    refreshTray()
  })
  ipcMain.on(IPC.APP_QUIT, () => app.quit())

  // ---------- 剪贴板历史 ----------
  // 整个历史在任何写操作后都会主动 notifyChanged，渲染层默认走 onChanged 重读；
  // 这里所有 invoke 都返回最新数据，确保面板打开时也是最新。
  initClipboard()
  ipcMain.handle(IPC.CLIPBOARD_LIST, () => listClipboard())
  ipcMain.handle(IPC.CLIPBOARD_STATUS, () => clipboardStatus())
  ipcMain.handle(IPC.CLIPBOARD_SET, async (_event: IpcMainInvokeEvent, id: unknown) => {
    const value = asString(id, 64)
    if (value === null) return false
    return setClipboard(value)
  })
  ipcMain.handle(IPC.CLIPBOARD_DELETE, (_event: IpcMainInvokeEvent, id: unknown) => {
    const value = asString(id, 64)
    if (value === null) return false
    return deleteClipboard(value)
  })
  ipcMain.handle(IPC.CLIPBOARD_TOGGLE_PIN, (_event: IpcMainInvokeEvent, id: unknown) => {
    const value = asString(id, 64)
    if (value === null) return false
    return togglePinClipboard(value)
  })
  ipcMain.handle(IPC.CLIPBOARD_CLEAR, () => clearClipboard())
  ipcMain.handle(IPC.CLIPBOARD_PAUSE, (_event: IpcMainInvokeEvent, minutes: unknown) => {
    if (minutes === null) return pauseClipboard(null)
    const value = asNumber(minutes, 0, 1440)
    if (value === null) return clipboardStatus()
    return pauseClipboard(Math.round(value))
  })
  ipcMain.on(IPC.CLIPBOARD_OPEN_PANEL, () => openClipboardPanel())

  // 存储目录：调用 dialog.showOpenDialog 让用户挑一个目录。返回值即绝对路径或 null
  ipcMain.handle(IPC.CLIPBOARD_PICK_DIR, () => pickStorageDir())

  // 校验候选目录：dry-run，确保能创建 / 能写入。
  // 入参统一走 asString，避免渲染层塞一个对象进来。
  ipcMain.handle(IPC.CLIPBOARD_VALIDATE_DIR, (_event: IpcMainInvokeEvent, raw: unknown) => {
    const dir = asString(raw, 260)
    if (dir === null) return { ok: false, reason: '路径不合法' }
    return validateStorageDir(dir)
  })

  // 试探 hotkey：format + register-noop，不改设置。
  ipcMain.handle(IPC.CLIPBOARD_TRY_HOTKEY, (_event: IpcMainInvokeEvent, raw: unknown) => {
    const hotkey = asString(raw, 64)
    if (hotkey === null) return { ok: false, reason: '快捷键不合法' }
    return tryHotkey(hotkey)
  })

  // 录制开始：主进程解绑旧值。begin/end 严格配对，渲染层在 unmount 时也要调 end(null) 兜底。
  ipcMain.handle(IPC.CLIPBOARD_BEGIN_RECORDING, () => {
    suspendHotkeyForRecording()
  })

  // 录制结束：传新值 → 注册；传 null → 恢复旧值。
  ipcMain.handle(IPC.CLIPBOARD_END_RECORDING, (_event: IpcMainInvokeEvent, raw: unknown) => {
    const next = typeof raw === 'string' ? raw : null
    endHotkeyRecording(next)
  })

  // ---------- 待办与便签 ----------
  // 约定：写操作一律返回最新快照（渲染层不用"改完再读一次"），广播是为了
  // 同步**另一个窗口**（设置页与旁挂小面板经常同时开着）。
  // 入参不合法时不抛错，回一份未改动的快照 —— 让 UI 的"没生效"是可见的，
  // 而不是一个被吞掉的异常。
  initTodo()

  ipcMain.handle(IPC.TODO_SNAPSHOT, () => todoSnapshot())

  ipcMain.handle(IPC.TODO_ADD, (_event: IpcMainInvokeEvent, raw: unknown) => {
    const draft = asTodoDraft(raw)
    if (draft === null) return todoSnapshot()
    todoRepo().addTodo(draft)
    // 立刻评估一次：用户可能填的截止时间已经非常近（甚至就是当下）
    todoReminder.refresh()
    return todoAfterWrite()
  })

  ipcMain.handle(IPC.TODO_UPDATE, (_event: IpcMainInvokeEvent, raw: unknown) => {
    const input = raw as { id?: unknown; patch?: unknown } | undefined
    const id = asString(input?.id, 64)
    const patch = asTodoPatch(input?.patch)
    if (id === null || patch === null) return todoSnapshot()
    todoRepo().updateTodo(id, patch)
    // 改了截止时间 → 立刻重算（比如从"明天"改成"已经过了"，就应马上标记为已处理）
    todoReminder.refresh()
    return todoAfterWrite()
  })

  ipcMain.handle(IPC.TODO_REMOVE, (_event: IpcMainInvokeEvent, raw: unknown) => {
    const id = asString(raw, 64)
    if (id === null) return todoSnapshot()
    todoRepo().removeTodo(id)
    return todoAfterWrite()
  })

  ipcMain.handle(IPC.TODO_SET_DONE, (_event: IpcMainInvokeEvent, raw: unknown) => {
    const input = raw as { id?: unknown; done?: unknown } | undefined
    const id = asString(input?.id, 64)
    const done = asBool(input?.done)
    if (id === null || done === null) return todoSnapshot()
    todoRepo().setDone(id, done)
    return todoAfterWrite()
  })

  ipcMain.handle(IPC.TODO_REORDER, (_event: IpcMainInvokeEvent, raw: unknown) => {
    if (!Array.isArray(raw)) return todoSnapshot()
    const ids: string[] = []
    for (const item of raw) {
      const id = asString(item, 64)
      if (id !== null) ids.push(id)
      if (ids.length >= 2000) break
    }
    todoRepo().reorderTodos(ids)
    return todoAfterWrite()
  })

  ipcMain.handle(IPC.TODO_CLEAR_DONE, () => {
    todoRepo().clearDoneTodos()
    return todoAfterWrite()
  })

  ipcMain.handle(IPC.TODO_NOTE_ADD, (_event: IpcMainInvokeEvent, raw: unknown) => {
    const draft = asStickyDraft(raw)
    if (draft === null) return todoSnapshot()
    todoRepo().addNote(draft)
    return todoAfterWrite()
  })

  ipcMain.handle(IPC.TODO_NOTE_UPDATE, (_event: IpcMainInvokeEvent, raw: unknown) => {
    const input = raw as { id?: unknown; patch?: unknown } | undefined
    const id = asString(input?.id, 64)
    const patch = asStickyPatch(input?.patch)
    if (id === null || patch === null) return todoSnapshot()
    todoRepo().updateNote(id, patch)
    return todoAfterWrite()
  })

  ipcMain.handle(IPC.TODO_NOTE_REMOVE, (_event: IpcMainInvokeEvent, raw: unknown) => {
    const id = asString(raw, 64)
    if (id === null) return todoSnapshot()
    todoRepo().removeNote(id)
    return todoAfterWrite()
  })

  ipcMain.handle(IPC.TODO_NOTE_TOGGLE_PIN, (_event: IpcMainInvokeEvent, raw: unknown) => {
    const id = asString(raw, 64)
    if (id === null) return todoSnapshot()
    const note = todoRepo().listNotes().find((n) => n.id === id)
    if (note) todoRepo().setNotePinned(id, !note.pinned)
    return todoAfterWrite()
  })

  // 打开旁挂面板；focusQuickAdd 只由「宠物右键 → 记一条待办」使用
  ipcMain.on(IPC.TODO_OPEN_PANEL, (_event: IpcMainEvent, raw: unknown) => {
    const input = raw as { focusQuickAdd?: unknown } | undefined
    openTodoPanel({ focusQuickAdd: asBool(input?.focusQuickAdd) === true })
  })
}
