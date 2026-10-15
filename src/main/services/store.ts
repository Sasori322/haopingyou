import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '../utils/logger'

const log = createLogger('store')

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 用 patch 覆盖 base，仅对普通对象做递归合并 */
function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(out[key]) && isPlainObject(value) ? deepMerge(out[key], value) : value
  }
  return out as T
}

/**
 * 极简 JSON 持久化：原子写（tmp + rename）+ 递归默认值补齐 + 写合并防抖。
 * 之所以不用 electron-store v12：它是 pure ESM，而本项目主进程输出为 CJS
 * （为了在 sandbox: true 下使用 preload），静态 import 会直接报错。
 */
export class JsonStore<T extends object> {
  private readonly file: string
  private readonly defaults: T
  private data: T
  private writeTimer: NodeJS.Timeout | null = null

  constructor(name: string, defaults: T) {
    this.file = join(app.getPath('userData'), `${name}.json`)
    this.defaults = defaults
    this.data = this.load()
  }

  get path(): string {
    return this.file
  }

  private load(): T {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
        return deepMerge(structuredClone(this.defaults), raw)
      }
    } catch (error) {
      log.warn('读取失败，回退默认值：', this.file, error)
    }
    return structuredClone(this.defaults)
  }

  all(): T {
    return this.data
  }

  set(patch: Partial<T>): T {
    this.data = deepMerge(this.data, patch)
    this.scheduleWrite()
    return this.data
  }

  /** 同步落盘，用于退出前 */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    this.writeNow()
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
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      log.error('写入失败：', this.file, error)
    }
  }
}
