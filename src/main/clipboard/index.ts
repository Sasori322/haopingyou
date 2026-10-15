import { app, BrowserWindow, clipboard, dialog, net, protocol, ClipboardItem } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC } from '../../shared/ipc'
import type { ClipboardStatus } from '../../shared/types/clipboard'
import { getSettings } from '../services/settingsService'
import { createLogger } from '../utils/logger'
import { setHotkey } from '../services/globalHotkeys'
import { ClipboardStore } from './clipboardStore'
import { ClipboardWatcher } from './clipboardWatcher'
import { toggleClipboardPanel } from '../windows/clipboardWindow'

const log = createLogger('clipboard')

let store: ClipboardStore | null = null
let watcher: ClipboardWatcher | null = null
let currentDir: string | null = null
let pausedUntilAt = 0

/**
 * 剪贴板图片协议（私有）。
 * 必须先注册特权（registerSchemesAsPrivileged）后注册处理器。
 * 用专门的 scheme 是为了避免 pet-asset:// 的范围蔓延——这一类不需要走读目录的能力，
 * 也方便后续精细化权限。
 */
export const CLIPBOARD_IMG_SCHEME = 'clipboard-img'

let schemeRegistered = false
let protocolHandled = false

/** 必须在 app ready 之前调用 */
export function registerClipboardSchemes(): void {
  if (schemeRegistered) return
  schemeRegistered = true
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CLIPBOARD_IMG_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // 不开 corsEnabled 会把 <img> 当作 cross-origin，canvas 之后无法读回。
        corsEnabled: true
      }
    }
  ])
}

/**
 * 把用户配置的目录规整成"主进程真能用"的形态：
 *  - null / 空串 / 不存在但能创建 → 创建并返回；存在但是文件 → 报错；存在但是目录 → 直接用；
 *  - 不允许相对路径（避免不同工作目录下读出不同语义）。
 *  - 整个流程同步，因为 init 时机早于 ready 之前允许同步。
 */
export function ensureDir(path: string): { ok: boolean; path: string; reason?: string } {
  const text = path.trim()
  if (!text) return { ok: false, path, reason: '路径不能为空' }
  if (text.length > 260) return { ok: false, path: text, reason: '路径过长（>260）' }
  if (!isAbsolute(text)) return { ok: false, path: text, reason: '必须是绝对路径' }
  try {
    if (existsSync(text)) {
      const stat = statSync(text)
      if (!stat.isDirectory()) return { ok: false, path: text, reason: '不是一个目录' }
    } else {
      mkdirSync(text, { recursive: true })
    }
    // 试探写入：很多挂载点（NAS / OneDrive 占位目录）能列但写不了，绕不开这一步
    const probe = join(text, `.haopingyou-probe-${Date.now()}`)
    writeFileSync(probe, 'probe')
    unlinkSync(probe)
    return { ok: true, path: text }
  } catch (error) {
    return { ok: false, path: text, reason: '无权限写入' }
  }
}

/**
 * 按设置里的 storageDir 决定实际目录。设置无效时静默回退默认——用户能继续使用、UI 还能拿到真实路径。
 */
export function resolveDir(): string {
  const setting = getSettings().clipboard.storageDir
  if (setting && typeof setting === 'string') {
    const ensured = ensureDir(setting)
    if (ensured.ok) return ensured.path
    log.warn('自定义存储目录不可用，回退默认：', setting, ensured.reason)
  }
  return join(app.getPath('userData'), 'clipboard')
}

/** app ready 后调用：注册 handler、初始化 store/watcher/hotkey */
export function initClipboard(): void {
  if (store) return
  registerProtocolHandler()
  recreateStore()
  recreateWatcher()
  // 快捷键：用设置里的值；如果注册失败由 setHotkey 内部 warn，不打断启动
  setHotkey('clipboard', getSettings().clipboard.hotkey, toggleClipboardPanel)
  // recreateWatcher 已经按 enabled 决定是否启动，这里不再重复 start
  log.info('剪贴板历史已就绪 存储', store!.meta().path)
}

