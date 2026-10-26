/**
 * Offline verification for dsh-workspace-cleanup's Host half.
 *
 * Runs with no DSH process, no ports and no prompts: a scratch DSH home, a stub
 * `sessionPersistence`, a stub `workspaceRegistry` and a stub `webServer` stand
 * in for the deployment, and `globalThis.fetch` records the calls the plugin
 * makes to `dsh-session-purge`. The assertions cover the two things that must
 * never be wrong here — which Sessions count as ungrouped / B 站, and that the
 * purge call list never includes a Session some Workspace accounts for.
 *
 *   node verify/verify-host.mjs
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, internals } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const scratch = join(here, '..', '.scratch', 'verify-host')

let failures = 0
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

function equal(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** Read a JSON response captured by the stub response object. */
async function callRoute(handler, { method = 'POST', body, headers } = {}) {
  const request = {
    method,
    headers: headers ?? {
      'x-dsh-workspace-cleanup': '1',
      host: '127.0.0.1:19387',
      origin: 'http://127.0.0.1:19387',
    },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
  let status = 0
  let payload = null
  let settle
  const finished = new Promise((resolve) => { settle = resolve })
  const response = {
    headersSent: false,
    writeHead(value) {
      status = value
      this.headersSent = true
    },
    end(chunk) {
      if (chunk !== undefined) payload = JSON.parse(Buffer.from(chunk).toString('utf8'))
      settle()
    },
  }
  void handler(request, response)
  await finished
  return { status, payload }
}

const GROUPED_A = 'session-aaaa1111-1111-1111-1111-111111111111'
const GROUPED_B = 'session-bbbb2222-2222-2222-2222-222222222222'
const BILI_1 = 'session-cccc3333-3333-3333-3333-333333333333'
const BILI_2 = 'session-dddd4444-4444-4444-4444-444444444444'
const STRAY = 'session-eeee5555-5555-5555-5555-555555555555'

function headerFor(id, cwd) {
  return { type: 'session', version: 4, id, createdAt: 1700000000000, cwd, isSeeded: false, delegationDepth: 0 }
}

async function main() {
  await rm(scratch, { recursive: true, force: true })

  const home = join(scratch, 'home')
  const workspaceA = join(scratch, 'workspace-a')
  const biliDir = join(home, 'bili-duty')
  const strayDir = join(scratch, 'stray')

  for (const dir of [workspaceA, biliDir, strayDir]) await mkdir(dir, { recursive: true })

  const layout = [
    ['--proj-a--', [GROUPED_A, GROUPED_B]],
    ['--proj-bili--', [BILI_1, BILI_2]],
    ['--proj-stray--', [STRAY]],
  ]
  for (const [project, ids] of layout) {
    for (const id of ids) {
      const dir = join(home, 'sessions', project, id)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'stub', 'utf8')
    }
  }
  await writeFile(join(biliDir, 'duty.log'), 'stub', 'utf8')

  process.env.DSH_HOME = home

  const persistence = {
    async list() {
      return [
        { header: headerFor(GROUPED_A, workspaceA) },
        { header: headerFor(GROUPED_B, workspaceA) },
        { header: headerFor(BILI_1, biliDir) },
        { header: headerFor(BILI_2, biliDir) },
        { header: headerFor(STRAY, strayDir) },
      ]
    },
  }

  const registry = {
    list() {
      return [{
        id: 'ws-a',
        path: workspaceA,
        title: 'workspace-a',
        get sessionIds() { return [GROUPED_A, GROUPED_B] },
      }]
    },
    get archivedSessionIds() { return [] },
  }

  const ctx = {
    sessionPersistence: persistence,
    webServer: { getOrigin: () => 'http://127.0.0.1:19387' },
    get(key) {
      if (key === 'workspaceRegistry') return registry
      return undefined
    },
    logger: { info() {}, warn() {} },
  }

  // ── collect / classify ────────────────────────────────────────────────────
  console.log('collect / classify')
  const plan = await internals.collect(ctx)
  const ungroupedIds = plan.ungrouped.map((row) => row.sessionId).sort()
  equal('ungrouped count', ungroupedIds.length, 3)
  check('ungrouped = bili + stray', ungroupedIds.includes(BILI_1) && ungroupedIds.includes(BILI_2) && ungroupedIds.includes(STRAY), JSON.stringify(ungroupedIds))
  check('grouped sessions excluded', !ungroupedIds.includes(GROUPED_A) && !ungroupedIds.includes(GROUPED_B), JSON.stringify(ungroupedIds))
  equal('bili count', plan.bili.length, 2)
  check('bili = the two bili sessions', plan.bili.map((r) => r.sessionId).sort().join(',') === [BILI_1, BILI_2].sort().join(','), JSON.stringify(plan.bili.map((r) => r.sessionId)))
  check('bili cwd recorded', plan.bili.every((row) => row.cwd === biliDir))
  equal('ungrouped rows', plan.ungrouped.length, 3)
  equal('grouped rows', plan.all.length - plan.ungrouped.length, 2)

  // Every Session lands in exactly one Workspace bucket, plus the B 站 bucket.
  equal('groups has one grouped bucket', plan.groups.filter((g) => g.kind === 'grouped').length, 1)
  const groupedBucket = plan.groups.find((g) => g.kind === 'grouped')
  equal('grouped bucket session count', groupedBucket.sessionCount, 2)
  check('grouped bucket rows are the two grouped sessions',
    groupedBucket.rows.map((r) => r.sessionId).sort().join(',') === [GROUPED_A, GROUPED_B].sort().join(','),
    JSON.stringify(groupedBucket.rows.map((r) => r.sessionId)))
  const ugBucket = plan.groups.find((g) => g.kind === 'ungrouped')
  equal('ungrouped bucket session count', ugBucket.sessionCount, 3)
  check('ungrouped bucket id', ugBucket.id, 'ungrouped')
  const biliBucket = plan.groups.find((g) => g.kind === 'bili')
  equal('bili bucket session count', biliBucket.sessionCount, 2)
  check('bili bucket id', biliBucket.id, 'bili')
  // Grouped buckets sort first, then Ungrouped, then B 站.
  equal('group order', plan.groups.map((g) => g.kind).join(','), 'grouped,ungrouped,bili')

  console.log('isSameOrUnder')
  check('bili cwd is under bili dir', internals.isSameOrUnder(biliDir, biliDir) === true)
  check('deeper bili path is under', internals.isSameOrUnder(biliDir, join(biliDir, 'out')) === true)
  check('workspace is not under bili dir', internals.isSameOrUnder(biliDir, workspaceA) === false)
  check('prefix sibling is not under', internals.isSameOrUnder(biliDir, join(scratch, 'bili-duty-other')) === false)
  check('forward-slash spelling matches', internals.isSameOrUnder(biliDir, biliDir.replace(/\\/g, '/')) === true)

  // ── clean scopes ──────────────────────────────────────────────────────────
  console.log('clean scopes')
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(String(options.body))
    calls.push({ url: String(url), body })
    // purge 0.2.0：文件没删净时会返回 partial/recordKept 并带着错误明细。
    // STRAY 模拟这一支，其余全成功——转发层必须原样带出，不许盖成「成功」。
    if (body.sessionId === STRAY) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          ok: true,
          partial: true,
          recordKept: true,
          retryable: true,
          removed: { directories: [], artifactBytes: 0 },
          plan: { cwd: '/tmp/stray', refusedCount: 0, warnings: ['1 个文件删除失败，已保留会话记录以便重试。'] },
          errors: [{ step: 'artifact', path: '/tmp/stray/x.txt', message: 'EPERM: still locked' }],
        }),
      }
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ ok: true, removed: { directories: ['x'], directoryBytes: 1 }, plan: {}, errors: [] }),
    }
  }
  try {
    const all = await internals.clean(ctx, 'all', 'artifacts')
    equal('all: target count', all.targetCount, 3)
    const allIds = calls.map((c) => c.body.sessionId).sort()
    equal('all: purge call count', calls.length, 3)
    check('all: never purges a grouped session', !allIds.includes(GROUPED_A) && !allIds.includes(GROUPED_B), JSON.stringify(allIds))
    check('all: purges every ungrouped session', allIds.includes(BILI_1) && allIds.includes(BILI_2) && allIds.includes(STRAY), JSON.stringify(allIds))
    check('all: purge url targets the purge plugin', calls.every((c) => c.url.includes('/plugins/dsh-session-purge/api/purge')), calls[0]?.url)
    // v0.6.1：转发层必须把 purge 的 partial/recordKept 原样带出并汇总，
    // 否则界面上「全部成功」会盖住还在磁盘上的产物。
    equal('all: partial run is counted', all.partialCount, 1)
    const strayRow = all.results.find((r) => r.sessionId === STRAY)
    check('all: the partial row keeps ok=true (the purge itself answered)', strayRow?.ok === true)
    check('all: the partial row is flagged recordKept', strayRow?.recordKept === true)
    check('all: the partial row carries its error', Array.isArray(strayRow?.errors) && strayRow.errors.length === 1)
    const cleanRow = all.results.find((r) => r.sessionId === BILI_1)
    check('all: a fully deleted row is not flagged partial', cleanRow?.recordKept === false && cleanRow?.partial === false)

    calls.length = 0
    const bili = await internals.clean(ctx, 'bili', 'artifacts')
    equal('bili: target count', bili.targetCount, 2)
    const biliIds = calls.map((c) => c.body.sessionId).sort()
    equal('bili: purge call count', calls.length, 2)
    check('bili: only bili sessions', biliIds.includes(BILI_1) && biliIds.includes(BILI_2) && !biliIds.includes(STRAY), JSON.stringify(biliIds))

    calls.length = 0
    const ws = await internals.clean(ctx, 'workspace', 'artifacts', 'ws-a')
    equal('workspace: target count', ws.targetCount, 2)
    equal('workspace: result carries the id', ws.workspaceId, 'ws-a')
    const wsIds = calls.map((c) => c.body.sessionId).sort()
    equal('workspace: purge call count', calls.length, 2)
    check('workspace: only that workspace', wsIds.includes(GROUPED_A) && wsIds.includes(GROUPED_B) && !wsIds.includes(BILI_1) && !wsIds.includes(STRAY), JSON.stringify(wsIds))

    calls.length = 0
    const ungroupedWs = await internals.clean(ctx, 'workspace', 'artifacts', 'ungrouped')
    equal('workspace(ungrouped): target count', ungroupedWs.targetCount, 3)
    const ugIds = calls.map((c) => c.body.sessionId).sort()
    check('workspace(ungrouped): ungrouped only', ugIds.includes(BILI_1) && ugIds.includes(BILI_2) && ugIds.includes(STRAY) && !ugIds.includes(GROUPED_A), JSON.stringify(ugIds))

    calls.length = 0
    const biliWs = await internals.clean(ctx, 'workspace', 'artifacts', 'bili')
    equal('workspace(bili): target count', biliWs.targetCount, 2)
    const biliWsIds = calls.map((c) => c.body.sessionId).sort()
    check('workspace(bili): bili only', biliWsIds.includes(BILI_1) && biliWsIds.includes(BILI_2) && !biliWsIds.includes(STRAY), JSON.stringify(biliWsIds))

    calls.length = 0
    const unknownWs = await internals.clean(ctx, 'workspace', 'artifacts', 'nope')
    equal('workspace(unknown): no targets', unknownWs.targetCount, 0)
    equal('workspace(unknown): no purge call', calls.length, 0)

    calls.length = 0
    const selected = await internals.clean(ctx, 'selected', 'artifacts', undefined, [GROUPED_A, 'bogus-id', BILI_1])
    equal('selected: target count', selected.targetCount, 2)
    equal('selected: result reports the scope', selected.scope, 'selected')
    const selectedIds = calls.map((c) => c.body.sessionId).sort()
    check('selected: only the named stored Sessions', selectedIds.includes(GROUPED_A) && selectedIds.includes(BILI_1) && !selectedIds.includes('bogus-id'), JSON.stringify(selectedIds))

    calls.length = 0
    const selectedUnknown = await internals.clean(ctx, 'selected', 'artifacts', undefined, ['nope'])
    equal('selected(unknown): no targets', selectedUnknown.targetCount, 0)
    equal('selected(unknown): no purge call', calls.length, 0)

    calls.length = 0
    const emptyCtx = {
      ...ctx,
      sessionPersistence: { async list() { return [{ header: headerFor(GROUPED_A, workspaceA) }] } },
    }
    const empty = await internals.clean(emptyCtx, 'bili', 'artifacts')
    equal('clean on an empty scope is a no-op', empty.targetCount, 0)
    equal('clean on an empty scope makes no purge call', calls.length, 0)
  } finally {
    globalThis.fetch = realFetch
  }

  // ── summarize truncation ──────────────────────────────────────────────────
  console.log('summarize')
  const groupRows = Array.from({ length: 600 }, (_, i) => ({
    sessionId: `g${i}`, bytes: 1, directories: [], isBili: false, archived: false, live: false, cwd: null, createdAt: null,
  }))
  const many = {
    home, biliDir, groups: [
      { id: 'ws-a', path: workspaceA, title: 'A', kind: 'grouped', rows: groupRows },
      { id: 'ungrouped', path: null, title: '未分组', kind: 'ungrouped', rows: [] },
      { id: 'bili', path: null, title: 'B站会话', kind: 'bili', rows: [] },
    ],
    all: [],
    ungrouped: Array.from({ length: 600 }, (_, i) => ({ sessionId: `s${i}`, bytes: 1, directories: [], isBili: false, archived: false, live: false, cwd: null, createdAt: null })),
    bili: [],
  }
  const summary = internals.summarize(many)
  equal('summarize caps rows', summary.ungrouped.length, 500)
  equal('summarize flags truncation', summary.ungroupedTruncated, true)
  equal('summarize reports every group', summary.groups.length, 3)
  equal('summarize caps a group rows', summary.groups[0].rows.length, 500)
  equal('summarize flags a group truncation', summary.groups[0].truncated, true)
  equal('summarize keeps group kind', summary.groups[0].kind, 'grouped')

  // ── requireOwnPage ───────────────────────────────────────────────────────
  console.log('requireOwnPage')
  let threw = false
  try { internals.requireOwnPage({ headers: { host: 'x' } }, 'x-dsh-workspace-cleanup') } catch { threw = true }
  check('missing marker rejected', threw)
  threw = false
  try { internals.requireOwnPage({ headers: { 'x-dsh-workspace-cleanup': '1', origin: 'http://evil.test', host: '127.0.0.1:1' } }, 'x-dsh-workspace-cleanup') } catch { threw = true }
  check('cross-origin rejected', threw)
  threw = false
  try { internals.requireOwnPage({ headers: { 'x-dsh-workspace-cleanup': '1', origin: 'http://127.0.0.1:1', host: '127.0.0.1:1' } }, 'x-dsh-workspace-cleanup') } catch { threw = true }
  check('same-origin accepted', threw === false)
  threw = false
  try { internals.requireOwnPage({ headers: { 'x-dsh-workspace-cleanup': '1' } }, 'x-dsh-workspace-cleanup') } catch { threw = true }
  check('absent origin accepted', threw === false)

  // ── headerOf shapes ───────────────────────────────────────────────────────
  console.log('headerOf')
  check('nested header', internals.headerOf({ header: { id: 'a', version: 4 } })?.id === 'a')
  check('flat snapshot', internals.headerOf({ id: 'b', version: 4 })?.id === 'b')
  check('garbage is null', internals.headerOf(null) === null)
  check('wrong shape is null', internals.headerOf({ foo: 1 }) === null)

  // ── title folding ──────────────────────────────────────────────────────────
  console.log('title folding')
  const titleLog = [
    { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一个问题' }] } },
    { type: 'session/title', seq: 2, time: 1, data: { title: '自动标题', messageSeqs: [], source: { kind: 'fallback' } } },
    { type: 'session/title', seq: 3, time: 2, data: { title: '用户标题', messageSeqs: [], source: { kind: 'user' } } },
  ]
  equal('the latest session/title event wins', internals.foldTitle(titleLog), '用户标题')
  equal('an empty log has no title', internals.foldTitle([]), null)
  equal('foldTitle falls back to the first user message', internals.foldTitle([{ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好世界' }] } }]), '你好世界')
  equal('foldTitle ignores assistant messages', internals.foldTitle([{ type: 'assistant/message', seq: 1, data: { content: [{ type: 'text', text: '回复' }] } }]), null)
  equal('foldTitle skips a blank title event', internals.foldTitle([
    { type: 'session/title', seq: 1, time: 1, data: { title: '   ', messageSeqs: [], source: { kind: 'fallback' } } },
    { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真正标题' }] } },
  ]), '真正标题')

  const titleCtx = {
    ...ctx,
    sessionPersistence: {
      async list() { return [] },
      async open(id) {
        return {
          async read() { return { events: id === GROUPED_A ? titleLog : [] } },
          async close() {},
        }
      },
    },
  }
  const folded = await internals.foldTitles(titleCtx, [GROUPED_A, GROUPED_B])
  equal('foldTitles maps the folded title', folded.get(GROUPED_A), '用户标题')
  check('foldTitles leaves an unreadable log without a title', !folded.has(GROUPED_B))

  // ── routes ────────────────────────────────────────────────────────────────
  console.log('routes')
  const routes = new Map()
  const routeCtx = {
    ...ctx,
    webServer: {
      ...ctx.webServer,
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    effect(fn) { fn() },
  }
  apply(routeCtx)
  check('health route registered', routes.has('/plugins/dsh-workspace-cleanup/api/health'))
  check('scan route registered', routes.has('/plugins/dsh-workspace-cleanup/api/scan'))
  check('clean route registered', routes.has('/plugins/dsh-workspace-cleanup/api/clean'))

  const scanRoute = routes.get('/plugins/dsh-workspace-cleanup/api/scan')
  const scanResult = await callRoute(scanRoute.handler, { body: {} })
  equal('scan route answers 200', scanResult.status, 200)
  equal('scan route ok', scanResult.payload.ok, true)
  equal('scan route totals.ungrouped', scanResult.payload.totals.ungrouped, 3)

  const badScan = await callRoute(scanRoute.handler, { body: {}, headers: { host: 'x' } })
  equal('scan route rejects a missing marker', badScan.status, 400)

  const cleanRoute = routes.get('/plugins/dsh-workspace-cleanup/api/clean')
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(String(options.body)) })
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ ok: true, removed: {}, plan: {}, errors: [] }) }
  }
  try {
    const cleanResult = await callRoute(cleanRoute.handler, { body: { scope: 'bili', mode: 'artifacts', confirm: true } })
    equal('clean route answers 200', cleanResult.status, 200)
    equal('clean route scope', cleanResult.payload.scope, 'bili')
    equal('clean route target count', cleanResult.payload.targetCount, 2)
    equal('clean route forwarded the mode', calls[0]?.body.mode, 'artifacts')

    const wsClean = await callRoute(cleanRoute.handler, { body: { scope: 'workspace', workspaceId: 'ws-a', mode: 'artifacts', confirm: true } })
    equal('clean route workspace answers 200', wsClean.status, 200)
    equal('clean route workspace scope', wsClean.payload.scope, 'workspace')
    equal('clean route workspace id', wsClean.payload.workspaceId, 'ws-a')
    equal('clean route workspace target count', wsClean.payload.targetCount, 2)

    const wsNoId = await callRoute(cleanRoute.handler, { body: { scope: 'workspace', mode: 'artifacts', confirm: true } })
    equal('clean route workspace requires an id', wsNoId.status, 400)

    const ungroupedClean = await callRoute(cleanRoute.handler, { body: { scope: 'workspace', workspaceId: 'ungrouped', mode: 'artifacts', confirm: true } })
    equal('clean route ungrouped bucket target count', ungroupedClean.payload.targetCount, 3)

    const beforeSelected = calls.length
    const selectedClean = await callRoute(cleanRoute.handler, { body: { scope: 'selected', sessionIds: [GROUPED_A, BILI_1], mode: 'artifacts', confirm: true } })
    equal('clean route selected answers 200', selectedClean.status, 200)
    equal('clean route selected scope', selectedClean.payload.scope, 'selected')
    equal('clean route selected target count', selectedClean.payload.targetCount, 2)
    equal('clean route selected purges exactly the named Sessions', calls.length - beforeSelected, 2)
    check('clean route selected purged only named Sessions', calls.slice(beforeSelected).every((c) => [GROUPED_A, BILI_1].includes(c.body.sessionId)), JSON.stringify(calls.slice(beforeSelected).map((c) => c.body.sessionId)))

    const selectedNoList = await callRoute(cleanRoute.handler, { body: { scope: 'selected', mode: 'artifacts', confirm: true } })
    equal('clean route selected requires a list', selectedNoList.status, 400)

    const selectedBadList = await callRoute(cleanRoute.handler, { body: { scope: 'selected', sessionIds: 'nope', mode: 'artifacts', confirm: true } })
    equal('clean route selected rejects a non-array list', selectedBadList.status, 400)

    const noConfirm = await callRoute(cleanRoute.handler, { body: { scope: 'all', mode: 'artifacts' } })
    equal('clean route requires confirmation', noConfirm.status, 400)

    const badScope = await callRoute(cleanRoute.handler, { body: { scope: 'nope', mode: 'artifacts', confirm: true } })
    equal('clean route rejects an unknown scope', badScope.status, 400)

    const badMode = await callRoute(cleanRoute.handler, { body: { scope: 'all', mode: 'nope', confirm: true } })
    equal('clean route rejects an unknown mode', badMode.status, 400)
  } finally {
    globalThis.fetch = realFetch
  }

  console.log(`\n${checks - failures}/${checks} checks passed`)
  // The suite owns its scratch root: remove it so a fresh checkout is
  // byte-identical to a tested tree.
  await rm(join(here, '..', '.scratch'), { recursive: true, force: true })
  if (failures > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
