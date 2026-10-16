<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type {
  ForceStatePayload,
  GazePayload,
  PetManifest,
  PetState,
  ReloadPayload,
  SpeakPayload
} from '@shared/types/pet'
import type { AppSettings } from '@shared/types/settings'
import {
  BUBBLE_MS_MAX,
  BUBBLE_MS_MIN,
  GAZE_EASE,
  GAZE_FACING_STATES,
  GAZE_MAX_SHIFT,
  GAZE_MAX_TILT,
  PET_REMIND_MOTION_MS,
  PET_SCALE_DEFAULT,
  SPEECH_BUBBLE_MS
} from '@shared/constants'
import Bubble from './components/Bubble.vue'
import PetSprite from './components/PetSprite.vue'
import PetSpriteSheet from './components/PetSpriteSheet.vue'
import type { HitRect } from './core/hitTest'
import { reminderToneOf } from './core/reminderTone'
import type { ReminderTone } from './core/reminderTone'
import { usePointerBridge } from './core/usePointerBridge'

/** 素材缺失时的兜底画布与命中框（DIP，画布坐标系），对齐小猫站立姿态 */
const FALLBACK_CANVAS = { w: 200, h: 260 }
const FALLBACK_BOUNDS: HitRect = { x: 31.5, y: 78, w: 137.5, h: 182 }

/** 气泡尾尖与宠物头顶之间的间距（DIP，固定值，不随 petScale 变） */
const BUBBLE_GAP = 8
/**
 * 气泡至少离窗口顶边这么远。
 * 宠物被拎起来（`drag` 姿态最高，画布上几乎顶到天）时头顶上方没多少地方，
 * 这时**宁可与宠物重叠**也不能被窗口裁掉半行字——那正是「看不到了」的那种坏法。
 */
const BUBBLE_MIN_TOP = 2

const state = ref<PetState>('idle')
/** 主进程驱动的「基底状态」，点击这类短效果播完后回落到它 */
const baseState = ref<PetState>('idle')
const kind = ref<'cat' | 'dog'>('cat')
const facing = ref<-1 | 1>(1)
/**
 * 宠物缩放。初值取 `PET_SCALE_DEFAULT`（= 主进程给的默认值），**不能写 1** ——
 * 设置是异步到渲染层的，初值偏大的话宠物会先按满尺寸渲染一帧、再缩回去，看着就是"闪一下"。
 */
const petScale = ref(PET_SCALE_DEFAULT)

const petId = ref('')
const petSource = ref<'builtin' | 'user'>('builtin')
const manifest = ref<PetManifest | null>(null)
const hasAssets = ref(false)
/** 素材加载失败时退回占位形象——桌面上宁可丑一点，不能直接空掉 */
const spriteFailed = ref(false)

const bubbleText = ref('')
const bubbleLeaving = ref(false)
/**
 * 当前气泡的提醒配色。`null` = 普通台词（白气泡）。
 * 由 `payload.reason` 推出来（见 showBubble），渲染层**不新增任何 IPC 字段**。
 */
const bubbleTone = ref<ReminderTone | null>(null)

/**
 * 提醒时宠物本体的动作开关（等价于给 `.pet-motion` 挂上 `pet-hop` 动画）。
 *
 * 为什么不是"切一个新姿态"：提醒用的 `eat` / `rest` 姿态目前**复用了站立族帧**
 * （见 MEMORY 的素材缺口，dog 甚至 0 张 PNG），切了也看不出来。
 * 而这里是纯 CSS 变换，**任何宠物、任何素材完整度下都成立**，不需要新画一张。
 */
const petMotion = ref(false)

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
 * 当前姿态的内容包络（DIP，画布坐标系）。
 * 命中判定与气泡锚点都吃它——**两处必须同一口径**，否则气泡会飘在宠物头顶之外。
 */
const currentBounds = computed<HitRect>(
  () => (useSheet.value ? manifest.value?.animations[state.value]?.bounds : null) ?? FALLBACK_BOUNDS
)

/**
 * 命中框：把当前动画的内容包络从「画布坐标」换算到「窗口坐标」。
 *
 * 画布在窗口内水平居中、底边对齐；再叠加三件事——
 *  petScale 的缩放原点是「窗口底边中点」（与 .pet-stage 的 transform-origin 一致）；
 *  facing = -1 时素材被水平镜像，命中框必须一起镜像，否则朝左走动时点不中；
 *  鼠标跟随的位移（倾角不建模：1.2° 在 182px 高的素材顶端约偏 3.8px，被 hitTest 的 8px pad 吸收）。
 */
