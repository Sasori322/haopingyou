/**
 * 把一张水平单行 sprite sheet 拆成单帧并放大导出，用来肉眼检查关键帧（朝向、四肢、遮挡）。
 *
 * 用法：
 *   node tools/preview-frames.mjs <sheet.png> <outDir> [frames] [zoom]
 *
 * 例：node tools/preview-frames.mjs resources/pets/cat/walk.png .tmp/preview 4 2
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cropRgba, decodePng, encodePng, scaleRgba } from './png.mjs'

const [, , srcArg, outDirArg, framesArg, zoomArg] = process.argv
if (!srcArg || !outDirArg) {
  console.error('用法：node tools/preview-frames.mjs <sheet.png> <outDir> [frames] [zoom]')
  process.exit(1)
}

const src = resolve(srcArg)
const outDir = resolve(outDirArg)
const frames = Math.max(1, Number(framesArg ?? 4))
const zoom = Math.max(1, Number(zoomArg ?? 2))

const img = decodePng(readFileSync(src))
const fw = Math.floor(img.width / frames)
if (fw < 1) {
  console.error(`条带宽度 ${img.width} 放不下 ${frames} 帧`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
for (let i = 0; i < frames; i += 1) {
  const cropped = cropRgba(img.data, img.width, img.height, i * fw, 0, fw, img.height)
  const up = scaleRgba(cropped, fw, img.height, fw * zoom, img.height * zoom)
  writeFileSync(join(outDir, `frame-${i}.png`), encodePng(fw * zoom, img.height * zoom, up))
}

console.log(`[preview] ${src}`)
console.log(`  条带 ${img.width}×${img.height} → 每帧 ${fw}×${img.height}，放大 ${zoom}×`)
console.log(`  已导出 ${frames} 帧到 ${outDir}`)