function recreateStore(): void {
  if (store) {
    // 切目录前必须 flush 老 store：可能在内存里有未落盘的改动
    store.flush()
  }
  const dir = resolveDir()
  currentDir = dir
  store = new ClipboardStore(dir)
  log.info('剪贴板存储目录', dir)
}

function recreateWatcher(): void {
  if (watcher) {
    watcher.stop()
    watcher = null
  }
  if (!store) return
  const readSettings = () => getSettings().clipboard
  watcher = new ClipboardWatcher(store, {
    enabled: () => readSettings().enabled,
    listenImages: () => readSettings().listenImages,
    excludeKeywords: () => readSettings().excludeKeywords,
    pausedUntilAt: () => pausedUntilAt,
    // "尽力而为" 的源：app 名 + 主窗口类名（无 P/Invoke 的话只能到这里）
    source: () => resolveSource()
  })
  if (readSettings().enabled) watcher.start()
}

function registerProtocolHandler(): void {
  if (protocolHandled) return
  protocolHandled = true
  protocol.handle(CLIPBOARD_IMG_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const id = decodeURIComponent(url.hostname)
      // 必须用 currentDir：用户切了自定义目录后，img 不再在 <userData>/clipboard/img
      const root = normalize(join(currentDir ?? resolveDir(), 'img'))
      const target = normalize(join(root, `${id}.png`))
      if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) {
        log.warn('拒绝越权访问剪贴板图：', id)
        return new Response('forbidden', { status: 403 })
      }
      if (!existsSync(target)) return new Response('not found', { status: 404 })
      const upstream = await net.fetch(pathToFileURL(target).toString())
      const headers = new Headers(upstream.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      headers.set('Cache-Control', 'no-cache')
      return new Response(upstream.body, { status: upstream.status, headers })
    } catch (error) {
      log.warn('加载剪贴板图失败：', request.url, error)
      return new Response('error', { status: 500 })
    }
  })
}

// ---------- 给 IPC 用的便捷函数 ----------

export interface ClipboardListEntry {
  id: string
  kind: 'text' | 'image' | 'files'
  preview: string
  hash: string
  at: number
  pinned: boolean
  source: string
  truncated?: boolean
}

export function listClipboard(): ClipboardListEntry[] {
  if (!store) return []
  return store.list().map((e) => {
    const out: ClipboardListEntry = {
      id: e.id,
      kind: e.kind,
      preview: e.preview,
      hash: e.hash,
      at: e.at,
      pinned: e.pinned,
      source: e.source
    }
    if (e.truncated) out.truncated = true
    return out
  })
}

export function clipboardStatus(): ClipboardStatus {
  return {
    count: store?.count() ?? 0,
    latestId: store?.list()[0]?.id ?? null,
    listeningImages: getSettings().clipboard.listenImages,
    pausedUntilAt: pausedUntilAt,
    storageDir: currentStorageDir()
  }
}

/** 当前生效的存储目录；设置未生效时返回默认 */
export function currentStorageDir(): string {
  return currentDir ?? resolveDir()
}

export function deleteClipboard(id: string): boolean {
  if (!store) return false
  const ok = store.delete(id)
  if (ok) notifyChanged()
  return ok
}

export function togglePinClipboard(id: string): boolean {
  if (!store) return false
  const ok = store.togglePin(id)
  if (ok) notifyChanged()
  return ok
}

export function clearClipboard(): number {
  if (!store) return 0
  const removed = store.clearAll()
  notifyChanged()
  return removed
}

