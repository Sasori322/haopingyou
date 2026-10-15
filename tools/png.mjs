/**
 * 零依赖 PNG 编解码 + RGBA 图像操作。
 * 供 tools/ 下的素材流水线脚本共用；不支持调色板 / 隔行扫描（素材不需要）。
 */
import { deflateSync, inflateSync } from 'node:zlib'

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

const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** @returns {{ width:number, height:number, data:Buffer }} data 为 RGBA，逐行紧密排列 */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件')
  let offset = 8
  let header = null
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') header = body
    else if (type === 'IDAT') idat.push(body)
    offset += 12 + length
  }
  if (!header) throw new Error('PNG 缺少 IHDR')

  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  const bitDepth = header[8]
  const colorType = header[9]
  const interlace = header[12]
  if (interlace !== 0) throw new Error('不支持隔行扫描 PNG')
  if (![8, 16].includes(bitDepth)) throw new Error(`不支持的位深：${bitDepth}`)

  const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
  const channels = channelsByType[colorType]
  if (!channels || colorType === 3) throw new Error(`不支持的颜色类型：${colorType}`)

  const bytesPerSample = bitDepth / 8
  const bpp = channels * bytesPerSample
  const stride = width * bpp
  const raw = inflateSync(Buffer.concat(idat))
  const flat = Buffer.alloc(height * stride)

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? flat[y * stride + i - bpp] : 0
      const b = y > 0 ? flat[(y - 1) * stride + i] : 0
      const c = i >= bpp && y > 0 ? flat[(y - 1) * stride + i - bpp] : 0
      let value = src[i]
      if (filter === 1) value = (value + a) & 255
      else if (filter === 2) value = (value + b) & 255
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 255
      else if (filter === 4) value = (value + paeth(a, b, c)) & 255
      flat[y * stride + i] = value
    }
  }

  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const si = y * stride + x * bpp
      const di = (y * width + x) * 4
      if (bitDepth === 16) {
        const step = 2
        if (colorType === 0) {
          const g = flat[si]
          data[di] = g
          data[di + 1] = g
          data[di + 2] = g
          data[di + 3] = 255
        } else if (colorType === 2) {
          data[di] = flat[si]
          data[di + 1] = flat[si + step]
          data[di + 2] = flat[si + step * 2]
          data[di + 3] = 255
        } else if (colorType === 4) {
          const g = flat[si]
          data[di] = g
          data[di + 1] = g
          data[di + 2] = g
          data[di + 3] = flat[si + step]
        } else {
          data[di] = flat[si]
          data[di + 1] = flat[si + step]
          data[di + 2] = flat[si + step * 2]
          data[di + 3] = flat[si + step * 3]
        }
      } else if (colorType === 0) {
        const g = flat[si]
        data[di] = g
        data[di + 1] = g
        data[di + 2] = g
        data[di + 3] = 255
      } else if (colorType === 2) {
        data[di] = flat[si]
        data[di + 1] = flat[si + 1]
        data[di + 2] = flat[si + 2]
        data[di + 3] = 255
      } else if (colorType === 4) {
        const g = flat[si]
        data[di] = g
        data[di + 1] = g
        data[di + 2] = g
        data[di + 3] = flat[si + 1]
      } else {
        data[di] = flat[si]
        data[di + 1] = flat[si + 1]
        data[di + 2] = flat[si + 2]
        data[di + 3] = flat[si + 3]
      }
    }
  }

  return { width, height, data }
}

export function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

export function createRgba(width, height) {
  return Buffer.alloc(width * height * 4)
}

/** 不透明内容的包围盒；全透明返回 null */
export function alphaBounds(rgba, width, height, threshold = 8) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

export function cropRgba(rgba, width, height, x, y, w, h) {
  const out = Buffer.alloc(w * h * 4)
  for (let row = 0; row < h; row += 1) {
    const sy = y + row
    if (sy < 0 || sy >= height) continue
    for (let col = 0; col < w; col += 1) {
      const sx = x + col
      if (sx < 0 || sx >= width) continue
      const si = (sy * width + sx) * 4
      const di = (row * w + col) * 4
      out[di] = rgba[si]
      out[di + 1] = rgba[si + 1]
      out[di + 2] = rgba[si + 2]
      out[di + 3] = rgba[si + 3]
    }
  }
  return out
}

