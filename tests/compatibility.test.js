import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { createMemoryBlob } from './helpers/memory-blob.js'

// 同一组兼容契约同时校验源码与部署 bundle，避免打包替换改变运行行为。
const { createHandler } = await import(process.env.TWIKOO_TEST_BUNDLE === '1'
  ? '../dist/twikoo.js'
  : '../src/handler.js')

const PAGE = '/legacy/article/'
const ADMIN_TOKEN = 'legacy-admin-browser-token'
const OWNER_TOKEN = 'legacy-visitor-browser-token'
const OTHER_TOKEN = 'another-visitor-browser-token'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'
const OLD_TIME = 1700000000000

/** 复现 1.7.24 已落库记录的字段和键名，不执行数据迁移。 */
function legacySeed (config = {}) {
  return {
    'config:main': {
      ADMIN_PASS: createHash('md5').update(ADMIN_TOKEN).digest('hex'),
      SITE_NAME: 'Legacy blog',
      SITE_URL: 'https://blog.example.test',
      BLOGGER_EMAIL: 'blogger@example.test',
      CORS_ALLOW_ORIGIN: 'https://blog.example.test/',
      SHOW_UA: 'false',
      SHOW_REGION: 'false',
      LIMIT_PER_MINUTE: '0',
      LIMIT_PER_MINUTE_ALL: '0',
      COMMENT_PAGE_SIZE: '8',
      ...config
    },
    'comments:all': [
      legacyComment('legacy-root', { comment: '<p>Existing article comment</p>' }),
      legacyComment('legacy-reply', {
        uid: OTHER_TOKEN,
        nick: 'Reply author',
        comment: '<p>Existing reply</p>',
        rid: 'legacy-root',
        pid: 'legacy-root',
        created: OLD_TIME + 1
      }),
      legacyComment('legacy-spam', {
        comment: '<p>Moderation search needle</p>',
        isSpam: true,
        created: OLD_TIME + 2
      }),
      legacyComment('legacy-spam-reply', {
        comment: '<p>Private reply needle</p>',
        rid: 'legacy-root',
        pid: 'legacy-root',
        isSpam: true,
        created: OLD_TIME + 3
      })
    ],
    [`counter:${encodeURIComponent(PAGE)}`]: {
      url: PAGE,
      title: 'Legacy article',
      time: 42,
      created: OLD_TIME,
      updated: OLD_TIME
    }
  }
}

/** 构造旧版评论文档，包括旧版同时写入的 id / _id。 */
function legacyComment (id, fields = {}) {
  return {
    _id: id,
    id,
    uid: OWNER_TOKEN,
    nick: 'Legacy author',
    mail: 'reader@example.test',
    mailMd5: 'legacy-avatar-hash',
    link: 'https://reader.example.test',
    ua: UA,
    ip: '203.0.113.10',
    master: false,
    url: PAGE,
    href: `https://blog.example.test${PAGE}`,
    comment: '<p>Legacy comment</p>',
    isSpam: false,
    created: OLD_TIME,
    updated: OLD_TIME,
    ...fields
  }
}

/** 通过实际 HTTP 入口调用官方业务，禁止测试直接调用内部 handler。 */
function fixture (config = {}, handlerOptions = {}) {
  const store = createMemoryBlob(legacySeed(config))
  const handler = createHandler({ store, ...handlerOptions })
  async function request (body, options = {}) {
    const method = options.method || 'POST'
    const backgroundJobs = []
    const response = await handler({
      env: options.env || {},
      clientIp: options.clientIp,
      waitUntil: job => backgroundJobs.push(job),
      request: new Request('https://api.example.test/', {
        method,
        headers: {
          'Content-Type': 'application/json',
          Origin: options.origin || 'https://blog.example.test',
          'eo-connecting-ip': '203.0.113.50',
          ...options.headers
        },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
      })
    })
    // 测试等待平台托管的后置任务，确保异步通知也在网络 mock 生命周期内。
    await Promise.all(backgroundJobs)
    return response
  }
  async function call (event, fields = {}, accessToken = OWNER_TOKEN) {
    const response = await request({ event, accessToken, ...fields })
    assert.equal(response.status, 200)
    return response.json()
  }
  return { store, request, call }
}

