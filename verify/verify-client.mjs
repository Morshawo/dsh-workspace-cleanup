/**
 * Offline verification for dsh-workspace-cleanup's browser half.
 *
 * The browser half is a hand-written module-loader bundle, so it cannot be
 * `import`ed directly. This suite loads it in a `vm` sandbox with mocked
 * `window.__ModuleLoader__`, a small React-hook simulator and mocked
 * primitives, then drives `apply()` and renders the `Panel` component against a
 * canned scan.
 *
 * The assertions cover:
 *   * the settings-nav row: the shell keys each row's icon on its section id and
 *     falls back to a gear for ids it does not know, and this plugin carries no
 *     icon of its own — the label is plain text and the CSS carries no
 *     gear-hiding rule;
 *   * the workspace panel: one card per bucket, each with its own
 *     "清理该工作区" button, and the two global quick actions still at the bottom;
 *   * the fold ("收纳") toggle: folding a card hides its Session list *and* its
 *     clean button, so a folded card cannot be cleaned by accident.
 *
 *   node verify/verify-client.mjs
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

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

/** Minimal React element shape; enough for the factory and the label thunk. */
const element = (type, props, ...children) => ({ type, props: props ?? {}, children })

/**
 * A tiny hooks simulator: state persists across renders, `setState` accepts a
 * value or an updater, and effects are never invoked (so the panel never calls
 * `fetch`). `__resetHooks` rewinds the hook cursor before each render and
 * `__setSlot` seeds one hook's value.
 */
function createReact() {
  const slots = []
  let cursor = 0
  return {
    __resetHooks: () => { cursor = 0 },
    __setSlot: (index, value) => { slots[index] = { value } },
    createElement: element,
    Fragment: 'Fragment',
    Component: class { constructor(props) { this.props = props } },
    useState(initial) {
      const slot = cursor++
      if (slots[slot] === undefined) slots[slot] = { value: typeof initial === 'function' ? initial() : initial }
      return [
        slots[slot].value,
        (value) => { slots[slot].value = typeof value === 'function' ? value(slots[slot].value) : value },
      ]
    },
    useEffect: () => { cursor++; return undefined },
    useCallback: (fn) => { cursor++; return fn },
    useSyncExternalStore: () => { cursor++; return null },
  }
}

const React = createReact()

const primitives = {
  Button: 'Button',
  Checkbox: 'Checkbox',
  IconWarningOutlineRegular: 'IconWarningOutlineRegular',
  IconChevronUpOutlineMedium: 'IconChevronUpOutlineMedium',
  IconChevronDownOutlineMedium: 'IconChevronDownOutlineMedium',
  Modal: 'Modal',
}

let captured = null
let styleEl = null

const registrations = []
const slots = {
  inject(name, fn) { registrations.push({ name, fn }) },
  register(options, component) { return { options, component } },
}

