import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { screen } from 'electron'
import { FULLSCREEN_PROBE_INTERVAL_MS, FULLSCREEN_PROBE_STALE_MS } from '../../shared/constants'
import { createLogger } from '../utils/logger'

const log = createLogger('foreground')

/**
 * 前台窗口探针：常驻一个 PowerShell 辅助进程，报告两件事
 *
 *   1. 前台窗口的矩形（判断"是否铺满整屏"）
 *   2. 用户名单里的进程是否在运行
 *
 * ## 为什么是这个方案
 * Electron **没有任何 API** 能拿到别的进程的前台窗口矩形，而本项目有一条硬约束：
 * **不引原生模块**（不做 electron-rebuild、不依赖 VS Build Tools）。所以只剩两条路：
 * PowerShell 辅助进程，或者放弃这个功能。
 *
 * ## 实测数据（Windows 10 19041 / PowerShell 5.1 FullLanguage）
 * - 载入 UIAutomation 程序集：12.7ms（进程内一次性）
 * - 首次 `FocusedElement`：95ms（冷启动），**之后每次 1–2ms**
 * - ⚠️ **绝对不要读 `Current.Name`（窗口标题）**：那是跨进程编组，单次约 290ms，
 *   轮询会把一个核心吃满。只要句柄和矩形就足够判断全屏。
 * - ⚠️ **不要用 `tasklist` 轮询进程**：实测稳定 530–700ms/次，代价比 UIAutomation 高两个数量级。
 *   名单匹配改用 `Get-Process -Name`（按名字查，只查关心的那几个，而不是枚举 344 个进程）。
 *
 * ## 安全与稳定性
 * - 只用到 PowerShell 自带的 `LoadWithPartialName` 反射载入系统程序集，**不用 Add-Type、不编译任何 C#**
 *   （企业策略常拦 Add-Type / 约束语言模式）。
 * - 脚本以 ASCII 通过 `-EncodedCommand`（base64 UTF-16LE）传入，绕开引号与编码问题
 *   —— 中文写在 .ps1 里会被 PowerShell 5.1 按 GBK 读串，这个坑已经踩过。
 * - 进程名单由 `sanitizeSettingsPatch` 限制字符集后才会进到这里，并再做一次单引号转义。
 *
 * 判定"铺满整屏"放在 Node 侧做（Electron 的 screen API 才是显示器的权威来源），
 * 辅助进程只负责吐一个矩形，职责单一。
 */
class ForegroundProbe {
  private child: ChildProcess | null = null
  private buffer = ''
  private snapshot: ForegroundSnapshot | null = null
  private ready = false
  private names: string[] = []
  private wants = false
  private startedAt = 0
  /** 连续失败次数达到上限后进入冷却，避免"起不来就疯狂重启" */
  private failures = 0
  private nextAttemptAt = 0
  private watchdog: NodeJS.Timeout | null = null

  get isRunning(): boolean {
    return !!this.child
  }

  get isAvailable(): boolean {
    return this.ready && this.fresh()
  }

  /** 最近一次快照（可能为 null / 过期） */
  get lastSnapshot(): ForegroundSnapshot | null {
    return this.snapshot
  }

  /**
   * 按设置启停。名单变化时重启辅助进程（名单是编译进脚本的，改不了运行中的进程）。
   */
  refresh(enabled: boolean, names: string[]): void {
    this.wants = enabled
    const changed = names.join('\u0000') !== this.names.join('\u0000')
    this.names = names
    if (!enabled) {
      this.stop()
      return
    }
    if (this.child && changed) {
      log.info('进程名单已变化，重启辅助进程')
      this.killChild()
      this.ready = false
    }
    if (!this.child) this.ensureChild()
  }

  stop(): void {
    this.killChild()
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
    this.snapshot = null
    this.ready = false
    this.failures = 0
    this.nextAttemptAt = 0
  }

  /** 前台窗口是否铺满某一块显示器 */
  isForegroundFullscreen(): boolean {
    const snap = this.snapshot
    if (!snap || !this.fresh() || snap.w <= 0 || snap.h <= 0 || snap.hwnd === 0) return false

    for (const display of screen.getAllDisplays()) {
      const b = display.bounds
      const wa = display.workArea
      // 任务栏设为自动隐藏时 workArea 与 bounds 完全重合，此时「最大化」与「真全屏」
      // 的窗口矩形一模一样 → 无法区分，索性不下判断，避免把正常工作状态误判成全屏。
      if (wa.width === b.width && wa.height === b.height) continue

      const slop = 12
      if (
        snap.x <= b.x + slop &&
        snap.y <= b.y + slop &&
        snap.x + snap.w >= b.x + b.width - slop &&
        snap.y + snap.h >= b.y + b.height - slop
      ) {
        return true
      }
    }
    return false
  }

  // ---------------- 内部 ----------------

  private fresh(): boolean {
    return !!this.snapshot && Date.now() - this.snapshot.at < FULLSCREEN_PROBE_STALE_MS
  }

