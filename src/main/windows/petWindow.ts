import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { petWindowSize } from '../../shared/constants'
import { primaryDropPoint } from '../pet/displayManager'
import { createLogger } from '../utils/logger'

const log = createLogger('petWindow')

let petWindow: BrowserWindow | null = null

/**
 * 可见性变化的唯一出口（由 `petApp` 在 `attach()` 时注册）。
 *
 * 为什么必须集中在这里而不是散在各调用方：宠物窗口的点击穿透是**两段式握手**——
 * 常态穿透（`ignoreMouseEvents(true, { forward: true })`），靠一条**被转发的 mousemove**
 * 命中宠物后才切回「接收鼠标」。而隐藏 / 显示会让这条通路前后失配：
 * 窗口被藏过一次之后再出来，两侧可能都停在"可交互"，于是唯一的恢复路径因为"值没变"
 * 变成空操作，表现就是宠物看得见、却点不动也拖不动（2026-10-14 实机踩到）。
 *
 * 藏 / 显是这个握手最容易失配的两个时刻，所以必须有一个**集中的**复位点；
 * 而 `setPetVisible` 是所有显隐路径（托盘、设置、沉浸躲开、开机自启）的唯一收口。
 */
let visibilityListener: ((visible: boolean) => void) | null = null

export function onPetVisibilityChange(fn: (visible: boolean) => void): void {
  visibilityListener = fn
}

export function getPetWindow(): BrowserWindow | null {
  return petWindow && !petWindow.isDestroyed() ? petWindow : null
}

/**
 * 创建宠物窗口。
 *
 * 这里每个参数都不是可选项：
 * - transparent + frame:false → 无边框透明玻璃
 * - resizable:false → 透明窗口开启 resize 后透明会失效
 * - movable:false → 位置完全由主进程 setPosition 控制
 * - hasShadow:false → 不加会得到一圈灰黑色矩形轮廓
 * - skipTaskbar:true → 不出现在任务栏与 Alt+Tab
 * - focusable:false → 永不抢焦点（代价：该窗口无法接收键盘输入）
 * - backgroundThrottling:false → 否则失焦后 rAF 停摆，宠物静止
 */
export function createPetWindow(canvas?: { w: number; h: number }): BrowserWindow {
  const existing = getPetWindow()
  if (existing) return existing

  const { width, height } = petWindowSize(canvas)
  const drop = primaryDropPoint(height)

  const win = new BrowserWindow({
    width,
    height,
    x: drop.x,
    y: drop.y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    title: '好屏友',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      devTools: !app.isPackaged
    }
  })

  // Windows 上 'screen-saver' 层级才能压住多数普通窗口与全屏应用
  win.setAlwaysOnTop(true, 'screen-saver')
  // 初始态：完全穿透，但要求 Electron 继续把 mousemove 转发给渲染进程，
  // 渲染进程才能自行判断光标是否落在宠物身上。
  win.setIgnoreMouseEvents(true, { forward: true })

  win.once('ready-to-show', () => {
    win.showInactive()
    log.info('宠物窗口已显示', `位置 ${drop.x},${drop.y}`, `尺寸 ${width}x${height}`)
  })

  // 全屏应用退出、虚拟桌面切换后置顶层级可能被系统回收，这里做幂等重设
  const reassert = (): void => {
    const current = getPetWindow()
    if (!current) return
    current.setAlwaysOnTop(true, 'screen-saver')
  }
  win.on('show', reassert)
  win.on('focus', reassert)

  win.on('closed', () => {
    petWindow = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(`${devUrl}/pet.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/pet.html'))
  }

  petWindow = win
  return win
}

/**
 * 按宠物画布调整窗口尺寸，**保持底边不动**。
 * 底边即「地面/抓取点」，位置由用户拖拽决定，不能被改窗口尺寸带跑。
 *
 * 注意：窗口是 resizable:false 的（透明窗口开 resize 会丢透明），这里只做程序化 setBounds。
 * 若系统的窗口样式导致设置不生效，渲染层会按实际 innerWidth/innerHeight 自适应布局，
 * 表现只是多出/少了一点留白，不会错位。
 */
export function resizePetWindow(canvas?: { w: number; h: number }): void {
  const win = getPetWindow()
  if (!win) return
  const { width, height } = petWindowSize(canvas)
  const bounds = win.getBounds()
  if (bounds.width === width && bounds.height === height) return
  win.setBounds({
    x: bounds.x,
    y: bounds.y + bounds.height - height,
    width,
    height
  })
  log.info('宠物窗口尺寸已同步画布', width, height)
}

export function setPetVisible(visible: boolean): void {
  const win = getPetWindow()
  if (!win) return
  if (visible) {
    win.showInactive()
    // 显示之后再通知：此刻渲染层已存在，才能立刻按主进程手里的光标位置重算命中
    visibilityListener?.(true)
  } else {
    // 隐藏之前先通知：让控制器把窗口**确定性**置回穿透态，两侧状态不留下分歧
    visibilityListener?.(false)
    win.hide()
  }
}

export function isPetVisible(): boolean {
  const win = getPetWindow()
  return !!win && win.isVisible()
}

export function togglePetVisible(): boolean {
  const next = !isPetVisible()
  setPetVisible(next)
  return next
}
