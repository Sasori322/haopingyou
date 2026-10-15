import { app, Menu, Tray, nativeImage } from 'electron'
import type { MenuItemConstructorOptions, NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { PRODUCT_NAME, DND_PRESET_MINUTES } from '../../shared/constants'
import { IPC } from '../../shared/ipc'
import type { PetState } from '../../shared/types/pet'
import { petApp } from '../pet/petApp'
import { listPetSummaries } from '../pet/petLibrary'
import { createLogger } from '../utils/logger'
import { resourcePath } from '../utils/paths'
import { isPetVisible, setPetVisible, togglePetVisible } from '../windows/petWindow'
import { broadcast, openSettingsWindow } from '../windows/settingsWindow'
import { getAutostart, isAutostartSupported, setAutostart } from './autostart'
import { immersiveWatcher } from './immersiveWatcher'
import { notifier } from './notifier'
import { getSettings, patchSettings } from './settingsService'
import { openClipboardPanel } from '../windows/clipboardWindow'
import { openTodoPanel, toggleTodoPanel } from '../windows/todoPanelWindow'

const log = createLogger('tray')

/** 必须存模块级变量，否则托盘图标会被 GC 回收后从任务栏消失 */
let tray: Tray | null = null

const STATE_LABEL: Record<PetState, string> = {
  idle: '空闲',
  walk: '散步中',
  sleep: '睡觉中',
  eat: '吃东西',
  drag: '被拎起来了',
  click: '被戳了',
  focus: '专注陪伴中',
  rest: '提醒休息',
  hot: '有点吃力'
}

function loadTrayIcon(): NativeImage {
  const file = resourcePath('icons', 'tray.png')
  if (!existsSync(file)) {
    log.error('托盘图标缺失：', file)
    return nativeImage.createEmpty()
  }
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) log.error('托盘图标无法解析：', file)
  return image
}

function notifySettingsChanged(): void {
  broadcast(IPC.SETTINGS_CHANGED, getSettings())
}

function selectPet(petId: string): void {
  patchSettings({ activePetId: petId })
  petApp.loadPet(petId)
  petApp.idle()
  notifySettingsChanged()
  refreshTray()
}

/** 手动让宠物躲开：minutes = null 表示立刻恢复 */
function quietFor(minutes: number | null): void {
  if (minutes === null) {
    patchSettings({ petVisible: true })
  }
  immersiveWatcher.quiet(minutes)
  // quiet 之后宠物窗口的可见性由评估循环决定，托盘文案要跟着刷新
  refreshTray()
}

/**
 * 免打扰：只停提醒，宠物照常在桌面上。
 * 与上面「让宠物躲开」是两件事，所以刻意做成两个并列入口 —— 合成一个会让用户
 * （想安静工作但还想要猫陪着）只能二选一。
 */
function snoozeFor(minutes: number | null): void {
  notifier.snooze(minutes)
  refreshTray()
}

/** 免打扰菜单项的标题与子项，托盘菜单与宠物右键菜单共用，避免两处文案漂移 */
function dndMenuItems(): MenuItemConstructorOptions[] {
  const until = notifier.dndUntilAt
  const remainMin = until > 0 ? Math.max(1, Math.ceil((until - Date.now()) / 60_000)) : 0
  return [
    {
      label: remainMin > 0 ? `免打扰提醒（剩 ${remainMin} 分钟）` : '免打扰提醒',
      submenu: [
        ...DND_PRESET_MINUTES.map((minutes) => ({
          label: `${minutes} 分钟`,
          click: () => snoozeFor(minutes)
        })),
        { type: 'separator' as const },
        { label: '现在恢复提醒', click: () => snoozeFor(null) }
      ]
    }
  ]
}

