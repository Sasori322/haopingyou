/**
 * 校验宠物清单与素材一致性。
 *
 * 判定分两级：
 *   ERROR —— manifest 结构错误（动画缺失、hitbox 出界、非循环动画没写 next 等），会导致运行期异常，必须修。
 *   WARN  —— 雪碧图尚未生成（M1 阶段属正常，渲染层会回退占位形象），或帧尺寸与画布倍数不符。
 * 只有 ERROR 会让进程以非 0 退出。
 *
 * 用法：node tools/validate-pet.mjs [--root resources/pets]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { decodePng } from './png.mjs'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]
  return fallback
}

const root = resolve(arg('root', 'resources/pets'))

const errors = []
const warnings = []

function checkPet(dir) {
  const name = dir.split(/[\\/]/).pop()
  const manifestPath = join(dir, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    errors.push(`[${name}] manifest.json 无法解析：${error.message}`)
    return
  }

  const fail = (message) => errors.push(`[${name}] ${message}`)
  const warn = (message) => warnings.push(`[${name}] ${message}`)

  if (typeof manifest.id !== 'string' || !manifest.id) fail('缺少 id')
  else if (manifest.id !== name) warn(`id（${manifest.id}）与目录名（${name}）不一致`)
  if (manifest.kind !== 'cat' && manifest.kind !== 'dog') fail('kind 必须是 cat 或 dog')

  const canvas = manifest.canvas
  if (!canvas || !(canvas.w > 0) || !(canvas.h > 0)) fail('canvas 缺失或非法')
  const hitbox = manifest.hitbox
  if (!hitbox || !(hitbox.w > 0) || !(hitbox.h > 0)) fail('hitbox 缺失或非法')
  else if (canvas && (hitbox.x < 0 || hitbox.y < 0 || hitbox.x + hitbox.w > canvas.w || hitbox.y + hitbox.h > canvas.h)) {
    fail(`hitbox（${hitbox.x},${hitbox.y},${hitbox.w}×${hitbox.h}）超出画布 ${canvas.w}×${canvas.h}`)
  }

  const animations = manifest.animations
  if (!animations || typeof animations !== 'object' || Object.keys(animations).length === 0) {
    fail('animations 为空')
    return
  }
  if (!animations[manifest.defaultAnimation]) {
    fail(`defaultAnimation（${manifest.defaultAnimation}）不在 animations 中`)
  }

  for (const [key, anim] of Object.entries(animations)) {
    if (!Number.isInteger(anim.frames) || anim.frames < 1) fail(`animations.${key}.frames 非法`)
    if (!(anim.fps > 0)) fail(`animations.${key}.fps 非法`)
    if (anim.loop === false && !anim.next) warn(`animations.${key} 非循环但未声明 next`)
    if (anim.bounds) {
      const b = anim.bounds
      const bad =
        !(b.w > 0) ||
        !(b.h > 0) ||
        b.x < 0 ||
        b.y < 0 ||
        b.x + b.w > canvas.w + 0.5 ||
        b.y + b.h > canvas.h + 0.5
      if (bad) {
        warn(
          `animations.${key}.bounds 非法或超出画布（画布 ${canvas.w}×${canvas.h}，bounds ${JSON.stringify(b)}）`
        )
      }
    }
    if (anim.mode === 'sheet') {
      if (!anim.src) {
        fail(`animations.${key} 为 sheet 模式但缺少 src`)
        continue
      }
      const file = join(dir, anim.src)
      if (!existsSync(file)) {
        warn(`animations.${key} 素材尚未生成（${anim.src}）`)
        continue
      }
      const { width, height } = decodePng(readFileSync(file))
      if (width % anim.frames !== 0) {
        fail(`${anim.src} 宽度 ${width} 不能被 ${anim.frames} 帧整除`)
      } else {
        const frameW = width / anim.frames
        const expectedW = canvas.w * 2
        const expectedH = canvas.h * 2
        // 画布允许非正方形：悬空挣扎比站立高约 43%，用正方形画布会把它裁掉
        if (Math.abs(frameW - expectedW) > 1 || Math.abs(height - expectedH) > 1) {
          warn(
            `${anim.src} 单帧 ${frameW}×${height} 与约定 ${expectedW}×${expectedH}` +
              `（画布 ${canvas.w}×${canvas.h} 的 2 倍）不符`
          )
        }
      }
    } else if (anim.mode === 'sequence') {
      if (!anim.dir) fail(`animations.${key} 为 sequence 模式但缺少 dir`)
      else if (!existsSync(join(dir, anim.dir))) warn(`animations.${key} 帧目录尚未生成（${anim.dir}/）`)
    } else {
      fail(`animations.${key}.mode 必须是 sheet 或 sequence`)
    }
  }

  const bubbles = manifest.bubbles
  if (bubbles && typeof bubbles === 'object') {
    for (const [reason, lines] of Object.entries(bubbles)) {
      if (!Array.isArray(lines) || lines.length === 0) warn(`bubbles.${reason} 为空数组`)
    }
  }

  const status = errors.some((line) => line.startsWith(`[${name}]`)) ? 'FAIL' : 'OK'
  const animCount = Object.keys(animations).length
  const readyCount = Object.values(animations).filter(
    (anim) => anim.mode === 'sheet' && anim.src && existsSync(join(dir, anim.src))
  ).length
  console.log(
    `  ${status === 'OK' ? '✔' : '✘'} ${manifest.name ?? name}（${manifest.id ?? name}）` +
      `  动画 ${readyCount}/${animCount} 素材就绪`
  )
}

console.log(`[validate] 宠物根目录：${root}`)
if (!existsSync(root)) {
  console.log('  目录不存在（属正常：尚未放入任何宠物）')
  process.exit(0)
}

const dirs = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(root, entry.name))
  .filter((dir) => existsSync(join(dir, 'manifest.json')))

if (dirs.length === 0) {
  console.log('  没有找到任何带 manifest.json 的宠物目录')
  process.exit(0)
}

for (const dir of dirs) checkPet(dir)

console.log('')
if (warnings.length > 0) {
  console.log(`提醒（${warnings.length}）：`)
  for (const line of warnings) console.log(`  · ${line}`)
}
if (errors.length > 0) {
  console.log(`错误（${errors.length}）：`)
  for (const line of errors) console.log(`  ✘ ${line}`)
  process.exit(1)
}
console.log('清单校验通过。')
