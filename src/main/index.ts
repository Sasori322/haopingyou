import { app, powerMonitor, screen, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { APP_ID } from '../shared/constants'
import type { PetState } from '../shared/types/pet'
import { registerClipboardSchemes, flushClipboard } from './clipboard'
import { unregisterClipboardHotkey } from './clipboard/clipboardHotkey'
import { petApp } from './pet/petApp'
import { builtinPetsRoot, getPet, userPetsRoot } from './pet/petLibrary'
import { handlePetAssetProtocol, registerPetAssetScheme } from './services/assetProtocol'
import { isAutostartLaunch } from './services/autostart'
import { gazeWatcher } from './services/gazeWatcher'
import { immersiveWatcher } from './services/immersiveWatcher'
import { notifier } from './services/notifier'
import { registerIpc } from './services/ipcRegistry'
import { reminderScheduler } from './services/reminderScheduler'
import { flushSettings, getSettings, patchSettings } from './services/settingsService'
import { createTray, destroyTray, refreshTray } from './services/tray'
import { createLogger } from './utils/logger'
import { createPetWindow, getPetWindow, setPetVisible } from './windows/petWindow'
import { openSettingsWindow } from './windows/settingsWindow'
import { closeClipboardPanel } from './windows/clipboardWindow'

const log = createLogger('main')

// ---- 以下三项必须在 app ready 之前完成 ----
// Chromium 的原生窗口遮挡计算可能把透明 / 被覆盖的置顶窗口判定为「不可见」而停止合成，
// 导致宠物莫名静止。这是 Windows 桌面挂件类应用的经典坑。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
// 必须与 electron-builder.yml 的 appId 一致，否则 Windows 通知不显示应用名/图标
app.setAppUserModelId(APP_ID)
// 统一使用 pet-asset:// 协议寻址宠物素材（协议必须在 ready 前注册特权）
registerPetAssetScheme()
// 同理：clipboard-img:// 让面板窗口能把图片塞进 <img>（canvas 也需要 corsEnabled）
registerClipboardSchemes()

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  log.info('已有实例在运行，本次启动退出')
  app.quit()
} else {
  start()
}

function start(): void {
  app.on('second-instance', () => {
    const win = getPetWindow()
    if (!win) return
    patchSettings({ petVisible: true })
    setPetVisible(true)
    petApp.speak('click', '我在这儿呢~')
    refreshTray()
  })

  // 托盘常驻应用：窗口全部关闭不退出
  app.on('window-all-closed', () => {
    log.info('所有窗口已关闭，托盘常驻继续运行')
  })

  app.on('before-quit', () => {
    flushSettings()
    petApp.detach()
    gazeWatcher.stop()
    reminderScheduler.stop()
    // 必须先停沉浸躲开：它会顺手把宠物恢复成用户意图，再销毁托盘
    immersiveWatcher.stop()
    // 关掉剪贴板面板（如果还在开），flush 落盘，停 watcher，解绑热键
    closeClipboardPanel()
    flushClipboardSafe()
    unregisterClipboardHotkey()
    destroyTray()
  })

  // 安全加固：一律拒绝打开新窗口与站外跳转
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      const devUrl = process.env['ELECTRON_RENDERER_URL']
      const allowed = url.startsWith('file://') || (!!devUrl && url.startsWith(devUrl))
      if (allowed) return
      event.preventDefault()
      if (url.startsWith('https://')) void shell.openExternal(url)
    })
  })

  app.whenReady().then(onReady).catch((error) => {
    log.error('启动失败', error)
    app.quit()
  })
}

