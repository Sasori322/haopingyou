import type {
  ForceStatePayload,
  GazePayload,
  ImmersiveStatus,
  PetGeometry,
  PetState,
  PetSummary,
  PointerSyncPayload,
  ReloadPayload,
  SpeakPayload
} from './types/pet'
import type { ReminderStatus } from './types/reminder'
import type { AppSettings } from './types/settings'
import type { ClipboardEntry, ClipboardStatus } from './types/clipboard'
import type {
  StickyDraft,
  StickyPatch,
  TodoDraft,
  TodoPatch,
  TodoSnapshot
} from './types/todo'
import type { MenuKind } from './ipc'

/**
 * 渲染层调 `settings.patch({...})` 时，主进程只关心自己白名单键里出现的那几个，
 * 其它一律丢——所以前端不必每次都把所有 sibling 字段也带上。TS 上用 DeepPartial 来表达：
 * "部分字段 + 部分嵌套"，落到 IPC 那边再由 sanitizeSettingsPatch 收紧。
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

/** contextBridge 暴露到 window.petAPI 的白名单 API */
export interface PetApi {
  // ---- 穿透 / 拖拽 ----
  /** 切换鼠标穿透：true = 穿透，false = 接收鼠标事件 */
  setIgnoreMouse(ignore: boolean): void
  /** 开始拖拽（offset 为光标相对窗口左上角的偏移，DIP） */
  dragStart(offset: { x: number; y: number }): void
  /** 拖拽中（屏幕坐标，DIP） */
  dragMove(pos: { x: number; y: number }): void
  /** 结束拖拽 */
  dragEnd(): void
  /** 取窗口几何 */
  getGeometry(): Promise<PetGeometry>

  // ---- 宠物 ----
  listPets(): Promise<PetSummary[]>
  getActivePet(): Promise<ReloadPayload>
  setActivePet(petId: string): Promise<void>
  /** 弹出原生右键菜单（位置由主进程交给系统取当前光标位置） */
  popupMenu(kind: MenuKind): void
  /** 上报当前状态 */
  reportState(state: PetState): void
  /** 请求说一句话 */
  requestSpeak(reason: string, text?: string): void
  /** 请求切换状态 */
  requestState(state: PetState, reason?: string): void

  // ---- 订阅（返回取消订阅函数） ----
  onSpeak(cb: (payload: SpeakPayload) => void): () => void
  onForceState(cb: (payload: ForceStatePayload) => void): () => void
  onReload(cb: (payload: ReloadPayload) => void): () => void
  /** 鼠标跟随的目标方位（只在量化值变化时下发） */
  onGaze(cb: (payload: GazePayload) => void): () => void
  /**
   * 指针重同步（窗口重新显示 / 系统唤醒 / 切换宠物后下发）。
   * 收到后必须**无条件**重算命中并落地穿透态，不能复用"值没变就跳过"的缓存。
   */
  onPointerSync(cb: (payload: PointerSyncPayload) => void): () => void

  // ---- 设置 / 应用 ----
  settings: {
    get(): Promise<AppSettings>
    patch(patch: DeepPartial<AppSettings>): Promise<AppSettings>
    onChanged(cb: (settings: AppSettings) => void): () => void
  }
  app: {
    getVersion(): Promise<string>
    getAutostart(): Promise<boolean>
    setAutostart(enabled: boolean): Promise<boolean>
    openSettings(): void
    showPet(): void
    hidePet(): void
    quit(): void
    getImmersiveStatus(): Promise<ImmersiveStatus>
    /** 提醒（久坐 / 喝水）的运行状态：已累计多久、是否判定离开、下次喝水提醒时间 */
    getReminderStatus(): Promise<ReminderStatus>
    /** 设置免打扰；minutes = null 表示立刻恢复提醒。返回设置后的状态 */
    setDnd(minutes: number | null): Promise<ReminderStatus>
    /** 打开剪贴板历史面板（独立窗口） */
    openClipboardPanel(): void
  }

  /** 剪贴板历史面板 API。**
   * 列表/图片字节走 ipcRenderer.invoke；状态变更走订阅（只在真变化时推送）。
   */
  clipboard: {
    list(): Promise<ClipboardEntry[]>
    status(): Promise<ClipboardStatus>
    set(id: string): Promise<boolean>
    delete(id: string): Promise<boolean>
    togglePin(id: string): Promise<boolean>
    clear(): Promise<number>
    pause(minutes: number | null): Promise<ClipboardStatus>
    onChanged(cb: (status: ClipboardStatus) => void): () => void
    /** 调起系统目录选择对话框；null = 取消 */
    pickStorageDir(): Promise<string | null>
    /**
     * 校验候选目录：返回 `{ ok, path?, reason? }`。
     * reason 字段是结构化错误："昵称原因 / 路径过长 / 必须是绝对路径 / 不是一个目录 / 无权限写入"。
     */
    validateStorageDir(path: string): Promise<{ ok: boolean; path?: string; reason?: string }>
/**
   * 试探 hotkey：format + register-noop 测试，返回 `{ok, reason?}`。
   * reason 区分"格式不合法""已被其它应用占用"。
   */
  tryHotkey(hotkey: string): Promise<{ ok: boolean; reason?: string }>
  /**
   * 录制热键开始：让主进程临时解绑旧值，避免用户按"原热键"时把面板弹起来干扰输入。
   * 已处于录制态时是 noop；幂等。
   */
  beginHotkeyRecording(): Promise<void>
  /**
   * 录制热键结束。`newHotkey` 非空 → 注册新值；null / 空 → 取消，恢复旧值。
   * 与 `beginHotkeyRecording` 严格配对；没 begin 就 end 是 noop，安全。
   */
  endHotkeyRecording(newHotkey: string | null): Promise<void>
  }

  /**
   * 待办与便签。
   *
   * 写操作**一律返回最新快照**，渲染层不必"改完再读一遍"——也就不会出现
   * "点了完成但画面上还是未完成"的中间态。
   * `onChanged` 只用于**另一个窗口**改了数据时同步（设置页与旁挂小面板会同时开着）。
   */
  todo: {
    snapshot(): Promise<TodoSnapshot>
    add(draft: TodoDraft): Promise<TodoSnapshot>
    update(id: string, patch: TodoPatch): Promise<TodoSnapshot>
    remove(id: string): Promise<TodoSnapshot>
    setDone(id: string, done: boolean): Promise<TodoSnapshot>
    /** 传"进行中列表"的完整新顺序（id 数组）；不在数组里的条目次序不受影响 */
    reorder(ids: string[]): Promise<TodoSnapshot>
    clearDone(): Promise<TodoSnapshot>
    addNote(draft: StickyDraft): Promise<TodoSnapshot>
    updateNote(id: string, patch: StickyPatch): Promise<TodoSnapshot>
    removeNote(id: string): Promise<TodoSnapshot>
    toggleNotePin(id: string): Promise<TodoSnapshot>
    onChanged(cb: (snapshot: TodoSnapshot) => void): () => void
    /**
     * 打开旁挂小面板（已开则聚焦）。
     * `focusQuickAdd = true` 时把光标落到快速录入框 —— 宠物右键的「记一条待办」走这条。
     */
    openPanel(focusQuickAdd?: boolean): void
    /** 面板窗口专用：主进程要求把光标落到快速录入框 */
    onFocusQuickAdd(cb: () => void): () => void
  }
}
