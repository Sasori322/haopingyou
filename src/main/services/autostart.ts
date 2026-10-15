import { app } from 'electron'
import { createLogger } from '../utils/logger'

const log = createLogger('autostart')

/**
 * 开发态 process.execPath 指向 electron.exe，写进注册表会导致开机弹出一个空壳，
 * 因此只在打包后（且仅在 Windows 上）生效。
 */
export function isAutostartSupported(): boolean {
  return app.isPackaged && process.platform === 'win32'
}

const LOGIN_ARGS = ['--autostart']

export function getAutostart(): boolean {
  if (!isAutostartSupported()) return false
  try {
    // 读取时的 path / args 必须与写入时完全一致，否则 Windows 会判定为不匹配而恒为 false
    return app.getLoginItemSettings({ path: process.execPath, args: LOGIN_ARGS }).openAtLogin
  } catch (error) {
    log.warn('读取开机自启状态失败', error)
    return false
  }
}

export function setAutostart(enabled: boolean): boolean {
  if (!isAutostartSupported()) {
    log.info('开发态或非 Windows 平台，跳过开机自启设置')
    return false
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: LOGIN_ARGS
    })
    return getAutostart()
  } catch (error) {
    log.error('设置开机自启失败', error)
    return false
  }
}

/** 本次启动是否由「开机自启」触发（静默启动、宠物延迟出现） */
export function isAutostartLaunch(): boolean {
  return process.argv.includes('--autostart')
}
