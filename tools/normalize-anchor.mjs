/**
 * 帧归一化：把逐帧图片（或一张雪碧图）处理成规范的动画雪碧图。
 *
 * 做三件事，缺一不可：
 *  1) 按 alpha 求包围盒，裁掉纯透明边；
 *  2) 用「角色高度中位数」算一个统一缩放系数（统一缩放而不是逐帧缩放到等高，
 *     这样动画里有意的压缩/拉伸不会被抹掉），再按画布留白比例缩放；
 *  3) 重排到固定画布：水平居中、底边贴齐画布下边缘（脚底锚点）。
 *
 * 输出为水平单行雪碧图：宽 = 画布宽 × 帧数，高 = 画布高。
 *
 * 缩放基准有两种模式：
 *  - 自动（默认）：把「内容高度中位数」拉到 `--height`（默认画布高 ×(1-2×margin)），即"填满画布"。
 *    适合单个姿态族内部对齐，**但跨姿态会出错**——趴卧天然比站立矮，自动模式会把它放大到与站立等高。
 *  - 显式（`--scale` 或 `--height`）：直接用给定系数换算，保证多个姿态族之间**绝对尺寸一致**。
 *    跨姿态族时用法：先用默认模式归一化站立族，记下打印的 scale，再把它传给其余族。
 *
 * 用法：
 *   node tools/normalize-anchor.mjs --in raw/idle-frames --frames 6 --out resources/pets/cat/idle.png
 *   node tools/normalize-anchor.mjs --in raw/idle.png --frames 6 --out resources/pets/cat/idle.png --canvas 200 --ratio 2
 *   node tools/normalize-anchor.mjs --in raw/sleep.png --frames 4 --out resources/pets/cat/sleep.png --scale 0.6731
 *
 * 画布可非正方形（--canvas 宽 --canvas-h 高）。跨姿态族共用一个高画布时，各姿态按统一的
 * `--scale` 换算，姿态之间的自然高度差（站立高、趴卧矮、悬空被拉长）就会被保留下来。
 *
 * `--emit-bounds <json>` 会导出每帧内容框与整体合并框（**DIP 单位**，相对画布左上角），
 * 供渲染层做精确命中判定——直接写进 manifest 的 `animations[x].bounds` 即可。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { alphaBounds, cropRgba, decodePng, drawRgba, encodePng, median, scaleRgba } from './png.mjs'

const CHAR_LABEL = {
  idle: '待机',
  walk: '走动',
  sleep: '睡觉',
  eat: '进食',
  drag: '被拖拽',
  click: '被点击',
  rest: '休息提醒',
  hot: '吃力',
  focus: '专注陪伴'
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]
  return fallback
}

const inputPath = arg('in')
const outputPath = arg('out')
const frames = Number(arg('frames', '0'))
const rows = Number(arg('rows', '1'))
const canvas = Number(arg('canvas', '200'))
const ratio = Number(arg('ratio', '2'))
const margin = Number(arg('margin', '0.06'))
const label = arg('label', '')
/** 画布高度（DIP）；缺省与 --canvas 相同（正方形画布） */
const canvasHArg = Number(arg('canvas-h', '')) || canvas
/** 导出内容框的 JSON 路径 */
const emitBounds = arg('emit-bounds', '')
/** 显式统一缩放系数；给了就完全跳过自动计算，用于跨姿态族保持绝对尺寸一致 */
const explicitScaleRaw = arg('scale', '')
/** 显式目标内容高度（输出像素）；给了就用它代替画布留白推算 */
const explicitHeightRaw = arg('height', '')

if (!inputPath || !outputPath || !Number.isInteger(frames) || frames < 1) {
  console.error(
    '用法：node tools/normalize-anchor.mjs --in <目录|雪碧图> --frames <n> --out <png> [--canvas 200] [--canvas-h 260] [--ratio 2] [--margin 0.06] [--scale 0.6731 | --height 352] [--emit-bounds bounds.json]'
  )
  process.exit(2)
}
if (explicitScaleRaw !== '' && !(Number(explicitScaleRaw) > 0)) {
  console.error(`--scale 必须是正数，收到：${explicitScaleRaw}`)
  process.exit(2)
}
if (explicitHeightRaw !== '' && !(Number(explicitHeightRaw) > 0)) {
  console.error(`--height 必须是正数，收到：${explicitHeightRaw}`)
  process.exit(2)
}
if (!existsSync(inputPath)) {
  console.error(`找不到输入：${inputPath}`)
  process.exit(2)
}

function loadFrames() {
  if (extname(inputPath).toLowerCase() === '.png') {
    const { width, height, data } = decodePng(readFileSync(inputPath))
    if (width % frames !== 0) throw new Error(`雪碧图宽度 ${width} 不能被帧数 ${frames} 整除`)
    const fw = width / frames / rows
    const fh = height / rows
    const list = []
    for (let i = 0; i < frames; i += 1) {
      list.push({ data: cropRgba(data, width, height, i * fw, 0, fw, fh), w: fw, h: fh })
    }
    return list
  }

  const files = readdirSync(inputPath)
    .filter((name) => extname(name).toLowerCase() === '.png')
    .sort()
  if (files.length === 0) throw new Error(`目录里没有 PNG：${inputPath}`)
  const picked = files.slice(0, frames)
  return picked.map((name) => {
    const { width, height, data } = decodePng(readFileSync(join(inputPath, name)))
    return { data, w: width, h: height }
  })
}

