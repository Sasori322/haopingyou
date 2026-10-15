import { net, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLogger } from '../utils/logger'

const log = createLogger('assetProtocol')

export const PET_ASSET_SCHEME = 'pet-asset'

export interface PetAssetRoots {
  builtin: string
  user: string
}

/** 必须在 app ready 之前调用 */
export function registerPetAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PET_ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // 不开这个的话，把素材画进 <canvas> 会把画布标记为 cross-origin，
        // 之后 getImageData / toDataURL 全部抛 SecurityError。
        // 对于自己托管的本地素材没有任何安全收益，纯粹是自找麻烦。
        corsEnabled: true
      }
    }
  ])
}

/**
 * pet-asset://<builtin|user>/<petId>/<file>
 * 把内置宠物目录与用户导入目录统一成同构的寻址方式，并做路径穿越校验。
 */
export function handlePetAssetProtocol(roots: PetAssetRoots): void {
  protocol.handle(PET_ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const source = url.hostname === 'user' ? 'user' : 'builtin'
      const root = normalize(source === 'user' ? roots.user : roots.builtin)
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      if (!relative) return new Response('not found', { status: 404 })

      const target = normalize(join(root, relative))
      // 路径穿越校验：必须是 root 下的路径
      if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) {
        log.warn('拒绝越权访问：', relative)
        return new Response('forbidden', { status: 403 })
      }
      if (!existsSync(target)) return new Response('not found', { status: 404 })

      const upstream = await net.fetch(pathToFileURL(target).toString())
      const headers = new Headers(upstream.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      // 素材是本地文件，改了要立刻生效（开发期尤其重要）
      headers.set('Cache-Control', 'no-cache')
      return new Response(upstream.body, { status: upstream.status, headers })
    } catch (error) {
      log.warn('加载素材失败：', request.url, error)
      return new Response('error', { status: 500 })
    }
  })
}
