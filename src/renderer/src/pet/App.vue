<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type {
  ForceStatePayload,
  GazePayload,
  PetManifest,
  PetState,
  ReloadPayload,
  SpeakPayload
} from '@shared/types/pet'
import type { AppSettings } from '@shared/types/settings'
import { GAZE_EASE, GAZE_FACING_STATES, GAZE_MAX_SHIFT, GAZE_MAX_TILT } from '@shared/constants'
import Bubble from './components/Bubble.vue'
import PetSprite from './components/PetSprite.vue'
import PetSpriteSheet from './components/PetSpriteSheet.vue'
import type { HitRect } from './core/hitTest'
import { usePointerBridge } from './core/usePointerBridge'

/** 素材缺失时的兜底画布与命中框（DIP，画布坐标系），对齐小猫站立姿态 */
const FALLBACK_CANVAS = { w: 200, h: 260 }
const FALLBACK_BOUNDS: HitRect = { x: 31.5, y: 78, w: 137.5, h: 182 }

const state = ref<PetState>('idle')
/** 主进程驱动的「基底状态」，点击这类短效果播完后回落到它 */
const baseState = ref<PetState>('idle')
const kind = ref<'cat' | 'dog'>('cat')
const facing = ref<-1 | 1>(1)
const petScale = ref(1)

const petId = ref('')
const petSource = ref<'builtin' | 'user'>('builtin')
const manifest = ref<PetManifest | null>(null)
const hasAssets = ref(false)
/** 素材加载失败时退回占位形象——桌面上宁可丑一点，不能直接空掉 */
const spriteFailed = ref(false)

const bubbleText = ref('')
const bubbleLeaving = ref(false)

/**
 * 鼠标跟随。
 *
 * 方位由主进程下发（渲染层拿不到全局光标位置），这里只做两件事：
 * 平滑插值 + 映射成位移/倾角。**绝对值很小**（最多 3.2px / 1.2°）——
 * 目的是"它在看你"，不是"它在动"，幅度一大就变成廉价的抖动。
 */
const gazeTarget = ref<GazePayload>({ x: 0, y: 0, near: false, facing: 0 })
const gazeShift = ref({ x: 0, y: 0 })
const gazeEnabled = ref(true)
let gazeRaf = 0

/** 窗口尺寸会随宠物画布变化（悬空姿态比站立高得多），布局必须跟着重算 */
const winSize = ref({ w: window.innerWidth, h: window.innerHeight })

const canvas = computed(() => manifest.value?.canvas ?? FALLBACK_CANVAS)
const useSheet = computed(() => hasAssets.value && !!manifest.value && !spriteFailed.value)

/**
 * 实际渲染用的朝向。
 *
 * 走动时必须以走动方向为准，否则光标在身后会把正在走路的猫翻转成"倒着走"；
 * 所以只有站立族状态（idle/click/eat/rest/hot/focus）才允许被光标拉过去。
 */
const renderFacing = computed<-1 | 1>(() => {
  const target = gazeTarget.value
  if (gazeEnabled.value && target.facing !== 0 && GAZE_FACING_STATES.includes(state.value)) {
    return target.facing
  }
  return facing.value
})

/**
 * 跟随幅度：横向全量、纵向压到 55%（人眼对上下位移更敏感），
 * 倾斜与横向位移按同一个 x 走，看起来才像"往光标那边偏了一下"。
 */
const gazeStyle = computed(() => {
  if (!gazeEnabled.value) return { transform: 'none' }
  const { x, y } = gazeShift.value
  return {
    transform:
      `translate(${(x * GAZE_MAX_SHIFT).toFixed(2)}px, ${(y * GAZE_MAX_SHIFT * 0.55).toFixed(2)}px) ` +
      `rotate(${(x * GAZE_MAX_TILT).toFixed(2)}deg)`
  }
})

