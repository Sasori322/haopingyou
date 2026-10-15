<script setup lang="ts">
/**
 * 全局快捷键录制控件（剪贴板历史 / 待办便签共用）。
 *
 * 一行设置：左侧标题 + 说明，右侧「录制…／取消 + 应用」。
 *
 * ## 为什么要有"录制"而不是让用户自己拼字符串
 * Electron Accelerator 是 `CommandOrControl+Shift+V` 这种写法，让用户手打既不直观、
 * 也容易写错（大小写、`Ctrl` 与 `Control` 的差别）。录制模式直接把 KeyboardEvent 翻译成
 * Accelerator：用户按什么就是什么。
 *
 * ## 两个必须成对的动作
 * 进入录制要 `beginHotkeyRecording()` 让主进程**临时解绑旧键** —— 否则用户按的恰好是
 * 原组合时，面板会一边弹出来一边录进输入框。退出（提交或取消）必须 `endHotkeyRecording()`，
 * 不配对就把那把键弄丢了。组件卸载时也要兜一次 null（用户录到一半切去别的设置页）。
 *
 * 翻译用 `e.code` 而不是 `e.key`：Shift+1 在 `e.key` 里是 `!`，在 `e.code` 里是 `Digit1`，
 * 而 Accelerator 关心的是"按了哪个物理键"。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

/** 一个快捷键槽位需要的三个主进程能力（`petAPI.clipboard` / `petAPI.todo` 都满足） */
interface HotkeyApi {
  tryHotkey(hotkey: string): Promise<{ ok: boolean; reason?: string }>
  beginHotkeyRecording(): Promise<void>
  endHotkeyRecording(newHotkey: string | null): Promise<void>
}

const props = withDefaults(
  defineProps<{
    /** 左侧标题，如「唤起面板的全局快捷键」 */
    label: string
    /** 当前生效值（来自设置层）；变化时要同步回草稿 */
    modelValue: string
    /** 槽位三件套 */
    api: HotkeyApi
    disabled?: boolean
    placeholder?: string
  }>(),
  { disabled: false, placeholder: 'CommandOrControl+Shift+V' }
)

const emit = defineEmits<{ (e: 'change', value: string): void }>()

const recording = ref(false)
/** 录制过程中只按了修饰键时的实时预览，如 "Ctrl+Shift+" */
const recorderPreview = ref('')
// el-input 的 ref 是组件实例，要 focus 内部 input；类型先放宽，留给 el-input 自身。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const recorderInputRef = ref<any>(null)

/** 用户正在输入的本地草稿；保存到设置层走 blur / Enter 或录制 commit */
const draft = ref<string>('')
watch(
  () => props.modelValue,
  (value) => {
    if (value !== undefined && draft.value !== value) draft.value = value
  },
  { immediate: true }
)

interface HotkeyCheck {
  ok: boolean
  reason?: string
}
const check = ref<HotkeyCheck | null>(null)

// ---- 键盘翻译 ----

const MODIFIER_NAMES = new Set([
  'CommandOrControl',
  'CmdOrCtrl',
  'Alt',
  'AltGr',
  'Shift',
  'Super',
  'Meta'
])
/** 排序：固定 Ctrl/Alt/Shift/Super 这套，便于 UI 显示稳定 */
const MODIFIER_ORDER = ['CommandOrControl', 'Alt', 'Shift', 'Super']

function isModifierName(name: string): boolean {
  return MODIFIER_NAMES.has(name)
}

function canonicalize(parts: string[]): string {
  const mods: string[] = []
  const rest: string[] = []
  for (const p of parts) {
    if (isModifierName(p)) mods.push(p)
    else rest.push(p)
  }
  mods.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b))
  return [...mods, ...rest].join('+')
}

/** 把 KeyboardEvent 的 `code` 翻译成 Electron accelerator 接受的按键名 */
function keyToElectronMainKey(e: KeyboardEvent): string | null {
  const code = e.code
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]
  const digit = /^Digit(\d)$/.exec(code)
  if (digit) return digit[1]
  const fn = /^F(\d{1,2})$/.exec(code)
  if (fn) {
    const n = parseInt(fn[1], 10)
    if (n >= 1 && n <= 24) return 'F' + n
  }
  const numpad = /^Numpad(\d)$/.exec(code)
  if (numpad) return 'num' + numpad[1]
  switch (code) {
    case 'Space': return 'Space'
    case 'Tab': return 'Tab'
    case 'Backspace': return 'Backspace'
    case 'Delete': return 'Delete'
    case 'Insert': return 'Insert'
    case 'Enter': return 'Return'
    case 'Home': return 'Home'
    case 'End': return 'End'
    case 'PageUp': return 'PageUp'
    case 'PageDown': return 'PageDown'
    case 'ArrowUp': return 'Up'
    case 'ArrowDown': return 'Down'
    case 'ArrowLeft': return 'Left'
    case 'ArrowRight': return 'Right'
    case 'Escape': return 'Esc'
    case 'CapsLock': return 'Capslock'
    case 'NumLock': return 'Numlock'
    case 'ScrollLock': return 'Scrolllock'
    case 'PrintScreen': return 'PrintScreen'
    case 'AudioVolumeUp': return 'VolumeUp'
    case 'AudioVolumeDown': return 'VolumeDown'
    case 'AudioVolumeMute': return 'VolumeMute'
    case 'MediaTrackNext': return 'MediaNextTrack'
    case 'MediaTrackPrevious': return 'MediaPreviousTrack'
    case 'MediaStop': return 'MediaStop'
    case 'MediaPlayPause': return 'MediaPlayPause'
    case 'Comma': return 'Comma'
    case 'Period': return 'Period'
    case 'Semicolon': return 'Semicolon'
    case 'Quote': return 'Quote'
    case 'Backquote': return 'Backquote'
    case 'Backslash': return 'Backslash'
    case 'IntlBackslash': return 'Backslash'
    case 'Slash': return 'Slash'
    case 'Minus': return 'Minus'
    case 'Equal': return 'Equal'
    default:
      return null
  }
}

