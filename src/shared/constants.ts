import type { AppSettings } from './types/settings'

/** 必须与 electron-builder.yml 的 appId 完全一致，否则 Windows 通知不显示应用名 */
export const APP_ID = 'com.haopingyou.desktop'
export const PRODUCT_NAME = '好屏友'

/**
 * 宠物窗口相对宠物画布的四周留白（DIP）。
 * 画布之外的这点空间是留给气泡和阴影的，同时也让宠物不至于贴着窗口边缘。
 */
export const PET_WINDOW_PADDING = 10

/**
 * 宠物窗口的兜底尺寸（DIP）。真实尺寸由 manifest.canvas + 留白算出
 * （见 `petWindowSize()`）：画布要能装下最高的姿态——悬空挣扎比站立高约 43%，
 * 用正方形画布会把它裁掉。
 */
export const PET_WINDOW_SIZE = { width: 220, height: 220 }

/** 由宠物画布尺寸推算窗口尺寸 */
export function petWindowSize(canvas?: { w: number; h: number }): { width: number; height: number } {
  if (!canvas || !(canvas.w > 0) || !(canvas.h > 0)) return { ...PET_WINDOW_SIZE }
  return {
    width: Math.round(canvas.w + PET_WINDOW_PADDING * 2),
    height: Math.round(canvas.h + PET_WINDOW_PADDING * 2)
  }
}

/** 离开命中区后回退穿透的防抖时间（ms） */
export const LEAVE_DEBOUNCE_MS = 80

/** 判定为拖拽的最小位移（px） */
export const DRAG_THRESHOLD_PX = 3

/** 拖拽上报节流间隔（ms），约 30fps */
export const DRAG_THROTTLE_MS = 33

/** 走动时的位移速度（DIP/秒） */
export const WALK_SPEED = 70

/** 走动逻辑的驱动帧率（约 30fps），与动画帧率解耦 */
export const WALK_TICK_MS = 33

/** 随机行为调度的间隔区间（ms） */
export const BEHAVIOR_INTERVAL_MS: [number, number] = [8000, 25000]

/** 内置宠物的资源目录名（相对 process.resourcesPath 或项目根） */
export const PET_DIR_NAME = 'pets'

// ---------------- 宠物尺寸 ----------------

/**
 * 宠物缩放的允许区间。设置页滑块与主进程校验都必须引用这里，别再各写一遍。
 *
 * 上限刻意压到 1。原因是窗口尺寸按 `petWindowSize()` = `manifest.canvas + 20` **固定推算**，
 * 不会跟着 petScale 放大；而素材里**悬空挣扎那一族最高**（竖直外框是站立姿的 1.43 倍，
 * 见 `docs/STATUS.md` 的已知缺口）。所以 petScale > 1 时，最先顶出窗口的必然是它 ——
 * 表现为「拎起来的瞬间爪子/尾巴尖被窗口边缘切掉」。
 *
 * 另一个理由来自实测：这个 Q 版大头造型放大到 1.3 倍以上就会被读成「这只猫变大了」，
 * 而不是「变大了一点」，收益本来也很有限。
 *
 * 想真正支持放大，得先让窗口尺寸随 scale 一起长（并按最高的姿态族算），
 * 那是另一件事 —— 在那之前这里保持 1。
 */
export const PET_SCALE_MIN = 0.5
export const PET_SCALE_MAX = 1

/**
 * 宠物自定义昵称的最大长度（按 JS 字符数，中文算 1）。
 *
 * 定 12 是因为这个字符串会出现在两个地方，都放不下更长的：托盘 tooltip（后面还跟着状态与
 * 「已让路 / 免打扰」后缀）、系统通知标题（`昵称 · 提醒内容`）。再长就被系统截断，
 * 反而看不到完整的提醒内容。
 */
export const PET_NAME_MAX = 12

// ---------------- 鼠标跟随 ----------------

/**
 * 光标采样间隔（ms）。
 * 这个定时器跑在主进程里，但只有「量化后的取值发生变化」才会发 IPC，
 * 所以接在屏幕上的开销只有一次 getCursorScreenPoint 系统调用。
 */
export const GAZE_POLL_MS = 60

/**
 * 鼠标跟随的最大位移（DIP）与最大倾角（度），在 petScale 之前生效。
 *
 * 幅度是调过的：3.2px / 1.2° 实测几乎看不出来（在当前正脸素材上只有约 2% 的形变），
 * 这一版提到 5px / 2.2° —— 猫是"踩着地面朝光标那边偏一下"，看不出位移就失去了意义。
 * 再往上就会变成廉价抖动，而且倾斜过大会让命中框偏出 hitTest 的 8px pad。
 */
export const GAZE_MAX_SHIFT = 5
export const GAZE_MAX_TILT = 2.2

/** 平滑插值每帧向目标靠拢的比例（约 150ms 到位；收敛后渲染层必须停掉 rAF） */
export const GAZE_EASE = 0.16

/** 允许按光标方位翻转朝向的状态（站立族） */
export const GAZE_FACING_STATES: readonly string[] = ['idle', 'click', 'eat', 'rest', 'hot', 'focus']

