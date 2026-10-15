/**
 * 把 AI 生成的原始帧图处理成干净的透明底 PNG（抠底 + 去水印）。
 *
 * 生成图有两个特点，决定了不能直接用 chromaKey：
 *   1. 背景是**洋红渐变 + 压缩噪点**，固定色 + 全局阈值抠不干净；
 *   2. 右下角固定带「AI生成」水印，颜色与背景差异大，会被当成前景保留。
 * 算法细节见 png.mjs 里 cutoutBackdrop / dropCornerSpecks 的注释。
 *
 * 用法：
 *   node tools/cutout.mjs --in raw/cat --out cut/cat
 *   node tools/cutout.mjs --in raw/idle-01.png --out cut/idle-01.png --tolerance 90
 *   node tools/cutout.mjs --in raw/cat --out cut/cat --keep-specks   # 只抠底，保留水印
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { chromaKey, cutoutBackdrop, decodePng, dropCornerSpecks, encodePng, estimateBackdrop } from './png.mjs'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]
  return fallback
}

const inPath = arg('in')
const outPath = arg('out')
const tolerance = Number(arg('tolerance', '80'))
const keepSpecks = process.argv.includes('--keep-specks')
const noEnclosed = process.argv.includes('--no-enclosed')

if (!inPath || !outPath || !Number.isFinite(tolerance)) {
  console.error(
    '用法：node tools/cutout.mjs --in <png|dir> --out <png|dir> [--tolerance 80] [--keep-specks]'
  )
  process.exit(2)
}
if (!existsSync(inPath)) {
  console.error(`找不到输入：${inPath}`)
  process.exit(2)
}

function processOne(srcFile, dstFile) {
  const { width, height, data } = decodePng(readFileSync(srcFile))
  const reference = estimateBackdrop(data, width, height)
  const cut = cutoutBackdrop(data, width, height, { reference, tolerance })
  // 边界泛洪只吃「与画面四边连通」的背景，被角色围住的背景块会漏掉
  // （典型：四条腿之间的缝隙里透出的幕布，表现为身上残留一小块洋红）。
  // 幕布色是饱和洋红，角色的调色板里没有这个颜色，所以补一道全局阈值去除是安全的。
  const enclosed = noEnclosed ? 0 : countEnclosedRemoval(data, width, height, reference, tolerance)
  const specks = keepSpecks ? null : dropCornerSpecks(data, width, height, cut.mask)
  mkdirSync(dirname(dstFile), { recursive: true })
  writeFileSync(dstFile, encodePng(width, height, data))
  return { width, height, reference, cut, specks, enclosed }
}

/** 全局阈值去除与幕布色接近的像素，返回本步新清掉的像素数（用于日志） */
function countEnclosedRemoval(data, width, height, reference, tolerance) {
  let before = 0
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) before += 1
  chromaKey(data, width, height, reference, tolerance, 20)
  let after = 0
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) after += 1
  return before - after
}

const inputStat = statSync(inPath)
const isDir = inputStat.isDirectory()
const files = isDir
  ? readdirSync(inPath)
      .filter((name) => extname(name).toLowerCase() === '.png')
      .sort()
      .map((name) => join(inPath, name))
  : [inPath]

if (files.length === 0) {
  console.error(`目录里没有 PNG 文件：${inPath}`)
  process.exit(2)
}

const startedAt = Date.now()
for (const file of files) {
  const dst = isDir ? join(outPath, basename(file)) : outPath
  const result = processOne(file, dst)
  const bgPercent = ((result.cut.removed / result.cut.total) * 100).toFixed(1)
  const mainPixels = result.specks?.main ? result.specks.main.count : '-'
  const speckNote = result.specks ? `去水印 ${result.specks.dropped.length} 块` : '保留碎片'
  console.log(
    `[cutout] ${basename(file)}  ref=${result.reference.join(',')}  ` +
      `背景 ${bgPercent}%  主体 ${mainPixels}px  封闭残留 ${result.enclosed}px  ${speckNote}`
  )
}
console.log(`[cutout] 完成 ${files.length} 张 → ${resolve(outPath)}  (${Date.now() - startedAt}ms)`)
