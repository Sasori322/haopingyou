<script setup lang="ts">
/**
 * 旁挂小面板：常驻显示**未完成的待办**与**全部便签**。
 *
 * 为什么便签也要挂在这里：便签的用途就是"随时看得见"，只躺在设置页里等于没有。
 * 面板本来就是独立窗口 + 无边框 + 置顶 + 可拖，复用它是**零成本**的桌面常驻
 * （另开一个"便签墙"窗口要重新解决层级归属、透明区鼠标穿透、位置持久化三件事，
 * 见 `docs/STATUS.md`）。
 *
 * 与设置页的分工：
 * - 这里的职责是"瞥一眼 + 勾掉 + 随手记一条"，所以只读未完成待办、只有最简单的增/删/完成；
 * - 编辑（优先级 / 标签 / 截止时间）、按完成归档、**便签挑颜色与改正文**，都在设置页那一页里做。
 *
 * 数据流：写操作返回最新快照（直接赋值），`onChanged` 只用来接住**另一个窗口**的改动
 * —— 设置页和这个面板经常同时开着，两边显示不一致是最容易被发现的那种"坏味道"。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { NOTE_TEXT_MAX, TODO_TITLE_MAX } from '@shared/types/todo'
import type { StickyNote, TodoItem, TodoSnapshot } from '@shared/types/todo'
import { dueBucket, formatDueShort, formatOverdueSpan } from '@/common/todo-date'
import { NOTE_SKIN } from '@/common/note-skin'

type PanelTab = 'todo' | 'notes'

/** 面板可以用 `#notes` 直开便签页签（托盘入口 / `HPY_CAPTURE_TODO_PANEL_TAB` 自检都走它） */
function readInitialTab(): PanelTab {
  return window.location.hash.replace('#', '') === 'notes' ? 'notes' : 'todo'
}

const snapshot = ref<TodoSnapshot | null>(null)
const tab = ref<PanelTab>(readInitialTab())
const quickTitle = ref('')
const quickNote = ref('')
const busy = ref(false)
const noteBusy = ref(false)
/** 每分钟刷新的"现在"：让"已过期 3 分钟"和分档（今天/过期）自己往前走 */
const now = ref(Date.now())
const inputRef = ref<HTMLInputElement | null>(null)
const noteInputRef = ref<HTMLInputElement | null>(null)

let clock: ReturnType<typeof setInterval> | null = null
const disposers: Array<() => void> = []

/** 面板里的排序优先级：先看"要不要紧"，同档再按时间/用户顺序 */
const BUCKET_RANK = { overdue: 0, today: 1, later: 2, none: 3 } as const

const activeTodos = computed<TodoItem[]>(() =>
  (snapshot.value?.todos ?? [])
    .filter((t) => !t.done)
    .slice()
    .sort((a, b) => {
      const ra = BUCKET_RANK[dueBucket(a.dueAt, now.value)]
      const rb = BUCKET_RANK[dueBucket(b.dueAt, now.value)]
      if (ra !== rb) return ra - rb
      // 过期 / 今天这两档：越早到期越靠前；其余沿用用户在设置页拖出来的顺序
      if (ra <= 1) return (a.dueAt ?? 0) - (b.dueAt ?? 0)
      return a.order - b.order
    })
)

/** 便签顺序**不在面板里排**：主进程给的就是「置顶优先 → 最近改过」，再排一次就会两边不一致 */
const notes = computed<StickyNote[]>(() => snapshot.value?.notes ?? [])
const pinnedCount = computed(() => notes.value.filter((n) => n.pinned).length)

interface Chip {
  text: string
  cls: string
}

interface Row {
  todo: TodoItem
  chips: Chip[]
}

