/**
 * dsh-workspace-cleanup — Host half.
 *
 * One contributed capability: list every Workspace with its stored Sessions,
 * plus the ungrouped bucket and the cross-cutting B 站 bucket, and delete any
 * of them for good through the already installed `dsh-session-purge` plugin.
 *
 * Why this exists
 * ---------------
 * DSH has no Session deletion API; `dsh-session-purge` is that out-of-band
 * maintenance, but it works one Session at a time from the sidebar menu. The
 * "Ungrouped" bucket collects everything that has no Workspace: the headless
 * Sessions the B 站 scroll plugin spawns (cwd = `<DSH_HOME>/bili-duty`), stray
 * Sessions whose cwd no longer matches a registered Workspace, and anything
 * else the registry could not account for. Those pile up unnoticed, and the
 * grouped Workspaces are equally unmaintained. This plugin lists them all and
 * removes them in batch — either a whole Workspace's Sessions or one cross-cutting
 * bucket — **without ever deleting a Workspace record**.
 *
 * Reuse, not reimplementation
 * ---------------------------
 * The actual deletion is delegated to `dsh-session-purge`'s `POST
 * /plugins/dsh-session-purge/api/purge` endpoint, one Session at a time. That
 * keeps a single deletion implementation: the safety rules (id validation,
 * cwd containment, DSH-home protection, shared-attachment scan, live-Session
 * stop-and-archive) all live in the purge plugin and are enforced on its Host
 * half, not here. A cross-package `import` is deliberately avoided because the
 * profile installs bundles as symlinks outside the profile's `node_modules`
 * tree, where Node would not resolve `dsh-session-purge`; an HTTP call to the
 * same in-process web server resolves regardless.
 *
 * Surfaces
 * --------
 *   1. `POST /plugins/dsh-workspace-cleanup/api/scan` — list every Workspace
 *      bucket with its Sessions and their display titles, plus the Ungrouped and
 *      cross-cutting B 站 buckets.
 *   2. `POST /plugins/dsh-workspace-cleanup/api/clean` — recompute the same
 *      target list on the Host, then purge each target. `scope` is `all`
 *      (ungrouped), `bili`, `workspace` (one bucket by id), or `selected` (the
 *      ticked ids, filtered to Sessions the Host actually sees); the browser
 *      never sends a Session id list that the Host trusts blindly, so a tampered
 *      request cannot widen the scope.
 *   3. `GET  /plugins/dsh-workspace-cleanup/api/health` — liveness.
 *
 * Safety invariants, all enforced here rather than in the browser:
 *
 *   * The target list is recomputed from `sessionPersistence.list()` and the
 *     Workspace registry on every request. A `workspace` scope resolves its id
 *     to a bucket first, so an unknown or stale id cleans nothing; a `selected`
 *     scope filters the ticked ids against the stored corpus, so an id the Host
 *     never saw cleans nothing; a Session that no bucket claims is ungrouped and
 *     only the `all` scope reaches it.
 *   * The B 站 scope is derived from the Session header's recorded `cwd` being
 *     inside `<DSH_HOME>/bili-duty`, the directory the scroll plugin spawns its
 *     headless Sessions with. It is independent of grouping, so a B 站 Session
 *     that happens to be grouped is still recognised.
 *   * A Workspace record is never deleted: cleaning a Workspace's Sessions leaves
 *     the Workspace itself in the registry, now empty.
 *   * `/plugins` routes answer without the shell's session authorization, so
 *     both write endpoints demand this plugin's own marker header and reject a
 *     cross-origin `Origin`.
 */