/** 朝向翻转的死区（DIP）：光标离宠物中心这个距离以内不翻转，避免来回抖 */
export const GAZE_FACING_DEADZONE = 24

// ---------------- 沉浸躲开 ----------------

/** 进程名单的轮询间隔（ms） */
export const IMMERSIVE_PROCESS_POLL_MS = 6000

/**
 * 触发器需要「持续成立」或「持续消失」多久才真正切换（ms）。
 * 没有这个防抖，alt-tab、进程起停会让宠物反复闪烁。
 */
export const IMMERSIVE_SETTLE_MS = 1500

/** 用户手动把宠物叫回来后的豁免时长（ms）：这段时间内自动躲开不生效，避免和用户抢 */
export const IMMERSIVE_SUPPRESS_MS = 5 * 60 * 1000

/** 全屏检测辅助进程的轮询间隔（ms）与「多久没回话就重启」的看门狗阈值（ms） */
export const FULLSCREEN_PROBE_INTERVAL_MS = 1500
export const FULLSCREEN_PROBE_STALE_MS = 12000

// ---------------- 提醒（久坐 / 喝水） ----------------

/**
 * 久坐 / 喝水的评估周期（ms）。
 * 6000 那个是进程名单的轮询，这里是纯内存时间戳比较、没有任何 I/O，所以可以更快。
 */
export const REMINDER_TICK_MS = 5000

/**
 * 「座位是空的」判定阈值（秒），只给喝水提醒用。
 *
 * 久坐提醒**不用**这个值 —— 它有自己的 `sedentary.idleMinutes`，语义是
 * 「连续活跃段是否中断」，跟这里的「此刻有没有人在」是两件事，不要合并。
 *
 * 取 3 分钟是因为读长文 / 看视频会长时间不动鼠标，阈值太小会把「人在但没操作」
 * 误判成离开，那样喝水提醒就永远不响了。
 */
export const WATER_PRESENCE_IDLE_SEC = 180

/**
 * 开发期加速（`HPY_FAST_REMIND=1`）：把阈值里的「分钟」当成「秒」。
 *
 * 没有这个开关，久坐提醒最短也要 5 分钟、喝水最短 5 分钟才可能触发，
 * 开发机上根本没法验证「到点真的会提醒」。加速后的取值只用于自检，
 * 日志里会明确打一条告警，避免误以为是真实阈值。
 *
 * ⚠️ `REMIND_FAST_AWAY_SEC` 必须**明显大于**上面两个提醒阈值。
 * 最初把它设成 8 秒（比久坐的 20 秒还小），结果稍一停手就被判「离开座位」，
 * 久坐计时反复清零 → 反而永远测不出提醒。现在取 45 秒：验证提醒时不会误触发，
 * 想单独验「离开判定」停手 45 秒即可。
 */
export const REMIND_FAST_SEDENTARY_SEC = 20
export const REMIND_FAST_WATER_SEC = 25
export const REMIND_FAST_AWAY_SEC = 45

/** 免打扰的预设时长（分钟），托盘与宠物右键菜单共用 */
export const DND_PRESET_MINUTES: readonly number[] = [30, 60]

export const DEFAULT_SETTINGS: AppSettings = {
  activePetId: 'cat',
  // 空对象 = 所有宠物都用 manifest 里的默认昵称
  petNames: {},
  petVisible: true,
  petScale: 1,
  alwaysOnTop: true,
  autostart: false,
  reactToLoad: true,
  gaze: {
    enabled: true,
    range: 420,
    flipFacing: true
  },
  immersive: {
    enabled: true,
    // 默认空名单：没有任何触发器成立，等于什么都不做，不会让用户莫名其妙看不到宠物
    processes: [],
    // 默认关闭「自动检测全屏」：开发/日常使用时避免把普通窗口误判为全屏而藏起宠物
    autoDetect: false
  },
  pomodoro: {
    focusMin: 25,
    shortBreakMin: 5,
    longBreakMin: 15,
    longBreakEvery: 4,
    autoNext: false,
    sound: true
  },
  sedentary: {
    enabled: true,
    idleMinutes: 3,
    remindMinutes: 45
  },
  water: {
    enabled: true,
    intervalMin: 60
  },
  monitor: {
    enabled: true,
    showTopProcess: false
  },
  // 剪贴板历史默认：总开关开、不采图、空黑名单（黑名单第一条在 PRD 里举例）；
  // 存储目录留 null 表示沿用 <userData>/clipboard/；快捷键沿用老规矩。
  clipboard: {
    enabled: true,
    listenImages: false,
    excludeKeywords: ['password', 'passwd', '身份证', '银行卡'],
    storageDir: null,
    hotkey: 'CommandOrControl+Shift+V'
  },
  // 待办便签面板的默认快捷键。
  // 为什么不用 Ctrl+Shift+T：那个组合在浏览器里是「恢复刚关掉的标签页」，全局注册会把它
  // 从**所有**应用手里抢走，用户只会以"浏览器坏了"的形式感知到。Alt 组合在 Windows 上
  // 几乎没有系统级占用，代价小得多；用户随时可以在设置里改掉或清空。
  todo: {
    hotkey: 'CommandOrControl+Alt+T'
  }
}
