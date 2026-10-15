/**
 * 宠物相关的共享类型定义。
 * 主进程 / preload / 渲染进程三方共用，禁止引入任何运行时代码。
 */

/** 单个动画的播放配置 */
export interface SpriteAnimation {
  /** sheet = 单张雪碧图水平切帧；sequence = 逐帧独立文件 */
  mode: 'sheet' | 'sequence'
  /** mode=sheet 时的图片文件名，相对于宠物目录 */
  src?: string
  /** mode=sequence 时的帧目录名，相对于宠物目录 */
  dir?: string
  /** 帧数 */
  frames: number
  /** 播放帧率 */
  fps: number
  /** 是否循环 */
  loop: boolean
  /** 是否可被状态机打断 */
  interruptible: boolean
  /** 非循环动画播放结束后跳转到的状态 */
  next?: PetState
  /**
   * 该动画的「最大内容包络」（DIP，相对画布左上角）。
   * 由 `tools/normalize-anchor.mjs --emit-bounds` 导出，用于把鼠标命中区精确贴合宠物，
   * 而不是退化成整个透明窗口。缺省时回退到 manifest.hitbox。
   */
  bounds?: { x: number; y: number; w: number; h: number }
}

/** 一个宠物的完整清单（manifest.json） */
export interface PetManifest {
  id: string
  /** 品种名（"小橘猫"），用于区分 / 展示品种，不要和 nickname 合并 */
  name: string
  /**
   * 可爱昵称（"橘子"）。**对外称呼一律优先用它**——系统通知、托盘提示、设置页卡片，
   * 都是"宠物在跟你说话"，用昵称才像有个小活物陪着；缺省时回退 `name`。
   */
  nickname?: string
  /** 占位渲染时用于决定画哪只（素材缺失时的兜底） */
  kind: 'cat' | 'dog'
  version: number
  author?: string
  /** 逻辑画布尺寸（DIP），帧图为其 2 倍 */
  canvas: { w: number; h: number }
  /** 整体缩放，默认 1 */
  scale?: number
  /** 锚点，默认脚底中心 { x: 0.5, y: 1 } */
  anchor?: { x: number; y: number }
  /** 命中矩形（DIP，相对画布左上角） */
  hitbox: { x: number; y: number; w: number; h: number }
  defaultAnimation: string
  animations: Record<string, SpriteAnimation>
  /** 气泡台词：key 为触发原因 */
  bubbles?: Record<string, string[]>
}

/** 宠物库中的一条摘要信息 */
export interface PetSummary {
  id: string
  /** 品种名（"小橘猫"） */
  name: string
  /** 对外称呼（"橘子"）。normalize 后一定有值，缺省已回退为 name */
  nickname: string
  kind: 'cat' | 'dog'
  source: 'builtin' | 'user'
  /** 素材是否完整（缺失时渲染层走占位图） */
  hasAssets: boolean
}

/** 宠物状态机状态 */
export type PetState =
  | 'idle'
  | 'walk'
  | 'sleep'
  | 'eat'
  | 'drag'
  | 'click'
  | 'focus'
  | 'rest'
  | 'hot'

/** 宠物窗口几何信息（全部为 DIP） */
export interface PetGeometry {
  x: number
  y: number
  width: number
  height: number
  /** 设备像素比 */
  dpr: number
  /** 当前所在屏幕的工作区（已排除任务栏） */
  workArea: { x: number; y: number; width: number; height: number }
}

/** 主进程 → 渲染进程：气泡说话 */
export interface SpeakPayload {
  text: string
  /** 显示时长 ms，默认 3000 */
  ms?: number
  /** 台词来源（用于取 bubbles 时去重） */
  reason?: string
}

/** 主进程 → 渲染进程：强制切换状态 */
export interface ForceStatePayload {
  state: PetState
  reason?: string
  /** 该状态最短持续时间 ms */
  holdMs?: number
  /** 是否由本次指令驱动移动（走动由主进程负责位移） */
  direction?: -1 | 0 | 1
}

/** 主进程 → 渲染进程：重新加载宠物素材 */
export interface ReloadPayload {
  petId: string
  /** 素材来源，决定 pet-asset:// 的 host（builtin / user） */
  source: 'builtin' | 'user'
  manifest: PetManifest | null
  hasAssets: boolean
}

/**
 * 主进程 → 渲染进程：鼠标跟随的目标方位。
 *
 * 只能是主进程来算：宠物窗口是穿透的，渲染层只在光标落在窗口矩形内时才会收到 mousemove，
 * 拿不到全局光标位置，必须由主进程用 `screen.getCursorScreenPoint()` 采样。
 */
export interface GazePayload {
  /** 归一化横向分量，-1（左）..1（右），已按距离衰减 */
  x: number
  /** 归一化纵向分量，-1（上）..1（下），已按距离衰减 */
  y: number
  /** 光标是否落在感知半径内 */
  near: boolean
  /** 建议朝向：1 = 光标在宠物右侧 / -1 = 左侧 / 0 = 太远或不可判定 */
  facing: -1 | 0 | 1
}

/**
 * 指针重同步载荷：光标相对**窗口客户区左上角**的位置（DIP，与渲染层 clientX/clientY 同系）。
 *
 * 只用于"窗口重新显示 / 系统唤醒 / 切换宠物"这类**事件空窗**：这些时刻光标可能已经压在
 * 宠物身上，但因为没动过，渲染层收不到任何 mousemove，于是穿透态永远停在"穿透"，
 * 宠物看得见却点不动也拖不动。主进程手上有全局光标位置，由它算给渲染层。
 */
export interface PointerSyncPayload {
  x: number
  y: number
}

/** 沉浸躲开的运行状态（设置页展示用，让"全屏检测到底有没有生效"可见） */
export interface ImmersiveStatus {
  /** 当前是否因为沉浸条件被自动隐藏 */
  hidden: boolean
  /** 命中的触发器说明（进程名 / 全屏 / 手动安静），空表示未触发 */
  reason: string
  /** 全屏检测辅助进程是否在跑 */
  probeRunning: boolean
  /** 全屏检测是否可用（辅助进程能正常回话） */
  probeAvailable: boolean
}
