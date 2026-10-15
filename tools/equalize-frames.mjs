/**
 * 逐帧尺寸对齐：把一组**同一视角**的帧缩放到「角色一样大」。
 *
 * 为什么需要：逐帧单独出图（`ImageGen` 一次只画一个姿势）时，模型对每张图的取景
 * 比例是独立的——实测同一套姿势里，最夸张的伸展帧比其他帧小 12%，直接拼成动画会
 * 出现明显的「忽大忽小」。
 *
 * 度量用**头部宽度**：在内容包围盒的顶部 band 比例内取最长的不透明横向游程。
 * 注意这个指标只在**同一视角**的帧之间可比——正脸的头天生比侧脸宽得多
 * （实测同一只猫：正脸 214px / 侧脸 160px），所以**不要**拿它去跨姿态族比对，
 * 跨姿态族的绝对尺寸请用 `normalize-anchor --scale` 统一。
 *
 * 用法：
 *   node tools/equalize-frames.mjs --in .tmp/frames --out .tmp/frames-even
 *   node tools/equalize-frames.mjs --in raw --out out --band 0.3 --tol 0.03
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { alphaBounds, decodePng, encodePng, median, scaleRgba } from './png.mjs'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]
  return fallback
}

const inDir = arg('in')
const outDir = arg('out')
const band = Number(arg('band', '0.35'))
const tol = Number(arg('tol', '0.02'))

if (!inDir || !outDir) {
  console.error('用法：node tools/equalize-frames.mjs --in <dir> --out <dir> [--band 0.35] [--tol 0.02]')
  process.exit(2)
}

/** 内容包围盒顶部 band 比例内最长的不透明横向游程，作为「头宽」代理量 */
function headWidth(data, width, height, box) {
  const yEnd = box.y + Math.max(1, Math.round(box.h * band))
  let best = 0
  for (let y = box.y; y < yEnd; y += 1) {
    let run = 0
    for (let x = box.x; x < box.x + box.w; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        run += 1
        if (run > best) best = run
      } else {
        run = 0
      }
    }
  }
  return best
}

const files = readdirSync(inDir)
  .filter((name) => extname(name).toLowerCase() === '.png')
  .sort()
if (files.length === 0) {
  console.error(`目录里没有 PNG：${inDir}`)
  process.exit(2)
}

const loaded = files.map((name) => {
  const { width, height, data } = decodePng(readFileSync(join(inDir, name)))
  const box = alphaBounds(data, width, height, 8)
  if (!box) throw new Error(`${name} 内容全透明`)
  return { name, width, height, data, box, head: headWidth(data, width, height, box) }
})

const target = median(loaded.map((item) => item.head))
mkdirSync(outDir, { recursive: true })

console.log(`[equalize] ${resolve(inDir)} → ${resolve(outDir)}`)
console.log(`           目标头宽 ${target}px（中位数），容差 ±${(tol * 100).toFixed(1)}%`)

for (const item of loaded) {
  const k = target / item.head
  const dst = join(outDir, item.name)
  if (Math.abs(k - 1) <= tol) {
    copyFileSync(join(inDir, item.name), dst)
    console.log(`           ${item.name}  头宽 ${item.head}  保持不变`)
    continue
  }
  const tw = Math.max(1, Math.round(item.width * k))
  const th = Math.max(1, Math.round(item.height * k))
  writeFileSync(dst, encodePng(tw, th, scaleRgba(item.data, item.width, item.height, tw, th)))
  console.log(`           ${item.name}  头宽 ${item.head} → 缩放 ×${k.toFixed(4)}（${item.width}×${item.height} → ${tw}×${th}）`)
}
