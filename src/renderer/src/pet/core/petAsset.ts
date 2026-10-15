import type { PetManifest } from '@shared/types/pet'

export type PetSource = 'builtin' | 'user'

/**
 * 素材地址：pet-asset://<builtin|user>/<petId>/<file>
 *
 * 主进程把这个协议映射到 `process.resourcesPath/pets`（打包）或 `<项目根>/resources/pets`（开发），
 * 并做了路径穿越校验。用自定义协议而不是 file:// 的原因是：file:// 在 sandbox + contextIsolation
 * 下会被 webSecurity 拦掉，而且没法统一内置宠物与用户导入宠物的寻址。
 */
export function petAssetUrl(source: PetSource, petId: string, file: string): string {
  const encoded = file.split('/').map(encodeURIComponent).join('/')
  return `pet-asset://${source}/${encodeURIComponent(petId)}/${encoded}`
}

/** 取某个动画的素材地址；manifest 只存文件名，来源由调用方补全 */
export function animationUrl(manifest: PetManifest, source: PetSource, src: string): string {
  return petAssetUrl(source, manifest.id, src)
}

const cache = new Map<string, Promise<HTMLImageElement>>()

/**
 * 带缓存的图片加载。同一张 sheet 会被多个状态复用（例如 idle/click/eat 共用 stand.png），
 * 缓存 Promise 而不是 Image，可以避免并发竞态导致的重复请求。
 */
export function loadPetImage(url: string): Promise<HTMLImageElement> {
  const hit = cache.get(url)
  if (hit) return hit
  const pending = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    // 必须声明 anonymous：否则即便协议带了 CORS 头，浏览器也会按 no-cors 取回，
    // 把 canvas 标记为 cross-origin tainted，之后 getImageData / toDataURL 全部抛 SecurityError。
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => {
      cache.delete(url)
      reject(new Error(`宠物素材加载失败：${url}`))
    }
    img.src = url
  })
  cache.set(url, pending)
  return pending
}

/** 单帧在 sheet 中的宽度。帧按水平单行排布，所以直接用总宽除帧数 */
export function frameWidth(img: HTMLImageElement, frames: number): number {
  return img.naturalWidth / Math.max(1, frames)
}
