/**
 * 把一张雪碧图切成逐帧 PNG。
 *
 * 两种模式：
 *  1) 等分切（默认）：按 cols×rows 均分。sheet 一律水平单行排布（rows=1），切片零歧义。
 *     宽高不能被帧数整除时直接报错退出——1px 错位会让整个动画抖动。
 *  2) 自动识帧（--auto）：AI 生成的条带图**几乎不可能等间距**（实测 4 只猫横向互相重叠
 *     10~15px，四等分切点全部落在角色身上），改用连通块识别：
 *       - 面积 ≥ 最大块 × minAreaRatio 的连通块视为「角色主体」；
 *       - 其余小块（胡须碎片、闪光、水印残渣）按 x 区间重叠就近吸附到主体；
 *       - 主体按左边界排序即为帧序。
 *     角色之间**允许横向重叠**，因为判据是面积而非间隔。
 *     ⚠ 因为允许横向重叠，裁帧时**必须按连通块掩码只保留本帧像素**，否则会把邻居的
 *     尾巴尖/胡须一起裁进来（表现为角色旁边出现悬浮碎片）。
 *
 * 用法：
 *   node tools/slice-spritesheet.mjs --sheet raw/idle.png --frames 6 --out raw/idle-frames
 *   node tools/slice-spritesheet.mjs --sheet raw/idle.png --frames 6 --out out --key magenta
 *   node tools/slice-spritesheet.mjs --sheet raw/strip.png --out raw/frames --auto --frames 4
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromaKey, cropRgba, decodePng, encodePng } from './png.mjs'

const KEY_COLORS = {
  magenta: [255, 0, 255],
  green: [0, 255, 0],
  white: [255, 255, 255],
  black: [0, 0, 0]
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]
  return fallback
}

function flag(name) {
  return process.argv.includes(`--${name}`)
}

function parseKey(value) {
  if (!value) return null
  if (KEY_COLORS[value]) return KEY_COLORS[value]
  const parts = value.split(',').map(Number)
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) return parts
  throw new Error(`无法识别的幕布颜色：${value}`)
}

/**
 * 4 邻接连通块。返回 { comps, labels }：
 *  - comps：按扫描顺序排列的 { cnt, x1, y1, x2, y2 }（**不排序**，下标即 label）
 *  - labels：Int32Array，每个像素所属的 comps 下标，背景为 -1
 */
function findComponents(data, width, height, alphaT) {
  const total = width * height
  const solid = new Uint8Array(total)
  for (let i = 0; i < total; i += 1) solid[i] = data[i * 4 + 3] > alphaT ? 1 : 0

  const labels = new Int32Array(total).fill(-1)
  const comps = []
  const stack = []
  for (let seed = 0; seed < total; seed += 1) {
    if (!solid[seed] || labels[seed] >= 0) continue
    const id = comps.length
    let cnt = 0
    let x1 = width
    let y1 = height
    let x2 = 0
    let y2 = 0
    stack.length = 0
    stack.push(seed)
    labels[seed] = id
    while (stack.length) {
      const i = stack.pop()
      const x = i % width
      const y = (i - x) / width
      cnt += 1
      if (x < x1) x1 = x
      if (y < y1) y1 = y
      if (x > x2) x2 = x
      if (y > y2) y2 = y
      if (x > 0 && solid[i - 1] && labels[i - 1] < 0) (labels[i - 1] = id), stack.push(i - 1)
      if (x < width - 1 && solid[i + 1] && labels[i + 1] < 0) (labels[i + 1] = id), stack.push(i + 1)
      if (y > 0 && solid[i - width] && labels[i - width] < 0) (labels[i - width] = id), stack.push(i - width)
      if (y < height - 1 && solid[i + width] && labels[i + width] < 0) (labels[i + width] = id), stack.push(i + width)
    }
    comps.push({ cnt, x1, y1, x2, y2 })
  }
  return { comps, labels }
}

/** 按连通块自动识别帧：返回 [{ x, y, w, h, compIds }]，从左到右 */
function detectFrames(data, width, height, alphaT, minAreaRatio) {
  const { comps, labels } = findComponents(data, width, height, alphaT)
  if (comps.length === 0) return { frames: [], comps, labels }

  const byArea = comps.map((_, i) => i).sort((a, b) => comps[b].cnt - comps[a].cnt)
  const maxArea = comps[byArea[0]].cnt
  const mainIds = byArea.filter((i) => comps[i].cnt >= maxArea * minAreaRatio)
  const smallIds = byArea.filter((i) => comps[i].cnt < maxArea * minAreaRatio)

  const attached = new Map(mainIds.map((i) => [i, [i]]))

  // 小块吸附：优先吸附到 x 区间重叠最多者，否则吸附到中心最近者
  for (const s of smallIds) {
    let best = mainIds[0]
    let bestScore = -Infinity
    for (const m of mainIds) {
      const overlap = Math.min(comps[m].x2, comps[s].x2) - Math.max(comps[m].x1, comps[s].x1)
      const score =
        overlap > 0 ? overlap : -Math.abs((comps[m].x1 + comps[m].x2) / 2 - (comps[s].x1 + comps[s].x2) / 2) / 1000
      if (score > bestScore) {
        bestScore = score
        best = m
      }
    }
    attached.get(best).push(s)
    const m = comps[best]
    m.x1 = Math.min(m.x1, comps[s].x1)
    m.x2 = Math.max(m.x2, comps[s].x2)
    m.y1 = Math.min(m.y1, comps[s].y1)
    m.y2 = Math.max(m.y2, comps[s].y2)
  }

  mainIds.sort((a, b) => comps[a].x1 - comps[b].x1)
  return {
    frames: mainIds.map((id) => {
      const m = comps[id]
      return { x: m.x1, y: m.y1, w: m.x2 - m.x1 + 1, h: m.y2 - m.y1 + 1, compIds: attached.get(id) }
    }),
    comps,
    labels
  }
}

