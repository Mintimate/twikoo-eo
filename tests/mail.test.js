import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { createEoNodemailer, createMailBridgeContext, withMailBridgeContext } from '../src/mail.js'
import { createMemoryBlob } from './helpers/memory-blob.js'

const mail = { from: 'blog@example.com', to: 'reader@example.com', subject: 'reply', html: '<p>Hello</p>' }
const smtp = { host: 'smtp.example.com', port: 465, secure: true, auth: { user: 'blog@example.com', pass: 'smtp-secret' } }

function contextFor (host, token, body = {}) {
  return createMailBridgeContext({ url: `https://${host}/`, headers: { host, 'x-forwarded-proto': 'https' }, body }, { TWIKOO_SMTP_BRIDGE_TOKEN: token })
}

function probeResponse (body, token) {
  return Response.json({
    ok: true,
    bridgeHost: body.bridgeHost,
    signature: createHmac('sha256', token).update(`${body.nonce}\n${body.bridgeHost}`).digest('hex')
  })
}

for (const [service, endpoint, key] of [
  ['SendGrid', 'https://api.sendgrid.com/v3/mail/send', 'Authorization'],
  ['MailChannels', 'https://api.mailchannels.net/tx/v1/send', 'X-Api-Key']
]) {
  test(`${service} sends the API payload and surfaces non-2xx errors`, async t => {
    let status = 401
    const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(url, endpoint)
      assert.equal(init.method, 'POST')
      assert.equal(init.redirect, 'error')
      assert.equal(init.headers[key], service === 'SendGrid' ? 'Bearer api-secret' : 'api-secret')
      assert.deepEqual(JSON.parse(init.body), {
        personalizations: [{ to: [{ email: mail.to }] }], from: { email: mail.from },
        subject: mail.subject, content: [{ type: 'text/html', value: mail.html }]
      })
      return new Response(null, { status })
    })
    const transport = createEoNodemailer().createTransport({ service, auth: { user: 'api', pass: 'api-secret' } })
    assert.equal(await transport.verify(), true)
    assert.equal(fetch.mock.callCount(), 0)
    await assert.rejects(transport.sendMail(mail), new RegExp(`${service}.*HTTP 401`))
    status = 202
    assert.deepEqual(await transport.sendMail(mail), { ok: true, status: 202 })
  })

  test(`${service} converts nodemailer display names into separate API name/email fields`, async t => {
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body)
      assert.deepEqual(body.from, { email: 'blog@example.com', name: '博客 "Team"' })
      assert.deepEqual(body.personalizations[0].to, [{ email: 'reader@example.com', name: 'Reader' }])
      return new Response(null, { status: 202 })
    })
    const transport = createEoNodemailer().createTransport({ service, auth: { user: 'api', pass: 'api-secret' } })
    await transport.sendMail({ ...mail, from: '"博客 \\"Team\\"" <blog@example.com>', to: 'Reader <reader@example.com>' })
  })
}

test('SMTP verifies the HMAC before sending credentials and caches the authenticated URL per request', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, init, body })
    assert.equal(url, 'https://comments.example.com/smtp?preview=one')
    assert.equal(init.redirect, 'error')
    if (body.action === 'probe') {
      assert.equal(init.headers.Authorization, undefined)
      assert.deepEqual(Object.keys(body).sort(), ['action', 'bridgeHost', 'nonce'])
      assert.match(body.nonce, /^[a-f\d]{32}$/)
      return probeResponse(body, 'bridge-secret')
    }
    assert.equal(init.headers.Authorization, 'Bearer bridge-secret')
    assert.equal(body.pass, smtp.auth.pass)
    assert.equal(body.host, smtp.host)
    assert.equal(body.user, smtp.auth.user)
    assert.equal(body.port, 465)
    assert.equal(body.secure, true)
    return Response.json({ ok: true })
  })
  const context = contextFor('comments.example.com', 'bridge-secret', { envId: 'https://comments.example.com/?preview=one#hash' })
  const transport = createEoNodemailer().createTransport({ ...smtp, service: 'SendGrid' })
  await withMailBridgeContext(context, async () => {
    assert.equal(await transport.verify(), true)
    assert.deepEqual(await transport.sendMail(mail), { ok: true })
  })
  assert.deepEqual(calls.map(call => call.body.action), ['probe', 'verify', 'send'])
  assert.deepEqual(calls[2].body, { action: 'send', host: smtp.host, port: 465, secure: true, user: smtp.auth.user, pass: smtp.auth.pass, ...mail })
})

