/**
 * 纯 Node 生成应用图标与托盘图标（零依赖：zlib + 手写 PNG/ICO 封装）。
 *
 * 产出：
 *   build/icon.png         512×512，交给 electron-builder 生成安装包图标
 *   build/icon.ico         多尺寸（16/24/32/48/64/128/256），供 Windows 直接使用
 *   resources/icons/tray.png  32×32，运行时托盘图标
 *
 * 用法：node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------- 几何工具

const hex = (value) => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16)
]

const COLOR = {
  gradFrom: hex('#FF8A4C'),
  gradTo: hex('#E1251B'),
  fur: hex('#FFF3E4'),
  earInner: hex('#F5A48C'),
  ink: hex('#3F2C22'),
  nose: hex('#E8836B'),
  white: [255, 255, 255]
}

function inRoundRect(x, y, cx, cy, hx, hy, r) {
  const dx = Math.abs(x - cx) - (hx - r)
  const dy = Math.abs(y - cy) - (hy - r)
  if (dx <= 0 && dy <= 0) return true
  const ox = Math.max(dx, 0)
  const oy = Math.max(dy, 0)
  return ox * ox + oy * oy <= r * r
}

const inEllipse = (x, y, cx, cy, rx, ry) => {
  const dx = (x - cx) / rx
  const dy = (y - cy) / ry
  return dx * dx + dy * dy <= 1
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

/** 圆环的一段（用 y 范围与 x 半侧截取），用来画嘴 */
function inArcRing(x, y, cx, cy, r, half, side) {
  const dx = x - cx
  const dy = y - cy
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (Math.abs(dist - r) > half) return false
  if (dy < 0) return false
  return side === 'left' ? dx <= 0 : dx >= 0
}

// ---------------------------------------------------------------- 图案定义

function sample(x, y) {
  // 背景圆角方块 + 渐变
  if (!inRoundRect(x, y, 0.5, 0.5, 0.47, 0.47, 0.235)) return [0, 0, 0, 0]
  const t = Math.min(1, Math.max(0, (x + y) / 2))
  let color = [
    Math.round(COLOR.gradFrom[0] + (COLOR.gradTo[0] - COLOR.gradFrom[0]) * t),
    Math.round(COLOR.gradFrom[1] + (COLOR.gradTo[1] - COLOR.gradFrom[1]) * t),
    Math.round(COLOR.gradFrom[2] + (COLOR.gradTo[2] - COLOR.gradFrom[2]) * t)
  ]

  // 头部
  if (inEllipse(x, y, 0.5, 0.555, 0.212, 0.205)) color = COLOR.fur
  // 耳朵（外）
  if (
    inTriangle(x, y, 0.335, 0.45, 0.298, 0.222, 0.487, 0.372) ||
    inTriangle(x, y, 0.665, 0.45, 0.702, 0.222, 0.513, 0.372)
  ) {
    color = COLOR.fur
  }
  // 耳朵（内）
  if (
    inTriangle(x, y, 0.375, 0.415, 0.352, 0.296, 0.455, 0.375) ||
    inTriangle(x, y, 0.625, 0.415, 0.648, 0.296, 0.545, 0.375)
  ) {
    color = COLOR.earInner
  }
  // 眼睛
  if (
    inEllipse(x, y, 0.428, 0.552, 0.031, 0.041) ||
    inEllipse(x, y, 0.572, 0.552, 0.031, 0.041)
  ) {
    color = COLOR.ink
  }
  if (inEllipse(x, y, 0.437, 0.539, 0.011, 0.011) || inEllipse(x, y, 0.581, 0.539, 0.011, 0.011)) {
    color = COLOR.white
  }
  // 鼻子
  if (inTriangle(x, y, 0.5, 0.648, 0.469, 0.612, 0.531, 0.612)) color = COLOR.nose
  // 嘴
  if (
    inArcRing(x, y, 0.478, 0.664, 0.03, 0.0085, 'left') ||
    inArcRing(x, y, 0.522, 0.664, 0.03, 0.0085, 'right')
  ) {
    color = COLOR.ink
  }

  return [color[0], color[1], color[2], 255]
}

// ---------------------------------------------------------------- 光栅化

function render(size, samples = 4) {
  const buf = Buffer.alloc(size * size * 4)
  const step = 1 / (size * samples)
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < samples; sy += 1) {
        const y = (py * samples + sy + 0.5) * step
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px * samples + sx + 0.5) * step
          const c = sample(x, y)
          const alpha = c[3] / 255
          r += c[0] * alpha
          g += c[1] * alpha
          b += c[2] * alpha
          a += alpha
        }
      }
      const total = samples * samples
      const idx = (py * size + px) * 4
      if (a === 0) continue
      buf[idx] = Math.round(r / a)
      buf[idx + 1] = Math.round(g / a)
      buf[idx + 2] = Math.round(b / a)
      buf[idx + 3] = Math.round((a / total) * 255)
    }
  }
  return buf
}

// ---------------------------------------------------------------- ICO 封装

function packIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(entries.length * 16)
  let offset = 6 + entries.length * 16
  entries.forEach((entry, index) => {
    const base = index * 16
    directory[base] = entry.size >= 256 ? 0 : entry.size
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size
    directory[base + 2] = 0
    directory[base + 3] = 0
    directory.writeUInt16LE(1, base + 4)
    directory.writeUInt16LE(32, base + 6)
    directory.writeUInt32LE(entry.png.length, base + 8)
    directory.writeUInt32LE(offset, base + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)])
}

// ---------------------------------------------------------------- 主流程

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const APP_SIZE = 512
const TRAY_SIZE = 32

const cache = new Map()
function pngFor(size) {
  if (!cache.has(size)) cache.set(size, encodePng(size, size, render(size, size <= 32 ? 4 : 3)))
  return cache.get(size)
}

mkdirSync(join(ROOT, 'build'), { recursive: true })
mkdirSync(join(ROOT, 'resources', 'icons'), { recursive: true })

writeFileSync(join(ROOT, 'build', 'icon.png'), pngFor(APP_SIZE))
writeFileSync(join(ROOT, 'build', 'icon.ico'), packIco(ICO_SIZES.map((size) => ({ size, png: pngFor(size) }))))
writeFileSync(join(ROOT, 'resources', 'icons', 'tray.png'), pngFor(TRAY_SIZE))
writeFileSync(join(ROOT, 'resources', 'icons', 'app.png'), pngFor(256))

console.log('[make-icons] 已生成：')
console.log('  build/icon.png           512×512')
console.log(`  build/icon.ico           ${ICO_SIZES.join('/')}`)
console.log('  resources/icons/tray.png 32×32')
console.log('  resources/icons/app.png  256×256')