/** 双线性缩放，alpha 预乘，避免半透明边缘出现黑边 */
export function scaleRgba(src, sw, sh, tw, th) {
  const out = Buffer.alloc(tw * th * 4)
  const xRatio = sw / tw
  const yRatio = sh / th
  for (let y = 0; y < th; y += 1) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * yRatio - 0.5))
    const y0 = Math.floor(sy)
    const y1 = Math.min(sh - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < tw; x += 1) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xRatio - 0.5))
      const x0 = Math.floor(sx)
      const x1 = Math.min(sw - 1, x0 + 1)
      const fx = sx - x0
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      const taps = [
        [x0, y0, (1 - fx) * (1 - fy)],
        [x1, y0, fx * (1 - fy)],
        [x0, y1, (1 - fx) * fy],
        [x1, y1, fx * fy]
      ]
      for (const [px, py, weight] of taps) {
        if (weight <= 0) continue
        const i = (py * sw + px) * 4
        const alpha = src[i + 3] / 255
        r += src[i] * alpha * weight
        g += src[i + 1] * alpha * weight
        b += src[i + 2] * alpha * weight
        a += alpha * weight
      }
      const o = (y * tw + x) * 4
      if (a > 0.0001) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round(Math.min(1, a) * 255)
    }
  }
  return out
}

/** 把 src 叠到 dest 的 (dx, dy)，source-over 合成 */
export function drawRgba(dest, dw, dh, src, sw, sh, dx, dy) {
  for (let y = 0; y < sh; y += 1) {
    const ty = dy + y
    if (ty < 0 || ty >= dh) continue
    for (let x = 0; x < sw; x += 1) {
      const tx = dx + x
      if (tx < 0 || tx >= dw) continue
      const si = (y * sw + x) * 4
      const sa = src[si + 3] / 255
      if (sa <= 0) continue
      const di = (ty * dw + tx) * 4
      const da = dest[di + 3] / 255
      const outA = sa + da * (1 - sa)
      if (outA <= 0) continue
      for (let k = 0; k < 3; k += 1) {
        dest[di + k] = Math.round((src[si + k] * sa + dest[di + k] * da * (1 - sa)) / outA)
      }
      dest[di + 3] = Math.round(outA * 255)
    }
  }
}

/** 抠除纯色幕布（chroma-key）：把接近 keyColor 的像素置为全透明，并做边缘去杂色 */
export function chromaKey(rgba, width, height, keyColor, tolerance = 90, softness = 40) {
  const [kr, kg, kb] = keyColor
  for (let i = 0; i < width * height * 4; i += 4) {
    const dr = rgba[i] - kr
    const dg = rgba[i + 1] - kg
    const db = rgba[i + 2] - kb
    const distance = Math.sqrt(dr * dr + dg * dg + db * db)
    if (distance <= tolerance) {
      rgba[i + 3] = 0
    } else if (distance < tolerance + softness) {
      const t = (distance - tolerance) / softness
      rgba[i + 3] = Math.round(rgba[i + 3] * t)
      // 去杂色：把幕布色往回拉，避免边缘残留洋红/绿边
      const pull = 1 - t
      rgba[i] = Math.round(rgba[i] * (1 - pull * 0.6) + 128 * (pull * 0.6))
      rgba[i + 1] = Math.round(rgba[i + 1] * (1 - pull * 0.6) + 128 * (pull * 0.6))
      rgba[i + 2] = Math.round(rgba[i + 2] * (1 - pull * 0.6) + 128 * (pull * 0.6))
    }
  }
}

export function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * 用四条边像素的中位数估计幕布背景色。
 *
 * 为什么不用单点采样：AI 生成图的边缘带压缩噪点，相邻几像素的 G 通道能差 50+，
 * 单点会严重偏色（实测偏出 60+），导致后续容差判定整体失准。中位数对噪声稳健。
 */
export function estimateBackdrop(rgba, width, height) {
  const rs = []
  const gs = []
  const bs = []
  const take = (i) => {
    rs.push(rgba[i * 4])
    gs.push(rgba[i * 4 + 1])
    bs.push(rgba[i * 4 + 2])
  }
  for (let x = 0; x < width; x += 1) {
    take(x)
    take((height - 1) * width + x)
  }
  for (let y = 0; y < height; y += 1) {
    take(y * width)
    take(y * width + width - 1)
  }
  return [median(rs), median(gs), median(bs)]
}

