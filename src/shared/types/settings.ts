/** 应用设置（持久化于 electron-store 的 settings.json） */

export interface PomodoroSettings {
  /** 专注时长（分钟） */
  focusMin: number
  /** 短休时长（分钟） */
  shortBreakMin: number
  /** 长休时长（分钟） */
  longBreakMin: number
  /** 每完成几个番茄进入长休 */
  longBreakEvery: number
  /** 结束后自动进入下一阶段 */
  autoNext: boolean
  /** 是否播放提示音 */
  sound: boolean
}

export interface SedentarySettings {
  enabled: boolean
  /** 空闲超过该分钟数则不计入久坐 */
  idleMinutes: number
  /** 连续活跃多久后提醒（分钟） */
  remindMinutes: number
}

export interface WaterSettings {
  enabled: boolean
  /** 固定提醒间隔（分钟） */
  intervalMin: number
}

export interface MonitorSettings {
  enabled: boolean
  /** 是否在设置窗口显示占用最高的进程 */
  showTopProcess: boolean
}

/**
 * 剪贴板历史（设置层）。
 *
 * 见 `docs/STATUS.md` 三、待定：剪贴板历史的"隐私"与"采集"段落——
 * 不要承诺"绝不记录密码"这种做不到的事，能做的是给总开关、暂停、黑名单、
 * 不采图默认、清空入口；这一切都收敛在这一节里。
 */
export interface ClipboardSettings {
  /** 总开关 */
  enabled: boolean
  /**
   * 是否采集图片。**默认 false**：图片最容易误收隐私内容（截图），
   * 默认关了比默认开了安全。
   */
  listenImages: boolean
  /**
   * 关键字黑名单：命中即丢。逗号或换行分隔，例如 `password,passwd,身份证,银行卡`。
   * 字符集与长度由 IPC 校验层收紧，这里只信任存储里的内容。
   */
  excludeKeywords: string[]
  /**
   * 历史存储目录（绝对路径）。**null 表示沿用默认** `<userData>/clipboard/`。
   *
   * - 必须存在且可写；切换时旧目录数据保留在原地（不自动迁移），新目录接续采集。
   * - 不允许相对路径：用户配置的是「固定位置」，换工作目录就会出现意外迁移。
   * - ≤260 字符：Windows MAX_PATH，硬超长会让 explorer 和众多系统 API 失能。
   */
  storageDir: string | null
  /**
   * 唤起面板窗口的全局快捷键（Electron Accelerator 格式）。
   * - 空字符串表示禁用全局快捷键（仅走托盘菜单 / 设置页入口）。
   * - 由主进程用 format 校验 + register-noop 试探；失败时静默退化（设置页要显示原因）。
   */
  hotkey: string
}

/** 鼠标跟随：宠物朝光标方向轻微倾斜 / 转头 */
export interface GazeSettings {
  enabled: boolean
  /** 感知半径（DIP）。超出半径权重归零，宠物回到中立姿态 */
  range: number
  /** 是否允许按光标方位翻转朝向（只在站立族状态下生效） */
  flipFacing: boolean
}

/** 沉浸（游戏 / 全屏）时自动躲开 */
export interface ImmersiveSettings {
  enabled: boolean
  /** 命中即在运行时躲开的进程名，不区分大小写、可省略 .exe，支持 * 通配 */
  processes: string[]
  /**
   * 自动检测（前台窗口是否铺满整屏）。
   * 这条需要一个常驻的 PowerShell 辅助进程——Electron 没有前台窗口 API，项目又不引原生模块，
   * 所以单独开关、并在设置里显示自检状态。进程名单也依赖它（名单匹配跑在同一个辅助进程里），
   * 名单为空且这个开关关掉时，辅助进程完全不会启动。
   */
  autoDetect: boolean
}

export interface AppSettings {
  /** 当前选中的宠物 id */
  activePetId: string
  /** 宠物是否可见 */
  petVisible: boolean
  /**
   * 宠物整体缩放。取值区间由 `PET_SCALE_MIN` / `PET_SCALE_MAX` 决定（上限 1）——
   * 为什么封顶，见 `constants.ts` 里这两个常量的注释。
   */
  petScale: number
  /** 是否始终置顶 */
  alwaysOnTop: boolean
  /** 是否开机自启 */
  autostart: boolean
  /** 是否随系统负载切换 hot 状态 */
  reactToLoad: boolean
  gaze: GazeSettings
  immersive: ImmersiveSettings
  pomodoro: PomodoroSettings
  sedentary: SedentarySettings
  water: WaterSettings
  monitor: MonitorSettings
  clipboard: ClipboardSettings
}