/** 成功事件有些返回 code=0，有些沿用旧版省略 code 的响应。 */
function assertSuccess (result) {
  assert.ok(result.code === undefined || result.code === 0, JSON.stringify(result))
  assert.equal(result.message, undefined)
}

/** 提交载荷默认使用非 QQ 地址，避免引入头像服务请求。 */
function submission (fields = {}) {
  return {
    url: PAGE,
    href: `https://blog.example.test${PAGE}`,
    nick: 'New reader',
    mail: 'new-reader@example.test',
    ua: UA,
    comment: '<p>New comment</p>',
    ...fields
  }
}

describe(`1.7.24 Blob compatibility (${process.env.TWIKOO_TEST_BUNDLE === '1' ? 'bundle' : 'source'})`, { concurrency: false }, () => {
  let unexpectedNetwork
  beforeEach(() => {
    unexpectedNetwork = []
    mock.method(globalThis, 'fetch', async (input) => {
      unexpectedNetwork.push(String(input?.url || input))
      throw new Error('Network is disabled in compatibility tests')
    })
  })
  afterEach(() => {
    mock.restoreAll()
    assert.deepEqual(unexpectedNetwork, [], 'Compatibility tests must not contact remote services')
  })

  it('serves health checks before a Blob store is initialized', async () => {
    // 不传 store：若健康检查错误地进入存储路径，会尝试初始化真实 SDK。
    const handler = createHandler()
    for (const method of ['GET', 'HEAD']) {
      const response = await handler({ request: new Request('https://api.example.test/', { method }), env: {} })
      assert.equal(response.status, 200)
      if (method === 'HEAD') {
        assert.equal(await response.text(), '')
      } else {
        const result = await response.json()
        assert.equal(result.code, 0)
        assert.match(result.version, /^2\./)
      }
    }
  })

  it('rejects malformed JSON with HTTP 400 before accessing storage', async () => {
    let accesses = 0
    const store = new Proxy({}, { get () { accesses++; throw new Error('Unexpected storage access') } })
    const handler = createHandler({ store })
    for (const body of ['{broken', 'null', '[]']) {
      const response = await handler({
        env: {},
        request: new Request('https://api.example.test/', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body
        })
      })
      assert.equal(response.status, 400)
      assert.equal((await response.json()).code, 1000)
    }
    assert.equal(accesses, 0)
  })

  it('rejects external POST_SUBMIT calls without an internal dispatch token', async () => {
    const { call, store } = fixture()
    const before = await store.get('comments:all', { type: 'json' })
    const result = await call('POST_SUBMIT', { comment: legacyComment('injected-notification') }, ADMIN_TOKEN)
    assert.equal(result.code, 1403)
    assert.deepEqual(await store.get('comments:all', { type: 'json' }), before)
  })

  it('preserves old administrator credentials and merges configuration in config:main', async () => {
    const { call, store } = fixture()
    const before = await store.get('config:main', { type: 'json' })
    const login = await call('LOGIN', { password: ADMIN_TOKEN }, ADMIN_TOKEN)
    assertSuccess(login)
    assert.notEqual((await call('LOGIN', { password: 'wrong-password' })).code, 0)
    assert.notEqual((await call('GET_CONFIG_FOR_ADMIN')).code, 0)

    const publicConfig = await call('GET_CONFIG')
    assertSuccess(publicConfig)
    assert.equal(publicConfig.config.IS_ADMIN, false)
    assert.equal(publicConfig.config.ADMIN_PASS, undefined)
    const adminConfig = await call('GET_CONFIG_FOR_ADMIN', {}, ADMIN_TOKEN)
    assertSuccess(adminConfig)
    assert.equal(adminConfig.config.SITE_NAME, 'Legacy blog')
    assert.match(adminConfig.config.VERSION, /^2\./)
    assertSuccess(await call('SET_CONFIG', { config: { SITE_NAME: 'Enhanced blog' } }, ADMIN_TOKEN))
    assert.deepEqual(await store.get('config:main', { type: 'json' }), { ...before, SITE_NAME: 'Enhanced blog' })
  })

  it('keeps old visitor ownership, reply threads and private fields out of public DTOs', async () => {
    const { call } = fixture()
    const result = await call('COMMENT_GET', { url: PAGE })
    assertSuccess(result)
    assert.equal(result.accessToken, undefined)
    assert.equal(result.count, 2)
    const root = result.data.find(comment => comment.id === 'legacy-root')
    assert.equal(root.isOwner, true)
    assert.equal(root.comment, '<p>Existing article comment</p>')
    assert.deepEqual(root.replies.map(reply => reply.id), ['legacy-reply', 'legacy-spam-reply'])
    assert.equal(root.replies[0].isOwner, false)
    for (const item of [root, ...root.replies]) {
      for (const field of ['mail', 'uid', 'ip']) assert.equal(item[field], undefined)
    }
    // null 明确模拟首次匿名请求，不复用已有访客 token。
    const firstVisit = await call('GET_CONFIG', {}, null)
    assertSuccess(firstVisit)
    assert.match(firstVisit.accessToken, /^[a-f0-9]{32}$/)
  })

  it('HIDE_SPAM also hides the author’s pending roots and replies from lists and search', async () => {
    const { call } = fixture({ HIDE_SPAM: 'true' })
    for (const token of [OWNER_TOKEN, OTHER_TOKEN, ADMIN_TOKEN]) {
      const result = await call('COMMENT_GET', { url: PAGE }, token)
      assertSuccess(result)
      assert.equal(result.count, 1)
      assert.deepEqual(result.data.map(comment => comment.id), ['legacy-root'])
      assert.deepEqual(result.data[0].replies.map(reply => reply.id), ['legacy-reply'])
      const search = await call('COMMENT_GET', { url: PAGE, keyword: 'needle' }, token)
      assertSuccess(search)
      assert.equal(search.count, 0)
      assert.deepEqual(search.data, [])
    }
  })

  it('submits sanitized comments and replies into the existing comments:all document', async () => {
    const { call, store } = fixture()
    const created = await call('COMMENT_SUBMIT', submission({
      comment: '<p>Hello <strong>world</strong><img src="x" onerror="alert(1)"></p><script>alert(2)</script>'
    }))
    assertSuccess(created)
    assert.match(created.id, /^[a-f0-9]{32}$/)
    const reply = await call('COMMENT_SUBMIT', submission({
      comment: '<p>New reply</p>', rid: created.id, pid: created.id
    }), OTHER_TOKEN)
    assertSuccess(reply)
    const comments = await store.get('comments:all', { type: 'json' })
    assert.equal(comments.length, 6)
    const saved = comments.find(comment => comment._id === created.id)
    assert.equal(saved.uid, OWNER_TOKEN)
    assert.equal(saved.ip, '203.0.113.50')
    assert.match(saved.comment, /<strong>world<\/strong>/)
    assert.doesNotMatch(saved.comment, /<script\b|\sonerror\s*=/i)
    const listed = await call('COMMENT_GET', { url: PAGE })
    const thread = listed.data.find(comment => comment.id === created.id)
    assert.deepEqual(thread.replies.map(comment => comment.id), [reply.id])
    assert.equal(thread.replies[0].pid, created.id)
  })

  it('prefers the platform client IP and resolves its region from the bundled IPv4 database', async () => {
    const { request, call, store } = fixture({ SHOW_REGION: 'true' })
    const response = await request({
      event: 'COMMENT_SUBMIT', accessToken: OWNER_TOKEN, ...submission()
    }, {
      clientIp: '8.8.8.8',
      headers: {
        'eo-connecting-ip': '1.1.1.1',
        'x-forwarded-for': '203.0.113.20, 203.0.113.21',
        'x-real-ip': '203.0.113.22'
      }
    })
    const result = await response.json()
    assertSuccess(result)
    const saved = (await store.get('comments:all', { type: 'json' })).find(comment => comment._id === result.id)
    assert.equal(saved.ip, '8.8.8.8')
    const listed = await call('COMMENT_GET', { url: PAGE })
    assertSuccess(listed)
    const dto = listed.data.find(comment => comment.id === result.id)
    assert.equal(typeof dto.ipRegion, 'string')
    assert.ok(dto.ipRegion.trim().length > 0, 'The bundled IP database should resolve a public IPv4 address')
  })

  it('preserves vote exclusivity and only lets the legacy owner delete their comment', async () => {
    const { call, store } = fixture()
    assertSuccess(await call('COMMENT_LIKE', { id: 'legacy-root', type: 'up' }))
    assertSuccess(await call('COMMENT_LIKE', { id: 'legacy-root', type: 'down' }))
    let root = (await store.get('comments:all', { type: 'json' })).find(comment => comment._id === 'legacy-root')
    assert.deepEqual(root.ups, [])
    assert.deepEqual(root.downs, [OWNER_TOKEN])
    assertSuccess(await call('COMMENT_LIKE', { id: 'legacy-root', type: 'down' }))
    root = (await store.get('comments:all', { type: 'json' })).find(comment => comment._id === 'legacy-root')
    assert.deepEqual(root.downs, [])

    const denied = await call('COMMENT_DELETE_FOR_USER', { id: 'legacy-root' }, OTHER_TOKEN)
    assert.notEqual(denied.code, 0)
    assert.equal((await store.get('comments:all', { type: 'json' })).length, 4)
    assertSuccess(await call('COMMENT_DELETE_FOR_USER', { id: 'legacy-root' }))
    assert.equal((await store.get('comments:all', { type: 'json' })).some(comment => comment._id === 'legacy-root'), false)
  })

  it('exports legacy documents and reimports an old Twikoo backup without duplicating existing IDs', async () => {
    const { call, store } = fixture()
    assert.notEqual((await call('COMMENT_EXPORT_FOR_ADMIN')).code, 0)
    const exported = await call('COMMENT_EXPORT_FOR_ADMIN', {}, ADMIN_TOKEN)
    assertSuccess(exported)
    assert.deepEqual(exported.data, legacySeed()['comments:all'])
    const extra = legacyComment('backup-new-comment', { comment: 'Imported backup' })
    const imported = await call('COMMENT_IMPORT_FOR_ADMIN', {
      source: 'twikoo', file: JSON.stringify([...exported.data, extra])
    }, ADMIN_TOKEN)
    assertSuccess(imported)
    const comments = await store.get('comments:all', { type: 'json' })
    assert.equal(comments.length, 5)
    assert.equal(comments.filter(comment => comment._id === 'legacy-root').length, 1)
    assert.equal(comments.find(comment => comment._id === extra._id).comment, extra.comment)
  })

  it('continues legacy counters and returns only visible comments in recent/count APIs', async () => {
    const { call, store } = fixture()
    const first = await call('COUNTER_GET', { url: PAGE, title: 'Current title' })
    assertSuccess(first)
    assert.equal(first.time, 42)
    assert.equal(first.updated, 1)
    const stored = await store.get(`counter:${encodeURIComponent(PAGE)}`, { type: 'json' })
    assert.equal(stored.time, 43)
    assert.equal(stored.created, OLD_TIME)
    assert.equal(stored.title, 'Current title')
    assert.equal((await call('COUNTER_GET', { url: PAGE })).time, 43)

    const count = await call('GET_COMMENTS_COUNT', { urls: [PAGE], includeReply: true })
    assertSuccess(count)
    assert.deepEqual(count.data, [{ url: PAGE, count: 2 }])
    const recent = await call('GET_RECENT_COMMENTS', { urls: [PAGE], includeReply: true, pageSize: 10 })
    assertSuccess(recent)
    assert.deepEqual(recent.data.map(comment => comment.id), ['legacy-reply', 'legacy-root'])
    assert.equal(recent.data[1].commentText, 'Existing article comment')
  })

  it('applies the configured CORS origin to both ordinary responses and preflight', async () => {
    const { request } = fixture()
    for (const method of ['POST', 'OPTIONS']) {
      const allowed = await request({ event: 'GET_CONFIG' }, { method })
      assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://blog.example.test')
      assert.equal(allowed.status, method === 'OPTIONS' ? 204 : 200)
      if (method === 'OPTIONS') assert.equal(await allowed.text(), '')
      const denied = await request({ event: 'GET_CONFIG' }, { method, origin: 'https://untrusted.example.test' })
      assert.ok(!denied.headers.get('Access-Control-Allow-Origin'))
      const local = await request({ event: 'GET_CONFIG' }, { method, origin: 'http://localhost:5173' })
      assert.equal(local.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173')
    }
  })

  it('accepts deployment CORS overrides without rewriting stored configuration', async () => {
    const { request, store } = fixture({}, { env: { CORS_ALLOW_ORIGIN: 'deploy.example.test' } })
    const before = await store.get('config:main', { type: 'json' })
    const deployment = await request({ event: 'GET_CONFIG' }, { origin: 'https://deploy.example.test' })
    assert.equal(deployment.headers.get('Access-Control-Allow-Origin'), 'https://deploy.example.test')
    const context = await request({ event: 'GET_CONFIG' }, {
      origin: 'https://context.example.test',
      env: { CORS_ALLOW_ORIGIN: 'https://context.example.test/' }
    })
    assert.equal(context.headers.get('Access-Control-Allow-Origin'), 'https://context.example.test')
    const oldOrigin = await request({ event: 'GET_CONFIG' })
    assert.ok(!oldOrigin.headers.get('Access-Control-Allow-Origin'))
    assert.deepEqual(await store.get('config:main', { type: 'json' }), before)
  })

  it('rejects query operator objects before reading or mutating comments', async () => {
    const { call, store } = fixture()
    const before = await store.get('comments:all', { type: 'json' })
    for (const fields of [
      { id: { $ne: null } },
      { id: 'legacy-root', accessToken: { $ne: null } },
      { id: 'legacy-root', url: ['unexpected'] },
      { id: 'legacy-root', urls: [PAGE, { $ne: null }] }
    ]) {
      const result = await call('COMMENT_DELETE_FOR_USER', fields)
      assert.equal(result.code, 1000)
      assert.match(result.message, /必须是字符串/)
    }
    assert.deepEqual(await store.get('comments:all', { type: 'json' }), before)
  })

  it('stores Cap challenges in existing keys and rejects missing or invalid proof', async () => {
    const { call, store } = fixture({ CAPTCHA_PROVIDER: 'Cap' })
    const challenge = await call('CAP_CHALLENGE')
    assertSuccess(challenge)
    assert.equal(typeof challenge.token, 'string')
    assert.ok(challenge.expires > Date.now())
    assert.deepEqual(await store.get(`cap:c:${challenge.token}`, { type: 'json' }), {
      challenge: challenge.challenge, expires: challenge.expires
    })
    const missing = await call('CAP_REDEEM')
    assert.equal(missing.success, false)
    const invalid = await call('CAP_REDEEM', { token: challenge.token, solutions: [] })
    assert.equal(invalid.success, false)
    assert.equal(await store.get(`cap:c:${challenge.token}`, { type: 'json' }), null)
    assert.notEqual((await call('COMMENT_SUBMIT', submission())).code, 0)
    assert.equal((await store.get('comments:all', { type: 'json' })).length, 4)
  })

  it('accepts an unexpired 1.x Cap token exactly once after upgrading', async () => {
    const { call, store } = fixture({ CAPTCHA_PROVIDER: 'Cap' })
    const tokenId = 'legacy-cap-id'
    const proof = 'legacy-cap-proof'
    const storageKey = `cap:t:${tokenId}:${createHash('sha256').update(proof).digest('hex')}`
    await store.setJSON(storageKey, { expires: Date.now() + 600000 })
    const fields = submission({ capToken: `${tokenId}:${proof}` })
    assertSuccess(await call('COMMENT_SUBMIT', fields))
    assert.equal(await store.get(storageKey, { type: 'json' }), null)
    assert.notEqual((await call('COMMENT_SUBMIT', fields)).code, 0)
    assert.equal((await store.get('comments:all', { type: 'json' })).length, 5)
  })
})
