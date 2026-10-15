<script setup lang="ts">
/**
 * 剪贴板历史面板。
 *
 * 设计要点：
 * 1. 快照式打开 —— 进入时 list() 一次、状态订阅只用来高亮"有新内容"，不主动重新渲染。
 * 2. 键盘导航：↑↓ 上下移动、Ctrl+C 写回剪贴板、Esc 关闭窗口、Del 删除、P 置顶、Ctrl+L 清空。
 * 3. 暂停 5/30 分钟、立刻恢复 —— 暂停只影响采集不影响列表（暂停前的内容还在）。
 * 4. 图片缩略图走 clipboard-img:// 协议，与 pet-asset:// 平级、需要 CORS 自定义协议配合。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { ClipboardEntry, ClipboardStatus } from '@shared/types/clipboard'

const entries = ref<ClipboardEntry[]>([])
const selectedIndex = ref(0)
const status = ref<ClipboardStatus | null>(null)
let unsub: (() => void) | null = null

async function refresh(): Promise<void> {
  const list = await window.petAPI.clipboard.list()
  // 顺序保持：主进程返回的就是最新在前
  entries.value = list
  if (selectedIndex.value >= list.length) selectedIndex.value = Math.max(0, list.length - 1)
}

async function refreshStatus(): Promise<void> {
  status.value = await window.petAPI.clipboard.status()
}

onMounted(async () => {
  await refresh()
  await refreshStatus()
  unsub = window.petAPI.clipboard.onChanged((next) => {
    status.value = next
    // 仅在"最新 id 变化"时重读列表；用户主动操作（删/置顶/清空）自己已经乐观更新了
    if (!status.value?.latestId || next.latestId !== status.value.latestId) {
      void refresh()
    }
  })
  window.addEventListener('keydown', onKeydown)
  // 自适应滚到选中位置
  scrollSelectedIntoView()
})

onUnmounted(() => {
  unsub?.()
  window.removeEventListener('keydown', onKeydown)
})

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return
  if (event.ctrlKey && event.key.toLowerCase() === 'l') {
    event.preventDefault()
    void clearAll()
    return
  }
  // Ctrl+C = 把选中项写回系统剪贴板（取代原来的 Enter；Enter 在本窗口不再绑定动作）
  if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'c') {
    event.preventDefault()
    const entry = currentEntry.value
    if (entry) void onUse(entry)
    return
  }
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      moveSelection(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      moveSelection(-1)
      break
    case 'Home':
      event.preventDefault()
      selectedIndex.value = 0
      scrollSelectedIntoView()
      break
    case 'End':
      event.preventDefault()
      selectedIndex.value = Math.max(0, entries.value.length - 1)
      scrollSelectedIntoView()
      break
    case 'Delete': {
      event.preventDefault()
      const entry = currentEntry.value
      if (entry) void onDelete(entry)
      break
    }
    case 'p':
    case 'P': {
      event.preventDefault()
      const entry = currentEntry.value
      if (entry) void onPin(entry)
      break
    }
    case 'Escape':
      event.preventDefault()
      window.close()
      break
  }
}

function moveSelection(delta: number): void {
  if (entries.value.length === 0) return
  const next = selectedIndex.value + delta
  selectedIndex.value = Math.max(0, Math.min(entries.value.length - 1, next))
  scrollSelectedIntoView()
}

function scrollSelectedIntoView(): void {
  // rAF 等一帧，row 渲染完再滚
  requestAnimationFrame(() => {
    const el = document.querySelector('.clip-row--active') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  })
}

const currentEntry = computed<ClipboardEntry | null>(() => entries.value[selectedIndex.value] ?? null)

async function onUse(entry: ClipboardEntry): Promise<void> {
  // 写回剪贴板：主进程按 kind 选择 writeText / writeImage / write({text,bookmark})
  // 第一版不模拟按键（见 docs/STATUS.md 三、待定的"诚实的限制"）
  await window.petAPI.clipboard.set(entry.id)
  // 给反馈：让用户知道命中
  flashToast('已写入剪贴板，按 Ctrl+V 粘贴')
}

async function onDelete(entry: ClipboardEntry): Promise<void> {
  if (!confirm(`删除「${entry.preview.slice(0, 30)}」？`)) return
  const ok = await window.petAPI.clipboard.delete(entry.id)
  if (ok) await refresh()
}

async function onPin(entry: ClipboardEntry): Promise<void> {
  await window.petAPI.clipboard.togglePin(entry.id)
  await refresh()
}

async function clearAll(): Promise<void> {
  if (!confirm('清空所有非置顶记录？此操作不可恢复。')) return
  await window.petAPI.clipboard.clear()
  await refresh()
}

async function pause(minutes: number | null): Promise<void> {
  await window.petAPI.clipboard.pause(minutes)
  await refreshStatus()
}

const toastText = ref('')
function flashToast(text: string): void {
  toastText.value = text
  setTimeout(() => {
    if (toastText.value === text) toastText.value = ''
  }, 1800)
}

function imageUrl(entry: ClipboardEntry): string {
  return `clipboard-img://${encodeURIComponent(entry.id)}`
}

function formatTime(at: number): string {
  const date = new Date(at)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const pad = (n: number) => n.toString().padStart(2, '0')
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const pausedRemain = computed<string | null>(() => {
  const until = status.value?.pausedUntilAt ?? 0
  if (!until) return null
  const remain = Math.max(0, until - Date.now())
  if (remain === 0) return null
  return `${Math.ceil(remain / 60_000)} 分钟`
})
</script>

<template>
  <div class="clip-root">
    <header class="clip-header">
      <div class="clip-header__title">剪贴板历史</div>
      <span class="clip-pause" v-if="pausedRemain">已暂停 · 还剩 {{ pausedRemain }}</span>
      <button class="clip-btn" :disabled="!!pausedRemain" @click="pause(5)">暂停 5 分钟</button>
      <button class="clip-btn" :disabled="!!pausedRemain" @click="pause(30)">暂停 30 分钟</button>
      <button class="clip-btn" v-if="pausedRemain" @click="pause(null)">恢复记录</button>
      <button class="clip-btn clip-btn--danger" :disabled="entries.length === 0" @click="clearAll">清空</button>
    </header>

    <main class="clip-list" v-if="entries.length > 0">
      <button
        v-for="(entry, idx) in entries"
        :key="entry.id"
        class="clip-row"
        :class="{ 'clip-row--active': idx === selectedIndex }"
        @click="selectedIndex = idx"
        @dblclick="onUse(entry)"
      >
        <template v-if="entry.kind === 'image'">
          <div class="clip-row__thumb">
            <img :src="imageUrl(entry)" alt="" />
          </div>
        </template>
        <template v-else>
          <div class="clip-row__thumb">{{ entry.kind === 'files' ? '📁' : 'T' }}</div>
        </template>
        <div class="clip-row__main">
          <div class="clip-row__preview" :class="{ 'clip-row__preview--truncated': entry.truncated }">
            {{ entry.preview }}
            <span v-if="entry.pinned" class="clip-row__pin">📌</span>
          </div>
          <div class="clip-row__meta">
            <span>{{ formatTime(entry.at) }}</span>
            <span>·</span>
            <span>{{ entry.source || '系统' }}</span>
            <span v-if="entry.kind === 'image'">· 图片</span>
            <span v-else-if="entry.kind === 'files'">· 多文件</span>
          </div>
        </div>
      </button>
    </main>
    <main class="clip-empty" v-else>
      <p>还没有捕获到任何剪贴板内容。</p>
      <p style="font-size: 11px; opacity: 0.7">
        复制一段文本或截图，看看会不会自动出现在这里。如果怀疑黑名单过宽，可以在设置里调。
      </p>
    </main>

    <footer class="clip-footer">
      <div>
        <span>{{ entries.length }} 条</span>
        <span v-if="status?.listeningImages"> · 已开启图片记录</span>
      </div>
      <div class="clip-footer__shortcut">
        <span class="shortcut-item"><span class="kbd">↑↓</span>切换</span>
        <span class="shortcut-item"><span class="kbd">Ctrl+C</span>写入剪贴板</span>
        <span class="shortcut-item"><span class="kbd">P</span>置顶</span>
        <span class="shortcut-item"><span class="kbd">Del</span>删</span>
        <span class="shortcut-item"><span class="kbd">Ctrl+L</span>清空</span>
        <span class="shortcut-item"><span class="kbd">Esc</span>关</span>
      </div>
    </footer>

    <transition>
      <div v-if="toastText" class="clip-toast">{{ toastText }}</div>
    </transition>
  </div>
</template>

<style scoped>
.clip-toast {
  position: fixed;
  left: 50%;
  bottom: 60px;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.78);
  color: #ffffff;
  padding: 6px 14px;
  border-radius: 18px;
  font-size: 12px;
}
</style>
