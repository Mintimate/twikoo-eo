/**
 * Minimal native-fetch transport for @twikoojs/common's Akismet integration.
 * The akismet-api SDK uses superagent/Node HTTP; Makers requires fetch instead.
 * Protocol references:
 * https://akismet.com/developers/detailed-docs/key-verification/
 * https://akismet.com/developers/detailed-docs/comment-check/
 */
const API_ROOT = 'https://rest.akismet.com/1.1/'
const REQUEST_TIMEOUT_MS = 10000
const COMMENT_FIELDS = [
  'user_ip', 'user_agent', 'referrer', 'permalink', 'comment_type',
  'comment_author', 'comment_author_email', 'comment_author_url', 'comment_content'
]

export class AkismetClient {
  #key
  #blog

  constructor ({ key, blog } = {}) {
    if (typeof key !== 'string' || !key.trim()) throw new Error('Akismet 需要配置 AKISMET_KEY。')
    try {
      if (!/^https?:$/.test(new URL(blog).protocol)) throw new Error()
    } catch {
      throw new Error('Akismet 需要将 SITE_URL 配置为完整的 HTTP(S) 网址。')
    }
    this.#key = key
    this.#blog = blog
  }

  async #request (method, fields = {}) {
    const body = new URLSearchParams({ ...fields, api_key: this.#key, blog: this.#blog })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      let response
      try {
        response = await fetch(`${API_ROOT}${method}`, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
            'User-Agent': 'Twikoo-EdgeOne-Makers/Akismet'
          },
          body,
          signal: controller.signal
        })
      } catch {
        // Fetch errors may contain request data; report only a fixed message.
        throw new Error(`Akismet ${method} ${controller.signal.aborted ? '请求超时' : '请求失败'}。`)
      }
      if (!response.ok) throw new Error(`Akismet ${method} 请求失败：HTTP ${response.status}`)
      try {
        return (await response.text()).trim()
      } catch {
        throw new Error(`Akismet ${method} ${controller.signal.aborted ? '请求超时' : '读取响应失败'}。`)
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  async verifyKey () {
    const result = await this.#request('verify-key')
    if (result === 'valid') return true
    // common 2.0.13 logs the API key when verifyKey returns false. Throw instead
    // so its existing error handler reports a safe message without the secret.
    if (result === 'invalid') throw new Error('Akismet API key 或站点配置无效。')
    throw new Error('Akismet verify-key 返回了无效响应。')
  }

  async checkSpam (comment = {}) {
    const fields = {}
    for (const field of COMMENT_FIELDS) {
      if (comment[field] !== undefined && comment[field] !== null) fields[field] = String(comment[field])
    }
    const result = await this.#request('comment-check', fields)
    if (result === 'true') return true
    if (result === 'false') return false
    throw new Error('Akismet comment-check 返回了无效响应。')
  }
}
