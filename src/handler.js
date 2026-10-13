/**
 * Makers 平台装配层：业务和 Blob 数据库复用 @twikoojs/common 的公开接口。
 * 不调用封闭的官方 EO bundle，避免两份 common 注册表和依赖注入互不生效。
 */
import {
  BlobKvDatabase,
  createHandler as createTwikooHandler,
  getPostSubmitService,
  resetRequestTimes,
  scaffoldAdapters,
  setCustomLibs,
  setLibImporter
} from '@twikoojs/common'
import { VERSION } from '@twikoojs/shared'
import xss from 'xss'
import { enhanceDatabase, installEnhancements } from './enhancements.js'
import { createEoNodemailer, createMailBridgeContext, withMailBridgeContext } from './mail.js'
import { AkismetClient } from './akismet.js'
import { searchSync } from './ip2region.js'

/** 官方公共层使用的能力声明；腾讯云 TMS SDK 仍不在 Makers 中启用。 */
export const capabilities = Object.freeze({
  mail: 'restricted',
  domPurify: false, // 由 xss 注入实现服务端过滤，不加载 jsdom。
  ip2region: true,
  akismet: true, // HTTP transport；检测规则仍由 common 执行。
  tencentTms: false,
  imageUpload: true,
  qqAvatar: true,
  ai: true
})

/** 将 common 的 Buffer/filename 形态适配成运行时原生 FormData。 */
class MakersFormData extends FormData {
  append (name, value, options) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      const filename = typeof options === 'string' ? options : options?.filename
      const blob = new Blob([value], { type: options?.contentType || 'application/octet-stream' })
      super.append(name, blob, filename || 'file')
    } else if (value instanceof Blob) {
      if (options) super.append(name, value, typeof options === 'string' ? options : options.filename)
      else super.append(name, value)
    } else {
      super.append(name, String(value))
    }
  }

  /** multipart boundary 由原生 fetch 生成。 */
  getHeaders () { return {} }
}

// 这些覆写均不持有请求配置；邮件上下文使用 AsyncLocalStorage 隔离。
setCustomLibs({
  DOMPurify: { sanitize: (html) => xss(html) },
  nodemailer: createEoNodemailer(),
  '@imaegoo/node-ip2region': { create: () => ({ binarySearchSync: searchSync }) },
  'form-data': MakersFormData
})
// common 2.0.13 的 Akismet 加载不检查 customLibs，使用公开 importer 接口。
// 字面量 import 保证构建器能追踪实际需要的依赖；其余库已有覆写或能力关闭。
const libraryLoaders = {
  'akismet-api': async () => ({ AkismetClient }),
  '@xsai/generate-text': () => import('@xsai/generate-text'),
  bowser: () => import('bowser'),
  marked: () => import('marked'),
  'html-to-text': () => import('html-to-text'),
  pushoo: () => import('pushoo'),
  xml2js: () => import('xml2js')
}
setLibImporter(specifier => {
  if (!Object.hasOwn(libraryLoaders, specifier)) throw new Error(`Makers 未启用依赖 ${specifier}`)
  return libraryLoaders[specifier]()
})
installEnhancements()

let throttleWindowStarted = Date.now()

/** 接受完整 Origin，也兼容本仓库旧文档中的裸域名（按 HTTPS 解释）。 */
function normalizeOrigins (value) {
  return String(value).split(',').map(item => {
    const origin = item.trim().replace(/\/+$/, '')
    return origin && !origin.includes('://') ? `https://${origin}` : origin
  }).filter(Boolean).join(',')
}

/** 只将部署配置中明确支持的字段叠加到请求视图，不改写 Blob。 */
function withDeploymentConfig (db, env) {
  return new Proxy(db, {
    get (target, key) {
      if (key === 'getConfig') {
        return async () => {
          const config = { ...(await target.getConfig() || {}) }
          if (env.CORS_ALLOW_ORIGIN !== undefined) config.CORS_ALLOW_ORIGIN = env.CORS_ALLOW_ORIGIN
          if (config.CORS_ALLOW_ORIGIN) config.CORS_ALLOW_ORIGIN = normalizeOrigins(config.CORS_ALLOW_ORIGIN)
          return config
        }
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

/** 将 Web Request 规范化成官方公共层使用的请求，不相信浏览器提供的 IP 字段。 */
async function toRequest (context) {
  const { request } = context
  const url = new URL(request.url)
  const headers = Object.fromEntries(request.headers.entries())
  let body = {}
  if (request.method === 'POST') {
    body = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象')
  }
  return {
    method: request.method,
    url: request.url,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers,
    body,
    ip: context.clientIp || headers['eo-connecting-ip'] || headers['x-forwarded-for']?.split(',')[0]?.trim() || headers['x-real-ip'] || 'unknown'
  }
}

/** 创建可注入内存 Blob 的平台入口；生产首次业务请求才初始化 twikoo namespace。 */
export function createHandler ({ store, env = {} } = {}) {
  let storePromise
  const getStore = () => {
    if (store) return Promise.resolve(store)
    storePromise ??= import('@edgeone/pages-blob').then(({ getStore }) => getStore({ name: 'twikoo', consistency: 'strong' }))
    return storePromise
  }
  return async function onRequest (context) {
    const method = context.request.method
    if (method === 'GET' || method === 'HEAD') {
      return new Response(method === 'HEAD' ? null : JSON.stringify({
        code: 0,
        message: 'Twikoo 云函数运行正常，请参考 https://twikoo.js.org/frontend.html 完成前端的配置',
        version: VERSION,
        adapter: 'twikoo-eo'
      }), { headers: { 'Content-Type': 'application/json;charset=UTF-8' } })
    }
    if (method !== 'POST' && method !== 'OPTIONS') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD, POST, OPTIONS' } })
    }
    let request
    try {
      request = await toRequest(context)
    } catch {
      return Response.json({ code: 1000, message: '请求体必须是合法 JSON 对象' }, { status: 400 })
    }
    // 每十分钟复位上游的进程内请求计数，避免常驻实例累计到永久 429。
    if (Date.now() - throttleWindowStarted >= 600000) {
      resetRequestTimes()
      throttleWindowStarted = Date.now()
    }
    const runtimeEnv = { ...process.env, ...env, ...context.env }
    const db = withDeploymentConfig(enhanceDatabase(new BlobKvDatabase(await getStore())), runtimeEnv)
    return withMailBridgeContext(createMailBridgeContext(request, runtimeEnv), async () => {
      const handler = createTwikooHandler(scaffoldAdapters({
        request: { toTkRequest: () => request },
        response: { fromTkResponse: result => result },
        database: db,
        capabilities,
        postSubmit: {
          /** 复用官方审核与通知服务；平台有 waitUntil 时托管后台 Promise。 */
          dispatch (comment, ctx) {
            const job = getPostSubmitService()(comment, ctx).catch(error => {
              ctx.logger.error('POST_SUBMIT 失败', error.message)
            })
            if (typeof context.waitUntil === 'function') context.waitUntil(job)
            // 沿用原 Makers 后置执行语义；不把通知失败变成评论提交失败。
            return Promise.resolve()
          }
        }
      }))
      const result = await handler(request)
      const headers = { ...result.headers, 'Content-Type': 'application/json;charset=UTF-8', Vary: 'Origin' }
      return new Response(result.status === 204 ? null : JSON.stringify(result.body), { status: result.status, headers })
    })
  }
}
