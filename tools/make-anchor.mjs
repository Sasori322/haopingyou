/**
 * 把抠好的透明角色合成到纯色底上，产出**图生图参考图（锚点）**。
 *
 * 为什么需要这一步：让模型一次生成「一横排多帧」的动画条带时，必须给它一张参考图来锁角色一致性。
 * 但生成图右下角带水印——直接拿原图当参考，模型会把水印一起学过去（表现为每帧都长出水印）。
 * 所以先用 cutout 抠干净，再合成回纯洋红底：锚点既干净，又和后续要重抠的底色一致。
 *
 * 用法：
 *   node tools/make-anchor.mjs --in cut/cat-stand-front.png --out artwork/cat/_anchor-stand-front.png
 *   node tools/make-anchor.mjs --in a.png --out b.png --bg 255,0,255
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { decodePng, drawRgba, encodePng } from './png.mjs'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]
  return fallback
}

const inputPath = arg('in')
const outputPath = arg('out')
const bg = (arg('bg', '255,0,255'))
  .split(',')
  .map(Number)

if (!inputPath || !outputPath) {
  console.error('用法：node tools/make-anchor.mjs --in <透明png> --out <锚点png> [--bg 255,0,255]')
  process.exit(2)
}
if (!existsSync(inputPath)) {
  console.error(`找不到输入：${inputPath}`)
  process.exit(2)
}
if (bg.length !== 3 || !bg.every((n) => Number.isFinite(n))) {
  console.error(`--bg 需要 r,g,b 三个数字，收到：${bg.join(',')}`)
  process.exit(2)
}

const { width, height, data } = decodePng(readFileSync(inputPath))
const canvas = Buffer.alloc(width * height * 4)
for (let i = 0; i < canvas.length; i += 4) {
  canvas[i] = bg[0]
  canvas[i + 1] = bg[1]
  canvas[i + 2] = bg[2]
  canvas[i + 3] = 255
}
drawRgba(canvas, width, height, data, width, height, 0, 0)

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, encodePng(width, height, canvas))
console.log(`[anchor] ${resolve(outputPath)}  ${width}×${height}  底色 ${bg.join(',')}`)
