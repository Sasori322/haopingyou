/**
 * 剪贴板历史共享类型。
 *
 * 设计要点（见 `docs/STATUS.md` 第三部分"剪贴板历史"）：
 * 1. 三类 kind：text / image / files（files 视为文本，本地不存二进制）
 * 2. 元数据只存到 userData/clipboard/clipboard.json，**绝不放进 settings.json**
 *    （图片/长文本会把配置文件撑爆）
 * 3. 图片二进制单文件落到 userData/clipboard/img/<id>.png，淘汰同步删
 * 4. pinned 永不淘汰，其它按 100 条 / 30 天 双重封顶，**先到者为准**
 * 5. 文本单条上限 32KB，超过截断并打 truncated 标
 * 6. 幂等：相同 hash 再次出现 → 提到队首，不新增条目
 */

export type ClipboardKind = 'text' | 'image' | 'files'

export interface ClipboardEntry {
  /** 唯一 id（uuid，时间戳 + 随机） */
  id: string
  kind: ClipboardKind
  /** 列表里显示的一行摘要：
   *  - text 截断到 80 字符
   *  - image 是"[图片]"
   *  - files 是文件名的逗号串
   */
  preview: string
  /** 文本直接存这里；image 这里是 PNG 路径（相对 clip 根）；files 这里是 JSON 字符串 */
  payloadRef: string
  /** 内容哈希（去重用）—— text 是 sha1(text)；image 是 sha1(png bytes)；files 是拼接后的 sha1 */
  hash: string
  /** 捕获时刻（绝对时间戳，毫秒） */
  at: number
  /** 永不参与自动淘汰 */
  pinned: boolean
  /**
   * 尽力而为的来源标识，**不可信**：用应用名（LIMIT 32）+ 主窗口类名做粗粒度。
   * 这是当前约束下不用编译能做到的最大努力——真正可靠的"识别来源、跳过密码管理器"
   * 需要 `GetClipboardOwner` P/Invoke，与硬约束相冲突，**不要承诺更多**。
   */
  source: string
  /** 大文本被截断时为 true */
  truncated?: boolean
}

export interface ClipboardStatus {
  /** 当前可见条目数（不含被淘汰的） */
  count: number
  /** 最新一条的 id */
  latestId: string | null
  /** 启用了图片采集 */
  listeningImages: boolean
  /** 临时暂停到什么时候（0 = 未暂停） */
  pausedUntilAt: number
  /**
   * 当前实际生效的存储目录（绝对路径）。
   * 设置里的 storageDir 可能被回退（无效时），这里看展示的总是真在用的目录。
   */
  storageDir: string
}

/** 捕获到的文本上限（32KB）。超出截断并打 truncated 标 */
export const CLIPBOARD_TEXT_LIMIT_BYTES = 32 * 1024

/** 摘要里的预览截断长度 */
export const CLIPBOARD_PREVIEW_CHARS = 80

/** 容量上限（条目数）和时间上限（天）；**先到者为准** */
export const CLIPBOARD_MAX_ENTRIES = 100
export const CLIPBOARD_MAX_AGE_DAYS = 30
