import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryBlob } from './helpers/memory-blob.js'

const { createHandler } = await import(process.env.TWIKOO_TEST_BUNDLE === '1'
  ? '../dist/twikoo.js'
  : '../src/handler.js')

const AKISMET_KEY = 'private-akismet-test-key'
const LLM_KEY = 'private-llm-test-key'
const COMMENT = '<p>A private moderation test comment</p>'

function fixture (config = {}) {
  const store = createMemoryBlob({
    'config:main': {
      SITE_URL: 'https://blog.example.test',
      BLOGGER_EMAIL: 'blogger@example.test',
      LIMIT_PER_MINUTE: '0',
      LIMIT_PER_MINUTE_ALL: '0',
      SHOW_REGION: 'false',
      SHOW_UA: 'false',
      ...config
    },
    'comments:all': []
  })
  const handler = createHandler({ store })
  return async function submit () {
    const jobs = []
    const response = await handler({
      env: {},
      waitUntil: job => jobs.push(job),
      request: new Request('https://api.example.test/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://blog.example.test', 'eo-connecting-ip': '203.0.113.1' },
        body: JSON.stringify({
          event: 'COMMENT_SUBMIT',
          accessToken: 'test-reader',
          url: '/article/',
          href: 'https://blog.example.test/article/',
          ua: 'Mozilla/5.0',
          nick: 'Test reader',
          mail: 'reader@example.test',
          comment: COMMENT
        })
      })
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.code, 0, JSON.stringify(result))
    assert.equal(jobs.length, 1, 'The platform must receive the real post-submit promise')
    await Promise.all(jobs)
    const comments = await store.get('comments:all', { type: 'json' })
    assert.equal(comments.length, 1)
    assert.equal(comments[0]._id, result.id)
    return comments[0]
  }
}

function captureLogs (t) {
  const lines = []
  for (const level of ['log', 'info', 'warn', 'error']) {
    t.mock.method(console, level, (...args) => lines.push(args.map(value => value?.message || String(value)).join(' ')))
  }
  return lines
}

function assertNoCredentials (logs) {
  const text = logs.join('\n')
  assert.ok(!text.includes(AKISMET_KEY), 'Akismet key must not be logged')
  assert.ok(!text.includes(LLM_KEY), 'LLM key must not be logged')
}

test('official post-submit service uses the native Akismet transport and persists a spam decision', async t => {
  const logs = captureLogs(t)
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push(url)
    assert.equal(new URL(url).origin, 'https://rest.akismet.com')
    const body = new URLSearchParams(init.body)
    assert.equal(body.get('api_key'), AKISMET_KEY)
    assert.equal(body.get('blog'), 'https://blog.example.test')
    if (url.endsWith('/verify-key')) return new Response('valid')
    assert.equal(body.get('user_ip'), '203.0.113.1')
    assert.equal(body.get('comment_author_email'), 'reader@example.test')
    assert.equal(body.get('comment_content'), COMMENT)
    return new Response('true')
  })
  const comment = await fixture({ AKISMET_KEY })()
  assert.equal(comment.isSpam, true)
  assert.deepEqual(requests, ['https://rest.akismet.com/1.1/verify-key', 'https://rest.akismet.com/1.1/comment-check'])
  assertNoCredentials(logs)
})

test('unconfigured moderation makes no remote request', async t => {
  const logs = captureLogs(t)
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request') })
  const comment = await fixture()()
  assert.equal(comment.isSpam, false)
  assert.equal(fetch.mock.callCount(), 0)
  assertNoCredentials(logs)
})

for (const mode of ['invalid-key', 'http-error']) {
  test(`Akismet ${mode} keeps the submitted comment and does not log the key`, async t => {
    const logs = captureLogs(t)
    const fetch = t.mock.method(globalThis, 'fetch', async url => {
      assert.equal(url, 'https://rest.akismet.com/1.1/verify-key')
      return new Response(mode === 'invalid-key' ? 'invalid' : `server echoed ${AKISMET_KEY}`, { status: mode === 'invalid-key' ? 200 : 503 })
    })
    const comment = await fixture({ AKISMET_KEY })()
    assert.equal(comment.isSpam, false)
    assert.equal(fetch.mock.callCount(), 1)
    assert.ok(logs.some(line => line.includes('垃圾评论检测异常')))
    assertNoCredentials(logs)
  })
}

const llmConfig = {
  LLM_API_KEY: LLM_KEY,
  LLM_API_ENDPOINT: 'https://llm.example.test/v1/',
  LLM_MODEL: 'test-moderation-model',
  LLM_MAX_RETRIES: '1'
}

function completion (text) {
  return Response.json({
    id: 'test-completion', object: 'chat.completion', created: 0, model: llmConfig.LLM_MODEL,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  })
}

for (const spam of [true, false]) {
  test(`official LLM service and real SDK persist spam=${spam}`, async t => {
    const logs = captureLogs(t)
    const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(String(url), 'https://llm.example.test/v1/chat/completions')
      assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${LLM_KEY}`)
      const body = JSON.parse(init.body)
      assert.equal(body.model, llmConfig.LLM_MODEL)
      assert.deepEqual(body.response_format, { type: 'json_object' })
      assert.ok(body.messages.some(message => message.content.includes(COMMENT)))
      return completion(JSON.stringify({ spam }))
    })
    const comment = await fixture(llmConfig)()
    assert.equal(fetch.mock.callCount(), 1)
    assert.equal(comment.isSpam, spam)
    assertNoCredentials(logs)
  })
}

for (const mode of ['http-error', 'invalid-decision']) {
  test(`LLM ${mode} follows upstream fail-open behavior without logging credentials`, async t => {
    const logs = captureLogs(t)
    const fetch = t.mock.method(globalThis, 'fetch', async () => mode === 'http-error'
      ? Response.json({ error: { message: 'Temporarily unavailable' } }, { status: 503 })
      : completion('{"spam":"not-a-boolean"}'))
    const comment = await fixture(llmConfig)()
    assert.equal(comment.isSpam, false)
    assert.equal(fetch.mock.callCount(), 1)
    assert.ok(logs.some(line => line.includes('放行兜底')))
    assertNoCredentials(logs)
  })
}
