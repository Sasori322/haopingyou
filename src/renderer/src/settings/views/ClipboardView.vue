<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useSettings } from '../composables/useSettings'

const { settings, patch } = useSettings()

const enabled = computed({
  get: () => settings.value?.clipboard?.enabled ?? true,
  set: (value: boolean) => void patch({ clipboard: { enabled: value } })
})

const listenImages = computed({
  get: () => settings.value?.clipboard?.listenImages ?? false,
  set: (value: boolean) => void patch({ clipboard: { listenImages: value } })
})

/**
 * 关键字黑名单以"逗号或换行"分隔在 UI 落地。
 *
 * 这里注意一个事：v-model 直接绑字符串 → patch 时再 split + trim；
 * 不要在这里做"每按一字就 patch"——设置层写得越少越好（旧版的 reset() 也是同样的考量）。
 */
const keywordInput = computed({
  get: () => (settings.value?.clipboard?.excludeKeywords ?? []).join(', '),
  set: (value: string) => {
    const list = value
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    void patch({ clipboard: { excludeKeywords: list } })
  }
})

const status = ref<{
  count: number
  pausedUntilAt: number
  storageDir: string
} | null>(null)

async function refreshStatus(): Promise<void> {
  const next = await window.petAPI.clipboard.status()
  status.value = { count: next.count, pausedUntilAt: next.pausedUntilAt, storageDir: next.storageDir }
}

if (window.petAPI.clipboard.onChanged) {
  // 进入页面就订阅：状态一旦被别处改了（暂停 / 清空）能立刻反映在数字上
  window.petAPI.clipboard.onChanged((next) => {
    status.value = { count: next.count, pausedUntilAt: next.pausedUntilAt, storageDir: next.storageDir }
  })
}
void refreshStatus()

// ---------- 存储目录 ----------

/**
 * 当前实际生效目录（来自主进程，可能与设置不同：例如设置无效时被回退到默认）。
 *
 * 优先信 settings：patch 走 settings.patch 返回的 next 是同步回填 settings.value 的，
 * UI 不必等 status 异步刷；而 status.storageDir 用来兜底"设置被回退"或"还在初始化"的情形。
 */
const activeStorageDir = computed(() => {
  const fromSettings = settings.value?.clipboard?.storageDir
  if (typeof fromSettings === 'string' && fromSettings.length > 0) return fromSettings
  return status.value?.storageDir ?? ''
})
/** 设置里存的目录；null/空 = 沿用默认。决定"恢复默认"按钮的启用态 */
const settingStorageDir = computed<string | null>(() => settings.value?.clipboard?.storageDir ?? null)

async function pickAndApplyDir(): Promise<void> {
  const picked = await window.petAPI.clipboard.pickStorageDir()
  if (picked === null) return
  const validation = await window.petAPI.clipboard.validateStorageDir(picked)
  if (!validation.ok) {
    ElMessage.error(`目录不可用：${validation.reason ?? '未知'}`)
    return
  }
  const target = validation.path!
  // patch 返回的最新 settings 是同步回填的；前后比对可以立刻发现 IPC 默默丢。
  // 这种"看起来成功"但实际没改的反馈，比沉默好得多——主进程的 log 里也有对应 warn。
  await patch({ clipboard: { storageDir: target } })
  if (settings.value?.clipboard?.storageDir !== target) {
    ElMessage.error(`这个目录没能保存成功：${target}`)
    return
  }
  await refreshStatus()
  ElMessage.success('已切换存储目录')
}

async function resetToDefault(): Promise<void> {
  await patch({ clipboard: { storageDir: null } })
  await refreshStatus()
  ElMessage.success('已恢复默认存储目录')
}

// ---------- 全局快捷键 ----------

/**
 * 录制模式：用户在 input 上随便按，渲染层把 KeyboardEvent 翻译成 Electron Accelerator
 * 格式字符串，命中主键时自动试注册 + apply。
 *
 * 注意主进程侧的"录制期间旧快捷键会被 toggle clipboard panel 触发"问题：
 * 进入录制时 IPC.beginHotkeyRecording 让主进程临时解绑旧值；
 * 退出（commit or cancel）时 IPC.endHotkeyRecording 再恢复——不配对的话旧键就丢了。
 */
const recording = ref(false)
const recorderPreview = ref('')
// el-input 的 ref 是组件实例，要 focus 内部 input；类型先放宽，留给 el-input 自身。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const recorderInputRef = ref<any>(null)

/** 用户正在输入的本地草稿；保存到设置层走 blur / Enter 或录制 commit */
const hotkeyDraft = ref<string>('')
watch(
  () => settings.value?.clipboard?.hotkey,
  (value) => {
    if (value !== undefined && hotkeyDraft.value !== value) hotkeyDraft.value = value
  },
  { immediate: true }
)

interface HotkeyCheck {
  ok: boolean
  reason?: string
}
const hotkeyCheck = ref<HotkeyCheck | null>(null)

// ---- 录制模式的键盘翻译 ----

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