const sandbox = {
  console,
  window: { __ModuleLoader__: { load: (options) => { captured = options } } },
  document: {
    createElement: (tag) => {
      const el = { tag, attrs: {}, textContent: '' }
      el.setAttribute = (key, value) => { el.attrs[key] = value }
      if (tag === 'style') styleEl = el
      return el
    },
    head: { appendChild() {} },
    querySelectorAll: () => [],
  },
  MutationObserver: class { observe() {} disconnect() {} },
  require: (name) => (name === 'react' ? React : primitives),
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

const plugin = captured.factory(sandbox.require)
plugin.apply({ get: () => slots, effect: (fn) => fn() })

console.log('module contract')
equal('loader id is the package name', captured.id, 'dsh-workspace-cleanup')
equal('inject declares slots', plugin.inject.join(','), 'slots')

console.log('slot registrations')
const sectionEntry = registrations.find((entry) => entry.name === 'settings.section')
const overlayEntry = registrations.find((entry) => entry.name === 'shell.overlay')
check('settings.section registered', sectionEntry !== undefined)
check('shell.overlay registered', overlayEntry !== undefined)

const section = sectionEntry.fn()
equal('section id', section.options.id, 'workspace-cleanup')
equal('section order sits next to 刷B站', section.options.order, 35)

console.log('nav label')
const label = section.options.label()
check('label is a thunk', typeof section.options.label === 'function')
check('label is a string, not a React node', typeof label === 'string')
equal('label is the plain nav text', label, '清理工作区')

console.log('gear CSS')
const css = styleEl?.textContent ?? ''
check('style element was created', styleEl !== null)
check('CSS carries no gear-hiding rule', !css.includes('.wCInkW_navIcon') && !css.includes('wc-nav-trash'))
check('CSS styles the fold toggle', css.includes('[data-wc-ws-head]') && css.includes('[data-wc-ws-arrow]'))

console.log('workspace panel')
const row = (sessionId, cwd, bytes, isBili, title) => ({ sessionId, cwd, bytes, isBili, title: title ?? null, archived: false, live: false, createdAt: null, directories: [] })
const scan = {
  home: '/x',
  biliDir: '/x/bili-duty',
  groups: [
    { id: 'ws-a', path: '/ws-a', title: 'A', kind: 'grouped', sessionCount: 1, bytes: 10, rows: [row('s1', '/ws-a', 10, false, 'A 的第一个会话')], truncated: false },
    { id: 'ungrouped', path: null, title: '未分组', kind: 'ungrouped', sessionCount: 1, bytes: 20, rows: [row('s2', null, 20, true)], truncated: false },
    { id: 'bili', path: null, title: 'B站会话', kind: 'bili', sessionCount: 1, bytes: 20, rows: [row('s2', '/x/bili-duty', 20, true)], truncated: false },
  ],
  ungrouped: [row('s2', null, 20, true)],
  bili: [row('s2', '/x/bili-duty', 20, true)],
  totals: { stored: 2, ungrouped: 1, bili: 1, workspaceCount: 1 },
}

const Panel = section.component

let opened = []
const dialogStore = {
  open: (request) => { opened.push(request) },
  close() {},
}

/** Render the Panel with the canned scan seeded into the first useState hook. */
function renderWithScan() {
  React.__resetHooks()
  React.__setSlot(0, scan)
  return Panel({ dialogStore })
}

/** Flatten the element tree, visiting every element. */
function walk(node, visit) {
  if (node === null || node === undefined) return
  if (typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return }
  if (typeof node === 'object' && 'type' in node) {
    visit(node)
    walk(node.children, visit)
  }
}

/** Collect the text of one element's children. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'children' in node) return textOf(node.children)
  return ''
}

/** Every button matching a data attribute. */
function buttons(root, attr) {
  const out = []
  walk(root, (el) => {
    if (el.type === 'button' && el.props?.[attr] === '') out.push(el)
  })
  return out
}

/** Every element carrying a data attribute (not just buttons). */
function elements(root, attr) {
  const out = []
  walk(root, (el) => {
    if (el.props?.[attr] === '') out.push(el)
  })
  return out
}

const panelElement = renderWithScan()
const all = []
walk(panelElement, (el) => all.push(el))
check('panel renders a page container', panelElement?.props?.['data-wc-page'] === '')

const cards = elements(panelElement, 'data-wc-ws')
equal('one card per bucket', cards.length, 3)
check('grouped card title', cards.some((c) => textOf(c).includes('A')))
check('ungrouped card title', cards.some((c) => textOf(c).includes('未分组')))
check('bili card title', cards.some((c) => textOf(c).includes('B站会话')))

console.log('fold defaults')
// Every bucket starts folded: no clean button, no Session list, up arrow.
check('every bucket starts folded', cards.every((c) => c.props['data-collapsed'] === ''), JSON.stringify(cards.map((c) => c.props['data-collapsed'])))
equal('no clean button while everything is folded', buttons(panelElement, 'data-wc-ws-btn').length, 0)
check('a folded card hides its Session list', !textOf(panelElement).includes('s1'))

const heads = elements(panelElement, 'data-wc-ws-head')
equal('one clickable head per bucket', heads.length, 3)
check('every head carries the fold handler', heads.every((el) => typeof el.props.onClick === 'function'))
check('every head is keyboard-focusable', heads.every((el) => el.props.tabIndex === 0))

const arrows = elements(panelElement, 'data-wc-ws-arrow')
equal('one arrow per bucket', arrows.length, 3)
check('a folded bucket shows the up arrow', arrows.every((el) => el.children[0]?.type === 'IconChevronUpOutlineMedium'), JSON.stringify(arrows.map((el) => el.children[0]?.type)))

const globalActions = buttons(panelElement, 'data-wc-act')
check('bottom keeps 清理全部未分组', globalActions.some((b) => textOf(b.children).includes('清理全部未分组')), JSON.stringify(globalActions.map((b) => textOf(b.children))))
check('bottom keeps 仅B站会话', globalActions.some((b) => textOf(b.children).includes('仅B站会话')), JSON.stringify(globalActions.map((b) => textOf(b.children))))

console.log('fold by clicking the header box')
// Expand ws-a by clicking its header box.
heads[0].props.onClick()
const expanded = renderWithScan()
const expandedCard = elements(expanded, 'data-wc-ws').find((c) => textOf(c).includes('A'))
check('clicking the head expands the card', expandedCard?.props['data-collapsed'] === undefined)
check('the expanded card shows its Session list', textOf(expandedCard).includes('s1'))
equal('the expanded card shows its clean button', buttons(expanded, 'data-wc-ws-btn').length, 1)
check('the expanded card shows the down arrow', elements(expandedCard, 'data-wc-ws-arrow')[0]?.children[0]?.type === 'IconChevronDownOutlineMedium')
check('the expanded clean button label is 清理该工作区', textOf(buttons(expanded, 'data-wc-ws-btn')[0].children).includes('清理该工作区'))

// The Session list is not clickable for folding; each row toggles selection.
const lists = elements(expanded, 'data-wc-list')
check('the Session list is rendered when expanded', lists.length === 1)
check('the Session list does not toggle on click', lists.every((el) => el.props.onClick === undefined))
const sessionRows = elements(expanded, 'data-wc-item')
equal('the expanded card shows one Session row', sessionRows.length, 1)
check('every Session row carries a selection handler', sessionRows.every((el) => typeof el.props.onClick === 'function'))
check('every Session row shows its display title', sessionRows.every((el) => textOf(el).includes('A 的第一个会话')), JSON.stringify(sessionRows.map((el) => textOf(el))))

console.log('selection')
// Tick a Session by clicking its row; the checkbox reflects it.
const rowA = sessionRows[0]
rowA.props.onClick()
const ticked = renderWithScan()
const tickedRow = elements(ticked, 'data-wc-item')[0]
check('clicking a row selects it', tickedRow?.props['data-selected'] === '')
check('the selected row shows a checked box', elements(tickedRow, 'data-wc-check')[0]?.props['data-on'] === '')
check('the selection count line appears', textOf(ticked).includes('已选中 1 个会话'))
check('the selected button shows the count', textOf(buttons(ticked, 'data-wc-act').find((b) => textOf(b.children).includes('清理选中会话'))).includes('1'))

// The conditional button exists only while something is ticked, and clears it.
const clearButton = buttons(ticked, 'data-wc-btn').find((b) => textOf(b.children).includes('取消全部选中'))
check('a 取消全部选中 button appears while something is ticked', clearButton !== undefined)
check('the 取消全部选中 button is primary-styled', clearButton?.props['data-primary'] === '')
opened = []
clearButton.props.onClick()
const cleared = renderWithScan()
check('clicking 取消全部选中 clears every tick', !textOf(cleared).includes('已选中'))
check('clicking 取消全部选中 does not open the dialog', opened.length === 0)
check('the 取消全部选中 button disappears once nothing is ticked', buttons(cleared, 'data-wc-btn').length === 0)
check('the clean-selected button is disabled again', buttons(cleared, 'data-wc-act').find((b) => textOf(b.children).includes('清理选中会话')).props.disabled === true)

// The row is unticked now; clicking it ticks it again.
elements(cleared, 'data-wc-item')[0].props.onClick()
const tickedAgain = renderWithScan()
check('clicking an unticked row ticks it', elements(tickedAgain, 'data-wc-item')[0]?.props['data-selected'] === '')

// Click again to untick.
elements(tickedAgain, 'data-wc-item')[0].props.onClick()
const unticked = renderWithScan()
check('clicking a selected row unticks it', elements(unticked, 'data-wc-item')[0]?.props['data-selected'] === undefined)
check('the selection count line disappears', !textOf(unticked).includes('已选中'))
check('the clean-selected button is disabled with nothing ticked', buttons(unticked, 'data-wc-act').find((b) => textOf(b.children).includes('清理选中会话')).props.disabled === true)

// Tick again and open the confirm dialog for the selection.
elements(unticked, 'data-wc-item')[0].props.onClick()
const selectedPanel = renderWithScan()
opened = []
buttons(selectedPanel, 'data-wc-act').find((b) => textOf(b.children).includes('清理选中会话')).props.onClick()
equal('the clean-selected button opens the dialog once', opened.length, 1)
equal('the dialog is scoped to the selection', opened[0]?.scope, 'selected')
equal('the dialog carries the ticked id', opened[0]?.sessionIds?.[0], 's1')
check('the dialog carries the ticked row', Array.isArray(opened[0]?.rows) && opened[0].rows.length === 1 && opened[0].rows[0].sessionId === 's1')

// Clicking the clean button opens the dialog and must not fold the card.
opened = []
buttons(expanded, 'data-wc-ws-btn')[0].props.onClick({ stopPropagation() {} })
equal('the clean button opens the dialog once', opened.length, 1)
equal('the dialog is scoped to the Workspace', opened[0]?.scope, 'workspace')
equal('the dialog targets the right Workspace', opened[0]?.workspaceId, 'ws-a')
const afterClean = renderWithScan()
check('the clean button does not fold the card', elements(afterClean, 'data-wc-ws').find((c) => textOf(c).includes('A'))?.props['data-collapsed'] === undefined)

// Clicking the head again folds it back.
elements(afterClean, 'data-wc-ws-head').find((h) => textOf(h).includes('A')).props.onClick()
const refolded = renderWithScan()
check('clicking the head again folds the card', elements(refolded, 'data-wc-ws').find((c) => textOf(c).includes('A'))?.props['data-collapsed'] === '')
check('the refolded card shows the up arrow again', elements(refolded, 'data-wc-ws-arrow').find((a) => a.children[0]?.type === 'IconChevronUpOutlineMedium') !== undefined)

// All three are folded again: no clean button anywhere.
equal('no clean button when every card is folded', buttons(refolded, 'data-wc-ws-btn').length, 0)

// Expand every card: one clean button per bucket.
elements(renderWithScan(), 'data-wc-ws-head').forEach((h) => h.props.onClick())
const allExpanded = renderWithScan()
equal('every expanded card shows a clean button', buttons(allExpanded, 'data-wc-ws-btn').length, 3)

// Fold every card again.
elements(renderWithScan(), 'data-wc-ws-head').forEach((h) => h.props.onClick())
const allFolded = renderWithScan()
equal('no clean button when every card is folded again', buttons(allFolded, 'data-wc-ws-btn').length, 0)
check('global actions survive folding', buttons(allFolded, 'data-wc-act').length === 3)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
