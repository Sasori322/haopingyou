<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { DEFAULT_SETTINGS, PET_NAME_MAX } from '@shared/constants'
import type { ImmersiveStatus, PetSummary } from '@shared/types/pet'
import { useSettings } from '../composables/useSettings'

const { settings, patch } = useSettings()
const pets = ref<PetSummary[]>([])
const loading = ref(true)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    pets.value = await window.petAPI.listPets()
  } finally {
    loading.value = false
  }
}

/**
 * 对外称呼：用户自定义名字优先，空串回退 manifest 的默认昵称。
 *
 * 直接读 settings 而不是 `pet.nickname`，是为了改名后**立刻**反映到卡片上——
 * settings 是响应式的，不必等重新扫描宠物目录。
 */
function displayNameOf(pet: PetSummary): string {
  return settings.value?.petNames?.[pet.id]?.trim() || pet.nickname
}

async function choose(pet: PetSummary): Promise<void> {
  await window.petAPI.setActivePet(pet.id)
  await patch({ activePetId: pet.id })
  ElMessage.success(`已换成${displayNameOf(pet)}`)
}

/** 改名：留空即恢复 manifest 默认昵称（主进程会把空串原样存下来表示"用默认"） */
async function rename(pet: PetSummary): Promise<void> {
  const current = displayNameOf(pet)
  try {
    const result = await ElMessageBox.prompt('给它起个新叫法，留空则恢复默认', `给「${current}」改名`, {
      inputValue: current,
      inputValidator: (value) =>
        (value ?? '').trim().length <= PET_NAME_MAX || `最多 ${PET_NAME_MAX} 个字符`,
      confirmButtonText: '保存',
      cancelButtonText: '取消'
    })
    const next = (result.value ?? '').trim()
    await patch({ petNames: { ...(settings.value?.petNames ?? {}), [pet.id]: next } })
    // 主进程的 PetSummary.nickname 也带这套覆盖逻辑，重扫一次让两边口径保持一致
    await refresh()
    ElMessage.success(next ? `以后就叫它「${next}」啦` : '已恢复默认称呼')
  } catch {
    // 用户取消，什么都不做
  }
}

// ---------------- 鼠标跟随 ----------------

const gaze = computed(() => settings.value?.gaze ?? DEFAULT_SETTINGS.gaze)

const gazeEnabled = computed({
  get: () => gaze.value.enabled,
  set: (value: boolean) => void patch({ gaze: { ...gaze.value, enabled: value } })
})

const gazeRange = computed({
  get: () => gaze.value.range,
  set: (value: number) => void patch({ gaze: { ...gaze.value, range: value } })
})

const gazeFlip = computed({
  get: () => gaze.value.flipFacing,
  set: (value: boolean) => void patch({ gaze: { ...gaze.value, flipFacing: value } })
})

// ---------------- 沉浸躲开 ----------------

const immersive = computed(() => settings.value?.immersive ?? DEFAULT_SETTINGS.immersive)

const immersiveEnabled = computed({
  get: () => immersive.value.enabled,
  set: (value: boolean) => void patch({ immersive: { ...immersive.value, enabled: value } })
})

const immersiveAutoDetect = computed({
  get: () => immersive.value.autoDetect,
  set: (value: boolean) => void patch({ immersive: { ...immersive.value, autoDetect: value } })
})

/** 进程名单：主进程会做字符集白名单与去重，所以回写的值可能和输入不完全一致 */
const immersiveProcesses = computed({
  get: () => immersive.value.processes,
  set: (value: string[]) => void patch({ immersive: { ...immersive.value, processes: value } })
})

const status = ref<ImmersiveStatus | null>(null)
let statusTimer: number | null = null

async function refreshStatus(): Promise<void> {
  status.value = await window.petAPI.app.getImmersiveStatus()
}

/** 把"到底有没有生效"讲清楚——这个功能有外部依赖（PowerShell），不能只有一个开关 */
const statusText = computed(() => {
  if (!immersive.value.enabled) return '已关闭，宠物不会再自动让路'
  const current = status.value
  if (!current) return '读取中…'
  if (current.hidden) return `正在让路（${current.reason}），条件消失后自动回来`
  const neither = immersive.value.processes.length === 0 && !immersive.value.autoDetect
  if (neither) return '还没有可用条件：填一个进程名，或打开「全屏检测」'
  if (immersive.value.autoDetect && !current.probeAvailable) {
    return current.probeRunning
      ? '正在启动检测，请稍候…'
      : '全屏检测当前不可用，可在托盘或右键菜单里手动让宠物躲开'
  }
  if (immersive.value.autoDetect) return '检测中'
  return '按进程名单检测中'
})

onMounted(() => {
  void refresh()
  void refreshStatus()
  statusTimer = window.setInterval(() => void refreshStatus(), 3000)
})

onBeforeUnmount(() => {
  if (statusTimer !== null) {
    window.clearInterval(statusTimer)
    statusTimer = null
  }
})
</script>