test('untrusted envId and Origin cannot become credential destinations', async t => {
  const context = createMailBridgeContext({
    url: 'https://comments.example.com/',
    headers: { host: 'comments.example.com', origin: 'https://evil.example.com' },
    body: { envId: 'https://evil.example.com?secret=attacker' }
  }, { TWIKOO_SMTP_BRIDGE_TOKEN: 'bridge-secret' })
  assert.deepEqual(context.urls, ['https://comments.example.com/smtp'])
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(JSON.parse(init.body))
    assert.equal(url, 'https://comments.example.com/smtp')
    assert.equal(init.headers.Authorization, undefined)
    return probeResponse(JSON.parse(init.body), 'wrong-token')
  })
  await assert.rejects(withMailBridgeContext(context, () => createEoNodemailer().createTransport(smtp).sendMail(mail)), /自动发现失败/)
  assert.deepEqual(calls.map(body => body.action), ['probe'])
  assert.deepEqual(createMailBridgeContext({ headers: {}, body: { envId: 'https://evil.example.com' } }).urls, [])
})

test('an explicit server bridge URL supports internal runtime URLs without authorizing body URLs', () => {
  const context = createMailBridgeContext({
    url: 'http://internal-runtime:8080/index',
    headers: { host: 'attacker.example.com' },
    body: { envId: 'https://attacker.example.com' }
  }, { TWIKOO_SMTP_BRIDGE_URL: 'https://comments.example.com/index?preview=one#hash' })
  assert.deepEqual(context.urls, ['https://comments.example.com/smtp?preview=one', 'http://internal-runtime:8080/smtp'])
  assert.throws(() => createMailBridgeContext({ headers: {} }, { TWIKOO_SMTP_BRIDGE_URL: 'ftp://example.com' }), /TWIKOO_SMTP_BRIDGE_URL/)
  assert.throws(() => createMailBridgeContext({ headers: {} }, { TWIKOO_SMTP_BRIDGE_URL: 'https://user:pass@example.com' }), /TWIKOO_SMTP_BRIDGE_URL/)
  assert.deepEqual(contextFor('comments.example.com', 'token', { envId: 'http://comments.example.com' }).urls, ['https://comments.example.com/smtp'])
})

test('a malformed or redirected probe never causes a credential-bearing request', async t => {
  for (const result of [null, { ok: true, bridgeHost: 'wrong.example.com', signature: 'a'.repeat(64) }, { ok: true, signature: 'a'.repeat(64) + 'extra' }]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(result))
    await assert.rejects(withMailBridgeContext(contextFor('comments.example.com', 'token'), () => createEoNodemailer().createTransport(smtp).verify()), /自动发现失败/)
    assert.equal(fetch.mock.callCount(), 1)
    fetch.mock.restore()
  }
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.redirect, 'error')
    throw new TypeError('redirect rejected')
  })
  await assert.rejects(withMailBridgeContext(contextFor('comments.example.com', 'token'), () => createEoNodemailer().createTransport(smtp).verify()), /自动发现失败/)
  assert.equal(fetch.mock.callCount(), 1)
})

test('SMTP bridge errors and malformed JSON propagate to the caller', async t => {
  let mode = 'error'
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.action === 'probe') return probeResponse(body, 'token')
    if (mode === 'error') return Response.json({ ok: false, message: 'SMTP auth failed' }, { status: 502 })
    return new Response('not JSON', { status: 502 })
  })
  await withMailBridgeContext(contextFor('comments.example.com', 'token'), async () => {
    const transport = createEoNodemailer().createTransport(smtp)
    await assert.rejects(transport.sendMail(mail), /SMTP auth failed/)
    mode = 'malformed'
    await assert.rejects(transport.sendMail(mail), /SMTP Bridge 返回异常：HTTP 502/)
  })
})

