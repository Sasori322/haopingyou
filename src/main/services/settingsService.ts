import { DEFAULT_SETTINGS, PET_SCALE_MAX, PET_SCALE_MIN } from '../../shared/constants'
import type { AppSettings } from '../../shared/types/settings'
import { JsonStore } from './store'

let store: JsonStore<AppSettings> | null = null

/** 懒初始化：JsonStore 依赖 app.getPath('userData')，必须在 app ready 之后创建 */
function ensure(): JsonStore<AppSettings> {
  if (!store) store = new JsonStore<AppSettings>('settings', DEFAULT_SETTINGS)
  return store
}

/**
 * 夹回越界的数值。
 *
 * `sanitizeSettingsPatch` 只拦得住新写入，拦不住**磁盘上已经躺着的**旧值 ——
 * `petScale` 早先允许配到 2，改上限之后旧配置文件里可能还是 1.5，光改滑块不会修正它。
 * 所以在唯一的读取出口做一次收敛（就地改内存里的同一份对象，下一次落盘即固化）。
 */
function normalize(data: AppSettings): AppSettings {
  if (data.petScale > PET_SCALE_MAX) data.petScale = PET_SCALE_MAX
  else if (data.petScale < PET_SCALE_MIN) data.petScale = PET_SCALE_MIN
  return data
}

export function getSettings(): AppSettings {
  return normalize(ensure().all())
}

export function patchSettings(patch: Partial<AppSettings>): AppSettings {
  return ensure().set(patch)
}

export function flushSettings(): void {
  store?.flush()
}

export function settingsFilePath(): string {
  return ensure().path
}
