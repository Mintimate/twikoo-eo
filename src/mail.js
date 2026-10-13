/*!
 * EdgeOne Makers mail adapter.
 * Adapted from Twikoo 2.0.13 packages/server-edgeone-makers/src/mail (MIT),
 * copyright (c) 2020-present iMaeGoo, and this repository's 1.x SMTP bridge.
 * Enhancements: explicit request environment, trusted-origin discovery, no redirects.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const mailBridgeStorage = new AsyncLocalStorage()
const PROBE_TIMEOUT_MS = 5000
const UNSUPPORTED_MESSAGE = 'EdgeOne Makers 仅支持 SendGrid、MailChannels，或通过 SMTP_HOST 使用 Go SMTP Bridge。'

export function withMailBridgeContext (context, fn) {
  return mailBridgeStorage.run(context, fn)
}

function firstHeader (request, name) {
  const entry = Object.entries(request.headers || {}).find(([key]) => key.toLowerCase() === name)
  return entry?.[1] ? String(entry[1]).split(',')[0].trim() : ''
}

function normalizeBridgeUrl (value, protocol = 'https') {
  if (typeof value !== 'string') return ''
  const raw = value.trim()
  if (!raw) return ''
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `${protocol}://${raw}`)
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return ''
    url.pathname = '/smtp'
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

function bridgeHostOf (url) {
  return new URL(url).host.toLowerCase().replace(/\.$/, '')
}

function formatForError (value) {
  const url = new URL(value)
  url.search = ''
  url.hash = ''
  return url.toString()
}

/**
 * The adapter must provide url from the actual incoming Request URL.
 * envId and Origin are only hints on that same origin: the Go probe signs a
 * caller-supplied host, so HMAC alone cannot authenticate an arbitrary URL when
 * an attacker can relay the probe to our public /smtp endpoint.
 * An explicit TWIKOO_SMTP_BRIDGE_URL allows deployments whose incoming URL is
 * internal to reach a trusted public bridge; it is never read from request.body.
 * runtimeEnv is the server-provided context.env and takes precedence over any
 * request wrapper environment. No environment is read from request.body.
 */
export function createMailBridgeContext (request, runtimeEnv = {}) {
  const env = { ...(request.env || {}), ...runtimeEnv }
  const token = env.TWIKOO_SMTP_BRIDGE_TOKEN || ''
  const hostUrl = normalizeBridgeUrl(request.url)
  const urls = []
  if (env.TWIKOO_SMTP_BRIDGE_URL) {
    const configuredUrl = normalizeBridgeUrl(env.TWIKOO_SMTP_BRIDGE_URL)
    if (!configuredUrl) throw new Error('TWIKOO_SMTP_BRIDGE_URL 必须是可信 SMTP Bridge 的 HTTP(S) 地址。')
    urls.push(configuredUrl)
  }
  if (hostUrl) {
    const trustedOrigin = new URL(hostUrl).origin
    for (const value of [request.body?.envId, firstHeader(request, 'origin'), hostUrl]) {
      const url = normalizeBridgeUrl(value, new URL(hostUrl).protocol.slice(0, -1))
      if (url && new URL(url).origin === trustedOrigin && !urls.includes(url)) urls.push(url)
    }
  }
  return { urls, token }
}

async function verifyBridgeUrl (url, token) {
  const host = bridgeHostOf(url)
  const nonce = randomBytes(16).toString('hex')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    // Neither the shared token nor SMTP credentials are sent during discovery.
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'probe', nonce, bridgeHost: host }),
      signal: controller.signal
    })
    if (!response.ok) return false
    const result = await response.json()
    if (result?.ok !== true || result.bridgeHost !== host || !/^[a-f\d]{64}$/i.test(result.signature || '')) return false
    const expected = createHmac('sha256', token).update(`${nonce}\n${host}`).digest()
    return timingSafeEqual(Buffer.from(result.signature, 'hex'), expected)
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function getBridgeUrl (context) {
  if (context.url) return context.url
  for (const url of context.urls) {
    if (await verifyBridgeUrl(url, context.token)) {
      context.url = url
      return url
    }
  }
  const candidates = context.urls.length ? context.urls.map(formatForError).join(', ') : '无'
  throw new Error(`EdgeOne Makers SMTP Bridge 自动发现失败，未找到可校验的 /smtp 地址。候选地址：${candidates}。如请求 URL 是平台内部地址，请设置 TWIKOO_SMTP_BRIDGE_URL 为本项目可信的公开地址。`)
}