function buildTemplate(): MenuItemConstructorOptions[] {
  const pets = listPetSummaries()

  const petItems: MenuItemConstructorOptions[] =
    pets.length > 0
      ? pets.map((pet) => ({
          label: pet.hasAssets ? pet.name : `${pet.name}（待补充素材）`,
          type: 'radio' as const,
          checked: pet.id === petApp.currentPetId,
          click: () => selectPet(pet.id)
        }))
      : [{ label: '未找到宠物素材', enabled: false }]

  return [
    {
      // 沉浸躲开期间点这一项是「把它叫回来」：给出豁免窗口，否则下一个 tick 又会被自动藏回去
      label: immersiveWatcher.isHidden
        ? '显示宠物（已自动让路）'
        : isPetVisible()
          ? '隐藏宠物'
          : '显示宠物',
      click: () => {
        if (immersiveWatcher.isHidden) {
          patchSettings({ petVisible: true })
          setPetVisible(true)
          immersiveWatcher.suppress()
        } else {
          patchSettings({ petVisible: togglePetVisible() })
        }
        refreshTray()
      }
    },
    { type: 'separator' },
    { label: '更换宠物', submenu: petItems },
    {
      label: '行为',
      submenu: [
        { label: '走动', click: () => petApp.startWalk(Math.random() < 0.5 ? -1 : 1, 3500) },
        { label: '睡觉', click: () => petApp.sleep() },
        { label: '吃饭', click: () => petApp.eat() },
        { label: '说句话', click: () => petApp.speak(petApp.currentState) }
      ]
    },
    {
      label: '让宠物躲开',
      submenu: [
        { label: '30 分钟', click: () => quietFor(30) },
        { label: '1 小时', click: () => quietFor(60) },
        { type: 'separator' },
        { label: '现在就让它回来', click: () => quietFor(null) }
      ]
    },
    ...dndMenuItems(),
    { type: 'separator' },
    { label: '剪贴板历史…', click: () => openClipboardPanel() },
    { label: '待办与便签面板…', click: () => toggleTodoPanel() },
    { type: 'separator' },
    { label: '设置…', click: () => openSettingsWindow() },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: getAutostart(),
      enabled: isAutostartSupported(),
      click: (item) => {
        const actual = setAutostart(item.checked)
        patchSettings({ autostart: actual })
        notifySettingsChanged()
        refreshTray()
      }
    },
    { type: 'separator' },
    { label: `关于 ${PRODUCT_NAME} v${app.getVersion()}`, enabled: false },
    {
      label: '退出',
      click: () => {
        app.quit()
      }
    }
  ]
}

export function refreshTray(): void {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate(buildTemplate()))
  const state = STATE_LABEL[petApp.currentState] ?? petApp.currentState
  // 提示语按优先级串起来：宠物昵称 → 宠物状态 → 是否自动让路 → 是否免打扰
  tray.setToolTip(
    `${PRODUCT_NAME} · ${petApp.displayName} · ${state}${immersiveWatcher.isHidden ? ' · 已让路' : ''}${notifier.isDnd ? ' · 免打扰' : ''}`
  )
}

export function createTray(): void {
  if (tray) return
  tray = new Tray(loadTrayIcon())
  tray.setToolTip(`${PRODUCT_NAME} · ${petApp.displayName} · ${STATE_LABEL.idle}`)
  tray.setContextMenu(Menu.buildFromTemplate(buildTemplate()))
  tray.on('click', () => {
    setPetVisible(togglePetVisible())
    refreshTray()
  })
  tray.on('right-click', () => refreshTray())
  log.info('托盘已创建')
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

/**
 * 宠物窗口右键 → 主进程弹出原生菜单。
 *
 * 两个刻意的选择：
 *
 * 1) **不传 x / y**。`menu.popup({ x, y })` 里的 x/y 是**窗口客户区坐标**，Electron 内部会
 *    用 `ClientToScreen` 把它换算成屏幕坐标；而渲染层能拿到的是 `screenX/screenY`（已是屏幕坐标）。
 *    两者混用等于「窗口左上角 + 屏幕坐标」，菜单会被推到宠物右下很远的地方。
 *    不传坐标时 Electron 直接取系统当前光标位置 —— 右键点在哪，菜单就出现在哪。
 *
 * 2) **不把宠物窗口设为菜单的 owner**。宠物窗口是 `focusable: false`，
 *    交给它承载原生菜单可能导致菜单收不到输入；保持默认（聚焦窗口）更稳。
 */
export function popupPetMenu(): void {
  const menu = Menu.buildFromTemplate([
    { label: '说句话', click: () => petApp.speak(petApp.currentState) },
    { label: '让它走走', click: () => petApp.startWalk(Math.random() < 0.5 ? -1 : 1, 3500) },
    { label: '让它睡觉', click: () => petApp.sleep() },
    { label: '喂点东西', click: () => petApp.eat() },
    { type: 'separator' },
    // 「与宠物联动」那条 PRD：宠物右键即可快速添加一条待办。
    // 实现是"打开面板并把光标落到快速录入框"，而不是在菜单里做一个输入框 ——
    // 原生菜单承载不了带校验的文本输入，用完还得再想办法回收，不如复用面板。
    { label: '记一条待办…', click: () => openTodoPanel({ focusQuickAdd: true }) },
    { type: 'separator' },
    {
      label: '让宠物躲开',
      submenu: [
        { label: '30 分钟', click: () => quietFor(30) },
        { label: '1 小时', click: () => quietFor(60) },
        { type: 'separator' },
        { label: '现在就让它回来', click: () => quietFor(null) }
      ]
    },
    ...dndMenuItems(),
    {
      label: '隐藏宠物',
      click: () => {
        patchSettings({ petVisible: false })
        setPetVisible(false)
        refreshTray()
      }
    },
    { label: '设置…', click: () => openSettingsWindow() }
  ])
  menu.popup()
}