/** 给一个 KeyboardEvent 拼出候选 accelerator 段。修饰键按 Ctrl→Alt→Shift→Super 顺序排 */
function partsFromKeyboard(e: KeyboardEvent): string[] {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')
  const main = keyToElectronMainKey(e)
  return main === null ? mods : [...mods, main]
}

// ---- 录制入口与生命周期 ----

async function startRecording(): Promise<void> {
  if (recording.value) return
  recording.value = true
  recorderPreview.value = ''
  await props.api.beginHotkeyRecording()
  // 让 input 先挂上去再 focus——否则 keydown 不会被它捕获
  await nextTick()
  const inst = recorderInputRef.value as { focus?: () => void } | null
  if (inst && typeof inst.focus === 'function') inst.focus()
}

async function cancelRecording(): Promise<void> {
  recording.value = false
  recorderPreview.value = ''
  // 草稿还原到设置里的值
  if (draft.value !== props.modelValue) draft.value = props.modelValue
  await props.api.endHotkeyRecording(null)
}

async function commitRecording(accelerator: string): Promise<void> {
  const next = canonicalize(accelerator.split('+'))
  if (recording.value) {
    recording.value = false
    recorderPreview.value = ''
  }
  const result = await props.api.tryHotkey(next)
  if (!result.ok) {
    ElMessage.error(`快捷键不可用：${result.reason ?? '未知'}，未应用`)
    // 主进程在试探时已经 unregister；要恢复旧值只能靠 end(null)
    await props.api.endHotkeyRecording(null)
    return
  }
  // ok：先 end 把主进程的"挂起态"结掉（顺带注册新值），再交给父组件写设置
  await props.api.endHotkeyRecording(next)
  emit('change', next)
  ElMessage.success(`已设为 ${next}`)
}

function onKeydown(e: KeyboardEvent): void {
  if (!recording.value) return
  // 整个 keydown 吃掉，避免回车提交表单、字符进 input、IME 等副作用
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape' || e.code === 'Escape') {
    void cancelRecording()
    return
  }
  const parts = partsFromKeyboard(e)
  const hasMainKey = parts.some((p) => !isModifierName(p))
  if (hasMainKey) {
    if (!parts.some(isModifierName)) {
      ElMessage.warning('至少需要一个修饰键（Ctrl/Alt/Shift/Super），否则会和普通按键冲突')
      return
    }
    void commitRecording(canonicalize(parts))
    return
  }
  // 仅修饰键：实时预览（如 Ctrl 单独按下 → "Ctrl+"）
  recorderPreview.value = canonicalize(parts) + '+'
}

async function onBlur(): Promise<void> {
  // 录制中失焦 = 用户跑去别处了，自动取消；否则 input 看似仍"激活"但按键已经丢失
  if (recording.value) await cancelRecording()
}

// 卸载兜底：录到一半切走页面时，仍要把主进程的挂起态清掉
onBeforeUnmount(() => {
  if (recording.value) {
    void props.api.endHotkeyRecording(null)
    recording.value = false
  }
})

// ---- 文本输入流（不走录制，纯手填）----

async function validateDraft(): Promise<void> {
  if (recording.value) return
  const value = draft.value.trim()
  if (value === '') {
    check.value = { ok: true, reason: '已禁用' }
    return
  }
  check.value = await props.api.tryHotkey(value)
}

async function applyDraft(): Promise<void> {
  if (recording.value) await cancelRecording()
  await validateDraft()
  if (!check.value?.ok) {
    ElMessage.error(`快捷键不可用：${check.value?.reason ?? '未知'}`)
    return
  }
  emit('change', draft.value.trim())
}
</script>

<template>
  <div class="setting-row">
    <div>
      <div class="setting-row__label">{{ label }}</div>
      <div class="setting-row__hint">
        <span v-if="recording">正在录制：按键组合（Esc 取消）</span>
        <span v-else>
          点 <strong>录制…</strong>，再按你想用的组合（必须含 Ctrl / Alt / Shift 等修饰键）。<br />
          留空 = 不使用全局快捷键，改为从托盘打开面板。<br />
        </span>
        <span v-if="check?.ok && !recording" class="hint-ok">✓ 可用：{{ check.reason ?? 'ok' }}</span>
        <span v-else-if="check && !check.ok && !recording" class="hint-err">
          ✗ {{ check.reason ?? '不可用' }}
        </span>
      </div>
    </div>
    <div style="display: flex; gap: 8px; align-items: center">
      <el-input
        v-if="recording"
        ref="recorderInputRef"
        :model-value="recorderPreview"
        readonly
        placeholder="请按下组合键…"
        style="width: 260px"
        @keydown="onKeydown"
        @blur="onBlur"
      />
      <el-input
        v-else
        v-model="draft"
        :placeholder="placeholder"
        :disabled="disabled"
        style="width: 260px"
        @keyup.enter="applyDraft"
        @blur="validateDraft"
      />
      <el-button v-if="recording" @click="cancelRecording">取消</el-button>
      <el-button v-else :disabled="disabled" @click="startRecording">录制…</el-button>
      <el-button v-if="!recording" :disabled="disabled" @click="applyDraft">应用</el-button>
    </div>
  </div>
</template>

<style scoped>
.hint-ok {
  color: var(--el-color-success);
}
.hint-err {
  color: var(--el-color-danger);
}
</style>
