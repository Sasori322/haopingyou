<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PetManifest, PetState, SpriteAnimation } from '@shared/types/pet'
import { animationUrl, frameWidth, loadPetImage, type PetSource } from '../core/petAsset'

/**
 * 序列帧播放器。
 *
 * 三条设计约束：
 * 1) 帧图是「逻辑画布 × 2」的位图，元素 CSS 尺寸用逻辑尺寸；backing store 再乘 dpr × petScale，
 *    这样在任意缩放下都 1:1 落到设备像素上，不会糊。
 * 2) 播放靠 rAF 按时间累积算帧号，**不靠 setInterval**——主进程持有绝对时间戳，
 *    渲染层这里只做表现，掉帧时也不会累积漂移。
 * 3) 非循环动画播完只发一次 finished，由父级决定回落到哪个状态（渲染层不自行决定业务状态）。
 */
const props = defineProps<{
  manifest: PetManifest
  source: PetSource
  state: PetState
  facing: -1 | 1
  scale: number
}>()

const emit = defineEmits<{
  (e: 'finished', state: PetState): void
  (e: 'failed', state: PetState): void
}>()

const canvasEl = ref<HTMLCanvasElement | null>(null)
const image = ref<HTMLImageElement | null>(null)

const anim = computed<SpriteAnimation | null>(() => {
  const list = props.manifest.animations
  return list[props.state] ?? list[props.manifest.defaultAnimation] ?? list[Object.keys(list)[0]] ?? null
})

const frames = computed(() => Math.max(1, Math.round(anim.value?.frames ?? 1)))
const frameMs = computed(() => 1000 / Math.max(1, anim.value?.fps ?? 8))

const canvasStyle = computed(() => ({
  width: `${props.manifest.canvas.w}px`,
  height: `${props.manifest.canvas.h}px`,
  transform: props.facing === -1 ? 'scaleX(-1)' : 'none'
}))

let raf = 0
let startedAt = 0
let lastIndex = -1
/** 最近一次真正画上去的帧号，缩放/画布变化时按它重绘 */
let paintedIndex = 0
let notified = false

function paint(index: number): void {
  const canvas = canvasEl.value
  const img = image.value
  if (!canvas || !img) return

  const dpr = window.devicePixelRatio || 1
  const ratio = dpr * Math.max(0.1, props.scale)
  const backW = Math.max(1, Math.round(props.manifest.canvas.w * ratio))
  const backH = Math.max(1, Math.round(props.manifest.canvas.h * ratio))
  if (canvas.width !== backW || canvas.height !== backH) {
    canvas.width = backW
    canvas.height = backH
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, backW, backH)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  const fw = frameWidth(img, frames.value)
  const safeIndex = Math.min(Math.max(0, index), frames.value - 1)
  paintedIndex = safeIndex
  ctx.drawImage(
    img,
    safeIndex * fw,
    0,
    fw,
    img.naturalHeight,
    0,
    0,
    backW,
    backH
  )
}

function tick(now: number): void {
  raf = window.requestAnimationFrame(tick)
  const info = anim.value
  if (!info) return

  if (startedAt === 0) startedAt = now
  const elapsed = now - startedAt
  const total = frames.value

  let index: number
  if (info.loop !== false) {
    index = Math.floor(elapsed / frameMs.value) % total
  } else {
    index = Math.floor(elapsed / frameMs.value)
    if (index >= total) {
      index = total - 1
      if (!notified) {
        notified = true
        emit('finished', props.state)
      }
    }
  }

  if (index !== lastIndex) {
    lastIndex = index
    paint(index)
  }
}

function reset(): void {
  startedAt = 0
  lastIndex = -1
  notified = false
}

async function loadSheet(): Promise<void> {
  const info = anim.value
  if (!info?.src) return
  try {
    const img = await loadPetImage(animationUrl(props.manifest, props.source, info.src))
    // 加载期间状态可能已经变了，切换后再校验一次，避免画错素材
    if (anim.value?.src !== info.src) return
    image.value = img
    reset()
    lastIndex = -1
    paint(0)
  } catch (error) {
    console.error(error)
    image.value = null
    emit('failed', props.state)
  }
}

watch(
  () => [anim.value?.src, props.state] as const,
  () => {
    reset()
    void loadSheet()
  }
)

watch(
  () => [props.scale, props.manifest.canvas.w, props.manifest.canvas.h],
  () => paint(paintedIndex)
)

onMounted(() => {
  void loadSheet()
  raf = window.requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  if (raf) window.cancelAnimationFrame(raf)
  raf = 0
})
</script>

<template>
  <canvas ref="canvasEl" class="pet-sheet" :style="canvasStyle" />
</template>
