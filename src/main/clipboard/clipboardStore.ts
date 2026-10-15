import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createLogger } from '../utils/logger'
import {
  CLIPBOARD_MAX_AGE_DAYS,
  CLIPBOARD_MAX_ENTRIES,
  CLIPBOARD_PREVIEW_CHARS,
  CLIPBOARD_TEXT_LIMIT_BYTES
} from '../../shared/types/clipboard'
import type { ClipboardEntry, ClipboardKind } from '../../shared/types/clipboard'

const log = createLogger('clipStore')

/**
 * 剪贴板历史的元数据持久化形态：单 JSON 文件，原子写。
 *
 * 选择"单文件"而不是 sqlite 的理由（与 STATUS.md 的判断一致）：
 * ① 列表最大 100 条、字段少且稳定，JSON 完全够；
 * ② "加宠物零代码"的判断线是"读目录/扫 manifest"——这里与之对称，
 *    单文件清单天然可比；
 * ③ 真到了要全文检索（比如全文搜索历史剪贴板），那是用户主动换的情境，
 *    数据迁 sqlite 是该换时再做。
 *
 * 图片二进制不进这个文件，单独落 PNG。
 */
interface PersistedShape {
  entries: ClipboardEntry[]
}

export interface AddTextInput {
  text: string
  source: string
}

export interface AddImageInput {
  /** 已是 PNG bytes */
  png: Buffer
  source: string
}

export class ClipboardStore {
  private readonly dir: string
  private readonly imgDir: string
  private readonly metaFile: string
  private entries: ClipboardEntry[]
  private writeTimer: NodeJS.Timeout | null = null

  /**
   * @param dir 历史与图片的存储根目录（含 `clipboard.json` 与 `img/`），
   *           调用方负责确保这个目录**已经存在且可写**。无效路径会让后续写盘直接抛。
   */
  constructor(dir: string) {
    this.dir = dir
    this.imgDir = join(this.dir, 'img')
    this.metaFile = join(this.dir, 'clipboard.json')
    mkdirSync(this.imgDir, { recursive: true })
    this.entries = this.load()
  }

  /** 给设置页/UI 用的元信息 */
  meta(): {
    path: string
    imgDir: string
  } {
    return { path: this.metaFile, imgDir: this.imgDir }
  }

  list(): ClipboardEntry[] {
    return this.entries.map((e) => ({ ...e }))
  }

  count(): number {
    return this.entries.length
  }

  /**
   * 加入一条文本。命中 hash 去重 → 提到队首不新增；超出文本上限 → 截断+打 truncated。
   * 落淘汰由 `enforcePolicy()` 自动做。
   */
  addText(input: AddTextInput): { added: boolean; id: string } {
    const text = input.text.replace(/\r\n/g, '\n')
    const hash = sha1(text)
    const existing = this.entries.find((e) => e.hash === hash)
    if (existing) {
      // 提到队首：先摘出来再插队
      this.entries = this.entries.filter((e) => e.id !== existing.id)
      existing.at = Date.now()
      existing.source = input.source || existing.source
      this.entries.unshift(existing)
      this.scheduleWrite()
      return { added: false, id: existing.id }
    }
    const truncated = Buffer.byteLength(text, 'utf8') > CLIPBOARD_TEXT_LIMIT_BYTES
    const body = truncated
      ? Buffer.from(text, 'utf8').subarray(0, CLIPBOARD_TEXT_LIMIT_BYTES).toString('utf8') + '\n…[过长已截断]'
      : text
    const entry: ClipboardEntry = {
      id: makeId('t'),
      kind: 'text',
      preview: makePreview(body),
      payloadRef: body,
      hash,
      at: Date.now(),
      pinned: false,
      source: input.source,
      ...(truncated ? { truncated: true } : {})
    }
    this.entries.unshift(entry)
    this.enforcePolicy()
    this.scheduleWrite()
    return { added: true, id: entry.id }
  }

  /**
   * 加入一张图片：先把 PNG 落盘，再插入条目。
   * 同样去重 —— 同样的 PNG 字节不会变成两条记录。
   */
  addImage(input: AddImageInput): { added: boolean; id: string } {
    const hash = sha1(input.png.toString('base64'))
    const existing = this.entries.find((e) => e.hash === hash)
    if (existing) {
      this.entries = this.entries.filter((e) => e.id !== existing.id)
      existing.at = Date.now()
      existing.source = input.source || existing.source
      this.entries.unshift(existing)
      this.scheduleWrite()
      return { added: false, id: existing.id }
    }
    const id = makeId('i')
    const filename = `${id}.png`
    const target = join(this.imgDir, filename)
    writeFileSync(target, input.png)
    const entry: ClipboardEntry = {
      id,
      kind: 'image',
      preview: '[图片]',
      payloadRef: filename,
      hash,
      at: Date.now(),
      pinned: false,
      source: input.source
    }
    this.entries.unshift(entry)
    this.enforcePolicy()
    this.scheduleWrite()
    return { added: true, id }
  }