/** 只复制属于本帧连通块的像素，其余留透明——避免裁进邻居角色溢出的尾巴/胡须 */
function cropMasked(data, width, labels, frame) {
  const out = Buffer.alloc(frame.w * frame.h * 4)
  const keep = new Set(frame.compIds)
  for (let y = 0; y < frame.h; y += 1) {
    const sy = frame.y + y
    for (let x = 0; x < frame.w; x += 1) {
      const si = sy * width + frame.x + x
      if (!keep.has(labels[si])) continue
      const di = (y * frame.w + x) * 4
      const s4 = si * 4
      out[di] = data[s4]
      out[di + 1] = data[s4 + 1]
      out[di + 2] = data[s4 + 2]
      out[di + 3] = data[s4 + 3]
    }
  }
  return out
}

const sheetPath = arg('sheet')
const outDir = arg('out')
const cols = Number(arg('frames', '0'))
const rows = Number(arg('rows', '1'))
const keyColor = parseKey(arg('key'))
const tolerance = Number(arg('tolerance', '90'))
const auto = flag('auto')
const alphaT = Number(arg('alpha', '8'))
const minAreaRatio = Number(arg('min-area-ratio', '0.15'))

if (!sheetPath || !outDir) {
  console.error(
    '用法：node tools/slice-spritesheet.mjs --sheet <png> (--frames <n> [--rows 1] | --auto) --out <dir> [--key magenta]'
  )
  process.exit(2)
}
if (!auto && (!Number.isInteger(cols) || cols < 1)) {
  console.error('等分切模式必须给 --frames <n>（正整数）')
  process.exit(2)
}
if (!existsSync(sheetPath)) {
  console.error(`找不到源图：${sheetPath}`)
  process.exit(2)
}

const { width, height, data } = decodePng(readFileSync(sheetPath))

if (keyColor) chromaKey(data, width, height, keyColor, tolerance, 40)

mkdirSync(outDir, { recursive: true })

if (auto) {
  const { frames, comps, labels } = detectFrames(data, width, height, alphaT, minAreaRatio)
  if (frames.length === 0) {
    console.error('自动识帧失败：图中没有任何不透明内容')
    process.exit(1)
  }
  if (Number.isInteger(cols) && cols >= 1 && frames.length !== cols) {
    console.error(
      `自动识帧得到 ${frames.length} 帧，与 --frames ${cols} 不符。` +
        `（连通块共 ${comps.length} 个；可调 --min-area-ratio 改变主体判定阈值）`
    )
    process.exit(1)
  }
  console.log(`[slice] ${resolve(sheetPath)}  ← 自动识帧`)
  console.log(`        源图 ${width}×${height}，连通块 ${comps.length} 个，识别出 ${frames.length} 帧`)
  frames.forEach((f, i) => {
    const frame = cropMasked(data, width, labels, f)
    const name = `frame-${String(i).padStart(2, '0')}.png`
    writeFileSync(join(outDir, name), encodePng(f.w, f.h, frame))
    console.log(
      `        frame-${String(i).padStart(2, '0')}  源位置 x[${f.x}-${f.x + f.w - 1}] y[${f.y}-${f.y + f.h - 1}]  ${f.w}×${f.h}  合并连通块 ${f.compIds.length} 个`
    )
  })
  console.log(`        输出 ${frames.length} 个文件到 ${resolve(outDir)}`)
} else {
  if (width % cols !== 0) {
    console.error(`宽度 ${width} 不能被帧数 ${cols} 整除，无法切片（差 ${width % cols}px）`)
    process.exit(1)
  }
  if (height % rows !== 0) {
    console.error(`高度 ${height} 不能被行数 ${rows} 整除`)
    process.exit(1)
  }

  const frameW = width / cols
  const frameH = height / rows

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col
      const frame = cropRgba(data, width, height, col * frameW, row * frameH, frameW, frameH)
      const name = `frame-${String(index).padStart(2, '0')}.png`
      writeFileSync(join(outDir, name), encodePng(frameW, frameH, frame))
    }
  }

  console.log(`[slice] ${resolve(sheetPath)}`)
  console.log(`        源图 ${width}×${height} → ${cols}×${rows} 帧，每帧 ${frameW}×${frameH}`)
  console.log(`        输出 ${cols * rows} 个文件到 ${resolve(outDir)}`)
}
