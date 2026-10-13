import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  BlobKvDatabase, createHandler, scaffoldAdapters, setCustomLibs, resolveHandler, RES_CODE
} from '@twikoojs/common'
import { enhanceDatabase, installEnhancements } from '../src/enhancements.js'

installEnhancements()
// Deliberately leave upstream sanitization as a no-op here: the database wrapper
// must protect admin edits/imports too, without depending on COMMENT_SUBMIT.
setCustomLibs({ DOMPurify: { sanitize: value => value } })

const admin = 'admin-session'
const adminPass = createHash('md5').update(admin).digest('hex')
const capabilities = {
  mail: false, domPurify: false, ip2region: false, akismet: false,
  tencentTms: false, imageUpload: false, qqAvatar: false, ai: false
}

function comment (id, fields = {}) {
  return {
    _id: id, url: '/article/', uid: 'owner', nick: 'reader',
    comment: `<p>${id}</p>`, created: 100, ...fields
  }
}

function fixture (comments = [], config = {}) {
  const records = new Map([
    ['comments:all', structuredClone(comments)],
    ['config:main', { ADMIN_PASS: adminPass, SHOW_UA: 'false', ...config }]
  ])
  const store = {
    async get (key) { return structuredClone(records.get(key) ?? null) },
    async setJSON (key, value) { records.set(key, structuredClone(value)) },
    async delete (key) { records.delete(key) },
    async list ({ prefix }) {
      return { blobs: [...records.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }
    }
  }
  return {
    records,
    database: () => enhanceDatabase(new BlobKvDatabase(store)),
    async request (event, fields = {}, accessToken = 'owner') {
      const database = enhanceDatabase(new BlobKvDatabase(store))
      const handle = createHandler(scaffoldAdapters({
        database, capabilities,
        request: { toTkRequest: value => value },
        response: { fromTkResponse: value => value },
        postSubmit: { async dispatch () {} }
      }))
      const response = await handle({
        method: 'POST', path: '/', query: {}, headers: {}, ip: '127.0.0.12', raw: {},
        body: { event, url: '/article', accessToken, ...fields }
      })
      assert.equal(response.status, 200)
      return response.body
    }
  }
}

function ids (response) { return response.data.map(item => item.id) }

test('HIDE_SPAM hides own/admin spam before pagination, counts, pinned rows and replies', async t => {
  for (const setting of ['true', true]) {
    for (const accessToken of ['owner', admin, 'visitor']) {
      await t.test(`${setting} (${typeof setting}), ${accessToken}`, async () => {
        const app = fixture([
          comment('spam-pinned', { top: true, isSpam: true, uid: accessToken, created: 700 }),
          comment('spam-newest', { isSpam: true, uid: accessToken, created: 600 }),
          comment('pin', { top: true, created: 50 }),
          comment('new', { created: 300 }), comment('middle', { created: 200 }),
          comment('old', { created: 100 }),
          comment('visible-reply', { rid: 'new', pid: 'new', created: 301 }),
          comment('spam-reply', { rid: 'new', pid: 'new', isSpam: true, uid: accessToken, created: 302 })
        ], { HIDE_SPAM: setting, COMMENT_PAGE_SIZE: '2' })
        const first = await app.request('COMMENT_GET', {}, accessToken)
        assert.equal(first.code, 0)
        assert.deepEqual(ids(first), ['pin', 'new', 'middle'])
        assert.equal(first.count, 4)
        assert.equal(first.more, true)
        assert.deepEqual(first.data.find(item => item.id === 'new').replies.map(item => item.id), ['visible-reply'])
        const next = await app.request('COMMENT_GET', { before: 200 }, accessToken)
        assert.deepEqual(ids(next), ['old'])
        assert.equal(next.count, 4)
        assert.equal(next.more, false)
      })
    }
  }
})

test('HIDE_SPAM=false preserves upstream author/admin visibility', async () => {
  const app = fixture([
    comment('public'), comment('own', { isSpam: true }),
    comment('other', { isSpam: true, uid: 'other' })
  ], { HIDE_SPAM: 'false' })
  assert.deepEqual(new Set(ids(await app.request('COMMENT_GET'))), new Set(['public', 'own']))
  assert.deepEqual(new Set(ids(await app.request('COMMENT_GET', {}, admin))), new Set(['public', 'own', 'other']))
  assert.deepEqual(ids(await app.request('COMMENT_GET', {}, 'visitor')), ['public'])
})

test('TOP_DISABLED keeps previously pinned comments in ordinary and search pagination', async () => {
  for (const topDisabled of [true, 'true']) {
    for (const hideSpam of [true, false]) {
      const app = fixture([
        comment('older', { comment: 'needle', created: 100 }),
        comment('newer', { comment: 'needle', created: 200 }),
        comment('pin', { comment: 'needle', top: true, created: 300 }),
        comment('spam-pin', { comment: 'needle', top: true, isSpam: true, created: 50 }),
        comment('pin-reply', { rid: 'pin', pid: 'pin', created: 301 })
      ], { TOP_DISABLED: topDisabled, HIDE_SPAM: hideSpam, COMMENT_PAGE_SIZE: '1' })
      for (const fields of [{}, { keyword: 'needle' }]) {
        const first = await app.request('COMMENT_GET', fields)
        assert.deepEqual(ids(first), ['pin'])
        assert.equal(first.count, hideSpam ? 3 : 4)
        assert.equal(first.more, true)
        assert.deepEqual(first.data[0].replies.map(item => item.id), ['pin-reply'])
      }
      const next = await app.request('COMMENT_GET', { before: 300 })
      assert.deepEqual(ids(next), ['newer'])
      assert.equal(next.count, hideSpam ? 3 : 4)
      const searchNext = await app.request('COMMENT_GET', { keyword: 'needle', page: 2 })
      assert.deepEqual(ids(searchNext), ['newer'])
      assert.equal(searchNext.count, hideSpam ? 3 : 4)
    }
  }
})

test('popular lists sort vote counts before limits and merge visible own spam correctly', async () => {
  const comments = [
    comment('low', { comment: 'needle', ups: [], created: 500 }),
    comment('own-spam', { comment: 'needle', ups: ['a', 'b', 'c', 'd'], isSpam: true, created: 400 }),
    comment('high-old', { comment: 'needle', ups: ['a', 'b', 'c'], created: 300 }),
    comment('high-new', { comment: 'needle', ups: ['a', 'b', 'c'], created: 350 }),
    comment('other-spam', { comment: 'needle', ups: ['a', 'b', 'c', 'd', 'e'], isSpam: true, uid: 'other', created: 200 }),
    comment('pin', { comment: 'needle', top: true, ups: ['a'], created: 100 }),
    comment('reply', { rid: 'high-new', pid: 'high-new', created: 351 })
  ]
  const cases = [
    { token: 'visitor', hideSpam: false, main: ['high-new', 'high-old', 'low'] },
    { token: 'owner', hideSpam: false, main: ['own-spam', 'high-new', 'high-old', 'low'] },
    { token: admin, hideSpam: false, main: ['other-spam', 'own-spam', 'high-new', 'high-old', 'low'] },
    { token: 'owner', hideSpam: true, main: ['high-new', 'high-old', 'low'] },
    { token: admin, hideSpam: true, main: ['high-new', 'high-old', 'low'] }
  ]
  for (const { token, hideSpam, main } of cases) {
    const app = fixture(comments, { HIDE_SPAM: hideSpam, COMMENT_PAGE_SIZE: '2' })
    for (const extra of [{}, { keyword: 'needle' }]) {
      const first = await app.request('COMMENT_GET', { sort: 'popular', ...extra }, token)
      assert.deepEqual(ids(first), ['pin', ...main.slice(0, 2)])
      assert.equal(first.count, main.length + 1)
      assert.equal(first.more, true)
      for (const item of first.data) {
        assert.equal(item.ups, comments.find(comment => comment._id === item.id).ups.length)
      }
      const highNew = first.data.find(item => item.id === 'high-new')
      if (highNew) assert.deepEqual(highNew.replies.map(item => item.id), ['reply'])
    }
    const next = await app.request('COMMENT_GET', { keyword: 'needle', sort: 'popular', page: 2 }, token)
    assert.deepEqual(ids(next), main.slice(2, 4))
    assert.equal(next.count, main.length + 1)
    assert.equal(next.more, main.length > 4)
    assert.deepEqual(app.records.get('comments:all'), comments, 'Vote sorting must not modify persisted arrays/order')
  }
})

test('popular sorting includes formerly pinned comments when pinning is disabled', async () => {
  const app = fixture([
    comment('low', { comment: 'needle', ups: [], created: 300 }),
    comment('pin', { comment: 'needle', top: true, ups: ['a', 'b'], created: 100 }),
    comment('middle', { comment: 'needle', ups: ['a'], created: 200 })
  ], { TOP_DISABLED: 'true', COMMENT_PAGE_SIZE: '1' })
  for (const extra of [{}, { keyword: 'needle' }]) {
    const first = await app.request('COMMENT_GET', { sort: 'popular', ...extra })
    assert.deepEqual(ids(first), ['pin'])
    assert.equal(first.count, 3)
    assert.equal(first.more, true)
  }
  const next = await app.request('COMMENT_GET', { keyword: 'needle', sort: 'popular', page: 2 })
  assert.deepEqual(ids(next), ['middle'])
  assert.equal(next.more, true)
})

test('search matches replies and returns whole visible threads with correct paging/count', async () => {
  const app = fixture([
    comment('a', { created: 100 }), comment('b', { created: 200 }),
    comment('reply-a', { rid: 'a', pid: 'a', comment: 'Needle', created: 101 }),
    comment('sibling-a', { rid: 'a', pid: 'a', comment: 'context', created: 102 }),
    comment('reply-b', { rid: 'b', pid: 'b', comment: 'needle', created: 201 }),
    comment('hidden-reply', { rid: 'b', pid: 'b', isSpam: true, comment: 'needle' }),
    comment('spam-root', { isSpam: true, comment: 'needle' }),
    comment('only-spam-match'),
    comment('spam-only', { rid: 'only-spam-match', pid: 'only-spam-match', isSpam: true, comment: 'needle' }),
    comment('elsewhere', { url: '/different', comment: 'needle' })
  ], { HIDE_SPAM: 'true', COMMENT_PAGE_SIZE: '1' })
  for (const accessToken of ['owner', admin, 'visitor']) {
    const first = await app.request('COMMENT_GET', { keyword: ' NEEDLE ' }, accessToken)
    assert.deepEqual(ids(first), ['b'])
    assert.deepEqual(first.data[0].replies.map(item => item.id), ['reply-b'])
    assert.equal(first.count, 2)
    assert.equal(first.more, true)
    const second = await app.request('COMMENT_GET', { keyword: 'needle', page: 2 }, accessToken)
    assert.deepEqual(ids(second), ['a'])
    assert.deepEqual(second.data[0].replies.map(item => item.id), ['reply-a', 'sibling-a'])
    assert.equal(second.count, 2)
    assert.equal(second.more, false)
  }
})

test('search hides spam threads for boolean HIDE_SPAM and includes own spam when disabled', async () => {
  for (const setting of [true, false, 'false']) {
    const app = fixture([
      comment('own', { isSpam: true, comment: 'needle' }),
      comment('other', { isSpam: true, uid: 'other', comment: 'needle' })
    ], { HIDE_SPAM: setting })
    const own = await app.request('COMMENT_GET', { keyword: 'needle' })
    const moderator = await app.request('COMMENT_GET', { keyword: 'needle' }, admin)
    assert.equal(own.count, setting === true ? 0 : 1)
    assert.equal(moderator.count, setting === true ? 0 : 2)
  }
})

test('search pins appear only on the first page and own spam shares a single page quota', async () => {
  const app = fixture([
    comment('pin', { top: true, comment: 'needle', created: 10 }),
    comment('public-new', { comment: 'needle', created: 300 }),
    comment('own-spam', { comment: 'needle', isSpam: true, created: 200 }),
    comment('public-old', { comment: 'needle', created: 100 })
  ], { HIDE_SPAM: 'false', COMMENT_PAGE_SIZE: '1' })
  const first = await app.request('COMMENT_GET', { keyword: 'needle' })
  assert.deepEqual(ids(first), ['pin', 'public-new'])
  assert.equal(first.count, 4)
  const second = await app.request('COMMENT_GET', { keyword: 'needle', page: 2 })
  assert.deepEqual(ids(second), ['own-spam'])
  assert.equal(second.more, true)
  const third = await app.request('COMMENT_GET', { keyword: 'needle', page: 3 })
  assert.deepEqual(ids(third), ['public-old'])
  assert.equal(third.more, false)
})

test('public search never matches private mail/ip fields, including for admins', async () => {
  const app = fixture([comment('one', { mail: 'private@example.com', ip: '198.51.100.77' })])
  for (const keyword of ['private@example.com', '198.51.100.77']) {
    assert.equal((await app.request('COMMENT_GET', { keyword }, admin)).count, 0)
    const backend = await app.request('COMMENT_GET_FOR_ADMIN', { keyword, per: 20, page: 1 }, admin)
    assert.equal(backend.count, 1)
  }
})

test('admin moderation and public count endpoints retain their intended scopes', async () => {
  const app = fixture([
    comment('public'), comment('spam', { isSpam: true }),
    comment('reply', { rid: 'public', pid: 'public' }),
    comment('spam-reply', { rid: 'public', pid: 'public', isSpam: true })
  ], { HIDE_SPAM: 'true' })
  const results = await Promise.all([
    app.request('COMMENT_GET'),
    app.request('COMMENT_GET_FOR_ADMIN', { per: 20, page: 1, type: 'HIDDEN' }, admin),
    app.request('GET_COMMENTS_COUNT', { urls: ['/article'], includeReply: true })
  ])
  assert.equal(results[0].count, 1)
  assert.equal(results[1].count, 2)
  assert.equal(results[2].data[0].count, 2)
  assert.equal(app.records.get('config:main').HIDE_SPAM, 'true')
  assert.equal((await app.request('COMMENT_GET_FOR_ADMIN', { per: 20, page: 1 }, 'visitor')).code, RES_CODE.NEED_LOGIN)
})

test('enhancement wrappers are idempotent and keep independent request configuration', async () => {
  const handler = resolveHandler('COMMENT_GET')
  installEnhancements()
  assert.equal(resolveHandler('COMMENT_GET'), handler)
  const hidden = fixture([comment('spam', { isSpam: true })], { HIDE_SPAM: 'true' })
  const visible = fixture([comment('spam', { isSpam: true })], { HIDE_SPAM: 'false' })
  const db = hidden.database()
  assert.equal(enhanceDatabase(db), db)
  const result = await Promise.all([hidden.request('COMMENT_GET'), visible.request('COMMENT_GET')])
  assert.equal(result[0].count, 0)
  assert.equal(result[1].count, 1)
})

test('upstream keyword validation is retained', async () => {
  const app = fixture([], { HIDE_SPAM: 'true' })
  for (const keyword of [{ $ne: '' }, 'x'.repeat(101)]) {
    const response = await app.request('COMMENT_GET', { keyword })
    assert.notEqual(response.code, 0)
    assert.match(response.message, /搜索关键词/)
  }
})

test('official submit, admin edit and backup import all sanitize before Blob writes', async () => {
  const app = fixture()
  const dangerous = '<p>allowed <strong>bold</strong><img src="x" onerror="alert(1)"></p><script>alert(1)</script>'
  const submitted = await app.request('COMMENT_SUBMIT', { comment: dangerous, ua: 'test', nick: 'reader' })
  assert.equal(submitted.code, 0)
  const check = data => {
    assert.match(data.comment, /<strong>bold<\/strong>/)
    assert.doesNotMatch(data.comment, /<script|onerror=/)
  }
  check(app.records.get('comments:all')[0])
  const edited = await app.request('COMMENT_SET_FOR_ADMIN', { id: submitted.id, set: { comment: dangerous } }, admin)
  assert.equal(edited.code, 0)
  check(app.records.get('comments:all')[0])
  const imported = await app.request('COMMENT_IMPORT_FOR_ADMIN', {
    source: 'twikoo', file: JSON.stringify([comment('imported', { comment: dangerous })])
  }, admin)
  assert.equal(imported.code, 0)
  check(app.records.get('comments:all').find(item => item._id === 'imported'))
  assert.deepEqual([...app.records.keys()].sort(), ['comments:all', 'config:main'])
})

test('write sanitation preserves caller objects, non-string values and non-comment fields', async () => {
  const app = fixture()
  const db = app.database()
  const input = comment('unchanged', { comment: '<img src="x" onerror="bad()">', nick: '<nickname>' })
  const original = structuredClone(input)
  await db.addComment(input)
  assert.deepEqual(input, original)
  assert.equal((await db.getComment('unchanged')).nick, '<nickname>')
  const nonString = { content: 'leave validation to upstream' }
  await db.updateComment('unchanged', { comment: nonString })
  assert.deepEqual((await db.getComment('unchanged')).comment, nonString)
  await db.updateComment('unchanged', { isSpam: true })
  assert.deepEqual((await db.getComment('unchanged')).comment, nonString)
})