/** 把 entry 内容写回操作系统剪贴板 */
export async function setClipboard(id: string): Promise<boolean> {
  if (!store) return false
  const payload = store.readPayload(id)
  if (!payload) return false
  try {
    if (payload.kind === 'text') {
      await clipboard.writeText(payload.text)
      return true
    }
    if (payload.kind === 'files' && payload.text) {
      try {
        const parsed = JSON.parse(payload.text) as unknown
        if (Array.isArray(parsed)) {
          const strings = parsed.filter((s): s is string => typeof s === 'string')
          if (strings.length > 0) {
            // Electron clipboard 没有"files" 槽——退化成文本，
            // 同时把文件名拼起来写进主文本槽位，方便常见应用直接粘贴
            await clipboard.writeText(strings.join(' '))
            return true
          }
        }
      } catch {
        // ignore
      }
      return false
    }
    if (payload.kind === 'image' && payload.pngPath) {
      const buf = readFileSync(payload.pngPath)
      // Electron 44：clipboard.write 需要 ClipboardItem 实例；
      // value 必须是 string/Blob/Promise——Buffer 不是 Blob，
      // 包一层 Blob(..., {type:'image/png'})
      const blob = new Blob([buf], { type: 'image/png' })
      const item = new ClipboardItem({ 'image/png': blob })
      await clipboard.write([item])
      return true
    }
    return false
  } catch (error) {
    log.warn('回写剪贴板失败：', error)
    return false
  }
}

export function pauseClipboard(minutes: number | null): ClipboardStatus {
  if (!minutes || minutes <= 0) {
    pausedUntilAt = 0
  } else {
    pausedUntilAt = Date.now() + Math.round(minutes) * 60_000
  }
  notifyChanged()
  return clipboardStatus()
}

/** 校验一个候选目录：返回值是结构化结果，便于 IPC 层直接传给渲染层 */
export function validateStorageDir(dir: string): { ok: boolean; path?: string; reason?: string } {
  if (typeof dir !== 'string') return { ok: false, reason: '路径必须是字符串' }
  const result = ensureDir(dir)
  if (result.ok) return { ok: true, path: result.path }
  return { ok: false, reason: result.reason }
}

/** 调起系统目录选择对话框，挂在设置窗口下作为父窗口 */
export async function pickStorageDir(): Promise<string | null> {
  const focused = BrowserWindow.getFocusedWindow()
    ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  const options = {
    title: '选择剪贴板历史存储目录',
    properties: ['openDirectory' as const, 'createDirectory' as const]
  }
  const result = focused
    ? await dialog.showOpenDialog(focused, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  const dir = result.filePaths[0]
  // 即便用户取消也先校验一遍：dialog 已经限制了选择目录，但加这层兜底 NAS / 虚拟盘的边界
  const ensured = ensureDir(dir)
  if (!ensured.ok) return null
  return ensured.path
}

/** 应用 settings 已改完后的「按需刷新」：仅当目录真变了才动 store/watcher */
export function refreshClipboardStorage(): void {
  const newDir = resolveDir()
  if (newDir === currentDir && store) return
  log.info('剪贴板存储目录切换', currentDir ?? '(未初始化)', '→', newDir)
  recreateStore()
  recreateWatcher()
  // 切换时不要 broadcast "已变更数据"——只是底子换了，主进程的 list 视图没变
  notifyChanged()
}

/** 设置改完后让 watcher 立刻按新设置生效（黑名单 / 采图 / 启停） */
export function refreshClipboardWatcher(): void {
  watcher?.refresh()
}

/** 进程退出前同步落盘 */
export function flushClipboard(): void {
  store?.flush()
}

/**
 * 给所有窗口广播剪贴板变更（由 IPC 触发或 store 主动改时调用）。
 * 渲染层只用 onChanged 一处订阅；增量更新由渲染层决定是否重读 list。
 */
function notifyChanged(): void {
  const status = clipboardStatus()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(IPC.CLIPBOARD_CHANGED, status)
  }
}

/**
 * "应用源" —— 不用 P/Invoke 的话，只能拼 app.getName() 与 BrowserWindow 的 title。
 * 给"我能识别来源"做一次诚实的尝试：值不可信，仅作为元数据。
 */
function resolveSource(): string {
  const appName = app.getName()
  const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const title = focused && !focused.isDestroyed() ? focused.getTitle() : ''
  return `${appName}${title ? ' · ' + title : ''}`
}