function onReady(): void {
  handlePetAssetProtocol({ builtin: builtinPetsRoot(), user: userPetsRoot() })
  registerIpc()
  createTray()

  const settings = getSettings()

  const petWindow = createPetWindow(getPet(settings.activePetId)?.manifest.canvas)
  petApp.onStateChanged = () => refreshTray()
  petApp.attach(petWindow)
  petApp.loadPet(settings.activePetId)
  petApp.setState('idle', 'boot')

  // 鼠标跟随（主进程采样光标 → 下发方位；渲染层只负责表现）
  gazeWatcher.refresh()
  // 沉浸躲开：进程名单 / 全屏检测 / 手动安静，三条触发器共用一个评估循环
  immersiveWatcher.onVisibilityChanged = (hidden) => {
    refreshTray()
    // 沉浸刚结束：把挂起的提醒补出去。放在这里而不是让 notifier 自己轮询，
    // 是因为"沉浸结束"这个时刻只有 immersiveWatcher 知道。
    if (!hidden) notifier.flushPending()
  }
  immersiveWatcher.start()
  immersiveWatcher.refresh()

  // 提醒投递层必须先于调度器就绪：调度器一 tick 就可能往里投递
  notifier.start()
  notifier.onDelivered = () => refreshTray()
  reminderScheduler.start()

  // 剪贴板全局快捷键：注册由 initClipboard 内部完成（用设置里的 hotkey，
  // 而不是再写一份硬编码）。下面只是兜底：如果注册后又被用户改坏，记一行日志。
  // 失败的常见原因是快捷键被占用（QQ、截图工具），失败时静默不报错（用户可以走托盘入口）。

  maybeForceState()
  maybeCapturePetWindow(petWindow)
  maybeProbeSettingsWindow()
  maybeVerifyPointerBridge()

  watchDisplayAndPower()

  if (settings.petVisible === false) {
    setPetVisible(false)
  } else if (isAutostartLaunch()) {
    // 开机自启时静默启动：先藏着，3 秒后再露面，避免开机瞬间打扰。
    // 隐藏也走 setPetVisible —— 它是可见性变化的唯一收口，直接调 window.hide()
    // 会绕过穿透态复位（2026-10-14 修「宠物被藏过一次后点不动」时收敛掉的最后一个旁路）。
    setPetVisible(false)
    setTimeout(() => {
      petApp.speak('idle', '我回来啦~')
      setPetVisible(true)
    }, 3000)
  }
}

/**
 * 开发期诊断：设置 HPY_FORCE_STATE=<状态名> 时，把宠物持续钉在该状态。
 *
 * 用途：给「逐帧单独出图」的姿态族反推跨族缩放系数时，离线指标（头宽 / 描边粗细 / 眼睛）
 * 在侧视姿势上都会失真——实测同一只猫，眼睛说 1.42 倍、描边说 1.75 倍、颈部收窄法直接
 * 量到身体。**最终只能看真实渲染**：配合 `HPY_CAPTURE_PET` 把每个姿态族各截一张，
 * 同窗口尺寸下并排比，一眼就能看出是否忽大忽小。
 *
 * 持续重设是因为行为调度器会按自己的节奏抢状态；holdMs 取小值，
 * 否则非循环动画（click / eat）与不可打断动画（drag）的新状态会被推迟到 hold 结束。
 */
function maybeForceState(): void {
  const wanted = process.env['HPY_FORCE_STATE']
  if (!wanted) return
  if (!petApp.manifest?.animations[wanted]) {
    log.warn(`HPY_FORCE_STATE=${wanted} 不是当前宠物的合法动画状态，已忽略`)
    return
  }
  const timer = setInterval(() => petApp.setState(wanted as PetState, 'debug', 200), 200)
  app.on('before-quit', () => clearInterval(timer))
  log.info(`[debug] 已把宠物钉在状态：${wanted}`)
}

/**
 * 开发期诊断：设置 HPY_CAPTURE_PET=<png 输出路径> 时，等宠物窗口渲染完成后
 * 截取窗口自身内容（保留 alpha）并退出。
 *
 * 用途：Windows 上透明窗口最典型的失败模式就是「白底 / 灰色矩形轮廓」，
 * 这条自检能在不开 DevTools（DevTools 会破坏透明）的前提下验证透明是否成立。
 */
