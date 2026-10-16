/**
 * 快捷键的「对外写法」收口。
 *
 * Electron Accelerator 里那个「按平台自动选 Ctrl / Cmd」的写法是 `CommandOrControl`
 * （常见别名还有 `CmdOrCtrl` / `Control`）。本项目**只跑 Windows**，它在 Windows 上就是 Ctrl，
 * 所以对用户一律写成 `Ctrl` —— `CommandOrControl+Alt+T` 这种串又长又不好念，摆在设置页里像乱码。
 *
 * ⚠️ 归一后的串**本身仍是合法 Accelerator**（主进程 `globalHotkeys` 的格式白名单里就含 `Ctrl`），
 *     所以"显示 / 保存 / 注册"三处共用同一个写法，**不需要**"显示时翻译、保存时翻回来"那层映射，
 *     也就不存在两者写歪的机会。老存档里的 `CommandOrControl+…` 照常注册（Electron 自己认），
 *     读出来经这里归一即可 —— 升级不需要写迁移代码。
 */

/** 在 Windows 上与 Ctrl 完全等价的几种写法（Electron 把 `Control` 也当 Ctrl） */
const CTRL_ALIASES = new Set(['CommandOrControl', 'CmdOrCtrl', 'Control', 'Ctrl'])
/** 在 Windows 上与 Win 键等价的写法 */
const SUPER_ALIASES = new Set(['Super', 'Meta'])
/** 修饰键的固定显示顺序，保证同一把键在设置页、提示、日志里长得一样 */
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'AltGr', 'Shift', 'Super']

/** 归一成规范修饰键名；不是修饰键则返回 null（当作主键） */
function canonModifier(part: string): string | null {
  if (CTRL_ALIASES.has(part)) return 'Ctrl'
  if (SUPER_ALIASES.has(part)) return 'Super'
  if (part === 'Alt' || part === 'AltGr' || part === 'Shift') return part
  return null
}

/**
 * 把 accelerator 归一对用户友好的写法：Ctrl 家族统一写 `Ctrl`，修饰键按固定顺序排在最前。
 *
 * - 空串原样返回（= 未设置 / 已禁用），调用方不需要先判空。
 * - **幂等**：归一过的串再喂进来结果不变，所以可以放心在显示、校验、提交多处重复调用。
 * - 只动修饰键的名字与顺序，主键原样保留（大小写不敏感由 Electron 与格式白名单负责）。
 */
export function formatHotkey(value: string): string {
  const text = value.trim()
  if (text === '') return ''
  const mods: string[] = []
  const rest: string[] = []
  for (const raw of text.split('+')) {
    const part = raw.trim()
    if (part === '') continue
    const mod = canonModifier(part)
    if (mod === null) rest.push(part)
    else mods.push(mod)
  }
  mods.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b))
  return [...mods, ...rest].join('+')
}
