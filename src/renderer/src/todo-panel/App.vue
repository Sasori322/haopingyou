<script setup lang="ts">
/**
 * 旁挂小面板：常驻显示**未完成的待办**。
 *
 * ## 便签去哪了（2026-10-16 拆分）
 * 这里原先挂着第二个页签「便签」。问题是便签的用途就是"贴在那儿看得见"，
 * 而它被挤在一个 320px 的窄窗里跟待办抢位置 —— 想看一眼还得先切页签，切完还要翻。
 * 现在它独立成了**桌面上的实体便签**：一张便签一个窗口，能直接在上面写字，
 * 各关各的（见 `src/main/notes/` 与 `src/renderer/src/notes/`）。
 * 所以这个面板回到只做一件事：**待办**。
 *
 * ## 与设置页的分工
 * - 这里的职责是"瞥一眼 + 勾掉 + 随手记一条"，所以只读未完成待办、只有最简单的增/删/完成；
 * - **记的时候**能顺手定优先级（点左侧圆点循环），但**改已经记下的条目**
 *   （优先级 / 标签 / 截止时间）仍然只在设置页 —— 面板是常驻窄窗，
 *   hover 时再长出一排控件就把它变成小设置页了。
 *
 * 数据流：写操作返回最新快照（直接赋值），`onChanged` 只用来接住**另一个窗口**的改动
 * —— 设置页和这个面板经常同时开着，两边显示不一致是最容易被发现的那种"坏味道"。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { TODO_PRIORITIES, TODO_PRIORITY_LABEL, TODO_TITLE_MAX } from '@shared/types/todo'
import type { TodoItem, TodoPriority, TodoSnapshot } from '@shared/types/todo'
import { dueBucket, formatDueShort, formatOverdueSpan } from '@/common/todo-date'

const snapshot = ref<TodoSnapshot | null>(null)
const quickTitle = ref('')
/**
 * 快速录入的"顺手选项"。**记完不重置**：连记三件同优先级的活儿是常态，
 * 每条都重新点一遍才是打扰。当前档位就摆在录入行上（圆点），看得见、随时能改。
 */
const quickPriority = ref<TodoPriority>('normal')
const busy = ref(false)
/** 每分钟刷新的"现在"：让"已过期 3 分钟"和分档（今天/过期）自己往前走 */
const now = ref(Date.now())
const inputRef = ref<HTMLInputElement | null>(null)

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

/**
 * 优先级圆点：点一下往下一档（普通 → 高 → 低 → 普通）。
 *
 * 顺序照着 `TODO_PRIORITIES` 走，所以"从默认的普通点第一下"落在**高**上 ——
 * 绝大多数时候用户点它是想强调这条，而不是想把它降下去。
 */
function cyclePriority(): void {
  const i = TODO_PRIORITIES.indexOf(quickPriority.value)
  const next = TODO_PRIORITIES[(i + 1) % TODO_PRIORITIES.length]
  if (next) quickPriority.value = next
}

async function addQuick(): Promise<void> {
  const title = quickTitle.value.trim()
  if (title.length === 0 || busy.value) return
  busy.value = true
  try {
    // 快速录入只填标题 + 一个优先级：面板的输入框就这么宽，再塞日期/标签就会变成小表单。
    // 那些字段仍然在设置页补 —— 这是"随手记"与"认真记"的分工。
    snapshot.value = await window.petAPI.todo.add({
      title,
      priority: quickPriority.value,
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
  // 宠物右键「记一条待办…」→ 主进程要求把光标落到快速录入框
  disposers.push(window.petAPI.todo.onFocusQuickAdd(() => focusQuickAdd()))
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
      <div class="todo-header__title">
        待办
        <span class="todo-header__count">{{ stats.active }}</span>
      </div>
      <button
        class="todo-header__close"
        title="关闭面板（待办还在，可从托盘或快捷键再打开）"
        @click="closePanel"
      >
        ✕
      </button>
    </header>

    <div class="todo-quick">
      <!-- 优先级圆点。`@mousedown.prevent` 是必需的：不拦的话按下去光标就从输入框跑了，
           用户点完圆点想接着打字还得再点一次输入框。 -->
      <button
        class="quick-priority"
        :class="`quick-priority--${quickPriority}`"
        :title="`优先级：${TODO_PRIORITY_LABEL[quickPriority]}（点击切换 低 → 普通 → 高）`"
        @mousedown.prevent
        @click="cyclePriority"
      >
        <span class="quick-priority__dot"></span>
      </button>
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

    <footer class="todo-footer">
      <span>今天到期 {{ stats.todayDue }} · 已过期 {{ stats.overdue }}</span>
      <span>已完成 {{ stats.done }}</span>
    </footer>
  </div>
</template>
