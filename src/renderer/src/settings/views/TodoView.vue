<script setup lang="ts">
/**
 * 待办与便签（设置页）。
 *
 * 分工：这一页是**认真管**的地方 —— 优先级、标签、截止时间、拖拽排序、便签都在这里；
 * 旁挂小面板只做"瞥一眼 / 勾掉 / 随手记一条"。
 *
 * 数据全部经 `window.petAPI.todo.*`，每个写操作都返回最新快照，直接赋值即可；
 * `onChanged` 用来接住**另一个窗口**（旁挂面板）的改动。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  NOTE_TEXT_MAX,
  TODO_PRIORITY_LABEL,
  TODO_PRIORITIES,
  TODO_TAGS_MAX,
  TODO_TAG_MAX,
  TODO_TITLE_MAX,
  STICKY_COLORS
} from '@shared/types/todo'
import type { StickyColor, StickyNote, TodoItem, TodoPriority, TodoSnapshot } from '@shared/types/todo'
import { formatDateTime, formatDueShort, formatOverdueSpan } from '@/common/todo-date'
import { NOTE_SKIN } from '@/common/note-skin'
import { useSettings } from '../composables/useSettings'
import HotkeyRecorder from '../components/HotkeyRecorder.vue'

const { settings, patch } = useSettings()

const snapshot = ref<TodoSnapshot | null>(null)
/** 每 30 秒走一次的"现在"：让"已过期 3 分钟"和 今天/明天 的分档自己往前走，不用刷新页面 */
const now = ref(Date.now())

let clock: ReturnType<typeof setInterval> | null = null
const disposers: Array<() => void> = []

const todos = computed(() => snapshot.value?.todos ?? [])
const notes = computed(() => snapshot.value?.notes ?? [])
const stats = computed(
  () => snapshot.value?.stats ?? { total: 0, active: 0, done: 0, todayDue: 0, overdue: 0 }
)

function applySnapshot(next: TodoSnapshot): void {
  snapshot.value = next
}

async function refresh(): Promise<void> {
  applySnapshot(await window.petAPI.todo.snapshot())
}

// ---------------- 新建待办 ----------------

const draft = reactive({
  title: '',
  priority: 'normal' as TodoPriority,
  tags: '',
  due: null as Date | null
})

async function addTodo(): Promise<void> {
  const title = draft.title.trim()
  if (title.length === 0) {
    ElMessage.warning('先写点内容')
    return
  }
  applySnapshot(
    await window.petAPI.todo.add({
      title,
      priority: draft.priority,
      tags: parseTags(draft.tags),
      dueAt: draft.due ? draft.due.getTime() : null
    })
  )
  draft.title = ''
  draft.tags = ''
  draft.due = null
}

/**
 * 标签输入：逗号 / 顿号 / 空格分隔。
 * 主进程还会再按 `[\w\-一-鿿]{1,16}` 过滤一遍（多余的空格、标点、超长项在那里丢掉），
 * 这里只做用户侧的顺手拆分。
 */
function parseTags(text: string): string[] {
  return text
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, TODO_TAGS_MAX)
}

// ---------------- 进行中列表 + 拖拽排序 ----------------