function maybeCapturePetWindow(win: BrowserWindow): void {
  const target = process.env['HPY_CAPTURE_PET']
  if (!target) return
  // 渲染层的报错不会出现在主进程日志里，这里把它转发出来，否则「窗口一片空白」无从定位
  win.webContents.on('console-message', (_event, level, message) => {
    log.info(`[renderer:${level}] ${message}`)
  })
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      const diagnostic = `(async () => {
        const hit = document.querySelector('.pet-hit')
        const cv = document.querySelector('canvas.pet-sheet')
        const fb = document.querySelector('.pet-fallback')
        const gazeEl = document.querySelector('.pet-gaze')
        let painted = 'n/a'
        if (cv) {
          try {
            const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
            let n = 0
            for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++
            painted = n
          } catch (e) { painted = 'THROW ' + e }
        }
        const url = 'pet-asset://builtin/cat/stand.png'
        const imageProbe = await new Promise((res) => {
          const img = new Image()
          img.onload = () => res('ok ' + img.naturalWidth + 'x' + img.naturalHeight)
          img.onerror = () => res('onerror')
          img.src = url
          setTimeout(() => res('timeout(1500ms)'), 1500)
        })
        let fetchProbe = 'n/a'
        try {
          const r = await fetch(url)
          const buf = await r.arrayBuffer()
          fetchProbe = r.status + ' ' + r.headers.get('content-type') + ' ' + buf.byteLength + 'B'
        } catch (e) { fetchProbe = 'THROW ' + e }
        // 直接把画布内容导出，绕开 capturePage —— 后者对 canvas 图层可能截到空帧
        let canvasDataUrl = ''
        if (cv) {
          try { canvasDataUrl = cv.toDataURL('image/png') } catch (e) { canvasDataUrl = 'THROW ' + e }
        }
        return JSON.stringify({
          win: [window.innerWidth, window.innerHeight],
          dpr: window.devicePixelRatio,
          hitRect: hit ? [hit.getBoundingClientRect().x, hit.getBoundingClientRect().y, hit.getBoundingClientRect().width, hit.getBoundingClientRect().height] : null,
          canvasBacking: cv ? [cv.width, cv.height] : null,
          canvasOpaquePixels: painted,
          fallback: !!fb,
          gazeWrap: gazeEl ? gazeEl.style.transform : 'MISSING',
          sheetTransform: cv ? cv.style.transform : 'MISSING',
          imageProbe,
          fetchProbe,
          canvasDataUrl
        }, null, 2)
      })()`
      void win.webContents
        .executeJavaScript(diagnostic, true)
        .then((info: unknown) => {
          const text = String(info)
          writeFileSync(`${target}.diag.json`, text)
          log.info('渲染层诊断：', text.replace(/\s+/g, ' '))
          try {
            const parsed = JSON.parse(text) as { canvasDataUrl?: string }
            const dataUrl = parsed.canvasDataUrl
            if (dataUrl?.startsWith('data:image/png;base64,')) {
              const canvasPath = target.replace(/\.png$/i, '.canvas.png')
              writeFileSync(canvasPath, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'))
              log.info('已保存画布导出：', canvasPath)
            }
          } catch (error) {
            log.warn('解析诊断结果失败', error)
          }
        })
        .catch((error: unknown) => log.warn('诊断脚本执行失败', error))
        .then(() =>
          win.webContents
            .capturePage()
            .then((image) => {
              writeFileSync(target, image.toPNG())
              log.info('已保存宠物窗口截图：', target)
              app.quit()
            })
            .catch((error: unknown) => {
              log.error('截图失败', error)
              app.quit()
            })
        )
    }, 1500)
  })
}

/**
 * 开发期诊断：设置 HPY_OPEN_SETTINGS=1 时自动打开设置窗口，把渲染层控制台转发到
 * 主进程日志，逐个路由 dump 关键 DOM 证据后退出。
 *
 * 用途：设置页唯一的入口是托盘菜单，手工路径太长；而且「页面一片空白」和「只是没数据」
 * 在日志里长得一样，所以这里必须有 DOM 证据（卡片标题 / 行数 / 正文长度）。
 */
