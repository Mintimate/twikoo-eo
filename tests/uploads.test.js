import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryBlob } from './helpers/memory-blob.js'

const { createHandler } = await import(process.env.TWIKOO_TEST_BUNDLE === '1'
  ? '../dist/twikoo.js'
  : '../src/handler.js')

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ4sAAAAASUVORK5CYII=', 'base64')
const PHOTO = `data:image/png;base64,${PNG.toString('base64')}`

function fixture (config = {}) {
  const store = createMemoryBlob({
    'config:main': {
      SITE_URL: 'https://blog.example.test', BLOGGER_EMAIL: 'blogger@example.test',
      SHOW_REGION: 'false', SHOW_UA: 'false', LIMIT_PER_MINUTE: '0', LIMIT_PER_MINUTE_ALL: '0',
      ...config
    },
    'comments:all': []
  })
  const handler = createHandler({ store })
  return {
    store,
    async call (event, fields = {}) {
      const jobs = []
      const response = await handler({
        env: {}, waitUntil: job => jobs.push(job),
        request: new Request('https://api.example.test/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'eo-connecting-ip': '203.0.113.7' },
          body: JSON.stringify({ event, accessToken: 'reader-token', ...fields })
        })
      })
      const result = await response.json()
      await Promise.all(jobs)
      return result
    }
  }
}

function silenceLogs (t) {
  for (const name of ['log', 'info', 'warn', 'error']) t.mock.method(console, name, () => {})
}

const imageConfig = {
  IMAGE_CDN: 'lskypro', IMAGE_CDN_URL: 'https://images.example.test', IMAGE_CDN_TOKEN: 'private-upload-token'
}

test('image upload serializes native multipart bytes, MIME and filename through the real HTTP handler', async t => {
  silenceLogs(t)
  const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://images.example.test/api/v1/upload')
    assert.equal(init.headers.Authorization, 'Bearer private-upload-token')
    assert.ok(init.body instanceof FormData)
    assert.equal(new Headers(init.headers).has('Content-Type'), false, 'fetch must generate the multipart boundary')
    // Serialize and decode at the actual Web Request boundary to catch Buffer
    // becoming a string, a missing filename, or an invalid multipart boundary.
    const wireRequest = new Request(url, init)
    assert.match(wireRequest.headers.get('Content-Type'), /^multipart\/form-data; boundary=/)
    const form = await wireRequest.formData()
    assert.deepEqual([...form.keys()], ['file'])
    const file = form.get('file')
    assert.equal(file.type, 'image/png')
    assert.match(file.name, /^[a-f\d]{32}\.png$/)
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG)
    return Response.json({ status: true, data: { links: { url: 'https://images.example.test/result.png' } } })
  })
  const result = await fixture(imageConfig).call('UPLOAD_IMAGE', { photo: PHOTO })
  assert.ok(result.code === undefined || result.code === 0, JSON.stringify(result))
  assert.equal(result.data.url, 'https://images.example.test/result.png')
  assert.equal(fetch.mock.callCount(), 1)
})

test('mismatched image MIME is rejected before any external upload', async t => {
  silenceLogs(t)
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected upload') })
  const result = await fixture(imageConfig).call('UPLOAD_IMAGE', { photo: PHOTO.replace('image/png', 'image/jpeg') })
  assert.equal(result.code, 1040)
  assert.match(result.err, /MIME/)
  assert.equal(fetch.mock.callCount(), 0)
})

test('an HTTP upload failure is surfaced as an upload error', async t => {
  silenceLogs(t)
  t.mock.method(globalThis, 'fetch', async () => new Response('temporary failure', { status: 503 }))
  const result = await fixture(imageConfig).call('UPLOAD_IMAGE', { photo: PHOTO })
  assert.equal(result.code, 1040)
  assert.match(result.err, /503/)
})

for (const success of [true, false]) {
  test(`Turnstile native FormData result success=${success} controls whether the comment is saved`, async t => {
    silenceLogs(t)
    const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
      const form = await new Request(url, init).formData()
      assert.deepEqual(Object.fromEntries(form), {
        secret: 'private-turnstile-key', response: 'browser-proof', remoteip: '203.0.113.7'
      })
      return Response.json({ success })
    })
    const { call, store } = fixture({ CAPTCHA_PROVIDER: 'Turnstile', TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'private-turnstile-key' })
    const result = await call('COMMENT_SUBMIT', {
      url: '/article', href: 'https://blog.example.test/article', ua: 'Mozilla/5.0',
      nick: 'Reader', mail: 'reader@example.test', comment: '<p>Test comment</p>', turnstileToken: 'browser-proof'
    })
    if (success) assert.equal(result.code, 0, JSON.stringify(result))
    else assert.notEqual(result.code, 0)
    assert.equal((await store.get('comments:all', { type: 'json' })).length, success ? 1 : 0)
    assert.equal(fetch.mock.callCount(), 1)
  })
}