  /** 把条目内容回写到主进程内存（即将由 watcher 帮你 writeText） */
  readPayload(id: string): { kind: ClipboardKind; text: string; pngPath: string | null } | null {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return null
    if (entry.kind === 'image') {
      const file = join(this.imgDir, entry.payloadRef)
      return { kind: 'image', text: '', pngPath: existsSync(file) ? file : null }
    }
    return { kind: entry.kind, text: entry.payloadRef, pngPath: null }
  }

  delete(id: string): boolean {
    const idx = this.entries.findIndex((e) => e.id === id)
    if (idx < 0) return false
    const entry = this.entries[idx]
    this.entries.splice(idx, 1)
    if (entry.kind === 'image') {
      const file = join(this.imgDir, entry.payloadRef)
      if (existsSync(file)) {
        try {
          unlinkSync(file)
        } catch (error) {
          log.warn('删除图片失败：', file, error)
        }
      }
    }
    this.scheduleWrite()
    return true
  }

  togglePin(id: string): boolean {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return false
    entry.pinned = !entry.pinned
    this.scheduleWrite()
    return true
  }

  clearAll(): number {
    const removed = this.entries.filter((e) => !e.pinned)
    this.entries = this.entries.filter((e) => e.pinned)
    for (const e of removed) {
      if (e.kind === 'image') {
        const file = join(this.imgDir, e.payloadRef)
        if (existsSync(file)) {
          try {
            unlinkSync(file)
          } catch (error) {
            log.warn('清空时删图失败：', file, error)
          }
        }
      }
    }
    this.scheduleWrite()
    return removed.length
  }

  /** 进程退出前同步落盘 */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    this.writeNow()
  }

  // ---------- 内部 ----------

  private load(): ClipboardEntry[] {
    try {
      if (existsSync(this.metaFile)) {
        const raw = JSON.parse(readFileSync(this.metaFile, 'utf8')) as PersistedShape
        if (Array.isArray(raw.entries)) return raw.entries
      }
    } catch (error) {
      log.warn('读取剪贴板历史失败，回退空列表：', error)
    }
    return []
  }

  /**
   * 淘汰策略：100 条 / 30 天双重封顶。
   * pinned 跳过；先按 at 升序排序，逐项删到满足上限为止；超龄的都删。
   */
  private enforcePolicy(): void {
    const cutoff = Date.now() - CLIPBOARD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
    // 先清超龄（pinned 跳过）
    const survivors = this.entries.filter((e) => e.pinned || e.at >= cutoff)
    const droppedByAge = this.entries.filter((e) => !e.pinned && e.at < cutoff)
    for (const e of droppedByAge) {
      if (e.kind === 'image') {
        const file = join(this.imgDir, e.payloadRef)
        if (existsSync(file)) {
          try {
            unlinkSync(file)
          } catch (error) {
            log.warn('超龄删图失败：', file, error)
          }
        }
      }
    }
    // 再按数量裁剪
    const over = survivors.length - CLIPBOARD_MAX_ENTRIES
    if (over > 0) {
      // pinned 保留在前；其余按 at 升序淘汰
      const ranked = survivors
        .map((e, idx) => ({ e, idx }))
        .sort((a, b) => {
          if (a.e.pinned !== b.e.pinned) return a.e.pinned ? -1 : 1
          return a.e.at - b.e.at
        })
      const removeIdx = new Set(ranked.slice(0, over).map((x) => x.idx))
      const final = survivors.filter((_, idx) => !removeIdx.has(idx))
      for (const e of survivors.filter((_, idx) => removeIdx.has(idx))) {
        if (e.kind === 'image') {
          const file = join(this.imgDir, e.payloadRef)
          if (existsSync(file)) {
            try {
              unlinkSync(file)
            } catch (error) {
              log.warn('超量删图失败：', file, error)
            }
          }
        }
      }
      this.entries = final
    } else {
      this.entries = survivors
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.writeNow()
    }, 180)
  }

  private writeNow(): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.metaFile}.tmp`
      const payload: PersistedShape = { entries: this.entries }
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(tmp, this.metaFile)
    } catch (error) {
      log.error('写剪贴板历史失败：', error)
    }
  }
}

// ---------- 小工具 ----------

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}

function sha1(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex')
}

function makePreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= CLIPBOARD_PREVIEW_CHARS ? flat : flat.slice(0, CLIPBOARD_PREVIEW_CHARS) + '…'
}