test('server-provided environment wins and mail rejects a missing bridge token before fetch', async t => {
  const context = createMailBridgeContext({ headers: { host: 'comments.example.com' }, env: { TWIKOO_SMTP_BRIDGE_TOKEN: 'wrapper-token' }, body: { env: { TWIKOO_SMTP_BRIDGE_TOKEN: 'body-token' } } }, { TWIKOO_SMTP_BRIDGE_TOKEN: 'server-token' })
  assert.equal(context.token, 'server-token')
  assert.equal(createMailBridgeContext({ headers: {}, body: { TWIKOO_SMTP_BRIDGE_TOKEN: 'body-token' } }).token, '')
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch') })
  await assert.rejects(createEoNodemailer().createTransport(smtp).sendMail(mail), /TWIKOO_SMTP_BRIDGE_TOKEN/)
  assert.equal(fetch.mock.callCount(), 0)
})

test('interleaved async requests retain their own SMTP host and token', async t => {
  const tokens = { 'one.example.com': 'token-one', 'two.example.com': 'token-two' }
  const sends = []
  let releaseProbes
  const bothProbesStarted = new Promise(resolve => { releaseProbes = resolve })
  let probes = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const host = new URL(url).host
    const body = JSON.parse(init.body)
    if (body.action === 'probe') {
      if (++probes === 2) releaseProbes()
      await bothProbesStarted
      return probeResponse(body, tokens[host])
    }
    await Promise.resolve()
    assert.equal(init.headers.Authorization, `Bearer ${tokens[host]}`)
    assert.equal(body.subject, host)
    sends.push(host)
    return Response.json({ ok: true })
  })
  const transport = createEoNodemailer().createTransport(smtp)
  await Promise.all(Object.entries(tokens).map(([host, token]) => withMailBridgeContext(contextFor(host, token), async () => {
    await Promise.resolve()
    await transport.sendMail({ ...mail, subject: host })
  })))
  assert.deepEqual(sends.sort(), Object.keys(tokens).sort())
  await assert.rejects(transport.sendMail(mail), /TWIKOO_SMTP_BRIDGE_TOKEN/)
})

test('official comment notification sends the configured display name through the HTTP mail API', async t => {
  const { createHandler } = await import(process.env.TWIKOO_TEST_BUNDLE === '1' ? '../dist/twikoo.js' : '../src/handler.js')
  for (const level of ['log', 'info', 'warn', 'error']) t.mock.method(console, level, () => {})
  const outgoing = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.sendgrid.com/v3/mail/send')
    outgoing.push(JSON.parse(init.body))
    return new Response(null, { status: 202 })
  })
  const store = createMemoryBlob({
    'config:main': {
      SITE_URL: 'https://blog.example.test', SITE_NAME: 'Test blog',
      BLOGGER_EMAIL: 'blogger@example.test',
      SMTP_SERVICE: 'SendGrid', SMTP_USER: 'apikey', SMTP_PASS: 'fake-mail-key',
      SENDER_EMAIL: 'notify@example.test', SENDER_NAME: '博客通知',
      SHOW_REGION: 'false', SHOW_UA: 'false', LIMIT_PER_MINUTE: '0', LIMIT_PER_MINUTE_ALL: '0'
    },
    'comments:all': []
  })
  const jobs = []
  const response = await createHandler({ store })({
    env: {}, waitUntil: job => jobs.push(job),
    request: new Request('https://api.example.test/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'eo-connecting-ip': '203.0.113.1' },
      body: JSON.stringify({
        event: 'COMMENT_SUBMIT', accessToken: 'reader-token',
        url: '/article/', href: 'https://blog.example.test/article/', ua: 'Mozilla/5.0',
        nick: 'Reader', mail: 'reader@example.test', comment: '<p>A new comment</p>'
      })
    })
  })
  assert.equal((await response.json()).code, 0)
  assert.equal(jobs.length, 1)
  await Promise.all(jobs)
  assert.equal(outgoing.length, 1)
  assert.deepEqual(outgoing[0].from, { name: '博客通知', email: 'notify@example.test' })
  assert.deepEqual(outgoing[0].personalizations[0].to, [{ email: 'blogger@example.test' }])
  assert.ok(outgoing[0].content[0].value.includes('A new comment'))
})
