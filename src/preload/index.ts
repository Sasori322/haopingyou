import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc'
import type { PetApi } from '../shared/api'
import type {
  ForceStatePayload,
  GazePayload,
  PetState,
  PointerSyncPayload,
  ReloadPayload,
  SpeakPayload
} from '../shared/types/pet'
import type { AppSettings } from '../shared/types/settings'
import type { ClipboardStatus } from '../shared/types/clipboard'

/** 订阅辅助：统一返回取消订阅函数，组件卸载时必须调用，否则窗口重载会累积监听 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: PetApi = {
  setIgnoreMouse: (ignore) => ipcRenderer.send(IPC.PET_SET_IGNORE_MOUSE, ignore),
  dragStart: (offset) => ipcRenderer.send(IPC.PET_DRAG_START, offset),
  dragMove: (pos) => ipcRenderer.send(IPC.PET_DRAG_MOVE, pos),
  dragEnd: () => ipcRenderer.send(IPC.PET_DRAG_END),
  getGeometry: () => ipcRenderer.invoke(IPC.PET_GET_GEOMETRY),

  listPets: () => ipcRenderer.invoke(IPC.PET_LIST),
  getActivePet: () => ipcRenderer.invoke(IPC.PET_GET_ACTIVE),
  setActivePet: (petId) => ipcRenderer.invoke(IPC.PET_SET_ACTIVE, petId),
  popupMenu: (kind) => ipcRenderer.send(IPC.PET_POPUP_MENU, kind),
  reportState: (state: PetState) => ipcRenderer.send(IPC.PET_STATE_CHANGED, state),
  requestSpeak: (reason, text) => ipcRenderer.send(IPC.PET_REQUEST_SPEAK, { reason, text }),
  requestState: (state, reason) => ipcRenderer.send(IPC.PET_REQUEST_STATE, { state, reason }),

  onSpeak: (cb) => subscribe<SpeakPayload>(IPC.PET_SPEAK, cb),
  onForceState: (cb) => subscribe<ForceStatePayload>(IPC.PET_FORCE_STATE, cb),
  onReload: (cb) => subscribe<ReloadPayload>(IPC.PET_RELOAD, cb),
  onGaze: (cb) => subscribe<GazePayload>(IPC.PET_GAZE, cb),
  onPointerSync: (cb) => subscribe<PointerSyncPayload>(IPC.PET_POINTER_SYNC, cb),

  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    patch: (patch) => ipcRenderer.invoke(IPC.SETTINGS_PATCH, patch),
    onChanged: (cb) => subscribe<AppSettings>(IPC.SETTINGS_CHANGED, cb)
  },

  app: {
    getVersion: () => ipcRenderer.invoke(IPC.APP_GET_VERSION),
    getAutostart: () => ipcRenderer.invoke(IPC.APP_GET_AUTOSTART),
    setAutostart: (enabled) => ipcRenderer.invoke(IPC.APP_SET_AUTOSTART, enabled),
    openSettings: () => ipcRenderer.send(IPC.APP_OPEN_SETTINGS),
    showPet: () => ipcRenderer.send(IPC.APP_SHOW_PET),
    hidePet: () => ipcRenderer.send(IPC.APP_HIDE_PET),
    quit: () => ipcRenderer.send(IPC.APP_QUIT),
    getImmersiveStatus: () => ipcRenderer.invoke(IPC.APP_GET_IMMERSIVE_STATUS),
    getReminderStatus: () => ipcRenderer.invoke(IPC.APP_GET_REMINDER_STATUS),
    setDnd: (minutes) => ipcRenderer.invoke(IPC.APP_SET_DND, minutes),
    openClipboardPanel: () => ipcRenderer.send(IPC.CLIPBOARD_OPEN_PANEL)
  },

  clipboard: {
    list: () => ipcRenderer.invoke(IPC.CLIPBOARD_LIST),
    status: () => ipcRenderer.invoke(IPC.CLIPBOARD_STATUS),
    set: (id) => ipcRenderer.invoke(IPC.CLIPBOARD_SET, id),
    delete: (id) => ipcRenderer.invoke(IPC.CLIPBOARD_DELETE, id),
    togglePin: (id) => ipcRenderer.invoke(IPC.CLIPBOARD_TOGGLE_PIN, id),
    clear: () => ipcRenderer.invoke(IPC.CLIPBOARD_CLEAR),
    pause: (minutes) => ipcRenderer.invoke(IPC.CLIPBOARD_PAUSE, minutes),
    onChanged: (cb) => subscribe<ClipboardStatus>(IPC.CLIPBOARD_CHANGED, cb),
    pickStorageDir: () => ipcRenderer.invoke(IPC.CLIPBOARD_PICK_DIR),
    validateStorageDir: (path: string) => ipcRenderer.invoke(IPC.CLIPBOARD_VALIDATE_DIR, path),
    tryHotkey: (hotkey: string) => ipcRenderer.invoke(IPC.CLIPBOARD_TRY_HOTKEY, hotkey),
    beginHotkeyRecording: () => ipcRenderer.invoke(IPC.CLIPBOARD_BEGIN_RECORDING),
    endHotkeyRecording: (newHotkey: string | null) =>
      ipcRenderer.invoke(IPC.CLIPBOARD_END_RECORDING, newHotkey)
  }
}

contextBridge.exposeInMainWorld('petAPI', api)
