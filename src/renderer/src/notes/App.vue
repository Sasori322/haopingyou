<script setup lang="ts">
/**
 * 桌面便签 —— 一个窗口 = 一张便签，贴在桌面上，可以直接在上面写字。
 *
 * ## 为什么是独立窗口
 * 见 `src/main/notes/index.ts` 的长注释。渲染层这边有四件事值得记：
 *
 * 1. **自己是哪一张**由主进程通过 `?id=` 带进来 —— 渲染层不猜、也不去"认领"。
 * 2. **正文可编辑**，改动防抖后写回数据层。便签的用法就是"顺手补一句"，
 *    连改个字都要跑去设置页，那它就不是便签了。
 * 3. **编辑中不接受外部覆盖**。写回会广播给所有窗口（包括我自己），
 *    如果无脑用广播回来的值重设 textarea，用户打字打到一半会被自己刚保存的内容打断。
 *    所以 `editing` 期间只更新元数据，不碰 `draft`。
 * 4. **空白是合法状态**，所以这里没有"空内容不保存"这类特殊逻辑 —— 桌面便笺本来就是
 *    "写空了也留着"。`?focus=1`（「记一条便签」那条路）时进来自动把光标落到正文，
 *    用户点完托盘就能直接打字。
 * 5. **换纸色就是顶上那排圆点**，改的是 `updateNote` 的一个字段 patch（只带 `color`、不带正文），
 *    所以不用先把正文写回去 —— 两个字段互不影响。改完广播回来会走 `applySnapshot`，
 *    而它**编辑中不碰 `draft`**，正在打的字不会被打断。
 *
 * ## 两个按钮分工明确
 * - `⌄` 收起：只是不贴在桌面上了，便签还在，设置页随时能再贴出来；
 * - `✕` 删除：连内容一起消失（**不可恢复**）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { NOTE_TEXT_MAX, STICKY_COLORS } from '@shared/types/todo'
import type { StickyColor, StickyNote, TodoSnapshot } from '@shared/types/todo'
import { NOTE_SKIN } from '@/common/note-skin'

const params = new URLSearchParams(window.location.search)
/** 自己是哪一张。主进程用 `?id=` 带过来（见 `src/main/notes/index.ts`） */
const noteId = params.get('id') ?? ''
/** 「记一条便签」新建的那张：进来自动聚焦正文 */
const autoFocus = params.get('focus') === '1'

const note = ref<StickyNote | null>(null)
/** 正文草稿。绑定到 textarea，编辑中不会被外部广播覆盖 */
const draft = ref('')
/** 是否正在输入 —— 决定广播回来时要不要重设 `draft` */
const editing = ref(false)
const saving = ref(false)
const textRef = ref<HTMLTextAreaElement | null>(null)

const skin = computed(() => NOTE_SKIN[note.value?.color ?? 'yellow'])
const tooLong = computed(() => draft.value.length >= NOTE_TEXT_MAX)

/** 保存防抖。输入是高频事件，攒一下再写 */
const SAVE_DEBOUNCE_MS = 300
let saveTimer: ReturnType<typeof setTimeout> | null = null
let disposed = false
const disposers: Array<() => void> = []

/**
 * 用一份快照刷新本地状态。
 * **编辑中不碰 `draft`** —— 那份广播很可能就是自己刚才保存触发的。
 */
function applySnapshot(snapshot: TodoSnapshot): void {
  const mine = snapshot.notes.find((n) => n.id === noteId)
  if (!mine) return // 自己已经被删了：主进程随即会关掉这个窗口，这里不需要做什么
  note.value = mine
  if (!editing.value) draft.value = mine.text
}

async function load(): Promise<void> {
  if (noteId.length === 0) return
  applySnapshot(await window.petAPI.todo.snapshot())
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flushSave()
  }, SAVE_DEBOUNCE_MS)
}

/** 立刻写回（失焦、关窗前用；正常输入走 `scheduleSave`） */
async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const current = note.value
  if (!current || saving.value) return
  // 数据层会 trim，所以这里也按 trim 后比 —— 否则"末尾多打一个空格"会反复触发写盘
  if (draft.value.trim() === current.text) return
  saving.value = true
  try {
    const snapshot = await window.petAPI.todo.updateNote(noteId, { text: draft.value })
    if (disposed) return
    applySnapshot(snapshot)
  } finally {
    saving.value = false
  }
}

/** ✕ = 删除这张便签（连内容一起）。关闭窗口由主进程在数据变更后完成 */
function removeSelf(): void {
  if (noteId.length === 0) return
  void window.petAPI.todo.removeNote(noteId)
}

/** 收起：便签留着，只是不再贴在屏幕上 */
function hideSelf(): void {
  if (noteId.length === 0) return
  // 先把没落盘的改动写回去，免得"改完立刻收起"丢掉刚写的那句话
  void flushSave().then(() => window.petAPI.todo.setNoteDesktop(noteId, false))
}

/**
 * 换纸色（顶上那排圆点）。
 *
 * 只 patch `color` 一个字段：正文交给它自己的防抖写回，两者互不干扰，
 * 所以这里**不需要**先 `flushSave`（那是"收起 / 删除"才要操心的事）。
 * 点到当前已经选中的颜色就什么都不做，免得白跑一次 IPC。
 */
function changeColor(color: StickyColor): void {
  if (noteId.length === 0 || note.value?.color === color) return
  void window.petAPI.todo.updateNote(noteId, { color }).then((snapshot) => {
    if (!disposed) applySnapshot(snapshot)
  })
}

function onInput(): void {
  editing.value = true
  scheduleSave()
}

function onBlur(): void {
  editing.value = false
  void flushSave()
}

onMounted(() => {
  void load()
  disposers.push(
    window.petAPI.todo.onChanged((snapshot) => {
      applySnapshot(snapshot)
    })
  )
  window.addEventListener('beforeunload', () => {
    disposed = true
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  })
  if (autoFocus) {
    void nextTick(() => textRef.value?.focus())
  }
})

onBeforeUnmount(() => {
  disposed = true
  for (const dispose of disposers) dispose()
  if (saveTimer) clearTimeout(saveTimer)
})
</script>

<template>
  <article class="note" :style="{ background: skin.bg, borderColor: skin.border }">
    <header class="note__bar">
      <span class="note__grip" title="按住拖动便签">⠿</span>
      <div class="note__colors" role="group" aria-label="便签颜色">
        <button
          v-for="c in STICKY_COLORS"
          :key="c"
          class="note__dot"
          :class="{ 'note__dot--active': c === note?.color }"
          :style="{ background: NOTE_SKIN[c].dot }"
          :title="`换成${NOTE_SKIN[c].label}色`"
          :aria-pressed="c === note?.color"
          @click="changeColor(c)"
        ></button>
      </div>
      <button class="note__btn" title="从桌面收起（便签还在，可从设置页再贴出来）" @click="hideSelf">
        ⌄
      </button>
      <button class="note__btn note__btn--danger" title="删除这张便签（不可恢复）" @click="removeSelf">
        ✕
      </button>
    </header>

    <textarea
      ref="textRef"
      v-model="draft"
      class="note__text"
      :maxlength="NOTE_TEXT_MAX"
      spellcheck="false"
      placeholder="写点什么…"
      @input="onInput"
      @blur="onBlur"
    ></textarea>

    <footer v-if="tooLong" class="note__foot">已到 {{ NOTE_TEXT_MAX }} 字上限</footer>
  </article>
</template>