  private ensureChild(): void {
    if (this.child || !this.wants) return
    if (Date.now() < this.nextAttemptAt) return

    const script = buildScript(this.names, FULLSCREEN_PROBE_INTERVAL_MS)
    const encoded = Buffer.from(script, 'utf16le').toString('base64')

    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      this.child = child
      this.buffer = ''
      this.startedAt = Date.now()

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => this.consume(chunk))
      child.stderr?.on('data', (chunk: string) => {
        const text = String(chunk).trim()
        // PowerShell 会往 stderr 打一段 CLIXML 头（它的错误流封装），不是真错误，别刷屏
        if (text && !text.startsWith('#< CLIXML')) log.warn('辅助进程 stderr：', text.slice(0, 300))
      })
      child.on('error', (error) => {
        log.warn('辅助进程启动失败：', error.message)
        this.child = null
        this.registerFailure()
      })
      child.on('exit', (code) => {
        this.child = null
        this.ready = false
        if (this.wants) {
          log.warn('辅助进程已退出，退出码', code)
          this.registerFailure()
        }
      })
      log.info('前台窗口探针已启动', this.names.length > 0 ? `名单 ${this.names.join(', ')}` : '（名单为空）')
    } catch (error) {
      log.warn('无法启动辅助进程', error)
      this.registerFailure()
    }

    this.startWatchdog()
  }

  private startWatchdog(): void {
    if (this.watchdog) return
    this.watchdog = setInterval(() => {
      if (!this.wants) return
      if (!this.child) {
        this.ensureChild()
        return
      }
      // 活着但很久没回话：UIA 调用可能在目标进程卡住，重启比等着强
      const lastAt = this.snapshot?.at ?? this.startedAt
      if (Date.now() - lastAt > FULLSCREEN_PROBE_STALE_MS) {
        log.warn('辅助进程超时未回话，重启')
        this.killChild()
        this.registerFailure()
      }
    }, Math.round(FULLSCREEN_PROBE_STALE_MS / 2))
  }

  private registerFailure(): void {
    this.failures += 1
    if (this.failures >= 3) {
      // 冷却 2 分钟后自然重试；设置页会显示"全屏检测不可用"
      this.nextAttemptAt = Date.now() + 2 * 60 * 1000
      this.failures = 0
      log.warn('全屏检测连续失败，暂停 2 分钟后再试（不影响进程名单与手动安静）')
    } else {
      this.nextAttemptAt = Date.now() + 3000
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.handleLine(line)
      index = this.buffer.indexOf('\n')
    }
    // 防御：如果辅助进程一直不换行，别让 buffer 无限涨
    if (this.buffer.length > 4096) this.buffer = ''
  }

  private handleLine(line: string): void {
    if (line === 'READY') {
      this.ready = true
      this.failures = 0
      log.info('辅助进程就绪')
      return
    }
    if (!line.startsWith('FG ')) return
    const parts = line.split(' ')
    if (parts.length < 7) return
    const hits = parts[6] === '-' ? [] : parts[6].split(',').filter(Boolean)
    this.snapshot = {
      hwnd: Number(parts[1]) || 0,
      x: Number(parts[2]) || 0,
      y: Number(parts[3]) || 0,
      w: Number(parts[4]) || 0,
      h: Number(parts[5]) || 0,
      hits,
      at: Date.now()
    }
  }

  private killChild(): void {
    const child = this.child
    this.child = null
    this.ready = false
    if (!child) return
    try {
      child.removeAllListeners('exit')
      child.kill()
    } catch {
      // 进程可能已经没了，忽略
    }
  }
}

export interface ForegroundSnapshot {
  /** 前台窗口句柄（0 = 取不到，例如焦点在桌面） */
  hwnd: number
  x: number
  y: number
  w: number
  h: number
  /** 名单里命中的进程名 */
  hits: string[]
  at: number
}

/**
 * 生成辅助进程脚本。**全 ASCII**——中文在 .ps1 / -Command 里会被 PowerShell 5.1 按 GBK 读串。
 */
function buildScript(names: string[], intervalMs: number): string {
  const list = names.map((name) => `'${name.replace(/'/g, "''")}'`).join(',')
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `[void][Reflection.Assembly]::LoadWithPartialName('UIAutomationClient')`,
    `[void][Reflection.Assembly]::LoadWithPartialName('UIAutomationTypes')`,
    `$names = @(${list})`,
    `[Console]::Out.WriteLine('READY')`,
    `[Console]::Out.Flush()`,
    `while ($true) {`,
    `  $id = 0; $x = 0; $y = 0; $w = 0; $h = 0`,
    `  try {`,
    `    $f = [System.Windows.Automation.AutomationElement]::FocusedElement`,
    `    if ($null -ne $f) {`,
    `      $id = [int]$f.Current.NativeWindowHandle`,
    `      $r = $f.Current.BoundingRectangle`,
    `      $x = [int][math]::Round($r.X)`,
    `      $y = [int][math]::Round($r.Y)`,
    `      $w = [int][math]::Round($r.Width)`,
    `      $h = [int][math]::Round($r.Height)`,
    `    }`,
    `  } catch { $id = 0 }`,
    `  $hits = '-'`,
    `  if ($names.Count -gt 0) {`,
    `    $found = @()`,
    `    foreach ($n in $names) { if (Get-Process -Name $n -ErrorAction SilentlyContinue) { $found += $n } }`,
    `    if ($found.Count -gt 0) { $hits = ($found -join ',') }`,
    `  }`,
    `  [Console]::Out.WriteLine('FG ' + $id + ' ' + $x + ' ' + $y + ' ' + $w + ' ' + $h + ' ' + $hits)`,
    `  [Console]::Out.Flush()`,
    `  Start-Sleep -Milliseconds ${intervalMs}`,
    `}`
  ].join('\r\n')
}

export const foregroundProbe = new ForegroundProbe()