const hitRect = computed<HitRect>(() => {
  const bounds = currentBounds.value
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

/**
 * 宠物**当前姿态**内容包络的顶边（窗口坐标，含 petScale，不含鼠标跟随位移）。
 *
 * 气泡靠它贴着头顶走。必须跟着 petScale 一起换算：宠物调小之后头顶会明显下移，
 * 若气泡还钉在窗口顶部，就会飘在小猫上方一大截，看着像别人的气泡。
 * 刻意**不含** gazeShift——鼠标一动气泡就跟着上下抖，很廉价。
 */
const petTopY = computed(() => {
  const bounds = currentBounds.value
  const { h: winH } = winSize.value
  const sy = winH - canvas.value.h + bounds.y
  return winH + (sy - winH) * petScale.value
})

/**
 * 气泡定位。用 `bottom` 而不是 `top`：气泡高度随文案折行数变化，
 * 用 `top` 得先量高度再回算，气泡出现的第一帧会先落在宠物脸上再弹上去。
 */
const bubbleAnchor = ref<HTMLElement | null>(null)
/** 量出来的气泡高度，只用于「头顶空间不够」时的兜底夹取；量不到（0）时不影响正常定位 */
const bubbleHeight = ref(0)

const bubbleStyle = computed(() => {
  const { h: winH } = winSize.value
  // 尾尖落在头顶上方 BUBBLE_GAP 处
  const snug = winH - (petTopY.value - BUBBLE_GAP)
  // 夹取：顶边不得高于 BUBBLE_MIN_TOP（量不到高度时这一项退化为「不夹」）
  const guarded = winH - BUBBLE_MIN_TOP - bubbleHeight.value
  return { bottom: `${Math.min(snug, guarded).toFixed(1)}px` }
})

let bubbleTimer: number | null = null
let clickRevertTimer: number | null = null
let motionTimer: number | null = null
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
  if (motionTimer !== null) {
    window.clearTimeout(motionTimer)
    motionTimer = null
  }
}

/**
 * 让宠物做一次"提醒动作"。多次连续提醒会**重播**而不是排队。
 *
 * ⚠️ 必须先落到 `false` 再翻回 `true`，否则连续两次提醒时 Vue 会把它当成
 * "属性没变化"而不重新触发 CSS 动画 —— 表现为"第二次提醒宠物不动了"。
 * 所以这里 `await nextTick()` 让 `false` 真正写进 DOM，再翻回 `true`。
 */
async function triggerPetMotion(): Promise<void> {
  if (motionTimer !== null) {
    window.clearTimeout(motionTimer)
    motionTimer = null
  }
  petMotion.value = false
  await nextTick()
  petMotion.value = true
  motionTimer = window.setTimeout(() => {
    petMotion.value = false
    motionTimer = null
  }, PET_REMIND_MOTION_MS)
}

function showBubble(payload: SpeakPayload): void {
  if (!payload?.text) return
  if (bubbleTimer !== null) {
    window.clearTimeout(bubbleTimer)
    bubbleTimer = null
  }
  bubbleText.value = payload.text
  bubbleLeaving.value = false
  // 提醒类走彩色卡片 + 宠物动作；普通台词一律白气泡（和不改造前完全一致）
  const tone = reminderToneOf(payload.reason)
  bubbleTone.value = tone
  if (tone) void triggerPetMotion()
  const hold = Math.min(Math.max(payload.ms ?? SPEECH_BUBBLE_MS, BUBBLE_MS_MIN), BUBBLE_MS_MAX)
  bubbleTimer = window.setTimeout(() => {
    bubbleLeaving.value = true
    bubbleTimer = window.setTimeout(() => {
      bubbleText.value = ''
      bubbleLeaving.value = false
      bubbleTone.value = null
      bubbleTimer = null
    }, 220)
  }, hold)
}

// 文案换了就得重新量高度（折行数会变）。量的是布局高度，入场动画的 transform 不影响它。
watch(bubbleText, async (text) => {
  if (!text) {
    bubbleHeight.value = 0
    return
  }
  await nextTick()
  bubbleHeight.value = bubbleAnchor.value?.offsetHeight ?? 0
})

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
  petScale.value = settings?.petScale ?? PET_SCALE_DEFAULT
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
  <!--
    气泡**刻意放在 .pet-stage 外面**：stage 整体套了 scale(var(--pet-scale))，
    气泡留在里面就会跟着宠物一起缩——宠物调到 75% 时 12px 的字只剩 9px，桌面上根本看不清。
    这一层只提供"窗口坐标系"的定位参照，字号永远按 DIP 绝对值渲染。
  -->
  <div class="pet-root">
    <div class="pet-stage" :style="{ '--pet-scale': String(petScale) }">
      <div class="pet-hit" :style="hitBoxStyle">
        <div class="pet-gaze" :style="gazeStyle">
          <!--
            提醒动作层：**必须在 .pet-gaze 里面**。
            .pet-gaze 的 transform 由鼠标跟随通过内联样式驱动，动画写在它身上会把跟随位移覆盖掉
            （CSS 动画的 transform 优先级高于内联样式），宠物一提醒就不再跟光标了。
            这一层只负责"跳一下"，不做定位。
          -->
          <div class="pet-motion" :data-motion="petMotion ? 'remind' : undefined">
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
      </div>
    </div>
    <div v-if="bubbleText" ref="bubbleAnchor" class="bubble-anchor" :style="bubbleStyle">
      <Bubble :text="bubbleText" :leaving="bubbleLeaving" :tone="bubbleTone" />
    </div>
  </div>
</template>