import { readdir, rm, stat as fsStat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

/** Package name the loader mounts this row as; also the browser module id. */
export const name = 'dsh-workspace-cleanup'

/**
 * Services this half requires. `webServer` carries the three routes and the
 * origin used to call the purge plugin; the persistence seam lists stored
 * Sessions. The Workspace registry is read lazily through `ctx.get`, exactly as
 * `dsh-session-purge` does, because it is a composition-level service rather
 * than an injected one.
 */
export const inject = ['webServer', 'sessionPersistence']

/** Route prefix for this plugin's own JSON endpoints. */
const ROUTE = '/plugins/dsh-workspace-cleanup/api'

/** Marker header every write endpoint demands; a cross-origin page cannot set it. */
const MARKER = 'x-dsh-workspace-cleanup'

/** Accepted delete modes, forwarded verbatim to `dsh-session-purge`. */
const MODES = ['record', 'artifacts', 'everything']

/** Default mode: drop the durable record plus the files the Session wrote. */
const DEFAULT_MODE = 'artifacts'

/** Directory the B 站 scroll plugin uses as the cwd of its headless Sessions. */
const BILI_DIR_NAME = 'bili-duty'

/** Synthetic id and title of the Ungrouped bucket (not a real Workspace). */
const UNGROUPED_ID = 'ungrouped'
const UNGROUPED_TITLE = '未分组'

/** Synthetic id and title of the cross-cutting B 站 bucket. */
const BILI_ID = 'bili'
const BILI_TITLE = 'B站会话'

/** A Session id is one path segment: letters, digits, dot, underscore, dash. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/

/** Largest request body this plugin accepts; every body it defines is tiny. */
const MAX_BODY_BYTES = 256 * 1024

/** How many Session rows one scan response may carry. */
const MAX_REPORTED_ROWS = 500

/** The purge plugin's route prefix. */
const PURGE_ROUTE = '/plugins/dsh-session-purge/api/purge'

/** Resolve the DSH home exactly as the rest of the harness does. */
async function resolveHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (fromEnv !== '') return fromEnv
  try {
    // Present in every shipped composition; a dynamic import keeps this half
    // loadable even where the library cannot be resolved.
    const library = await import('@deepseek-ai/dsh-home-paths')
    if (typeof library.resolveDshHome === 'function') return library.resolveDshHome()
  } catch {
    // Fall through to the documented default.
  }
  return join(homedir(), '.dsh')
}

/** One short human-readable line for a caught value. */
function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Case-insensitive "same directory or underneath it" comparison.
 * Both spellings are normalised to backslashes first, so a Session header that
 * recorded forward slashes still matches a Windows path.
 */