const activeTodos = computed(() => todos.value.filter((t) => !t.done))
const doneTodos = computed(() =>
  todos.value.filter((t) => t.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
)
const todoById = computed(() => new Map(todos.value.map((t) => [t.id, t] as const)))

/**
 * 拖拽期间的本地顺序（预览用）。
 * 只有松手时才落库 —— 每挪一格就发一次 IPC 会让设置层被高频写打满，
 * 而且中途的顺序是"半成品"，没必要持久化。
 */
const dragOrder = ref<string[]>([])
const dragId = ref<string | null>(null)

watch(
  activeTodos,
  (list) => {
    dragOrder.value = list.map((t) => t.id)
  },
  { immediate: true }
)

const orderedActive = computed<TodoItem[]>(() =>
  dragOrder.value
    .map((id) => todoById.value.get(id))
    .filter((t): t is TodoItem => t !== undefined)
)

function onDragStart(id: string, event: DragEvent): void {
  dragId.value = id
  event.dataTransfer?.setData('text/plain', id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(id: string, event: DragEvent): void {
  event.preventDefault()
  const from = dragId.value
  if (!from || from === id) return
  const list = [...dragOrder.value]
  const fromIdx = list.indexOf(from)
  const toIdx = list.indexOf(id)
  if (fromIdx < 0 || toIdx < 0) return
  list.splice(fromIdx, 1)
  list.splice(toIdx, 0, from)
  dragOrder.value = list
}

function onDragEnd(): void {
  const moved = dragId.value
  dragId.value = null
  if (!moved) return
  void window.petAPI.todo.reorder(dragOrder.value).then(applySnapshot)
}

// ---------------- 待办操作 ----------------

function toggleDone(todo: TodoItem, done: boolean): void {
  void window.petAPI.todo.setDone(todo.id, done).then(applySnapshot)
}

async function removeTodo(todo: TodoItem): Promise<void> {
  applySnapshot(await window.petAPI.todo.remove(todo.id))
  ElMessage.success('已删除')
}

async function clearDone(): Promise<void> {
  const removed = stats.value.done
  applySnapshot(await window.petAPI.todo.clearDone())
  ElMessage.success(`已清空 ${removed} 条已完成`)
}

function openPanel(): void {
  window.petAPI.todo.openPanel(false)
}

/**
 * 面板的全局快捷键。
 * 录制控件与剪贴板设置页是同一个组件（`components/HotkeyRecorder.vue`），
 * 这里只把「设置里的值」和「改完写回设置」接上。
 */
const todoApi = window.petAPI.todo
const todoHotkey = computed(() => settings.value?.todo?.hotkey ?? '')

function onHotkeyChange(value: string): void {
  void patch({ todo: { hotkey: value } })
}

// ---------------- 编辑弹框 ----------------

const editVisible = ref(false)
const editId = ref('')
const editForm = reactive({
  title: '',
  priority: 'normal' as TodoPriority,
  tags: '',
  due: null as Date | null
})

function openEdit(todo: TodoItem): void {
  editId.value = todo.id
  editForm.title = todo.title
  editForm.priority = todo.priority
  editForm.tags = todo.tags.join(', ')
  editForm.due = todo.dueAt === null ? null : new Date(todo.dueAt)
  editVisible.value = true
}

async function saveEdit(): Promise<void> {
  const title = editForm.title.trim()
  if (title.length === 0) {
    ElMessage.warning('标题不能为空')
    return
  }
  const next = await window.petAPI.todo.update(editId.value, {
    title,
    priority: editForm.priority,
    tags: parseTags(editForm.tags),
    dueAt: editForm.due ? editForm.due.getTime() : null
  })
  applySnapshot(next)
  // 主进程对非法输入是"整条拒绝并回未改动的快照"，所以这里要回读比对，
  // 否则用户会看到一个假的成功提示（与剪贴板存储目录那次踩的坑同源）。
  const saved = next.todos.find((t) => t.id === editId.value)
  if (!saved || saved.title !== title) {
    ElMessage.error('没能保存，请检查标题长度')
    return
  }
  editVisible.value = false
  ElMessage.success('已保存')
}

// ---------------- 便签 ----------------

const noteDraft = reactive({ text: '', color: 'yellow' as StickyColor })

async function addNote(): Promise<void> {
  const text = noteDraft.text.trim()
  if (text.length === 0) {
    ElMessage.warning('便签内容不能为空')
    return
  }
  applySnapshot(await window.petAPI.todo.addNote({ text, color: noteDraft.color }))
  noteDraft.text = ''
}

const noteEditVisible = ref(false)
const noteEditId = ref('')
const noteEditForm = reactive({ text: '', color: 'yellow' as StickyColor })

function openNoteEdit(note: StickyNote): void {
  noteEditId.value = note.id
  noteEditForm.text = note.text
  noteEditForm.color = note.color
  noteEditVisible.value = true
}

async function saveNote(): Promise<void> {
  const text = noteEditForm.text.trim()
  if (text.length === 0) {
    ElMessage.warning('便签内容不能为空')
    return
  }
  applySnapshot(
    await window.petAPI.todo.updateNote(noteEditId.value, { text, color: noteEditForm.color })
  )
  noteEditVisible.value = false
}

function toggleNotePin(note: StickyNote): void {
  void window.petAPI.todo.toggleNotePin(note.id).then(applySnapshot)
}

async function removeNote(note: StickyNote): Promise<void> {
  applySnapshot(await window.petAPI.todo.removeNote(note.id))
  ElMessage.success('便签已删除')
}

// ---------------- 展示 ----------------

function dueText(todo: TodoItem): string {
  if (todo.dueAt === null) return ''
  if (todo.dueAt < now.value) return formatOverdueSpan(todo.dueAt, now.value)
  return formatDueShort(todo.dueAt, now.value)
}

function isOverdue(todo: TodoItem): boolean {
  return todo.dueAt !== null && todo.dueAt < now.value
}

onMounted(() => {
  void refresh()
  disposers.push(window.petAPI.todo.onChanged(applySnapshot))
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
  <h2 class="page-title">待办与便签</h2>
  <p class="page-desc">
    待办不会像剪贴板那样自动清理，写下的每一条都会保留。
  </p>

  <el-card class="section-card" shadow="never">
    <div class="setting-row">
      <div>
        <div class="setting-row__label">概览</div>
        <div class="setting-row__hint">
          未完成 <strong>{{ stats.active }}</strong> · 今天到期 <strong>{{ stats.todayDue }}</strong>
          （含已过期 <strong>{{ stats.overdue }}</strong>）· 已完成 <strong>{{ stats.done }}</strong>
        </div>
      </div>
      <div style="display: flex; gap: 8px">
        <el-button @click="openPanel">打开旁挂面板</el-button>
        <el-button :disabled="stats.done === 0" plain @click="clearDone">
          清空已完成（{{ stats.done }}）
        </el-button>
      </div>
    </div>

    <HotkeyRecorder
      label="唤起面板的全局快捷键"
      :model-value="todoHotkey"
      :api="todoApi"
      placeholder="CommandOrControl+Alt+T"
      @change="onHotkeyChange"
    />
  </el-card>

  <el-card class="section-card" shadow="never">
    <div class="section-title">新建待办</div>
    <div class="create-row">
      <el-input
        v-model="draft.title"
        :maxlength="TODO_TITLE_MAX"
        show-word-limit
        placeholder="要做什么？"
        @keyup.enter="addTodo"
      />
      <el-select v-model="draft.priority" style="width: 104px">
        <el-option
          v-for="p in TODO_PRIORITIES"
          :key="p"
          :label="TODO_PRIORITY_LABEL[p]"
          :value="p"
        />
      </el-select>
      <el-input
        v-model="draft.tags"
        style="width: 150px"
        :placeholder="`标签，如 工作, 家里（≤${TODO_TAGS_MAX} 个）`"
      />
      <el-date-picker
        v-model="draft.due"
        type="datetime"
        placeholder="截止时间（可空）"
        style="width: 190px"
      />
      <el-button type="primary" @click="addTodo">添加</el-button>
    </div>
    <div class="create-hint">
      标签用逗号或空格分隔，单个 ≤{{ TODO_TAG_MAX }} 字。设了截止时间，到点宠物会提醒你。
    </div>
  </el-card>

  <el-card class="section-card" shadow="never">
    <div class="section-title">
      进行中
      <span class="section-count">{{ activeTodos.length }}</span>
      <span v-if="activeTodos.length > 1" class="section-tip">拖动行可调整顺序</span>
    </div>

    <el-empty v-if="orderedActive.length === 0" description="没有未完成的待办" :image-size="70" />

    <div v-else class="todo-list">
      <div
        v-for="todo in orderedActive"
        :key="todo.id"
        class="todo-row"
        :class="{ 'todo-row--dragging': dragId === todo.id }"
        draggable="true"
        @dragstart="onDragStart(todo.id, $event)"
        @dragover="onDragOver(todo.id, $event)"
        @dragend="onDragEnd"
        @drop.prevent="onDragEnd"
      >
        <span class="todo-row__handle" title="拖动排序">⋮⋮</span>
        <el-checkbox
          :model-value="todo.done"
          @change="(value: boolean | string | number) => toggleDone(todo, Boolean(value))"
        />
        <div class="todo-row__main">
          <div class="todo-row__title">{{ todo.title }}</div>
          <div class="todo-row__meta">
            <el-tag
              v-if="todo.dueAt !== null"
              size="small"
              :type="isOverdue(todo) ? 'danger' : 'info'"
              effect="light"
              :title="`截止 ${formatDateTime(todo.dueAt)}`"
            >
              {{ dueText(todo) }}
            </el-tag>
            <el-tag
              v-if="todo.priority !== 'normal'"
              size="small"
              :type="todo.priority === 'high' ? 'danger' : 'info'"
              effect="plain"
            >
              {{ TODO_PRIORITY_LABEL[todo.priority] }}
            </el-tag>
            <el-tag v-for="tag in todo.tags" :key="tag" size="small" type="info" effect="plain">
              {{ tag }}
            </el-tag>
          </div>
        </div>
        <div class="todo-row__actions">
          <el-button link size="small" @click="openEdit(todo)">编辑</el-button>
          <el-button link size="small" type="danger" @click="removeTodo(todo)">删除</el-button>
        </div>
      </div>
    </div>

    <template v-if="doneTodos.length > 0">
      <div class="section-subtitle">已完成 {{ doneTodos.length }}</div>
      <div class="todo-list">
        <div v-for="todo in doneTodos" :key="todo.id" class="todo-row todo-row--done">
          <el-checkbox
            :model-value="todo.done"
            @change="(value: boolean | string | number) => toggleDone(todo, Boolean(value))"
          />
          <div class="todo-row__main">
            <div class="todo-row__title">{{ todo.title }}</div>
          </div>
          <div class="todo-row__actions">
            <el-button link size="small" type="danger" @click="removeTodo(todo)">删除</el-button>
          </div>
        </div>
      </div>
    </template>
  </el-card>

  <el-card class="section-card" shadow="never">
    <div class="section-title">
      便签
      <span class="section-count">{{ notes.length }}</span>
    </div>

    <div class="create-row">
      <el-input
        v-model="noteDraft.text"
        type="textarea"
        :rows="2"
        :maxlength="NOTE_TEXT_MAX"
        placeholder="随手记点什么…"
      />
      <el-radio-group v-model="noteDraft.color" class="color-picker">
        <el-radio-button v-for="c in STICKY_COLORS" :key="c" :value="c">
          {{ NOTE_SKIN[c].label }}
        </el-radio-button>
      </el-radio-group>
      <el-button type="primary" @click="addNote">添加便签</el-button>
    </div>

    <el-empty v-if="notes.length === 0" description="还没有便签" :image-size="70" />

    <div v-else class="note-grid">
      <div
        v-for="note in notes"
        :key="note.id"
        class="note-card"
        :style="{ background: NOTE_SKIN[note.color].bg, borderColor: NOTE_SKIN[note.color].border }"
      >
        <div class="note-card__text">{{ note.text }}</div>
        <div class="note-card__footer">
          <span class="note-card__time">{{ formatDateTime(note.updatedAt) }}</span>
          <div class="note-card__actions">
            <el-button link size="small" @click="toggleNotePin(note)">
              {{ note.pinned ? '取消置顶' : '置顶' }}
            </el-button>
            <el-button link size="small" @click="openNoteEdit(note)">编辑</el-button>
            <el-button link size="small" type="danger" @click="removeNote(note)">删除</el-button>
          </div>
        </div>
      </div>
    </div>
  </el-card>

  <el-dialog v-model="editVisible" title="编辑待办" width="460px">
    <div class="dialog-row">
      <div class="dialog-label">标题</div>
      <el-input v-model="editForm.title" :maxlength="TODO_TITLE_MAX" show-word-limit />
    </div>
    <div class="dialog-row">
      <div class="dialog-label">优先级</div>
      <el-select v-model="editForm.priority" style="width: 100%">
        <el-option
          v-for="p in TODO_PRIORITIES"
          :key="p"
          :label="TODO_PRIORITY_LABEL[p]"
          :value="p"
        />
      </el-select>
    </div>
    <div class="dialog-row">
      <div class="dialog-label">标签</div>
      <el-input v-model="editForm.tags" placeholder="逗号分隔" />
    </div>
    <div class="dialog-row">
      <div class="dialog-label">截止时间</div>
      <el-date-picker
        v-model="editForm.due"
        type="datetime"
        placeholder="留空 = 不提醒"
        style="width: 100%"
      />
    </div>
    <template #footer>
      <el-button @click="editVisible = false">取消</el-button>
      <el-button type="primary" @click="saveEdit">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="noteEditVisible" title="编辑便签" width="460px">
    <el-input
      v-model="noteEditForm.text"
      type="textarea"
      :rows="6"
      :maxlength="NOTE_TEXT_MAX"
      show-word-limit
    />
    <div class="dialog-row" style="margin-top: 12px">
      <div class="dialog-label">颜色</div>
      <el-radio-group v-model="noteEditForm.color">
        <el-radio-button v-for="c in STICKY_COLORS" :key="c" :value="c">
          {{ NOTE_SKIN[c].label }}
        </el-radio-button>
      </el-radio-group>
    </div>
    <template #footer>
      <el-button @click="noteEditVisible = false">取消</el-button>
      <el-button type="primary" @click="saveNote">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.section-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
}

.section-count {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 400;
  color: #909399;
}

.section-tip {
  margin-left: 10px;
  font-size: 12px;
  font-weight: 400;
  color: #c0c4cc;
}

.section-subtitle {
  margin: 18px 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: #606266;
  padding-top: 12px;
  border-top: 1px dashed #e6e8eb;
}

.create-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  flex-wrap: wrap;
}

.create-hint {
  margin-top: 8px;
  font-size: 12px;
  color: #a8abb2;
  line-height: 1.7;
}

.todo-list {
  display: flex;
  flex-direction: column;
}

.todo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 8px;
  border-radius: 8px;
  border: 1px solid transparent;
  border-bottom-color: #f2f3f5;
  cursor: default;
}

.todo-row:hover {
  background: #fafbfc;
  border-color: #eef0f3;
}

.todo-row--dragging {
  opacity: 0.45;
}

.todo-row--done .todo-row__title {
  color: #a8abb2;
  text-decoration: line-through;
}

.todo-row__handle {
  color: #c8ccd4;
  cursor: grab;
  letter-spacing: -2px;
  user-select: none;
  font-size: 13px;
}

.todo-row__main {
  flex: 1;
  min-width: 0;
}

.todo-row__title {
  font-size: 13.5px;
  line-height: 1.5;
  word-break: break-word;
}

.todo-row__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.todo-row__actions {
  flex: 0 0 auto;
}

.color-picker {
  padding-top: 1px;
}

.note-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 12px;
}

.note-card {
  border: 1px solid;
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 104px;
}

.note-card__text {
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  flex: 1;
  color: #303133;
}

/* 时间与操作分两行：210px 宽的卡片里，"2026-10-15 15:13 + 三个按钮"横向塞不下，
   挤在一行会让时间折成两行、和按钮错位（比多一行更难读）。 */
.note-card__footer {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.note-card__time {
  font-size: 11px;
  color: #a8abb2;
}

.note-card__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  /* el-button 默认带 12px 左间距，把第一个也带上就会缩进得莫名其妙 */
  margin-left: -4px;
}

.dialog-row {
  margin-bottom: 14px;
}

.dialog-label {
  font-size: 12.5px;
  color: #606266;
  margin-bottom: 6px;
}
</style>
