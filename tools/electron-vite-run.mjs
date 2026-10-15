/**
 * 启动 electron-vite 的跨平台包装器。
 *
 * 存在的唯一原因：部分宿主环境（含 CI / 集成终端）会预设 `ELECTRON_RUN_AS_NODE`，
 * 而 Electron 只要看到该变量存在（哪怕值为空串）就会退化成纯 Node 运行——
 * 此时 `require('electron')` 只会返回二进制路径字符串，主进程会在
 * `app.commandLine` 一行直接崩溃。
 *
 * 这里在派生 electron-vite 之前彻底删除该变量，子进程继承到干净环境。
 */
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

delete process.env.ELECTRON_RUN_AS_NODE

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = resolve(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const args = process.argv.slice(2)

const child = spawn(process.execPath, [cli, ...args], {
  stdio: 'inherit',
  cwd: root,
  env: process.env
})

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0))
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