const items = loadFrames()
if (items.length !== frames) {
  console.error(`需要 ${frames} 帧，实际只有 ${items.length} 帧`)
  process.exit(1)
}

const trimmed = items.map((item, index) => {
  const bounds = alphaBounds(item.data, item.w, item.h)
  if (!bounds) throw new Error(`第 ${index} 帧内容全透明，请检查抠图结果`)
  return {
    index,
    bounds,
    data: cropRgba(item.data, item.w, item.h, bounds.x, bounds.y, bounds.w, bounds.h)
  }
})

const canvasW = Math.round(canvas * ratio)
const canvasH = Math.round(canvasHArg * ratio)
const contentHeights = trimmed.map((item) => item.bounds.h)
const medianH = median(contentHeights)
const autoTargetH = canvasH * (1 - margin * 2)
const targetH = explicitHeightRaw !== '' ? Number(explicitHeightRaw) : autoTargetH
const scaleMode =
  explicitScaleRaw !== ''
    ? `显式 --scale ${explicitScaleRaw}`
    : explicitHeightRaw !== ''
      ? `显式 --height ${targetH}px`
      : `自动（内容高拉到 ${targetH.toFixed(1)}px，留白 ${(margin * 100).toFixed(1)}%）`
const scale = explicitScaleRaw !== '' ? Number(explicitScaleRaw) : targetH / medianH

const sheet = Buffer.alloc(canvasW * frames * canvasH * 4)
const report = []
/** 每帧在画布中的实际放置框（输出像素），用于导出命中判定所需的 bounds */
const placed = []
/** 被"横向过宽"兜底缩小的帧——一旦发生，绝对尺寸一致性就被破坏了，必须让调用方看见 */
const clampedFrames = []

for (const item of trimmed) {
  const ratioW = item.bounds.w / item.bounds.h
  let height = Math.max(1, Math.round(item.bounds.h * scale))
  let width = Math.max(1, Math.round(item.bounds.w * scale))
  // 横向过宽的帧（例如伸懒腰）限制在画布内，避免溢出到相邻格
  const maxWidth = canvasW - Math.round(canvasW * 0.04)
  if (width > maxWidth) {
    const shrink = maxWidth / width
    width = maxWidth
    height = Math.max(1, Math.round(height * shrink))
    clampedFrames.push({ frame: item.index, w: item.bounds.w, h: item.bounds.h, shrink })
  }
  const scaled = scaleRgba(item.data, item.bounds.w, item.bounds.h, width, height)
  const dx = Math.round((canvasW - width) / 2)
  const dy = canvasH - height // 底边贴齐 = 脚底锚点
  drawRgba(sheet, canvasW * frames, canvasH, scaled, width, height, item.index * canvasW + dx, dy)
  placed.push({ x: dx, y: dy, w: width, h: height })
  report.push({
    帧: item.index,
    原尺寸: `${item.bounds.w}×${item.bounds.h}`,
    比例: ratioW.toFixed(2),
    放置: `${width}×${height} @ (${dx},${dy})`
  })
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, encodePng(canvasW * frames, canvasH, sheet))

const spread = (Math.max(...contentHeights) - Math.min(...contentHeights)) / medianH
console.log(`[normalize] ${label ? `${label} ` : ''}${resolve(outputPath)}`)
console.log(`            画布 ${canvasW}×${canvasH}（逻辑 ${canvas}，${ratio}x）× ${frames} 帧 = ${canvasW * frames}×${canvasH}`)
console.log(`            缩放基准：${scaleMode}`)
console.log(`            内容高度中位数 ${medianH.toFixed(1)}px，统一缩放 ${scale.toFixed(4)}`)
console.log(`            帧高度离散度 ${(spread * 100).toFixed(1)}%${spread > 0.25 ? '（偏大，建议检查素材一致性）' : ''}`)
if (clampedFrames.length > 0) {
  console.warn(
    `            ⚠ 有 ${clampedFrames.length} 帧因横向过宽被兜底缩小，绝对尺寸一致性已被破坏：` +
      clampedFrames.map((c) => `帧${c.frame}(${c.w}×${c.h} ×${c.shrink.toFixed(2)})`).join(' ')
  )
  console.warn('            对策：改用更宽的 --canvas，或重新出图让角色更紧凑。')
}
if (report.length <= 12) console.table(report)

if (emitBounds) {
  const toDip = (v) => Math.round((v / ratio) * 10) / 10
  const x1 = Math.min(...placed.map((p) => p.x))
  const y1 = Math.min(...placed.map((p) => p.y))
  const x2 = Math.max(...placed.map((p) => p.x + p.w))
  const y2 = Math.max(...placed.map((p) => p.y + p.h))
  const payload = {
    output: resolve(outputPath),
    canvas: { w: canvas, h: canvasHArg },
    frames: placed.map((p) => ({ x: toDip(p.x), y: toDip(p.y), w: toDip(p.w), h: toDip(p.h) })),
    /** 合并框：跨帧内容的最大包络，写进 manifest 的 animations[x].bounds 用于命中判定 */
    bounds: { x: toDip(x1), y: toDip(y1), w: toDip(x2 - x1), h: toDip(y2 - y1) }
  }
  mkdirSync(dirname(emitBounds), { recursive: true })
  writeFileSync(emitBounds, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`            命中框已导出 → ${resolve(emitBounds)}`)
  console.log(`            bounds(DIP) = ${JSON.stringify(payload.bounds)}`)
}