<template>
  <h2 class="page-title">宠物</h2>
  <p class="page-desc">
    点卡片切换宠物；点名字旁的 ✎ 可以改个叫法，系统通知与托盘提示会一起跟着变（留空恢复默认）。
  </p>

  <el-card class="section-card" shadow="never" v-loading="loading">
    <el-empty v-if="!loading && pets.length === 0" description="还没有可用的宠物" />
    <div v-else class="pet-grid">
      <div
        v-for="pet in pets"
        :key="pet.id"
        class="pet-card"
        :class="{ 'pet-card--active': pet.id === settings?.activePetId }"
        @click="choose(pet)"
      >
        <div class="pet-card__head">
          <span class="pet-card__name">{{ displayNameOf(pet) }}</span>
          <el-tag size="small" :type="pet.kind === 'dog' ? 'warning' : 'success'" effect="light">
            {{ pet.name }}
          </el-tag>
          <el-tag v-if="pet.source === 'user'" size="small" type="info" effect="plain">
            用户导入
          </el-tag>
          <button class="pet-card__rename" title="改个名字" @click.stop="rename(pet)">✎</button>
        </div>
        <div v-if="!pet.hasAssets" class="pet-card__status">形象完善中</div>
      </div>
    </div>
    <template #footer>
      <el-button text @click="refresh">重新扫描宠物目录</el-button>
    </template>
  </el-card>

  <el-card class="section-card" shadow="never" header="鼠标跟随">
    <div class="setting-row">
      <div>
        <div class="setting-row__label">跟着光标偏一下</div>
        <div class="setting-row__hint">光标靠近时宠物会朝它轻轻偏过去，走远了就自己站正</div>
      </div>
      <el-switch v-model="gazeEnabled" />
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-row__label">感知半径 · {{ gazeRange }} px</div>
        <div class="setting-row__hint">超出这个距离就不再跟随，避免宠物整天歪着身子</div>
      </div>
      <el-slider
        class="setting-row__control"
        v-model="gazeRange"
        :min="150"
        :max="900"
        :step="10"
        :disabled="!gazeEnabled"
      />
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-row__label">按光标翻转朝向</div>
        <div class="setting-row__hint">光标跑到另一侧时宠物会转过去看一眼；走动中仍以走动方向为准</div>
      </div>
      <el-switch v-model="gazeFlip" :disabled="!gazeEnabled" />
    </div>
  </el-card>

  <el-card class="section-card" shadow="never" header="沉浸时自动躲开">
    <div class="setting-row">
      <div>
        <div class="setting-row__label">启用自动躲开</div>
        <div class="setting-row__hint">看视频、打游戏、投屏演示时宠物自动让路，条件消失后自己回来</div>
      </div>
      <el-switch v-model="immersiveEnabled" />
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-row__label">全屏检测</div>
        <div class="setting-row__hint">前台窗口铺满整屏时让宠物让路</div>
      </div>
      <el-switch v-model="immersiveAutoDetect" :disabled="!immersiveEnabled" />
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-row__label">进程名单</div>
        <div class="setting-row__hint">
          这些程序运行时宠物让路。填 exe 名即可（可省略 .exe），支持 * 通配，例如 game*，最多 8 个
        </div>
      </div>
      <el-select
        class="setting-row__control"
        v-model="immersiveProcesses"
        multiple
        filterable
        allow-create
        default-first-option
        :reserve-keyword="false"
        placeholder="输入进程名后回车"
        :disabled="!immersiveEnabled"
      />
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-row__label">运行状态</div>
        <div class="setting-row__hint">{{ statusText }}</div>
      </div>
      <el-button text @click="refreshStatus">刷新</el-button>
    </div>
  </el-card>
</template>

<style scoped>
.pet-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 10px;
}

.pet-card {
  border: 1.5px solid #e6e8eb;
  border-radius: 9px;
  padding: 9px 11px;
  cursor: pointer;
  transition: all 0.16s ease;
  background: #fff;
}

.pet-card:hover {
  border-color: var(--el-color-primary, #e1251b);
  box-shadow: 0 4px 14px rgba(225, 37, 27, 0.1);
}

.pet-card--active {
  border-color: var(--el-color-primary, #e1251b);
  background: rgba(225, 37, 27, 0.04);
}

/* 名字与标签同排，靠 flex-wrap 在窄卡片里自动折行 */
.pet-card__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}

.pet-card__name {
  font-size: 14px;
  font-weight: 600;
  margin-right: 1px;
}

/* 改名入口：常驻但压得很淡，hover 卡片时才提亮——主交互仍然是"点卡片切换宠物" */
.pet-card__rename {
  margin-left: auto;
  border: none;
  background: transparent;
  padding: 0 2px;
  font-size: 13px;
  line-height: 1;
  color: var(--el-text-color-placeholder, #c0c4cc);
  cursor: pointer;
  transition: color 0.16s ease;
}

.pet-card__rename:hover {
  color: var(--el-color-primary, #e1251b);
}

/* 标签统一压小，避免把卡片撑高 */
.pet-card :deep(.el-tag) {
  height: 19px;
  padding: 0 6px;
  font-size: 11px;
  line-height: 17px;
}

.pet-card__status {
  margin-top: 6px;
  font-size: 11px;
  color: var(--el-color-warning, #e6a23c);
}

/* setting-row 是 space-between 的 flex，控件这一侧要给固定宽度，否则滑块会被压成 0 */
.setting-row__control {
  flex: none;
  width: 320px;
}
</style>
