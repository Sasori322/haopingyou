<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { DEFAULT_SETTINGS } from '@shared/constants'
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

async function choose(pet: PetSummary): Promise<void> {
  await window.petAPI.setActivePet(pet.id)
  await patch({ activePetId: pet.id })
  ElMessage.success(`已换成${pet.nickname}`)
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
      ? '辅助进程刚启动，正在自检…'
      : '全屏检测当前不可用（系统可能限制了 PowerShell），仍可用「让宠物躲开」手动让路'
  }
  if (immersive.value.autoDetect) return '检测中，辅助进程运行正常'
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
    宠物由 <code>resources/pets/&lt;id&gt;/manifest.json</code> 驱动，内置与用户导入的宠物同构。
    卡片上的名字取自 manifest 的 <code>nickname</code> 字段，系统通知与托盘提示也用它——
    想换个叫法，改这一处就够了。
    素材缺失时渲染层会回退为内置占位形象。
  </p>

  <el-card class="section-card" shadow="never" v-loading="loading">
    <el-empty v-if="!loading && pets.length === 0" description="还没有可用的宠物，请在 resources/pets 下放入宠物目录" />
    <div v-else class="pet-grid">
      <div
        v-for="pet in pets"
        :key="pet.id"
        class="pet-card"
        :class="{ 'pet-card--active': pet.id === settings?.activePetId }"
        @click="choose(pet)"
      >
        <div class="pet-card__name">{{ pet.nickname }}</div>
        <div class="pet-card__meta">
          <el-tag size="small" :type="pet.kind === 'dog' ? 'warning' : 'success'" effect="light">
            {{ pet.name }}
          </el-tag>
          <el-tag size="small" type="info" effect="plain">
            {{ pet.source === 'user' ? '用户导入' : '内置' }}
          </el-tag>
        </div>
        <div class="pet-card__status">
          {{ pet.hasAssets ? '序列帧素材就绪' : '素材待补充 · 当前显示占位形象' }}
        </div>
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
        <div class="setting-row__hint">
          光标靠近时宠物会朝它轻轻偏过去（最多 3.2px / 1.2°），走远了就自己站正
        </div>
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
        <div class="setting-row__hint">
          前台窗口铺满整屏时让路。Electron 拿不到别的应用的前台窗口，这里用一个常驻 PowerShell
          辅助进程读取（不引原生模块、不编译 .NET，实测每次查询 1–2ms）
        </div>
      </div>
      <el-switch v-model="immersiveAutoDetect" :disabled="!immersiveEnabled" />
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-row__label">进程名单</div>
        <div class="setting-row__hint">
          这些程序一运行就让路。填 exe 名即可（可省略 .exe），支持 * 通配，例如 game* 、steam ，最多 8 个
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
    <div class="setting-row">
      <div>
        <div class="setting-row__label">临时让它回来</div>
        <div class="setting-row__hint">
          也可以随时在托盘图标或宠物右键菜单里选「让宠物躲开」——手动让路不依赖上面这些检测
        </div>
      </div>
    </div>
  </el-card>
</template>

<style scoped>
.pet-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
}

.pet-card {
  border: 1.5px solid #e6e8eb;
  border-radius: 10px;
  padding: 14px 16px;
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

.pet-card__name {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 9px;
}

.pet-card__meta {
  display: flex;
  gap: 6px;
  margin-bottom: 9px;
}

.pet-card__status {
  font-size: 12px;
  color: #909399;
}

/* setting-row 是 space-between 的 flex，控件这一侧要给固定宽度，否则滑块会被压成 0 */
.setting-row__control {
  flex: none;
  width: 320px;
}
</style>
