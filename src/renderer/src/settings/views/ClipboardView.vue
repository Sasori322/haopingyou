<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useSettings } from '../composables/useSettings'
import HotkeyRecorder from '../components/HotkeyRecorder.vue'

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
 * 录制控件的全部逻辑（键盘翻译、录制期间挂起旧键、可用性试探）都在
 * `components/HotkeyRecorder.vue` 里 —— 待办设置页用的是同一个组件，改一处两边都生效。
 * 这里只负责把「设置里的值」与「改完写回设置」接上。
 */
function onHotkeyChange(value: string): void {
  void patch({ clipboard: { hotkey: value } })
}

/** 组件只用到命名空间里的 try / begin / end 三个方法，整个传过去即可 */
const clipboardApi = window.petAPI.clipboard
/** 当前生效的快捷键（空串 = 没启用全局快捷键） */
const clipboardHotkey = computed(() => settings.value?.clipboard?.hotkey ?? '')

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

    <HotkeyRecorder
      label="唤起面板的全局快捷键"
      :model-value="clipboardHotkey"
      :api="clipboardApi"
      :disabled="!enabled"
      @change="onHotkeyChange"
    />
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
</style>