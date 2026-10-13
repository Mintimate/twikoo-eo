import assert from 'node:assert/strict'
import test from 'node:test'
import { AkismetClient } from '../src/akismet.js'

const key = 'private-key&=测试'
const blog = 'https://blog.example.com/'
const comment = {
  user_ip: '203.0.113.1',
  user_agent: 'A browser',
  permalink: 'https://blog.example.com/article',
  comment_type: 'reply',
  comment_author: '测试 & name',
  comment_author_email: 'reader@example.com',
  comment_author_url: 'https://reader.example.com',
  comment_content: '<p>Private comment & emoji 🎈</p>'
}

test('Akismet uses fixed HTTPS endpoints and URL-encoded body credentials', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(new URL(url).origin, 'https://rest.akismet.com')
    assert.equal(new URL(url).search, '')
    assert.ok(!url.includes(key))
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'error')
    assert.match(init.headers['Content-Type'], /^application\/x-www-form-urlencoded/)
    assert.ok(init.signal instanceof AbortSignal)
    assert.ok(init.body instanceof URLSearchParams)
    const fields = Object.fromEntries(new URLSearchParams(init.body.toString()))
    calls.push({ url, fields })
    return new Response(url.endsWith('verify-key') ? 'valid' : 'true')
  })
  const client = new AkismetClient({ key, blog })
  assert.equal(await client.verifyKey(), true)
  assert.equal(await client.checkSpam({ ...comment, api_key: 'attacker', blog: 'https://evil.example.com', unknown: undefined }), true)
  assert.deepEqual(calls, [
    { url: 'https://rest.akismet.com/1.1/verify-key', fields: { api_key: key, blog } },
    { url: 'https://rest.akismet.com/1.1/comment-check', fields: { ...comment, api_key: key, blog } }
  ])
  assert.equal(JSON.stringify(client), '{}')
})

test('Akismet spam and ham responses remain distinct; omitted fields are not sent as undefined', async t => {
  let result = 'true'
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.body.has('comment_author_url'), false)
    assert.equal(init.body.get('comment_content'), '')
    return new Response(result)
  })
  const client = new AkismetClient({ key, blog })
  assert.equal(await client.checkSpam({ user_ip: '203.0.113.1', comment_author_url: undefined, comment_content: '' }), true)
  result = 'false\n'
  assert.equal(await client.checkSpam({ comment_content: '' }), false)
})

test('invalid keys throw safely so common cannot enter its key-logging false branch', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('invalid', { headers: { 'X-akismet-debug-help': encodeURIComponent(`${key} ${comment.comment_content}`) } }))
  await assert.rejects(new AkismetClient({ key, blog }).verifyKey(), error => {
    assert.match(error.message, /API key 或站点配置无效/)
    assert.ok(!error.message.includes(key))
    assert.ok(!error.message.includes(comment.comment_content))
    return true
  })
})

for (const method of ['verifyKey', 'checkSpam']) {
  test(`${method} rejects HTTP, unexpected-response and network errors without exposing payloads`, async t => {
    let failure = 'http'
    t.mock.method(globalThis, 'fetch', async () => {
      if (failure === 'network') throw new Error(`leaked ${key} ${comment.comment_content}`)
      return new Response(`${key} ${comment.comment_content}`, { status: failure === 'http' ? 503 : 200 })
    })
    const client = new AkismetClient({ key, blog })
    for (failure of ['http', 'response', 'network']) {
      await assert.rejects(client[method](comment), error => {
        if (failure === 'http') assert.match(error.message, /HTTP 503/)
        if (failure === 'response') assert.match(error.message, /无效响应/)
        if (failure === 'network') assert.match(error.message, /请求失败/)
        assert.ok(!error.message.includes(key))
        assert.ok(!error.message.includes(comment.comment_content))
        assert.equal(error.cause, undefined)
        return true
      })
    }
  })
}

test('Akismet aborts timed-out requests and clears its timer', async t => {
  let onTimeout
  const timer = {}
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    assert.equal(delay, 10000)
    onTimeout = callback
    return timer
  })
  const clearTimeout = t.mock.method(globalThis, 'clearTimeout', value => assert.equal(value, timer))
  t.mock.method(globalThis, 'fetch', async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    onTimeout()
  }))
  await assert.rejects(new AkismetClient({ key, blog }).verifyKey(), /请求超时/)
  assert.equal(clearTimeout.mock.callCount(), 1)
})

test('Akismet validates configuration without disclosing it', () => {
  assert.throws(() => new AkismetClient({ blog }), /AKISMET_KEY/)
  assert.throws(() => new AkismetClient({ key, blog: 'not-a-url' }), /SITE_URL/)
  assert.throws(() => new AkismetClient({ key, blog: 'ftp://blog.example.com' }), /SITE_URL/)
})