/** 把"显示什么标签"在计算属性里算好，模板只负责渲染 —— 免得在模板里写非空断言 */
const rows = computed<Row[]>(() =>
  activeTodos.value.map((todo) => {
    const chips: Chip[] = []
    if (todo.dueAt !== null) {
      if (todo.dueAt < now.value) {
        chips.push({ text: formatOverdueSpan(todo.dueAt, now.value), cls: 'todo-chip--overdue' })
      } else {
        const todayish = dueBucket(todo.dueAt, now.value) === 'today'
        chips.push({
          text: formatDueShort(todo.dueAt, now.value),
          cls: todayish ? 'todo-chip--today' : 'todo-chip--later'
        })
      }
    }
    if (todo.priority === 'high') chips.push({ text: '高', cls: 'todo-chip--high' })
    for (const tag of todo.tags) chips.push({ text: `#${tag}`, cls: 'todo-chip--later' })
    return { todo, chips }
  })
)

const stats = computed(
  () => snapshot.value?.stats ?? { total: 0, active: 0, done: 0, todayDue: 0, overdue: 0 }
)

async function refresh(): Promise<void> {
  snapshot.value = await window.petAPI.todo.snapshot()
}

function switchTab(next: PanelTab): void {
  if (tab.value === next) {
    focusActiveInput()
    return
  }
  tab.value = next
  void nextTick(() => focusActiveInput())
}

/** 切页签后把光标落到当前页签的输入框：面板的核心动作就是"随手记一条" */
function focusActiveInput(): void {
  if (tab.value === 'todo') inputRef.value?.focus()
  else noteInputRef.value?.focus()
}

async function addQuick(): Promise<void> {
  const title = quickTitle.value.trim()
  if (title.length === 0 || busy.value) return
  busy.value = true
  try {
    // 快速录入只填标题：面板的输入框就这么宽，塞优先级/日期选择器会把它变成一个小表单。
    // 需要那些字段时在设置页补 —— 这也是"随手记"与"认真记"的合理分工。
    snapshot.value = await window.petAPI.todo.add({
      title,
      priority: 'normal',
      tags: [],
      dueAt: null
    })
    quickTitle.value = ''
  } finally {
    busy.value = false
    await nextTick()
    inputRef.value?.focus()
  }
}

async function addQuickNote(): Promise<void> {
  const text = quickNote.value.trim()
  if (text.length === 0 || noteBusy.value) return
  noteBusy.value = true
  try {
    // 颜色固定给黄色：这一格的职责是"先把话记住"，挑颜色属于设置页那种"认真管"。
    // 想改颜色/改正文时，同一张便签在设置页点一下就能编辑。
    snapshot.value = await window.petAPI.todo.addNote({ text, color: 'yellow' })
    quickNote.value = ''
  } finally {
    noteBusy.value = false
    await nextTick()
    noteInputRef.value?.focus()
  }
}

function complete(todo: TodoItem): void {
  void window.petAPI.todo.setDone(todo.id, true).then((next) => {
    snapshot.value = next
  })
}

function remove(todo: TodoItem): void {
  void window.petAPI.todo.remove(todo.id).then((next) => {
    snapshot.value = next
  })
}

function togglePin(note: StickyNote): void {
  void window.petAPI.todo.toggleNotePin(note.id).then((next) => {
    snapshot.value = next
  })
}

function removeNote(note: StickyNote): void {
  void window.petAPI.todo.removeNote(note.id).then((next) => {
    snapshot.value = next
  })
}

function focusQuickAdd(): void {
  void nextTick(() => {
    inputRef.value?.focus()
    inputRef.value?.select()
  })
}

function closePanel(): void {
  window.close()
}

onMounted(() => {
  void refresh()
  disposers.push(
    window.petAPI.todo.onChanged((next) => {
      snapshot.value = next
    })
  )
  // 宠物右键「记一条待办…」→ 主进程要求把光标落到待办输入框。
  // 顺带把页签切回待办：用户点的是"记一条待办"，不该停在便签页签上。
  disposers.push(
    window.petAPI.todo.onFocusQuickAdd(() => {
      tab.value = 'todo'
      focusQuickAdd()
    })
  )
  clock = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})

onBeforeUnmount(() => {
  for (const dispose of disposers) dispose()
  if (clock !== null) clearInterval(clock)
})
</script>