async function requestSmtpBridge (action, mailConfig, mail = {}) {
  const context = mailBridgeStorage.getStore()
  if (!context?.token) throw new Error('使用自定义 SMTP 需要配置 TWIKOO_SMTP_BRIDGE_TOKEN 环境变量。')
  const bridgeUrl = await getBridgeUrl(context)
  const response = await fetch(bridgeUrl, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${context.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action,
      host: mailConfig.host,
      port: mailConfig.port,
      secure: mailConfig.secure,
      user: mailConfig.auth.user,
      pass: mailConfig.auth.pass,
      from: mail.from,
      to: mail.to,
      subject: mail.subject,
      html: mail.html
    })
  })
  let result
  try {
    result = await response.json()
  } catch {
    throw new Error(`SMTP Bridge 返回异常：HTTP ${response.status}`)
  }
  if (!response.ok || result?.ok !== true) {
    throw new Error(result?.message || `SMTP Bridge 请求失败：${formatForError(bridgeUrl)} HTTP ${response.status}`)
  }
  return result
}

function validateMailAuth (mailConfig) {
  if (!mailConfig.auth?.user) throw new Error('需要在 SMTP_USER 中配置账户名，如果邮件服务不需要可随意填写。')
  if (!mailConfig.auth?.pass) throw new Error('需要在 SMTP_PASS 中配置密码或 API 令牌。')
}

/** common sends nodemailer-style `"Display name" <address>` values. */
function httpMailbox (value) {
  const raw = String(value || '').trim()
  const mailbox = /^(.*)\s*<([^<>\r\n]+)>$/.exec(raw)
  if (!mailbox) return { email: raw }
  let name = mailbox[1].trim()
  if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(["\\])/g, '$1')
  return { email: mailbox[2].trim(), ...(name ? { name } : {}) }
}

async function sendViaHttpApi (service, mailConfig, mail) {
  const isSendGrid = service === 'sendgrid'
  const displayName = isSendGrid ? 'SendGrid' : 'MailChannels'
  const endpoint = isSendGrid ? 'https://api.sendgrid.com/v3/mail/send' : 'https://api.mailchannels.net/tx/v1/send'
  const headers = { 'Content-Type': 'application/json' }
  if (isSendGrid) headers.Authorization = `Bearer ${mailConfig.auth.pass}`
  else {
    headers['X-Api-Key'] = mailConfig.auth.pass
    headers.Accept = 'application/json'
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers,
    body: JSON.stringify({
      personalizations: [{ to: [httpMailbox(mail.to)] }],
      from: httpMailbox(mail.from),
      subject: mail.subject,
      content: [{ type: 'text/html', value: mail.html }]
    })
  })
  if (!response.ok) throw new Error(`${displayName} 发送失败：HTTP ${response.status}`)
  return { ok: true, status: response.status }
}

/** nodemailer-compatible transport injected into @twikoojs/common. */
export function createEoNodemailer () {
  return {
    createTransport (options = {}) {
      const mailConfig = options || {}
      const service = String(mailConfig.service || '').toLowerCase()
      const isHttpService = service === 'sendgrid' || service === 'mailchannels'
      return {
        async verify () {
          validateMailAuth(mailConfig)
          // SMTP_HOST takes precedence for both verify and send.
          if (mailConfig.host) {
            await requestSmtpBridge('verify', mailConfig)
            return true
          }
          if (isHttpService) return true
          throw new Error(UNSUPPORTED_MESSAGE)
        },
        async sendMail (mail = {}) {
          validateMailAuth(mailConfig)
          if (mailConfig.host) return requestSmtpBridge('send', mailConfig, mail)
          if (isHttpService) return sendViaHttpApi(service, mailConfig, mail)
          throw new Error(UNSUPPORTED_MESSAGE)
        }
      }
    }
  }
}