/**
 * 把 KeyboardEvent 翻译成一个或多个主键候选。
 * 返回的字符串是 Electron 文档里 accelerator 接受的 name（如 'A'、'F12'、'Tab'、'Space'）。
 *
 * 设计：用 `e.code` 而非 `e.key` 是关键的——Shift+1 在 e.key 里是 '!'，在 e.code 里是 'Digit1'；
 * Accelerator 关心"按了哪个物理键"。
 */
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

/** 给一个 KeyboardEvent 拼出对应的候选 accelerator 段。修饰键按 Ctrl→Alt→Shift→Super 顺序排。 */
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
  await window.petAPI.clipboard.beginHotkeyRecording()
  // 让 input 先挂上去再 focus——否则 keydown 不会被它捕获
  await nextTick()
  // el-input 实例自带 focus()；vue 3 组件实例的 $el 是包裹层，要拿 inner input
  // 走 ElInput 组件的对外 .focus() 方法最稳
  const inst = recorderInputRef.value as { focus?: () => void } | null
  if (inst && typeof inst.focus === 'function') inst.focus()
}

async function cancelRecording(): Promise<void> {
  recording.value = false
  recorderPreview.value = ''
  // 还原到设置值
  const stored = settings.value?.clipboard?.hotkey ?? ''
  if (hotkeyDraft.value !== stored) hotkeyDraft.value = stored
  await window.petAPI.clipboard.endHotkeyRecording(null)
}

async function commitRecording(accelerator: string): Promise<void> {
  // 已经按过修饰键的主键——直接收尾。
  const next = canonicalize(accelerator.split('+'))
  if (recording.value) {
    recording.value = false
    recorderPreview.value = ''
  }
  const check = await window.petAPI.clipboard.tryHotkey(next)
  if (!check.ok) {
    ElMessage.error(`快捷键不可用：${check.reason ?? '未知'}，未应用`)
    // 主进程已经 unregister；要恢复旧值，endHotkeyRecording(null)
    await window.petAPI.clipboard.endHotkeyRecording(null)
    // 不 patch，draft 不动；下面由 watch 把 hotkeyDraft 还原到 settings 里的值
    return
  }
  // ok：先 end 注册新值（让主进程把 suspended state 恢复回来），
  // 再 patch（已经注册了的话 setClipboardHotkey 是 noop）。
  await window.petAPI.clipboard.endHotkeyRecording(next)
  await patch({ clipboard: { hotkey: next } })
  ElMessage.success(`已设为 ${next}`)
}

function onRecorderKeydown(e: KeyboardEvent): void {
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
    const hasModifier = parts.some(isModifierName)
    if (!hasModifier) {
      ElMessage.warning('至少需要一个修饰键（Ctrl/Alt/Shift/Super），否则会和普通按键冲突')
      return
    }
    const accelerator = canonicalize(parts)
    void commitRecording(accelerator)
    return
  }
  // 仅修饰键：实时预览（如 Ctrl 单独按下 → "Ctrl+"）
  recorderPreview.value = canonicalize(parts) + '+'
}

async function onRecorderBlur(): Promise<void> {
  // 录制中失焦=用户跑去别处了，自动取消；否则 input 看似仍"激活"但按键已经丢失
  if (recording.value) await cancelRecording()
}

// 卸载兜底：万一用户切到别页再回来前组件被销毁，仍要把主进程挂起态清掉
onBeforeUnmount(() => {
  if (recording.value) {
    void window.petAPI.clipboard.endHotkeyRecording(null)
    recording.value = false
  }
})

// ---- 文本输入流（不走录制，纯手填）----

async function validateHotkey(): Promise<void> {
  if (recording.value) return
  const value = hotkeyDraft.value.trim()
  if (value === '') {
    hotkeyCheck.value = { ok: true, reason: '已禁用' }
    return
  }
  hotkeyCheck.value = await window.petAPI.clipboard.tryHotkey(value)
}

async function applyHotkey(): Promise<void> {
  if (recording.value) await cancelRecording()
  await validateHotkey()
  if (!hotkeyCheck.value?.ok) {
    ElMessage.error(`快捷键不可用：${hotkeyCheck.value?.reason ?? '未知'}`)
    return
  }
  await patch({ clipboard: { hotkey: hotkeyDraft.value.trim() } })
}

const pausedRemain = computed<string | null>(() => {
  const until = status.value?.pausedUntilAt ?? 0
  if (!until) return null
  const remain = Math.max(0, until - Date.now())
  if (remain === 0) return null
  return `${Math.ceil(remain / 60_000)} 分钟`
})

async function pause(minutes: number | null): Promise<void> {
  await window.petAPI.clipboard.pause(minutes)
  await refreshStatus()
}

async function clearAll(): Promise<void> {
  await window.petAPI.clipboard.clear()
  ElMessage.success('已清空所有非置顶条目')
  await refreshStatus()
}

function openPanel(): void {
  window.petAPI.app.openClipboardPanel()
}
</script>

