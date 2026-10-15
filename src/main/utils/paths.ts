import { app } from 'electron'
import { join } from 'node:path'

/**
 * 运行时资源根目录。
 * 打包后：process.resourcesPath（由 electron-builder 的 extraResources 投放）
 * 开发态：<项目根>/resources
 */
export function resourcesRoot(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
}

export function resourcePath(...parts: string[]): string {
  return join(resourcesRoot(), ...parts)
}
