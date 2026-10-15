import { ref } from 'vue'
import type { AppSettings } from '@shared/types/settings'
import type { DeepPartial } from '@shared/api'

/**
 * 设置读写单例。
 * 所有写操作都只经主进程落盘，渲染进程永不直连存储，避免多窗口并发写损坏文件。
 */
const settings = ref<AppSettings | null>(null)
let initialized = false

function init(): void {
  if (initialized) return
  initialized = true
  void window.petAPI.settings.get().then((value) => {
    settings.value = value
  })
  window.petAPI.settings.onChanged((value) => {
    settings.value = value
  })
}

export function useSettings(): {
  settings: typeof settings
  patch: (patch: DeepPartial<AppSettings>) => Promise<void>
} {
  init()
  async function patch(patchValue: DeepPartial<AppSettings>): Promise<void> {
    settings.value = await window.petAPI.settings.patch(patchValue)
  }
  return { settings, patch }
}