<template>
  <h2 class="page-title">剪贴板历史</h2>
  <p class="page-desc">
    历史保存在本机。<strong>默认不记录图片</strong>——图片最容易误收隐私内容，需要时手动打开。
  </p>

  <el-card class="section-card" shadow="never">
    <div class="setting-row">
      <div>
        <div class="setting-row__label">启用剪贴板历史</div>
        <div class="setting-row__hint">
          关闭后不再记录新内容，已有的历史会保留。
        </div>
      </div>
      <el-switch v-model="enabled" />
    </div>

    <div class="setting-row">
      <div>
        <div class="setting-row__label">同时记录图片</div>
        <div class="setting-row__hint">
          截图、复制图片都会被记录下来。
        </div>
      </div>
      <el-switch v-model="listenImages" :disabled="!enabled" />
    </div>
  </el-card>

  <el-card class="section-card" shadow="never">
    <div class="setting-row">
      <div>
        <div class="setting-row__label">关键字黑名单</div>
        <div class="setting-row__hint">
          命中即丢，逗号或换行分隔。<strong>无法保证挡住密码</strong>，敏感场合建议直接暂停记录。
        </div>
      </div>
      <el-input
        v-model="keywordInput"
        type="textarea"
        :rows="2"
        :disabled="!enabled"
        style="width: 260px"
        placeholder="password, passwd, 身份证, 银行卡"
      />
    </div>
  </el-card>

  <el-card class="section-card" shadow="never">
    <div class="setting-row">
      <div>
        <div class="setting-row__label">存储目录</div>
        <div class="setting-row__hint">
          当前正在写入：<code class="path-display">{{ activeStorageDir }}</code>。<br>
          切换目录后<strong>原目录的历史保留在原地</strong>，不会自动迁移；需要的话请手动拷贝过去。
        </div>
      </div>
      <div style="display: flex; gap: 8px; flex-direction: column; align-items: flex-end">
        <el-button :disabled="!enabled" @click="pickAndApplyDir">选择目录…</el-button>
        <el-button :disabled="!enabled || settingStorageDir === null" plain @click="resetToDefault">
          恢复默认
        </el-button>
      </div>
    </div>

    <div class="setting-row">
      <div>
        <div class="setting-row__label">唤起面板的全局快捷键</div>
        <div class="setting-row__hint">
          <span v-if="recording">正在录制：按键组合（Esc 取消）</span>
          <span v-else>
            点 <strong>录制…</strong>，再按你想用的组合（必须含 Ctrl / Alt / Shift 等修饰键）。<br />
            留空 = 不使用全局快捷键，改为从托盘打开面板。<br />
          </span>
          <span v-if="hotkeyCheck?.ok && !recording" class="hint-ok">✓ 可用：{{ hotkeyCheck.reason ?? 'ok' }}</span>
          <span v-else-if="hotkeyCheck && !hotkeyCheck.ok && !recording" class="hint-err">
            ✗ {{ hotkeyCheck.reason ?? '不可用' }}
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
          @keydown="onRecorderKeydown"
          @blur="onRecorderBlur"
        />
        <el-input
          v-else
          v-model="hotkeyDraft"
          placeholder="CommandOrControl+Shift+V"
          style="width: 260px"
          @keyup.enter="applyHotkey"
          @blur="validateHotkey"
        />
        <el-button v-if="recording" @click="cancelRecording">取消</el-button>
        <el-button v-else :disabled="!enabled" @click="startRecording">录制…</el-button>
        <el-button v-if="!recording" :disabled="!enabled" @click="applyHotkey">应用</el-button>
      </div>
    </div>
  </el-card>

  <el-card class="section-card" shadow="never">
    <div class="setting-row">
      <div>
        <div class="setting-row__label">记录状态</div>
        <div class="setting-row__hint">
          暂停期间不会记录新内容，已有历史不受影响。
          <span v-if="pausedRemain">· 已暂停，约 {{ pausedRemain }} 后自动恢复</span>
        </div>
      </div>
      <div style="display: flex; gap: 8px">
        <el-button :disabled="!enabled || !!pausedRemain" @click="pause(5)">暂停 5 分钟</el-button>
        <el-button :disabled="!enabled || !!pausedRemain" @click="pause(30)">暂停 30 分钟</el-button>
        <el-button :disabled="!pausedRemain" @click="pause(null)">恢复记录</el-button>
        <el-button type="danger" plain @click="clearAll">清空全部</el-button>
      </div>
    </div>

    <div class="setting-row">
      <div>
        <div class="setting-row__label">查看 / 使用历史</div>
        <div class="setting-row__hint">
          在独立窗口中查看与取用。
        </div>
      </div>
      <el-button @click="openPanel">
        打开剪贴板历史窗口
      </el-button>
    </div>
  </el-card>
</template>

<style scoped>
.path-display {
  word-break: break-all;
  user-select: text;
  font-family: var(--el-font-family-monospace, Consolas, monospace);
}
.hint-ok {
  color: var(--el-color-success);
}
.hint-err {
  color: var(--el-color-danger);
}
</style>