/**
 * 命中框：把当前动画的内容包络从「画布坐标」换算到「窗口坐标」。
 *
 * 画布在窗口内水平居中、底边对齐；再叠加三件事——
 *  petScale 的缩放原点是「窗口底边中点」（与 .pet-stage 的 transform-origin 一致）；
 *  facing = -1 时素材被水平镜像，命中框必须一起镜像，否则朝左走动时点不中；
 *  鼠标跟随的位移（倾角不建模：1.2° 在 182px 高的素材顶端约偏 3.8px，被 hitTest 的 8px pad 吸收）。
 */
const hitRect = computed<HitRect>(() => {
  const bounds =
    (useSheet.value ? manifest.value?.animations[state.value]?.bounds : null) ?? FALLBACK_BOUNDS
  const c = canvas.value
  const { w: winW, h: winH } = winSize.value
  const s = petScale.value

  const left = (winW - c.w) / 2
  const top = winH - c.h
  const bx = renderFacing.value === -1 ? c.w - bounds.x - bounds.w : bounds.x

  const sx = left + bx
  const sy = top + bounds.y
  const cx = winW / 2

  const g = gazeEnabled.value ? gazeShift.value : { x: 0, y: 0 }
  const gx = g.x * GAZE_MAX_SHIFT * s
  const gy = g.y * GAZE_MAX_SHIFT * 0.55 * s

  return {
    x: cx + (sx - cx) * s + gx,
    y: winH + (sy - winH) * s + gy,
    w: bounds.w * s,
    h: bounds.h * s
  }
})

const hitBoxStyle = computed(() => ({
  position: 'absolute' as const,
  left: '50%',
  bottom: '0',
  marginLeft: `${-canvas.value.w / 2}px`,
  width: `${canvas.value.w}px`,
  height: `${canvas.value.h}px`
}))

let bubbleTimer: number | null = null
let clickRevertTimer: number | null = null
const cleanups: Array<() => void> = []

function clearTimers(): void {
  if (bubbleTimer !== null) {
    window.clearTimeout(bubbleTimer)
    bubbleTimer = null
  }
  if (clickRevertTimer !== null) {
    window.clearTimeout(clickRevertTimer)
    clickRevertTimer = null
  }
}

function showBubble(payload: SpeakPayload): void {
  if (!payload?.text) return
  if (bubbleTimer !== null) {
    window.clearTimeout(bubbleTimer)
    bubbleTimer = null
  }
  bubbleText.value = payload.text
  bubbleLeaving.value = false
  const hold = Math.min(Math.max(payload.ms ?? 3200, 800), 8000)
  bubbleTimer = window.setTimeout(() => {
    bubbleLeaving.value = true
    bubbleTimer = window.setTimeout(() => {
      bubbleText.value = ''
      bubbleLeaving.value = false
      bubbleTimer = null
    }, 220)
  }, hold)
}

function applyReload(payload: ReloadPayload | null): void {
  if (!payload) return
  const switched = payload.petId !== petId.value
  petId.value = payload.petId
  petSource.value = payload.source ?? 'builtin'
  manifest.value = payload.manifest
  kind.value = payload.manifest?.kind === 'dog' ? 'dog' : 'cat'
  hasAssets.value = payload.hasAssets
  // 换了宠物、或素材已齐全，都重新给序列帧一次机会
  if (switched || payload.hasAssets) spriteFailed.value = false
}

function applyForceState(payload: ForceStatePayload | null): void {
  if (!payload?.state) return
  if (clickRevertTimer !== null) {
    window.clearTimeout(clickRevertTimer)
    clickRevertTimer = null
  }
  state.value = payload.state
  baseState.value = payload.state
  if (payload.state === 'walk' && payload.direction) {
    facing.value = payload.direction < 0 ? -1 : 1
  }
}