function maybeProbeSettingsWindow(): void {
  if (!process.env['HPY_OPEN_SETTINGS']) return
  const win = openSettingsWindow()
  win.webContents.on('console-message', (event) => {
    log.info(`[settings:${event.level}] ${event.message}`)
  })
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      const probe = `(async () => {
        const routes = ['/pet', '/general', '/pomodoro', '/todo', '/clipboard', '/monitor']
        const out = []
        for (const route of routes) {
          location.hash = '#' + route
          await new Promise((resolve) => setTimeout(resolve, 700))
          const cards = [...document.querySelectorAll('.section-card')].map((el) => {
            const header = el.querySelector('.el-card__header')
            return header ? header.textContent.trim() : '(无标题)'
          })
          out.push({
            route,
            title: document.querySelector('.page-title')?.textContent ?? 'MISSING',
            cards,
            rows: document.querySelectorAll('.setting-row').length,
            controls: document.querySelectorAll('.setting-row__control').length,
            sliders: [...document.querySelectorAll('[role="slider"]')].map((el) => ({
              min: el.getAttribute('aria-valuemin'),
              max: el.getAttribute('aria-valuemax'),
              now: el.getAttribute('aria-valuenow')
            })),
            rowsText:
              route === '/general' || route === '/pomodoro'
                ? [...document.querySelectorAll('.setting-row')].map((el) =>
                    (el.innerText || '').replace(/\\s+/g, ' ').trim()
                  )
                : undefined,
            len: (document.querySelector('.page-title')?.parentElement?.innerText || '').length
          })
        }

        // 免打扰这条横切规则没法靠等待验证（要等 30 分钟才知道生效），
        // 所以在设置页上真的点一下那个按钮，走完整条 IPC 链路再回读状态。
        // 注意：上面循环结束时停在最后一个路由（/monitor），必须先切回 /pomodoro，
        // 否则页面上根本没有这个按钮（第一次实现就踩了这个坑，buttonFound=false）。
        location.hash = '#/pomodoro'
        await new Promise((resolve) => setTimeout(resolve, 700))
        const dndRow = () =>
          [...document.querySelectorAll('.setting-row')]
            .map((el) => (el.innerText || '').replace(/\\s+/g, ' ').trim())
            .find((text) => text.includes('免打扰'))
        const dndBefore = dndRow()
        const button = [...document.querySelectorAll('button')].find((el) =>
          (el.innerText || '').includes('免打扰 1 小时')
        )
        let dndAfter = null
        let dndFlag = null
        let dndSuppressed = null
        let dndRestored = null
        let waited = 0
        let deliveredKind = null
        if (button) {
          button.click()
          await new Promise((resolve) => setTimeout(resolve, 900))
          dndAfter = dndRow()
          dndFlag = (await window.petAPI.app.getReminderStatus()).dnd

          // 免打扰的核心承诺是"真的不弹"。只点一下看不出这件事（窗口太短，没有提醒可丢），
          // 所以把它挂满 28 秒 —— 足够覆盖加速模式下的久坐(20s)与喝水(25s)各一轮，
          // 这段时间里 last 必须一直不变。
          const beforeWait = (await window.petAPI.app.getReminderStatus()).last
          await new Promise((resolve) => setTimeout(resolve, 28000))
          const afterWait = (await window.petAPI.app.getReminderStatus()).last
          dndSuppressed = (beforeWait?.at ?? 0) === (afterWait?.at ?? 0)

          await window.petAPI.app.setDnd(null)
          dndRestored = (await window.petAPI.app.getReminderStatus()).dnd
        }

        // 恢复之后必须能立刻收到提醒，否则"丢弃"就变成了"吞掉"
        const lastRow = () =>
          [...document.querySelectorAll('.setting-row')]
            .map((el) => (el.innerText || '').replace(/\\s+/g, ' ').trim())
            .find((text) => text.includes('最近一次提醒'))
        let delivered = null
        while (waited < 40000) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          waited += 1000
          delivered = (await window.petAPI.app.getReminderStatus()).last
          if (delivered) break
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
        return JSON.stringify({
          routes: out,
          dndBefore,
          buttonFound: !!button,
          dndAfter,
          dndFlag,
          dndSuppressed,
          dndRestored,
          waited,
          deliveredKind: delivered ? delivered.kind : null,
          lastRow: lastRow()
        })
      })()`
      void win.webContents
        .executeJavaScript(probe, true)
        .then((info: unknown) => {
          const parsed = JSON.parse(String(info)) as {
            routes: Array<Record<string, unknown>>
            dndBefore: string | null
            buttonFound: boolean
            dndAfter: string | null
            dndFlag: boolean | null
            dndSuppressed: boolean | null
            dndRestored: boolean | null
            waited: number
            deliveredKind: string | null
            lastRow: string | null
          }
          for (const item of parsed.routes) {
            log.info(
              `设置页 ${item['route']}：标题「${item['title']}」卡片 ${JSON.stringify(item['cards'])} 行 ${item['rows']} 控件 ${item['controls']} 正文 ${item['len']} 字`
            )
            const sliders = item['sliders'] as Array<Record<string, string | null>>
            for (const slider of sliders) {
              log.info(`  滑块范围 min=${slider['min']} max=${slider['max']} 当前=${slider['now']}`)
            }
            const rowsText = item['rowsText'] as string[] | undefined
            for (const text of rowsText ?? []) log.info(`  · ${text}`)
          }
          log.info(`免打扰按钮存在：${parsed.buttonFound}`)
          log.info(`  点击前：${parsed.dndBefore}`)
          log.info(`  点击后：${parsed.dndAfter}`)
          log.info(`  主进程回读 dnd = ${parsed.dndFlag}；恢复后 dnd = ${parsed.dndRestored}`)
          log.info(`  免打扰挂满 28 秒期间没有新提醒落地：${parsed.dndSuppressed}`)
          log.info(
            `等待 ${parsed.waited}ms 收到提醒：${parsed.deliveredKind ?? '(未收到)'} → 「${parsed.lastRow}」`
          )
        })
        .catch((error: unknown) => log.warn('设置窗口诊断失败', error))
        .then(() => app.quit())
    }, 1200)
  })
}