function isSameOrUnder(parent, child) {
  const a = String(parent).replace(/\//g, '\\').replace(/\\+$/, '')
  const b = String(child).replace(/\//g, '\\').replace(/\\+$/, '')
  if (a === '' || b === '') return false
  const left = process.platform === 'win32' ? a.toLowerCase() : a
  const right = process.platform === 'win32' ? b.toLowerCase() : b
  return left === right || right.startsWith(left + '\\')
}

/** Sum the bytes of every regular file under one directory, missing paths read as 0. */
async function directoryBytes(directory) {
  let total = 0
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(directory, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(child)
    else if (entry.isFile()) {
      try {
        total += (await fsStat(child)).size
      } catch {
        // A file that vanished mid-walk contributes nothing.
      }
    }
  }
  return total
}

/**
 * Locate one Session's storage directories under the sessions root.
 *
 * The backend nests a Session under a readable project directory; the id is
 * already a safe path segment for every id DSH produces, so the search is an
 * exact directory-name match across every project directory. Nothing is joined
 * from an unvalidated value.
 */
async function findSessionDirectories(home, sessionId) {
  const root = join(home, 'sessions')
  const found = []
  if (!existsSync(root)) return found
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(root, project.name, sessionId)
    if (!existsSync(candidate)) continue
    try {
      if (!(await fsStat(candidate)).isDirectory()) continue
    } catch {
      continue
    }
    found.push(candidate)
  }
  return found
}

/**
 * The Session creation header, whatever shape the backend's snapshot uses.
 * @param snapshot - result of `sessionPersistence.list()`.
 * @returns the header record, or null when the snapshot carries none.
 */
function headerOf(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return null
  const nested = snapshot.header
  if (nested !== null && typeof nested === 'object' && typeof nested.id === 'string') return nested
  if (typeof snapshot.id === 'string' && typeof snapshot.version === 'number') return snapshot
  return null
}

/** Whether the Session is currently live in this process. */
function isLive(ctx, sessionId) {
  try {
    const sessions = ctx.get('sessions')
    if (sessions === undefined || typeof sessions.get !== 'function') return false
    return sessions.get(sessionId) !== undefined
  } catch {
    return false
  }
}

/**
 * Fold the display title of one Session from its event log, the same way the
 * harness's own title service does: the latest `session/title` event wins; when
 * there is none, the first user message becomes the fallback title.
 * @param events - the Session's event log.
 * @returns the display title, or null when the log carries none.
 */
function foldTitle(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'session/title' && typeof event?.data?.title === 'string' && event.data.title.trim() !== '') {
      return event.data.title
    }
  }
  for (const event of events) {
    if (event?.type !== 'user/message' || event?.data?.source?.kind !== 'user') continue
    const text = (Array.isArray(event.data?.content) ? event.data.content : [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim()
    if (text !== '') return text.slice(0, 80)
  }
  return null
}

/**
 * Fold display titles for many Sessions so the panel can show the name the
 * sidebar shows instead of the raw id. Prefers the harness's own title fold
 * (one corpus observation); any Session that comes back without a title, or
 * whose fold fails, is re-read from its log directly. A read failure leaves the
 * title null, and the panel falls back to the id.
 * @param ctx - Host plugin context.
 * @param sessionIds - the Sessions to fold.
 * @returns a map from session id to display title.
 */
async function foldTitles(ctx, sessionIds) {
  const titles = new Map()
  if (sessionIds.length === 0) return titles

  const engine = ctx.get('sessionQuery')
  if (engine !== undefined && typeof engine.readTitleSnapshots === 'function') {
    try {
      const results = await engine.readTitleSnapshots(sessionIds)
      for (const result of Array.isArray(results) ? results : []) {
        const value = result?.value
        const id = value?.session?.id
        if (result?.status === 'fulfilled' && typeof id === 'string' && typeof value?.title === 'string' && value.title !== '') {
          titles.set(id, value.title)
        }
      }
    } catch {
      // Fall through to the per-log reads below.
    }
  }

  for (const sessionId of sessionIds) {
    if (titles.has(sessionId)) continue
    try {
      const handle = await ctx.sessionPersistence.open(sessionId, 'read')
      try {
        const result = await handle.read()
        const title = foldTitle(Array.isArray(result?.events) ? result.events : [])
        if (title !== null) titles.set(sessionId, title)
      } finally {
        try { await handle?.close?.() } catch { /* a close failure never changes the title */ }
      }
    } catch {
      // Leave the title null; the panel shows the id instead.
    }
  }
  return titles
}

/**
 * Read the whole stored-Session picture and split it into Workspaces.
 *
 * Every stored Session is placed in exactly one Workspace bucket: the
 * Workspace whose filtered `sessionIds` accounts for it, or the synthetic
 * Ungrouped bucket. Grouped Workspaces keep the registry's own order and the
 * Ungrouped bucket is appended last. A cross-cutting B 站 bucket is added on
 * top: it lists every B 站 Session whatever Workspace owns it, so it can
 * overlap a grouped bucket on purpose. The flat `ungrouped` and `bili` lists
 * back the two global quick actions.
 *
 * @param ctx - Host plugin context.
 * @returns every stored Session row, the Workspace buckets, and the derived lists.
 */
async function collect(ctx) {
  const home = await resolveHome()
  const biliDir = join(home, BILI_DIR_NAME)

  let snapshots = []
  try {
    snapshots = await ctx.sessionPersistence.list()
  } catch (error) {
    throw new Error(`读取会话列表失败：${describe(error)}`)
  }
  const headers = (Array.isArray(snapshots) ? snapshots : []).map(headerOf).filter(Boolean)

  const registry = ctx.get('workspaceRegistry')
  const registryWorkspaces = registry !== undefined && typeof registry.list === 'function' ? registry.list() : []

  // sessionId -> the Workspace that accounts for it, using the registry's own
  // filtered membership (a Session whose cwd no longer matches is ungrouped).
  const workspaceBySession = new Map()
  const accounted = new Set()
  for (const workspace of registryWorkspaces) {
    for (const sessionId of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []) {
      accounted.add(sessionId)
      workspaceBySession.set(sessionId, workspace)
    }
  }

  let archivedIds = []
  try {
    archivedIds = Array.isArray(registry?.archivedSessionIds) ? registry.archivedSessionIds : []
  } catch {
    archivedIds = []
  }
  const archived = new Set(archivedIds)

  const all = []
  for (const header of headers) {
    const sessionId = header.id
    const cwd = typeof header.cwd === 'string' ? header.cwd : undefined
    const directories = await findSessionDirectories(home, sessionId)
    const bytes = (await Promise.all(directories.map(directoryBytes))).reduce((a, b) => a + b, 0)
    const owner = workspaceBySession.get(sessionId)
    all.push({
      sessionId,
      cwd,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
      bytes,
      directories,
      grouped: accounted.has(sessionId),
      workspaceId: owner ? owner.id : UNGROUPED_ID,
      isBili: isSameOrUnder(biliDir, cwd),
      archived: archived.has(sessionId),
      live: isLive(ctx, sessionId),
    })
  }

  // Attach the display title every row will show. The title comes from the
  // Session's own log through the harness's title fold, so the panel names a
  // Session the way the sidebar does rather than by its raw id.
  const titles = await foldTitles(ctx, all.map((row) => row.sessionId))
  for (const row of all) row.title = titles.get(row.sessionId) ?? null

  // One bucket per Workspace, plus the Ungrouped bucket. Grouped buckets keep
  // the registry's order; Ungrouped is appended last.
  const buckets = new Map()
  for (const workspace of registryWorkspaces) {
    if (workspace?.id === undefined) continue
    buckets.set(workspace.id, {
      id: workspace.id,
      path: workspace.path ?? null,
      title: workspace.title ?? workspace.path ?? workspace.id,
      kind: 'grouped',
      rows: [],
    })
  }
  buckets.set(UNGROUPED_ID, {
    id: UNGROUPED_ID,
    path: null,
    title: UNGROUPED_TITLE,
    kind: 'ungrouped',
    rows: [],
  })
  for (const row of all) {
    const bucket = buckets.get(row.workspaceId)
    if (bucket !== undefined) bucket.rows.push(row)
  }

  // The B 站 bucket is cross-cutting: it lists every B 站 Session whatever
  // Workspace owns it, so it deliberately overlaps a grouped bucket.
  const biliBucket = {
    id: BILI_ID,
    path: null,
    title: BILI_TITLE,
    kind: 'bili',
    rows: all.filter((row) => row.isBili),
  }

  const groups = [...buckets.values(), biliBucket].sort((a, b) => {
    const rank = { grouped: 0, ungrouped: 1, bili: 2 }
    return rank[a.kind] - rank[b.kind]
  })
  for (const bucket of groups) {
    bucket.sessionCount = bucket.rows.length
    bucket.bytes = bucket.rows.reduce((sum, row) => sum + row.bytes, 0)
  }

  return {
    home,
    biliDir,
    groups,
    all,
    ungrouped: all.filter((row) => !row.grouped),
    bili: biliBucket.rows,
  }
}

/** One JSON-ready row for the browser. */
function rowToJson(row) {
  return {
    sessionId: row.sessionId,
    title: row.title ?? null,
    cwd: row.cwd ?? null,
    createdAt: row.createdAt,
    bytes: row.bytes,
    directories: row.directories,
    isBili: row.isBili,
    archived: row.archived,
    live: row.live,
  }
}

/** Trim a plan down to what the browser is allowed to see. */
function summarize(plan) {
  const totals = {
    stored: plan.all.length,
    grouped: plan.all.length - plan.ungrouped.length,
    ungrouped: plan.ungrouped.length,
    ungroupedBytes: plan.ungrouped.reduce((sum, row) => sum + row.bytes, 0),
    bili: plan.bili.length,
    biliBytes: plan.bili.reduce((sum, row) => sum + row.bytes, 0),
    workspaceCount: plan.groups.filter((bucket) => bucket.kind === 'grouped').length,
  }
  const groups = plan.groups.map((bucket) => ({
    id: bucket.id,
    path: bucket.path,
    title: bucket.title,
    kind: bucket.kind,
    sessionCount: bucket.sessionCount,
    bytes: bucket.bytes,
    rows: bucket.rows.slice(0, MAX_REPORTED_ROWS).map(rowToJson),
    truncated: bucket.rows.length > MAX_REPORTED_ROWS,
  }))
  return {
    home: plan.home,
    biliDir: plan.biliDir,
    groups,
    ungrouped: plan.ungrouped.slice(0, MAX_REPORTED_ROWS).map(rowToJson),
    bili: plan.bili.slice(0, MAX_REPORTED_ROWS).map(rowToJson),
    ungroupedTruncated: plan.ungrouped.length > MAX_REPORTED_ROWS,
    biliTruncated: plan.bili.length > MAX_REPORTED_ROWS,
    totals,
  }
}

/**
 * Call `dsh-session-purge`'s purge endpoint for one Session.
 *
 * The request goes to the same in-process web server. Node's `fetch` sends no
 * `Origin`, which the purge route's `requireOwnPage` accepts; the marker header
 * is set explicitly and a cross-origin page could not set it without a preflight
 * the server does not answer.
 */
async function callPurge(origin, sessionId, mode) {
  const response = await fetch(`${origin}${PURGE_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-session-purge': '1' },
    body: JSON.stringify({ sessionId, mode, confirm: true }),
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok || payload === null || payload.ok !== true) {
    const reason = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status} ${response.statusText}`
    throw new Error(String(reason))
  }
  return payload
}

/**
 * Delete one scope's Sessions through the purge plugin.
 *
 * The target list is recomputed here from the stored Sessions: `all` is every
 * ungrouped Session, `bili` is every B 站 Session, `workspace` is every Session
 * of one bucket, and `selected` is every named Session that the Host actually
 * sees in the stored corpus. A Workspace record is never touched — only its
 * Sessions go.
 *
 * @param ctx - Host plugin context.
 * @param scope - `all`, `bili`, `workspace`, or `selected`.
 * @param mode - one of {@link MODES}.
 * @param workspaceId - the bucket id when `scope` is `workspace`.
 * @param sessionIds - the checked Session ids when `scope` is `selected`.
 * @returns a per-Session report; every failure is reported rather than thrown.
 */
export async function clean(ctx, scope, mode, workspaceId, sessionIds) {
  const plan = await collect(ctx)
  let targets
  if (scope === 'bili') {
    targets = plan.bili
  } else if (scope === 'workspace') {
    const bucket = plan.groups.find((group) => group.id === workspaceId)
    targets = bucket ? bucket.rows : []
  } else if (scope === 'selected') {
    // The browser names the Sessions it checked; the Host only accepts ids it
    // actually sees in the stored corpus, so a tampered request cannot reach a
    // Session the user never saw.
    const known = new Map(plan.all.map((row) => [row.sessionId, row]))
    targets = (Array.isArray(sessionIds) ? sessionIds : [])
      .filter((id) => known.has(id))
      .map((id) => known.get(id))
  } else {
    targets = plan.ungrouped
  }
  const origin = ctx.webServer.getOrigin()

  const results = []
  for (const row of targets) {
    try {
      const payload = await callPurge(origin, row.sessionId, mode)
      results.push({
        sessionId: row.sessionId,
        ok: true,
        cwd: row.cwd ?? null,
        isBili: row.isBili,
        removed: payload.removed ?? null,
        plan: payload.plan ?? null,
        // purge 0.2.0 起会如实报告「文件没删净、记录被保留」；这一层原样转发，
        // 否则界面上「成功」会把还留在磁盘上的产物盖过去。
        partial: payload.partial === true,
        recordKept: payload.recordKept === true,
        errors: Array.isArray(payload.errors) ? payload.errors : [],
      })
    } catch (error) {
      results.push({ sessionId: row.sessionId, ok: false, cwd: row.cwd ?? null, isBili: row.isBili, error: describe(error) })
    }
  }

  const failed = results.filter((row) => row.ok !== true).length
  const partial = results.filter((row) => row.ok === true && row.recordKept === true).length
  ctx.logger?.info?.(
    `dsh-workspace-cleanup: scope=${scope} workspace=${workspaceId ?? '-'} mode=${mode} targets=${targets.length} ok=${results.length - failed} failed=${failed}`
    + (partial > 0 ? ` partial=${partial}` : ''),
  )
  return {
    scope,
    workspaceId: workspaceId ?? null,
    mode,
    home: plan.home,
    biliDir: plan.biliDir,
    targetCount: targets.length,
    partialCount: partial,
    results,
  }
}

/**
 * Read a full request body as JSON.
 * @param req - incoming Node request.
 * @returns the parsed body; an absent body parses as `{}`.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/** Answer one JSON response. */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Refuse anything that did not come from this plugin's own page.
 * @param req - incoming request.
 * @param marker - the header name this plugin demands.
 */
function requireOwnPage(req, marker) {
  if (req.headers?.[marker] !== '1') throw new Error('缺少插件请求标记')
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return
  let originHost = null
  try {
    originHost = new URL(origin).host
  } catch {
    throw new Error('请求来源不合法')
  }
  const host = req.headers.host
  if (typeof host === 'string' && host !== '' && originHost !== host) throw new Error('已拒绝跨站请求')
}

/**
 * Mount the three routes.
 * @param ctx - Host plugin context, with `webServer` and `sessionPersistence`.
 */
export function apply(ctx) {
  const server = ctx.webServer

  /** Route bodies share one shape: validate, run, answer, never throw out. */
  const wrap = (handler) => (req, res) => {
    void (async () => {
      try {
        await handler(req, res)
      } catch (error) {
        if (!res.headersSent) sendJson(res, 400, { ok: false, error: describe(error) })
        else res.end()
      }
    })()
  }

  ctx.effect(() => server.register({
    kind: 'exact',
    path: `${ROUTE}/health`,
    handler: wrap((req, res) => {
      sendJson(res, 200, { ok: true, plugin: name, version: '0.6.1' })
    }),
  }), 'dsh-workspace-cleanup: health route')

  ctx.effect(() => server.register({
    kind: 'exact',
    path: `${ROUTE}/scan`,
    handler: wrap(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只接受 POST' })
        return
      }
      requireOwnPage(req, MARKER)
      const plan = await collect(ctx)
      sendJson(res, 200, { ok: true, ...summarize(plan) })
    }),
  }), 'dsh-workspace-cleanup: scan route')

  ctx.effect(() => server.register({
    kind: 'exact',
    path: `${ROUTE}/clean`,
    handler: wrap(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只接受 POST' })
        return
      }
      requireOwnPage(req, MARKER)
      const body = await readJsonBody(req)
      const scope = body?.scope
      if (scope !== 'all' && scope !== 'bili' && scope !== 'workspace' && scope !== 'selected') throw new Error('清理范围不合法')
      let workspaceId
      if (scope === 'workspace') {
        workspaceId = body?.workspaceId
        if (typeof workspaceId !== 'string' || workspaceId === '') throw new Error('缺少工作区 id')
      }
      let sessionIds
      if (scope === 'selected') {
        sessionIds = body?.sessionIds
        if (!Array.isArray(sessionIds)) throw new Error('缺少选中会话列表')
      }
      const mode = body?.mode === undefined ? DEFAULT_MODE : body.mode
      if (typeof mode !== 'string' || !MODES.includes(mode)) throw new Error('删除模式不合法')
      if (body?.confirm !== true) throw new Error('缺少清理确认')

      const result = await clean(ctx, scope, mode, workspaceId, sessionIds)
      sendJson(res, 200, { ok: true, ...result })
    }),
  }), 'dsh-workspace-cleanup: clean route')
}

// Re-exported for the offline verification suite, which drives the plan and the
// purge calls against a stub Host context and a scratch DSH home.
export const internals = {
  clean,
  collect,
  callPurge,
  directoryBytes,
  findSessionDirectories,
  foldTitle,
  foldTitles,
  headerOf,
  isLive,
  isSameOrUnder,
  requireOwnPage,
  resolveHome,
  summarize,
}