/**
 * 抠除「渐变幕布」并顺带处理生成图的水印残留。
 *
 * 为什么不复用 chromaKey：
 *   1) AI 生成图的背景是**渐变 + 压缩噪点**，不是纯色。实测背景到内置 magenta 最远距离 129，
 *      而 chromaKey 默认 tolerance=90 —— 抠不干净。
 *   2) 也不能改成「相邻像素差分 + 平滑降噪」：平滑会把 2-3px 的细描边冲淡，
 *      洪水直接穿透进角色内部（实测背景占比飙到 96% 的错误结果）。
 *
 * 本函数用「四边中位数估背景 + 边界泛洪的连通性约束」：
 * 只抠与画面边界连通的、且到背景参考色距离在容差内的像素 —— 渐变能被整片吃掉，
 * 而角色内部的浅色区域（白胸、粉内耳）因为不与边界连通，不会被误伤。
 *
 * @returns {{ mask: Uint8Array, reference: number[], removed: number, total: number }}
 */
export function cutoutBackdrop(rgba, width, height, options = {}) {
  const reference = options.reference ?? estimateBackdrop(rgba, width, height)
  const tolerance = options.tolerance ?? 80
  const t2 = tolerance * tolerance
  const total = width * height
  const mask = new Uint8Array(total)
  const stack = []

  const within = (i) => {
    const dr = rgba[i * 4] - reference[0]
    const dg = rgba[i * 4 + 1] - reference[1]
    const db = rgba[i * 4 + 2] - reference[2]
    return dr * dr + dg * dg + db * db <= t2
  }
  const seed = (i) => {
    if (!mask[i] && within(i)) {
      mask[i] = 1
      stack.push(i)
    }
  }

  for (let x = 0; x < width; x += 1) {
    seed(x)
    seed((height - 1) * width + x)
  }
  for (let y = 0; y < height; y += 1) {
    seed(y * width)
    seed(y * width + width - 1)
  }

  while (stack.length) {
    const i = stack.pop()
    const x = i % width
    const y = (i - x) / width
    if (x > 0) seed(i - 1)
    if (x < width - 1) seed(i + 1)
    if (y > 0) seed(i - width)
    if (y < height - 1) seed(i + width)
  }

  let removed = 0
  for (let i = 0; i < total; i += 1) {
    if (mask[i]) {
      rgba[i * 4 + 3] = 0
      removed += 1
    }
  }
  return { mask, reference, removed, total }
}

/**
 * 剔除「角落 + 面积远小于主体」的孤立连通块，用来干掉生成图右下角的「AI生成」水印。
 *
 * 水印的笔画会被拆成十几个几十像素的碎块，且全部落在右下角；
 * 而角色是画面里最大的连通块。两条判据同时满足才丢，避免误伤角色的孤立部件（如断开的胡须）。
 *
 * @returns {{ components: number, main: object|null, dropped: Array<{count:number,x:number,y:number}> }}
 */
export function dropCornerSpecks(rgba, width, height, mask, options = {}) {
  const total = width * height
  const minRatio = options.minRatio ?? 0.01
  const cornerX = (options.cornerX ?? 0.8) * width
  const cornerY = (options.cornerY ?? 0.88) * height
  const seen = new Uint8Array(total)
  const comps = []

  for (let s = 0; s < total; s += 1) {
    if (mask[s] || seen[s]) continue
    let count = 0
    let x1 = width
    let y1 = height
    let x2 = 0
    let y2 = 0
    const idx = []
    const stack = [s]
    seen[s] = 1
    while (stack.length) {
      const i = stack.pop()
      const x = i % width
      const y = (i - x) / width
      count += 1
      idx.push(i)
      if (x < x1) x1 = x
      if (y < y1) y1 = y
      if (x > x2) x2 = x
      if (y > y2) y2 = y
      const neighbours = []
      if (x > 0) neighbours.push(i - 1)
      if (x < width - 1) neighbours.push(i + 1)
      if (y > 0) neighbours.push(i - width)
      if (y < height - 1) neighbours.push(i + width)
      for (const j of neighbours) {
        if (!mask[j] && !seen[j]) {
          seen[j] = 1
          stack.push(j)
        }
      }
    }
    comps.push({ count, x1, y1, x2, y2, idx })
  }

  comps.sort((a, b) => b.count - a.count)
  const main = comps[0] ?? null
  const dropped = []
  if (main) {
    for (const c of comps.slice(1)) {
      const cx = (c.x1 + c.x2) / 2
      const cy = (c.y1 + c.y2) / 2
      if (c.count < main.count * minRatio && cx > cornerX && cy > cornerY) {
        for (const i of c.idx) rgba[i * 4 + 3] = 0
        dropped.push({ count: c.count, x: Math.round(cx), y: Math.round(cy) })
      }
    }
  }
  return {
    components: comps.length,
    main: main ? { count: main.count, x1: main.x1, y1: main.y1, x2: main.x2, y2: main.y2 } : null,
    dropped
  }
}