<template>
  <div class="todo-root">
    <header class="todo-header">
      <div class="todo-tabs">
        <button
          class="todo-tab"
          :class="{ 'todo-tab--active': tab === 'todo' }"
          title="未完成的待办"
          @click="switchTab('todo')"
        >
          待办
          <span class="todo-tab__count">{{ stats.active }}</span>
        </button>
        <button
          class="todo-tab"
          :class="{ 'todo-tab--active': tab === 'notes' }"
          title="全部便签（置顶的排前面）"
          @click="switchTab('notes')"
        >
          便签
          <span class="todo-tab__count">{{ notes.length }}</span>
        </button>
      </div>
      <button class="todo-header__close" title="关闭面板（数据仍在，可从托盘再打开）" @click="closePanel">
        ✕
      </button>
    </header>

    <!-- ---------------- 待办 ---------------- -->
    <template v-if="tab === 'todo'">
      <div class="todo-quick">
        <input
          ref="inputRef"
          v-model="quickTitle"
          class="todo-quick__input"
          type="text"
          :maxlength="TODO_TITLE_MAX"
          placeholder="记一条待办，回车添加"
          @keydown.enter.prevent="addQuick"
        />
        <button
          class="todo-btn todo-btn--primary"
          :disabled="busy || quickTitle.trim().length === 0"
          @click="addQuick"
        >
          添加
        </button>
      </div>

      <div class="todo-list">
        <div v-if="rows.length === 0" class="todo-empty">
          还没有未完成的待办<br />
          在上面记一条，或用宠物右键「记一条待办…」
        </div>
        <div v-for="row in rows" :key="row.todo.id" class="todo-row">
          <button class="todo-check" title="标记完成" @click="complete(row.todo)"></button>
          <div class="todo-row__main">
            <div class="todo-row__title">{{ row.todo.title }}</div>
            <div v-if="row.chips.length > 0" class="todo-row__meta">
              <span v-for="chip in row.chips" :key="chip.text" class="todo-chip" :class="chip.cls">
                {{ chip.text }}
              </span>
            </div>
          </div>
          <button class="todo-row__del" title="删除" @click="remove(row.todo)">✕</button>
        </div>
      </div>
    </template>

    <!-- ---------------- 便签 ---------------- -->
    <template v-else>
      <div class="todo-quick">
        <input
          ref="noteInputRef"
          v-model="quickNote"
          class="todo-quick__input"
          type="text"
          :maxlength="NOTE_TEXT_MAX"
          placeholder="记一条便签，回车添加"
          @keydown.enter.prevent="addQuickNote"
        />
        <button
          class="todo-btn todo-btn--primary"
          :disabled="noteBusy || quickNote.trim().length === 0"
          @click="addQuickNote"
        >
          添加
        </button>
      </div>

      <div class="todo-list">
        <div v-if="notes.length === 0" class="todo-empty">
          还没有便签<br />
          在上面记一条，或到设置页挑个颜色
        </div>
        <div v-else class="note-grid">
          <div
            v-for="note in notes"
            :key="note.id"
            class="note-card"
            :style="{ background: NOTE_SKIN[note.color].bg, borderColor: NOTE_SKIN[note.color].border }"
          >
            <span v-if="note.pinned" class="note-card__pin">置顶</span>
            <div class="note-card__text">{{ note.text }}</div>
            <div class="note-card__ops">
              <button class="note-card__op" :title="note.pinned ? '取消置顶' : '置顶'" @click="togglePin(note)">
                {{ note.pinned ? '取消置顶' : '置顶' }}
              </button>
              <button class="note-card__op note-card__op--del" title="删除" @click="removeNote(note)">✕</button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <footer class="todo-footer">
      <template v-if="tab === 'todo'">
        <span>今天到期 {{ stats.todayDue }} · 已过期 {{ stats.overdue }}</span>
        <span>已完成 {{ stats.done }}</span>
      </template>
      <template v-else>
        <span>共 {{ notes.length }} 张 · 置顶 {{ pinnedCount }}</span>
        <span>颜色与正文在设置页改</span>
      </template>
    </footer>
  </div>
</template>