/**
 * 开发期诊断：设置 HPY_VERIFY_POINTER=1 时，脚本化复现一次「藏 → 显」并打印穿透态轨迹后退出。
 *
 * 用途：缺陷「宠物被自动躲开藏过一次之后就点不动 / 拖不动」只在 hide/show 之后出现，
 * 手工复现要摸托盘菜单、时机还不稳定。这里直接藏 1 秒再显示，配合 `HPY_DEBUG_POINTER`
 * 打印的穿透态轨迹，一次就能看清两侧到底有没有失配、重同步有没有落地。
 *
 * 判读方法（关键）：看日志里"显示（已重同步指针）"之后有没有紧跟一次穿透态切换。
 * 若光标此刻**就压在宠物上**（日志里会打 `落窗口内=true`），那么正确表现是切到「可交互」；
 * 若光标在窗口外，正确表现是保持/回到「穿透」。光标在窗口内那次才是决定性的一次。
 */
function maybeVerifyPointerBridge(): void {
  if (!process.env['HPY_VERIFY_POINTER']) return
  setTimeout(() => {
    const win = getPetWindow()
    if (!win) return
    const ctl = petApp.controller
    const [w] = win.getSize()
    const cursor = screen.getCursorScreenPoint()
    // 先主动把宠物挪到光标底下。这一步是自检有没有意义的前提：光标若是落在窗口外，
    // 重同步切回「穿透」与旧代码的表现一模一样，根本测不出区别；
    // 只有"光标确实压在宠物身上"才能把"显示之后有没有回到可交互"变成决定性判据。
    // 纵向偏移取 240（站立族命中框约 y 108..280），这样即使窗口被工作区夹取，
    // 光标也仍落在命中框内。
    ctl.startDrag({ x: Math.round(w / 2), y: 240 })
    ctl.dragMove(cursor)
    ctl.endDrag()
    const b = win.getBounds()
    log.info(
      `[指针自检] 已把窗口摆到光标下：窗口 ${b.x},${b.y} ${b.width}x${b.height}`,
      `光标窗口内坐标 ${cursor.x - b.x},${cursor.y - b.y}`,
      `起点穿透态=${ctl.isIgnoringMouse ? '穿透' : '可交互'}`
    )
    setPetVisible(false)
    setTimeout(() => {
      setPetVisible(true)
      setTimeout(() => {
        log.info(
          `[指针自检] 藏→显之后 穿透态=${ctl.isIgnoringMouse ? '穿透' : '可交互'}`,
          '（全程没有任何真实 mousemove，光标未动）'
        )
        app.quit()
      }, 600)
    }, 1000)
  }, 3000)
}

/** 屏幕几何 / 任务栏 / DPI 变化，以及睡眠唤醒、解锁后，都要重新贴地并夹回可视区 */
function watchDisplayAndPower(): void {
  const reclamp = (): void => {
    petApp.controller.reclamp()
    // 唤醒 / 解锁 / 屏幕与任务栏变化之后，宠物可能被挪动过，而光标可能已经压在它身上
    // 却不再产生任何 mousemove —— 重同步一次，否则这一格永远不会被重新评估
    petApp.syncPointer()
    refreshTray()
  }
  screen.on('display-added', reclamp)
  screen.on('display-removed', reclamp)
  screen.on('display-metrics-changed', reclamp)
  powerMonitor.on('resume', reclamp)
  powerMonitor.on('unlock-screen', reclamp)
}

/** 退出前同步落盘 */
function flushClipboardSafe(): void {
  try {
    flushClipboard()
  } catch (error) {
    log.warn('flush 剪贴板历史失败', error)
  }
}
