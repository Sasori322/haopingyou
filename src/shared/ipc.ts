/**
 * IPC 通道单一事实来源。
 * 主进程 / preload 一律引用此处的常量，禁止使用裸字符串，避免拼写漂移。
 */
export const IPC = {
  // ---- 宠物窗口 → 主进程（单向 send） ----
  /** 切换鼠标穿透。true = 穿透（可点到桌面） */
  PET_SET_IGNORE_MOUSE: 'pet:set-ignore-mouse',
  /** 开始拖拽，携带抓取偏移 */
  PET_DRAG_START: 'pet:drag-start',
  /** 拖拽中，携带屏幕坐标 */
  PET_DRAG_MOVE: 'pet:drag-move',
  /** 结束拖拽 */
  PET_DRAG_END: 'pet:drag-end',
  /** 上报状态机当前状态（供托盘 / 日志使用） */
  PET_STATE_CHANGED: 'pet:state-changed',
  /** 请求主进程弹出原生右键菜单 */
  PET_POPUP_MENU: 'pet:popup-menu',
  /** 请求说一句话（渲染层自发，如点击） */
  PET_REQUEST_SPEAK: 'pet:request-speak',
  /** 请求切换状态（渲染层自发，如点击动画播完） */
  PET_REQUEST_STATE: 'pet:request-state',

  // ---- 宠物窗口 → 主进程（请求-响应 invoke） ----
  /** 取窗口几何与所在屏工作区 */
  PET_GET_GEOMETRY: 'pet:get-geometry',
  /** 列出可用宠物 */
  PET_LIST: 'pet:list',
  /** 取当前宠物 manifest */
  PET_GET_ACTIVE: 'pet:get-active',
  /** 切换宠物 */
  PET_SET_ACTIVE: 'pet:set-active',

  // ---- 主进程 → 宠物窗口（单向 send） ----
  /** 气泡说话 */
  PET_SPEAK: 'pet:speak',
  /** 强制切换状态 */
  PET_FORCE_STATE: 'pet:force-state',
  /** 重新加载素材 */
  PET_RELOAD: 'pet:reload',
  /** 鼠标跟随：下发光标相对宠物的方位（已量化去重，只在变化时发） */
  PET_GAZE: 'pet:gaze',
  /**
   * 指针重同步：窗口重新显示 / 系统唤醒 / 切换宠物之后，下发**光标相对窗口客户区的位置**，
   * 让渲染层无条件重算一次命中并落地穿透态。
   * 这条通路是"点击穿透"这套两段式握手的兜底——它唯一的恢复路径是一条被转发的 mousemove，
   * 而上述时刻光标可能已经压在宠物身上却不再产生任何 mousemove。
   */
  PET_POINTER_SYNC: 'pet:pointer-sync',

  // ---- 设置窗口 → 主进程 ----
  SETTINGS_GET: 'settings:get',
  SETTINGS_PATCH: 'settings:patch',

  // ---- 主进程 → 所有窗口 ----
  SETTINGS_CHANGED: 'settings:changed',

  // ---- 应用级 ----
  APP_GET_VERSION: 'app:get-version',
  APP_GET_AUTOSTART: 'app:get-autostart',
  APP_SET_AUTOSTART: 'app:set-autostart',
  APP_OPEN_SETTINGS: 'app:open-settings',
  /** 取沉浸躲开的运行状态（设置页展示） */
  APP_GET_IMMERSIVE_STATUS: 'app:get-immersive-status',
  /** 取提醒（久坐 / 喝水）的运行状态（设置页展示） */
  APP_GET_REMINDER_STATUS: 'app:get-reminder-status',
  /** 设置免打扰（分钟；null = 立刻恢复提醒） */
  APP_SET_DND: 'app:set-dnd',
  APP_SHOW_PET: 'app:show-pet',
  APP_HIDE_PET: 'app:hide-pet',
  APP_QUIT: 'app:quit',

  // ---- 剪贴板历史 ----
  /** 列表（快照读：返回当前窗口创建时的快照） */
  CLIPBOARD_LIST: 'clipboard:list',
  /** 取一张图片的字节（流回渲染层 src=clipboard-img:// 用）。payload 是 id */
  CLIPBOARD_GET_IMAGE: 'clipboard:get-image',
  /** 把条目内容写回剪贴板 */
  CLIPBOARD_SET: 'clipboard:set',
  /** 删除一条 */
  CLIPBOARD_DELETE: 'clipboard:delete',
  /** 置顶/取消置顶 */
  CLIPBOARD_TOGGLE_PIN: 'clipboard:toggle-pin',
  /** 清空（非 pinned） */
  CLIPBOARD_CLEAR: 'clipboard:clear',
  /** 状态：长度、最新 id、采图开关、暂停到期时间 */
  CLIPBOARD_STATUS: 'clipboard:status',
  /** 暂停记录 N 分钟；传 0 或 null = 立刻恢复 */
  CLIPBOARD_PAUSE: 'clipboard:pause',
  /** 主进程 → 渲染层（面板窗口）：列表与状态变了就推一次 */
  CLIPBOARD_CHANGED: 'clipboard:changed',
  /** 申请打开剪贴板历史面板（托盘菜单调用） */
  CLIPBOARD_OPEN_PANEL: 'clipboard:open-panel',
  /**
   * 调起系统目录选择对话框，让用户挑一个绝对路径作为剪贴板历史目录；
   * 返回 string（绝对路径）或 null（取消）。
   */
  CLIPBOARD_PICK_DIR: 'clipboard:pick-dir',
  /**
   * 校验一个候选目录：存在性 / 目录属性 / 试探写入。
   * 仅作 dry-run，不改 storage。
   */
  CLIPBOARD_VALIDATE_DIR: 'clipboard:validate-dir',
  /**
   * 试探一个 hotkey：format + register-noop 测试；返回 {ok, reason?}。
   * 不改 hotkey 设置（可让 UI 实时反馈"是否被占用"）。
   */
  CLIPBOARD_TRY_HOTKEY: 'clipboard:try-hotkey',
  /**
   * 录制开始：让主进程临时解绑当前快捷键，避免输入时把 toggle clipboard panel 触发起来。
   * 不传参；幂等，已处于录制态时是 noop。
   */
  CLIPBOARD_BEGIN_RECORDING: 'clipboard:begin-recording',
  /**
   * 录制结束：
   *  - 参数是合法新快捷键 → 注册新值
   *  - 参数是 null / 空串 → 取消，恢复旧值
   * 与 `begin-recording` 严格配对；不在 begin 之前调用是 noop。
   */
  CLIPBOARD_END_RECORDING: 'clipboard:end-recording',

  // ---- 待办与便签 ----
  /**
   * 取全量快照（todos + notes + stats）。
   * 写操作也一律返回同一份快照，渲染层不必"改完再读一次"。
   */
  TODO_SNAPSHOT: 'todo:snapshot',
  TODO_ADD: 'todo:add',
  TODO_UPDATE: 'todo:update',
  TODO_REMOVE: 'todo:remove',
  TODO_SET_DONE: 'todo:set-done',
  /** 重排"进行中"列表（拖拽结束后调一次，传完整的新顺序） */
  TODO_REORDER: 'todo:reorder',
  /** 清空所有已完成条目 */
  TODO_CLEAR_DONE: 'todo:clear-done',
  TODO_NOTE_ADD: 'todo:note-add',
  TODO_NOTE_UPDATE: 'todo:note-update',
  TODO_NOTE_REMOVE: 'todo:note-remove',
  TODO_NOTE_TOGGLE_PIN: 'todo:note-toggle-pin',
  /** 主进程 → 所有窗口：待办/便签数据变了（另一个窗口改的，或截止提醒改了标记） */
  TODO_CHANGED: 'todo:changed',
  /** 打开（或切换）旁挂小面板窗口 */
  TODO_OPEN_PANEL: 'todo:open-panel',
  /** 主进程 → 面板窗口：把光标落到快速录入框（宠物右键「记一条待办」用） */
  TODO_PANEL_FOCUS_QUICK_ADD: 'todo:panel-focus-quick-add'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** 右键菜单类型 */
export type MenuKind = 'pet'
