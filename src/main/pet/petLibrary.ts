import { app } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PET_DIR_NAME } from '../../shared/constants'
import type { PetManifest, PetSummary, ReloadPayload } from '../../shared/types/pet'
import { resourcePath } from '../utils/paths'
import { createLogger } from '../utils/logger'

const log = createLogger('petLibrary')

export interface PetRecord {
  id: string
  source: 'builtin' | 'user'
  dir: string
  manifest: PetManifest
  hasAssets: boolean
}

/** 打包后为 process.resourcesPath/pets；开发态为 <项目根>/resources/pets */
export function builtinPetsRoot(): string {
  return resourcePath(PET_DIR_NAME)
}

export function userPetsRoot(): string {
  return join(app.getPath('userData'), PET_DIR_NAME)
}

function normalizeManifest(raw: Partial<PetManifest>): PetManifest {
  const animations = raw.animations ?? {}
  const firstAnim = Object.keys(animations)[0] ?? 'idle'
  return {
    id: raw.id ?? 'unknown',
    name: raw.name ?? raw.id ?? '未命名',
    // 昵称是"对外称呼"，缺省就退化成品名，保证调用方永远拿到一个能用的字符串
    nickname: raw.nickname?.trim() || raw.name || raw.id || '未命名',
    kind: raw.kind === 'dog' ? 'dog' : 'cat',
    version: raw.version ?? 1,
    author: raw.author,
    canvas: raw.canvas ?? { w: 200, h: 200 },
    scale: raw.scale ?? 1,
    anchor: raw.anchor ?? { x: 0.5, y: 1 },
    hitbox: raw.hitbox ?? { x: 40, y: 30, w: 120, h: 170 },
    defaultAnimation: raw.defaultAnimation ?? firstAnim,
    animations,
    bubbles: raw.bubbles ?? {}
  }
}

function readManifest(dir: string): PetManifest | null {
  const file = join(dir, 'manifest.json')
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PetManifest>
    if (!raw || typeof raw.id !== 'string' || !raw.animations) {
      log.warn('manifest 缺少必要字段，已跳过：', file)
      return null
    }
    return normalizeManifest(raw)
  } catch (error) {
    log.warn('manifest 解析失败，已跳过：', file, error)
    return null
  }
}

/** 素材齐全才走序列帧渲染，否则渲染层回退为占位宠物 */
function checkAssets(dir: string, manifest: PetManifest): boolean {
  const animations = Object.values(manifest.animations)
  if (animations.length === 0) return false
  return animations.every((anim) => {
    if (anim.mode === 'sheet') return !!anim.src && existsSync(join(dir, anim.src))
    if (anim.mode === 'sequence') return !!anim.dir && existsSync(join(dir, anim.dir))
    return false
  })
}

function scanRoot(root: string, source: 'builtin' | 'user'): PetRecord[] {
  if (!existsSync(root)) return []
  const records: PetRecord[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const manifest = readManifest(dir)
    if (!manifest) continue
    records.push({ id: manifest.id, source, dir, manifest, hasAssets: checkAssets(dir, manifest) })
  }
  return records
}

/** 用户目录同名 id 覆盖内置 */
export function listPets(): PetRecord[] {
  const builtin = scanRoot(builtinPetsRoot(), 'builtin')
  const user = scanRoot(userPetsRoot(), 'user')
  const merged = new Map<string, PetRecord>()
  for (const record of builtin) merged.set(record.id, record)
  for (const record of user) merged.set(record.id, record)
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function listPetSummaries(): PetSummary[] {
  return listPets().map((record) => ({
    id: record.id,
    name: record.manifest.name,
    nickname: record.manifest.nickname ?? record.manifest.name,
    kind: record.manifest.kind,
    source: record.source,
    hasAssets: record.hasAssets
  }))
}

export function getPet(id: string): PetRecord | null {
  const pets = listPets()
  return pets.find((pet) => pet.id === id) ?? pets[0] ?? null
}

export function toReloadPayload(record: PetRecord | null): ReloadPayload {
  if (!record) return { petId: '', source: 'builtin', manifest: null, hasAssets: false }
  return {
    petId: record.id,
    source: record.source,
    manifest: record.manifest,
    hasAssets: record.hasAssets
  }
}
