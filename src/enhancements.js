import { createHash } from 'node:crypto'
import { ABSENT, NOT, registerHandler, resolveHandler } from '@twikoojs/common'
import xss from 'xss'

// Keep local changes at the public extension points. The official handler owns
// validation, DTOs, replies, ordering, pagination and permission checks.
const installedHandlers = new WeakSet()
const enhancedDatabases = new WeakMap()

function databaseView (database, overrides) {
  return new Proxy(database, {
    get (target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key]
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

function sanitizeComment (data) {
  // Do not coerce malformed input and inadvertently bypass upstream validation.
  if (typeof data?.comment !== 'string') return data
  return { ...data, comment: xss(data.comment) }
}

/** Fix Blob's array-valued vote sorting before applying a page limit. */
async function getCommentsByVotes (database, query, options) {
  const comments = [...await database.getComments(query)]
  comments.sort((a, b) => {
    for (const [field, direction] of Object.entries(options.sort)) {
      const value = comment => field === 'ups'
        ? (Array.isArray(comment.ups) ? comment.ups.length : 0)
        : (comment[field] ?? 0)
      const difference = value(a) - value(b)
      if (difference) return difference * direction
    }
    return 0
  })
  const skipped = options.skip === undefined ? comments : comments.slice(options.skip)
  return options.limit === undefined ? skipped : skipped.slice(0, options.limit)
}

/** Sanitize every write and adapt Blob sorting without changing stored records. */
export function enhanceDatabase (database) {
  if (enhancedDatabases.has(database)) return enhancedDatabases.get(database)
  const enhanced = databaseView(database, {
    getComments: (query, options) => options?.sort?.ups !== undefined
      ? getCommentsByVotes(database, query, options)
      : database.getComments(query, options),
    addComment: data => database.addComment(sanitizeComment(data)),
    updateComment: (id, data) => database.updateComment(id, sanitizeComment(data)),
    bulkAddComments: list => database.bulkAddComments(list.map(sanitizeComment))
  })
  enhancedDatabases.set(database, enhanced)
  enhancedDatabases.set(enhanced, enhanced)
  return enhanced
}

function publicListDatabase (database, hideSpam, topDisabled) {
  const restrictQuery = query => {
    const condition = { ...query }
    // common 2.0.13 always excludes pinned rows from the main query. When
    // pinning is disabled they must instead take part in ordinary pagination.
    if (topDisabled && condition.top?.[NOT] === true) delete condition.top
    if (hideSpam) condition.isSpam = { [NOT]: true }
    return condition
  }
  return databaseView(database, {
    // The official handler separately asks for public and own spam comments.
    // Suppress the latter branch; constrain all others BEFORE limit/count.
    getComments: (query, options) => hideSpam && query.isSpam === true
      ? Promise.resolve([])
      : database.getComments(restrictQuery(query), options),
    countComments: query => hideSpam && query.isSpam === true
      ? Promise.resolve(0)
      : database.countComments(restrictQuery(query))
  })
}

function withDatabase (ctx, database) {
  // Never mutate shared adapters or config: simultaneous requests may have
  // different visibility rules, and the admin panel must retain spam access.
  return { ...ctx, adapters: { ...ctx.adapters, database } }
}

/**
 * Preserve repository search behavior: a matching reply selects its whole
 * visible thread. Only public DTO fields participate, including for admins.
 * For popular lists, use the same single visibility scope: upstream otherwise
 * merges the public/own-spam branches by subtracting vote arrays again.
 * Then reuse the normal official handler for assembling and paging the result.
 */
async function scopedThreads (ctx, officialHandler, keyword, hideSpam) {
  const event = ctx.request.body
  // Delegate invalid URLs to the official validation path.
  if (!event.url || typeof event.url !== 'string') return officialHandler(ctx)
  const database = ctx.adapters.database
  const urlVariant = event.url.endsWith('/') ? event.url.slice(0, -1) : `${event.url}/`
  const comments = await database.getComments({ url: { $in: [event.url, urlVariant] } })
  const isAdmin = ctx.config.ADMIN_PASS === createHash('md5').update(ctx.accessToken).digest('hex')
  const visible = comments.filter(comment => comment.isSpam !== true ||
    (!hideSpam && (isAdmin || comment.uid === ctx.accessToken)))
  const fields = ['nick', 'link', 'comment', 'url', 'href']
  const matchedRoots = new Set(visible
    .filter(comment => keyword === null || fields.some(field => typeof comment[field] === 'string' &&
      comment[field].toLowerCase().includes(keyword)))
    .map(comment => String(comment.rid || comment._id)))
  const ids = visible
    .filter(comment => matchedRoots.has(String(comment.rid || comment._id)))
    .map(comment => String(comment._id))
  const page = keyword === null ? 1 : Math.max(parseInt(event.page) || 1, 1)
  const pageSize = parseInt(ctx.config.COMMENT_PAGE_SIZE) || 8
  const scopedQuery = query => {
    // `ids` has already applied both visibility and keyword scope. Keep the
    // upstream public/own-spam branches disjoint by using the first one only.
    const { isSpam, ...condition } = query
    if (ctx.config.TOP_DISABLED && condition.top?.[NOT] === true) delete condition.top
    return { ...condition, _id: ids }
  }
  const scoped = databaseView(database, {
    getComments: (query, options) => {
      if (query.isSpam === true || (query.top === true && page > 1)) return Promise.resolve([])
      const paging = query.rid === ABSENT && query.top?.[NOT] === true
        ? { ...options, skip: (page - 1) * pageSize }
        : options
      return database.getComments(scopedQuery(query), paging)
    },
    countComments: query => query.isSpam === true
      ? Promise.resolve(0)
      : database.countComments(scopedQuery(query))
  })
  return officialHandler({
    ...withDatabase(ctx, scoped),
    request: { ...ctx.request, body: { ...event, keyword: undefined } }
  })
}

/** Install small, version-tested wrappers around the registered upstream API. */
export function installEnhancements () {
  const officialHandler = resolveHandler('COMMENT_GET')
  if (!officialHandler) throw new Error('Official COMMENT_GET handler is not registered')
  if (installedHandlers.has(officialHandler)) return
  const enhancedHandler = ctx => {
    const hideSpam = ctx.config.HIDE_SPAM === true || ctx.config.HIDE_SPAM === 'true'
    const keyword = ctx.request.body.keyword
    // Preserve upstream keyword validation (type and 100-character limit).
    if (typeof keyword === 'string' && keyword.trim().length > 0 && keyword.trim().length <= 100) {
      return scopedThreads(ctx, officialHandler, keyword.trim().toLowerCase(), hideSpam)
    }
    const noKeyword = keyword == null || (typeof keyword === 'string' && !keyword.trim())
    if (ctx.request.body.sort === 'popular' && noKeyword) {
      return scopedThreads(ctx, officialHandler, null, hideSpam)
    }
    return officialHandler(hideSpam || ctx.config.TOP_DISABLED
      ? withDatabase(ctx, publicListDatabase(ctx.adapters.database, hideSpam, ctx.config.TOP_DISABLED))
      : ctx)
  }
  installedHandlers.add(enhancedHandler)
  registerHandler('COMMENT_GET', enhancedHandler)
}
