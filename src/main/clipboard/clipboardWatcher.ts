import { app, clipboard } from 'electron'
import { createHash } from 'node:crypto'
import { createLogger } from '../utils/logger'
import type { ClipboardStore } from './clipboardStore'

const log = createLogger('clipWatch')

/**
 * 剪贴板轮询 watcher。
 *
 * 设计依据（见 `docs/STATUS.md` 三、待定 · 剪贴板历史 · 采集）：
 * ① 主进程轮询 `electron.clipboard`，800ms 起步；
 * ② 文本优先用 readText；只有 availableFormats 里含图片格式才 readImage，
 *    因为读图比读文本贵得多；
 * ③ 内容真变化才入 store（用"内容哈希"判等，不要直接比对对象）；
 * ④ 默认不采集图片，需要时手动开；
 * ⑤ 黑名单命中即丢——这个 watch 给 store 之前过滤；
 * ⑥ 总开关 / 暂停生效时仅停 timer，不删已采集条目。
 *
 * **没用全局键盘钩子**——那需要原生模块，跟项目硬约束冲突；
 * **也没读 clipboard owner**——同样需要 P/Invoke。
 * 这两处做不到的对采集/隐私的影响，必须老老实实告诉用户。
 */
const POLL_MS = 800

interface WatcherOptions {
  excludeKeywords: () => string[]
  listenImages: () => boolean
  enabled: () => boolean
  pausedUntilAt: () => number
  source: () => string
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/bmp', 'image/webp']

export class ClipboardWatcher {
  private store: ClipboardStore
  private options: WatcherOptions
  private timer: NodeJS.Timeout | null = null
  private inFlight = false
  private lastTextHash = ''
  private lastImageHash = ''
  private blacklistRegexp: RegExp | null = null
  private blacklistSignature = ''

  constructor(store: ClipboardStore, options: WatcherOptions) {
    this.store = store
    this.options = options
  }

  start(): void {
    if (this.timer) return
    if (!this.options.enabled()) {
      log.info('剪贴板采集已关闭，跳过启动')
      return
    }
    void this.tick().finally(() => {
      this.timer = setInterval(() => {
        void this.tick()
      }, POLL_MS)
      log.info('剪贴板采集已启动 800ms/次')
    })
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    log.info('剪贴板采集已停止')
  }

  /**
   * 设置可能改了，调一次：让 watcher 立即生效（启停 / 黑名单刷新 / 采图开关翻转）。
   * 实现策略：先停再按当前配置决定是否再起；副作用是下个 tick 会立刻跑一次（等于"补一次"）。
   */
  refresh(): void {
    const wasRunning = this.timer !== null
    if (wasRunning) this.stop()
    this.blacklistRegexp = null
    this.blacklistSignature = ''
    if (this.options.enabled()) {
      this.start()
    } else if (wasRunning) {
      log.info('剪贴板总开关已关，已停采集')
    }
  }

  /**
   * 一次 tick 必须是串行的：Electron 44 的 clipboard API 全是 Promise，
   * 防止上一轮没跑完下一轮又来（interval 800ms 但 await 期间可能拖过 800ms）。
   */
  private async tick(): Promise<void> {
    if (this.inFlight) return
    if (!this.options.enabled()) return
    if (!app.isReady()) return
    if (this.isPaused()) return
    this.inFlight = true
    try {
      await this.tickText()
      if (this.options.listenImages()) await this.tickImage()
    } finally {
      this.inFlight = false
    }
  }

  private async tickText(): Promise<void> {
    try {
      const text = await clipboard.readText()
      if (!text) return
      const hash = createHash('sha1').update(text, 'utf8').digest('hex')
      if (hash === this.lastTextHash) return
      this.lastTextHash = hash
      if (this.hitsBlacklist(text)) {
        log.info('剪贴板文本命中黑名单，已丢弃 长度', text.length)
        return
      }
      const result = this.store.addText({ text, source: this.options.source() })
      if (result.added) log.info('剪贴板捕获文本', text.length, '字节')
    } catch (error) {
      log.warn('读取文本剪贴板失败：', error)
    }
  }

  private async tickImage(): Promise<void> {
    try {
      const items = await clipboard.read()
      for (const item of items) {
        const imageType = item.types.find((t) => IMAGE_TYPES.includes(t))
        if (!imageType) continue
        const blob = (await item.getType(imageType)) as Blob
        const buf = Buffer.from(await blob.arrayBuffer())
        if (buf.length === 0) continue
        const hash = createHash('sha1').update(buf).digest('hex')
        if (hash === this.lastImageHash) return
        this.lastImageHash = hash
        // 只支持 PNG 落盘：Electron 提供的位图天然按平台位深，跨设备最稳的是 PNG。
        // 如来源不是 PNG，统一用 sharp/canvas 重编码开销太大，这里退回到"原样存原 MIME"。
        // 出于简化，**图片内容一律按 PNG 保存**——若来源不是 PNG 会丢色彩，
        // 我们目前只处理 PNG，jpeg 等"看下一版要不要做"。
        if (imageType !== 'image/png') {
          log.info('剪贴板图片非 PNG，跳过（仅采集 PNG）', imageType, buf.length, '字节')
          return
        }
        const result = this.store.addImage({ png: buf, source: this.options.source() })
        if (result.added) log.info('剪贴板捕获图片', buf.length, '字节')
        // 一次轮询只取一张图，避免图片大时阻塞下一轮
        break
      }
    } catch (error) {
      log.warn('读取图片剪贴板失败：', error)
    }
  }

  /** 关键字任一命中即丢；纯大小写不敏感的 substring 匹配 */
  private hitsBlacklist(text: string): boolean {
    const keywords = this.options.excludeKeywords()
    if (keywords.length === 0) return false
    const sig = keywords.join('\u0001')
    if (sig !== this.blacklistSignature) {
      const escaped = keywords
        .filter((k) => k.length > 0)
        .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      if (escaped.length === 0) {
        this.blacklistRegexp = null
        this.blacklistSignature = sig
        return false
      }
      this.blacklistRegexp = new RegExp(escaped.join('|'), 'i')
      this.blacklistSignature = sig
    }
    if (!this.blacklistRegexp) return false
    return this.blacklistRegexp.test(text)
  }

  private isPaused(): boolean {
    const until = this.options.pausedUntilAt()
    if (until === 0) return false
    if (Date.now() >= until) return false
    return true
  }
}