/** 平滑插值。收敛后必须停掉 rAF——常驻 rAF 会让宠物窗口一直满帧唤醒，笔记本上很费电 */
function pumpGaze(): void {
  const target = gazeTarget.value
  const current = gazeShift.value
  const nx = current.x + (target.x - current.x) * GAZE_EASE
  const ny = current.y + (target.y - current.y) * GAZE_EASE
  if (Math.abs(target.x - nx) < 0.008 && Math.abs(target.y - ny) < 0.008) {
    gazeShift.value = { x: target.x, y: target.y }
    gazeRaf = 0
    return
  }
  gazeShift.value = { x: nx, y: ny }
  gazeRaf = window.requestAnimationFrame(pumpGaze)
}

function applyGaze(payload: GazePayload | null): void {
  if (!payload) return
  gazeTarget.value = payload
  if (!gazeEnabled.value) {
    gazeShift.value = { x: 0, y: 0 }
    return
  }
  if (!gazeRaf) gazeRaf = window.requestAnimationFrame(pumpGaze)
}

function applySettings(settings: AppSettings | null): void {
  petScale.value = settings?.petScale ?? 1
  const enabled = settings?.gaze.enabled ?? true
  if (!enabled) {
    gazeTarget.value = { x: 0, y: 0, near: false, facing: 0 }
    gazeShift.value = { x: 0, y: 0 }
  }
  gazeEnabled.value = enabled
}

function revertToBase(): void {
  if (clickRevertTimer !== null) {
    window.clearTimeout(clickRevertTimer)
    clickRevertTimer = null
  }
  state.value = baseState.value
}

usePointerBridge({
  getHitRect: () => hitRect.value,
  onClick: () => {
    // 渲染层只负责表现与上报，说不说话由主进程决定
    state.value = 'click'
    window.petAPI.reportState('click')
    // 定时器是兜底：素材缺失走占位形象时没有 finished 事件可等
    if (clickRevertTimer !== null) window.clearTimeout(clickRevertTimer)
    clickRevertTimer = window.setTimeout(revertToBase, 520)
  },
  onDragStart: () => {
    state.value = 'drag'
  },
  onDragEnd: () => {
    state.value = 'idle'
    baseState.value = 'idle'
  }
})

function syncWindowSize(): void {
  winSize.value = { w: window.innerWidth, h: window.innerHeight }
}

onMounted(async () => {
  const [active, settings] = await Promise.all([
    window.petAPI.getActivePet(),
    window.petAPI.settings.get()
  ])
  // 注意：applyReload 内部用「petId 是否变化」判断要不要重置失败标记，
  // 所以不能在这里先手改 hasAssets，否则会掩盖切换检测
  applyReload(active)
  applySettings(settings)

  syncWindowSize()
  window.addEventListener('resize', syncWindowSize)

  cleanups.push(window.petAPI.onReload(applyReload))
  cleanups.push(window.petAPI.onForceState(applyForceState))
  cleanups.push(window.petAPI.onSpeak(showBubble))
  cleanups.push(window.petAPI.onGaze(applyGaze))
  cleanups.push(window.petAPI.settings.onChanged(applySettings))
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncWindowSize)
  if (gazeRaf) window.cancelAnimationFrame(gazeRaf)
  gazeRaf = 0
  for (const dispose of cleanups) dispose()
  cleanups.length = 0
  clearTimers()
})
</script>

<template>
  <div class="pet-stage" :style="{ '--pet-scale': String(petScale) }">
    <div class="pet-hit" :style="hitBoxStyle">
      <div class="pet-gaze" :style="gazeStyle">
        <PetSpriteSheet
          v-if="useSheet && manifest"
          :manifest="manifest"
          :source="petSource"
          :state="state"
          :facing="renderFacing"
          :scale="petScale"
          @finished="(s) => s === 'click' && revertToBase()"
          @failed="() => (spriteFailed = true)"
        />
        <div v-else class="pet-fallback">
          <PetSprite :kind="kind" :state="state" :facing="renderFacing" />
        </div>
      </div>
    </div>
    <Bubble v-if="bubbleText" :text="bubbleText" :leaving="bubbleLeaving" />
  </div>
</template>
