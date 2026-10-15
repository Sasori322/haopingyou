<script setup lang="ts">
/**
 * 旁挂小面板：常驻显示**未完成的待办**。
 *
 * 与设置页的分工：
 * - 这里的职责是"瞥一眼 + 勾掉 + 随手记一条"，所以只读未完成项、只有最简单的增/删/完成；
 * - 编辑（优先级 / 标签 / 截止时间）、按完成归档、便签，都在设置页那一页里做。
 *
 * 数据流：写操作返回最新快照（直接赋值），`onChanged` 只用来接住**另一个窗口**的改动
 * —— 设置页和这个面板经常同时开着，两边显示不一致是最容易被发现的那种"坏味道"。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { TodoItem, TodoSnapshot } from '@shared/types/todo'
import { dueBucket, formatDueShort, formatOverdueSpan } from '@/common/todo-date'

const snapshot = ref<TodoSnapshot | null>(null)
const quickTitle = ref('')
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
  // 宠物右键「记一条待办…」→ 主进程要求把光标落到这里
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
      <span class="todo-header__title">待办</span>
      <span class="todo-header__counts">{{ stats.active }} 项未完成</span>
      <button class="todo-header__close" title="关闭面板（数据仍在，可从托盘再打开）" @click="closePanel">
        ✕
      </button>
    </header>

    <div class="todo-quick">
      <input
        ref="inputRef"
        v-model="quickTitle"
        class="todo-quick__input"
        type="text"
        maxlength="120"
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
