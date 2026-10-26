/**
 * dsh-workspace-cleanup — browser half.
 *
 * Hand-written bundle in the module-loader format the shell expects: executing
 * it only registers a factory; the body runs at materialization. It contributes
 * two Slot entries and one tiny store:
 *
 *   * `settings.section` — the "清理工作区" row in the left-hand settings nav,
 *     placed next to "账号与余额" (order -10) and "刷B站" (order 30).
 *   * `shell.overlay` — the confirmation / result dialog, portaled over the
 *     whole frame by the shell's own Modal primitive.
 *
 * The panel lists every Workspace bucket with its Sessions, plus the Ungrouped
 * and B 站 buckets. Each bucket carries its own "清理该工作区" button; the two
 * global quick actions ("清理全部未分组", "仅B站会话") stay at the bottom. The
 * dialog asks for an explicit acknowledgement and then posts a scope to the
 * Host, which recomputes the target list itself. Nothing the page holds can
 * widen the scope.
 */

window.__ModuleLoader__.load({
  id: 'dsh-workspace-cleanup',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const {
      Button,
      Checkbox,
      IconChevronDownOutlineMedium,
      IconChevronUpOutlineMedium,
      IconWarningOutlineRegular,
      Modal,
    } = primitives

    const h = React.createElement

    /** This plugin's Host endpoints, served by the same web server as the page. */
    const API = '/plugins/dsh-workspace-cleanup/api'

    /** Marker header the Host write endpoints demand. */
    const MARKER = 'x-dsh-workspace-cleanup'

    /** Locale namespace; equals the package name by convention. */
    const NS = 'dsh-workspace-cleanup'

    /** How long a successful clean stays on screen before the page reloads. */
    const RELOAD_DELAY_MS = 1800

    /** Deletion scope forwarded to `dsh-session-purge`. */
    const MODE = 'artifacts'

    const T = {
      'nav': '清理工作区',
      'page.title': '清理工作区',
      'page.desc': '列出所有工作区及其会话，可以一键清掉某个工作区的全部会话，也可以清理未分组或 B 站会话。工作区本身不会被删除。',
      'page.scan': '重新扫描',
      'page.loading': '正在扫描工作区与会话…',
      'page.error': '读不到工作区与会话列表：{reason}',
      'page.summary': '{workspaces} 个工作区 · {sessions} 个会话',
      'page.workspaces': '已分组工作区 {count} 个',
      'page.kind.grouped': '工作区',
      'page.kind.ungrouped': '未分组',
      'page.kind.bili': 'B站会话',
      'page.ws.empty': '该工作区暂无会话。',
      'page.ws.act': '清理该工作区',
      'page.ws.toggle': '收纳',
      'page.ws.expand': '展开',
      'page.ws.truncated': '另有 {count} 个未列出。',
      'page.ungrouped': '未分组会话',
      'page.bili': 'B站会话',
      'page.ungrouped.none': '没有未分组会话。',
      'page.bili.none': '没有 B 站会话。',
      'page.ungrouped.truncated': '另有 {count} 个未列出。',
      'page.bili.truncated': '另有 {count} 个未列出。',
      'page.badge.bili': 'B站',
      'page.badge.archived': '已归档',
      'page.badge.live': '运行中',
      'page.action.all': '清理全部未分组',
      'page.action.allHint': '删除所有未分组会话（含 B 站会话）',
      'page.action.bili': '仅B站会话',
      'page.action.biliHint': '只删除刷B站插件产生的会话',
      'page.action.selected': '清理选中会话',
      'page.action.selectedHint': '删除你勾选的会话',
      'page.action.clear': '取消全部选中',
      'page.sel.count': '已选中 {count} 个会话',
      'dialog.title': '确认清理',
      'dialog.all': '清理全部未分组',
      'dialog.bili': '仅B站会话',
      'dialog.selected': '清理选中会话',
      'dialog.workspace': '清理该工作区',
      'dialog.workspaceNote': '将删除该工作区的全部会话；工作区本身保留，清空后仍是一个空工作区。',
      'dialog.selectedNote': '将删除你勾选的会话；工作区本身保留。',
      'dialog.targets': '将删除以下 {count} 个会话：',
      'dialog.none': '这个范围里没有可删除的会话。',
      'dialog.note': '删除内容：会话记录，以及该会话在其工作目录内产出的文件。位于 DSH 数据目录（`~/.dsh`）内的文件会保留。',
      'dialog.live': '该会话当前处于打开/运行状态：删除会先停止并归档它。',
      'dialog.ack': '我已知晓：删除后无法恢复',
      'dialog.cancel': '取消',
      'dialog.confirm': '确认清理',
      'dialog.deleting': '正在清理…',
      'dialog.failed': '清理失败：{reason}',
      'dialog.done.title': '清理完成',
      'dialog.done.partialTitle': '部分完成',
      'dialog.done.summary': '共处理 {count} 个会话：成功 {ok} 个，失败 {fail} 个。',
      'dialog.done.partial': '其中 {count} 个会话有文件没删掉，已保留其对话记录以便重试（原因见下）。',
      'dialog.done.reload': '页面将在 {seconds} 秒后重新加载以刷新列表。',
      'dialog.done.noReload': '存在未删净的会话，页面不会自动刷新——修复后可再清理一次同一会话。',
      'dialog.reloadNow': '立即重新加载',
      'dialog.close': '关闭',
      'dialog.warnings': '未能删除的会话',
      'dialog.partialWarnings': '未删净的会话（记录已保留）',
    }

    const CSS = `
[data-wc-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 10px;max-width:680px;}
[data-wc-group]{display:flex;flex-direction:column;gap:16px;}
[data-wc-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-wc-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-wc-grow]{flex:1;min-width:0;}
[data-wc-label]{font-size:13px;color:var(--dsw-alias-label-primary,inherit);}
[data-wc-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-wc-sec]{display:flex;flex-direction:column;gap:8px;}
[data-wc-stats]{display:flex;gap:8px;flex-wrap:wrap;}
[data-wc-chip]{font-size:11px;padding:3px 9px;border-radius:999px;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));
  color:var(--dsw-alias-label-secondary,inherit);}
[data-wc-list]{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;
  max-height:220px;overflow:auto;}
[data-wc-item]{display:flex;flex-direction:column;gap:2px;padding:7px 9px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.2));}
[data-wc-item][role='checkbox']{cursor:pointer;}
[data-wc-item][role='checkbox']:hover{border-color:var(--dsw-alias-brand-primary,rgba(76,141,255,.5));}
[data-wc-item][role='checkbox']:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);outline-offset:2px;}
[data-wc-item][data-selected]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c8dff) 55%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c8dff) 8%,transparent);}
[data-wc-item-row]{display:flex;align-items:flex-start;gap:8px;}
[data-wc-check]{flex:none;width:18px;height:18px;border-radius:5px;border:1.5px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.4));
  display:inline-flex;align-items:center;justify-content:center;background:transparent;margin-top:1px;}
[data-wc-check][data-on]{border-color:var(--dsw-alias-brand-primary,#4c8dff);background:var(--dsw-alias-brand-primary,#4c8dff);}
[data-wc-check-inner]{width:9px;height:9px;border-radius:2px;background:#fff;display:block;}
[data-wc-item-top]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
[data-wc-id]{font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:var(--dsw-alias-label-primary,inherit);word-break:break-all;}
[data-wc-cwd]{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-wc-badge]{font-size:10px;padding:1px 6px;border-radius:5px;white-space:nowrap;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.16));
  color:var(--dsw-alias-label-secondary,inherit);}
[data-wc-badge][data-bili]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c8dff) 20%,transparent);
  color:var(--dsw-alias-brand-primary,#4c8dff);}
[data-wc-badge][data-archived]{opacity:.8;}
[data-wc-actions]{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px;}
[data-wc-btn]{padding:7px 14px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.24));
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,inherit);}
[data-wc-btn]:hover{border-color:var(--dsw-alias-brand-primary,rgba(76,141,255,.55));}
[data-wc-btn][data-primary]{background:var(--dsw-alias-brand-primary,#4c8dff);border-color:var(--dsw-alias-brand-primary,#4c8dff);color:#fff;}
[data-wc-btn][data-primary]:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c8dff) 88%,#000);}
[data-wc-act]{display:flex;flex-direction:column;gap:3px;flex:1;min-width:200px;
  padding:10px 12px;border-radius:10px;cursor:pointer;text-align:left;font-family:inherit;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22));
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color:inherit;}
[data-wc-act]:hover{border-color:var(--dsw-alias-brand-primary,rgba(76,141,255,.55));
  background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));}
[data-wc-act][data-danger]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 45%,transparent);}
[data-wc-act][data-danger]:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 12%,transparent);}
[data-wc-act-t]{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);}
[data-wc-act-h]{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-wc-listbox]{max-height:260px;overflow:auto;margin:6px 0 0;padding:8px 9px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.2));
  font-size:11px;line-height:16px;}
[data-wc-listbox] div{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all;}
[data-wc-warn]{display:flex;gap:6px;align-items:flex-start;margin:6px 0 0;font-size:11px;line-height:16px;
  color:var(--dsw-alias-state-warn-primary,#f59e0b);}
[data-wc-ws]{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22));}
[data-wc-ws-head]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-wc-ws-title]{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);
  display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
[data-wc-ws-kind]{font-size:10px;padding:1px 6px;border-radius:5px;white-space:nowrap;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary,inherit);}
[data-wc-ws-kind][data-kind='ungrouped']{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c8dff) 18%,transparent);
  color:var(--dsw-alias-brand-primary,#4c8dff);}
[data-wc-ws-kind][data-kind='bili']{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c8dff) 18%,transparent);
  color:var(--dsw-alias-brand-primary,#4c8dff);}
[data-wc-ws-meta]{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);flex:1;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-wc-ws-path]{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-wc-ws-btn]{flex:none;padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 45%,transparent);
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,inherit);}
[data-wc-ws-btn]:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 12%,transparent);}
[data-wc-ws-btn][disabled]{opacity:.5;cursor:default;}
[data-wc-ws-head]{cursor:pointer;border-radius:8px;}
[data-wc-ws-head]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));}
[data-wc-ws-head]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);outline-offset:2px;}
[data-wc-ws-arrow]{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-wc-ws][data-collapsed]{border-style:dashed;}
`

    /** Human-readable byte size. */
    function formatBytes(bytes) {
      const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
      if (value < 1024) return `${String(value)} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let size = value / 1024
      let unit = 0
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit += 1
      }
      return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
    }

    /** Interpolate `{name}` placeholders. */
    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
      ))
    }

    /** One request to a Host endpoint. */
    async function callHost(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [MARKER]: '1' },
        body: JSON.stringify(body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload === null || payload.ok !== true) {
        const reason = payload && typeof payload.error === 'string' ? payload.error : `${response.status} ${response.statusText}`
        throw new Error(String(reason))
      }
      return payload
    }

    /**
     * The one piece of shared state: which scope the dialog is open for.
     * Module-local rather than a Cordis service, because both entries are
     * registered by this same plugin and nothing else reads it.
     */
    function createStore() {
      let value = null
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        open(request) {
          value = request
          for (const listener of [...listeners]) listener()
        },
        close() {
          value = null
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /** Small muted line. */
    function hint(key, text) {
      return h('p', {
        key,
        style: { margin: '4px 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      }, text)
    }

    /** One scrollable monospace list. */
    function listBox(key, paths) {
      return h('div', {
        key,
        'data-wc-listbox': '',
      }, paths.map((path, index) => h('div', { key: `${index}:${path}` }, path)))
    }

    /** Badges for a Session row. */
    function badges(row) {
      const out = []
      if (row.isBili) out.push(h('span', { key: 'bili', 'data-wc-badge': '', 'data-bili': '' }, T['page.badge.bili']))
      if (row.archived) out.push(h('span', { key: 'archived', 'data-wc-badge': '', 'data-archived': '' }, T['page.badge.archived']))
      if (row.live) out.push(h('span', { key: 'live', 'data-wc-badge': '', 'data-archived': '' }, T['page.badge.live']))
      return out
    }

    /**
     * One Session row: a checkbox on the left, the display title (the name the
     * sidebar shows) with badges, then the id / cwd / size. Clicking anywhere on
     * the row toggles the selection; the checkbox is a visual indicator.
     */
    function sessionRow(row, selected, onToggle) {
      const isSelected = selected === true
      const hasTitle = typeof row.title === 'string' && row.title.trim() !== ''
      const display = hasTitle ? row.title : row.sessionId
      const subtitle = hasTitle ? `${row.sessionId}${row.cwd ? ' · ' + row.cwd : ''}` : (row.cwd ?? '')
      return h('li', {
        key: row.sessionId,
        'data-wc-item': '',
        'data-selected': isSelected ? '' : undefined,
        role: 'checkbox',
        tabIndex: 0,
        'aria-checked': isSelected ? 'true' : 'false',
        onClick: () => onToggle(row.sessionId),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onToggle(row.sessionId)
          }
        },
      },
        h('div', { 'data-wc-item-row': '' },
          h('span', { key: 'check', 'data-wc-check': '', 'data-on': isSelected ? '' : undefined },
            h('span', { key: 'inner', 'data-wc-check-inner': '' })),
          h('div', { key: 'body', 'data-wc-grow': '' },
            h('div', { 'data-wc-item-top': '' },
              h('span', { 'data-wc-id': '' }, display),
              badges(row)),
            subtitle !== '' ? h('div', { 'data-wc-cwd': '' }, subtitle) : null,
            h('div', { 'data-wc-cwd': '' }, formatBytes(row.bytes)))))
    }

    /** The settings page body. */
    function Panel({ dialogStore }) {
      const [scan, setScan] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      // Ids whose cards are expanded. Empty by default, so every bucket starts
      // folded; a bucket that appears on a later scan is folded too. A folded
      // card hides its Session list *and* its clean button, so it cannot be
      // cleaned by accident.
      const [expanded, setExpanded] = React.useState(() => new Set())

      const toggleFold = (id) => {
        setExpanded((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      // Ids the user ticked. Toggled by clicking anywhere on a Session row; the
      // "清理选中会话" button cleans exactly these.
      const [selected, setSelected] = React.useState(() => new Set())

      const toggleSelected = (id) => {
        setSelected((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      const load = React.useCallback(() => {
        let alive = true
        setLoading(true)
        setError(null)
        callHost('/scan', {})
          .then((data) => { if (alive) { setScan(data); setLoading(false) } })
          .catch((error) => { if (alive) { setError(error instanceof Error ? error.message : String(error)); setLoading(false) } })
        return () => { alive = false }
      }, [])

      React.useEffect(load, [load])

      const groups = scan?.groups ?? []
      const ungrouped = scan?.ungrouped ?? []
      const bili = scan?.bili ?? []
      const workspaceCount = groups.filter((group) => group.kind === 'grouped').length
      const sessionCount = scan?.totals?.stored ?? 0

      // Every Session row the scan knows about, keyed by id, so a ticked Session
      // can be turned back into its full row for the confirm dialog.
      const rowsById = new Map()
      for (const group of groups) {
        for (const row of group.rows ?? []) rowsById.set(row.sessionId, row)
      }

      const openConfirm = (scope, workspace) => {
        let rows = []
        let workspaceId = null
        if (scope === 'workspace') {
          rows = workspace?.rows ?? []
          workspaceId = workspace?.id
        } else if (scope === 'bili') {
          rows = scan?.bili ?? []
        } else if (scope === 'selected') {
          rows = [...selected].map((id) => rowsById.get(id)).filter(Boolean)
        } else {
          rows = scan?.ungrouped ?? []
        }
        dialogStore.open({
          scope,
          workspaceId,
          sessionIds: rows.map((row) => row.sessionId),
          mode: MODE,
          rows,
          nonce: Date.now(),
        })
      }

      /**
       * One Workspace card. Only the header box toggles fold/expand on click —
       * the Session list that appears when expanded is not clickable for
       * toggling. The arrow on the right of the header shows the current state:
       * ↑ folded, ↓ expanded. The clean button only renders while expanded and
       * stops propagation so clicking it does not fold the card.
       */
      const renderWorkspace = (workspace) => {
        const rows = workspace.rows ?? []
        const isCollapsed = !expanded.has(workspace.id)
        return h('div', { key: workspace.id, 'data-wc-ws': '', 'data-collapsed': isCollapsed ? '' : undefined },
          h('div', {
            'data-wc-ws-head': '',
            role: 'button',
            tabIndex: 0,
            title: isCollapsed ? T['page.ws.expand'] : T['page.ws.toggle'],
            onClick: () => toggleFold(workspace.id),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                toggleFold(workspace.id)
              }
            },
          },
            h('div', { 'data-wc-grow': '' },
              h('div', { 'data-wc-ws-title': '' }, [
                workspace.title,
                h('span', { key: 'kind', 'data-wc-ws-kind': '', 'data-kind': workspace.kind }, T[`page.kind.${workspace.kind}`]),
              ]),
              h('div', { 'data-wc-ws-meta': '' }, `${workspace.sessionCount} 个会话 · ${formatBytes(workspace.bytes)}`)),
            isCollapsed || workspace.sessionCount === 0
              ? null
              : h('button', {
                  key: 'clean', 'data-wc-ws-btn': '', type: 'button',
                  disabled: workspace.sessionCount === 0,
                  onClick: (event) => {
                    // The header toggles fold on click; the clean button must
                    // not fold the card when it is pressed.
                    if (typeof event?.stopPropagation === 'function') event.stopPropagation()
                    openConfirm('workspace', workspace)
                  },
                }, T['page.ws.act']),
            h('span', { key: 'arrow', 'data-wc-ws-arrow': '' },
              isCollapsed
                ? h(IconChevronUpOutlineMedium, { size: 16 })
                : h(IconChevronDownOutlineMedium, { size: 16 }))),
          workspace.path ? h('div', { 'data-wc-ws-path': '' }, workspace.path) : null,
          isCollapsed
            ? null
            : (rows.length === 0
                ? h('div', { 'data-wc-note': '' }, T['page.ws.empty'])
                : h('ul', { 'data-wc-list': '' }, rows.map((row) => sessionRow(row, selected.has(row.sessionId), toggleSelected)))),
          isCollapsed
            ? null
            : (workspace.truncated
                ? hint(`ws-truncated-${workspace.id}`, format(T['page.ws.truncated'], { count: Math.max(0, workspace.sessionCount - rows.length) }))
                : null))
      }

      return h('div', { 'data-wc-page': '' },
        h('div', null,
          h('h3', { style: { margin: '0 0 4px', fontSize: 15 } }, T['page.title']),
          h('p', { 'data-wc-note': '', style: { margin: 0 } }, T['page.desc'])),

        h('div', { 'data-wc-row': '' },
          h('div', { 'data-wc-grow': '' },
            h('div', { 'data-wc-label': '' }, '扫描结果'),
            h('div', { 'data-wc-note': '' }, scan !== null
              ? format(T['page.summary'], { workspaces: workspaceCount, sessions: sessionCount })
              : '正在读取…')),
          h(Button, { variant: 'outline', onClick: load, disabled: loading }, T['page.scan'])),

        loading && scan === null
          ? h('div', { 'data-wc-note': '' }, T['page.loading'])
          : null,

        error !== null
          ? hint('error', format(T['page.error'], { reason: error }))
          : null,

        scan !== null
          ? h('div', { 'data-wc-group': '' }, groups.map(renderWorkspace))
          : null,

        // Only rendered while something is ticked. It used to be a second
        // "清理选中会话" button doing exactly the bottom button's job; it now
        // clears every tick instead. Deletion stays on the always-on bottom
        // button, whose target list the Host recomputes.
        selected.size > 0
          ? h('div', { 'data-wc-row': '' },
              h('div', { 'data-wc-grow': '' },
                h('div', { 'data-wc-label': '' }, format(T['page.sel.count'], { count: selected.size }))),
              h('button', {
                'data-wc-btn': '', 'data-primary': '', type: 'button',
                onClick: () => setSelected(() => new Set()),
              }, T['page.action.clear']))
          : null,

        h('div', { 'data-wc-actions': '' },
          h('button', {
            'data-wc-act': '', 'data-danger': '', type: 'button',
            onClick: () => openConfirm('all'),
          },
            h('span', { 'data-wc-act-t': '' }, T['page.action.all']),
            h('span', { 'data-wc-act-h': '' }, T['page.action.allHint'])),
          h('button', {
            'data-wc-act': '', 'data-danger': '', type: 'button',
            onClick: () => openConfirm('bili'),
          },
            h('span', { 'data-wc-act-t': '' }, T['page.action.bili']),
            h('span', { 'data-wc-act-h': '' }, T['page.action.biliHint'])),
          h('button', {
            'data-wc-act': '', 'data-danger': '', type: 'button',
            disabled: selected.size === 0,
            onClick: () => openConfirm('selected'),
          },
            h('span', { 'data-wc-act-t': '' }, selected.size > 0 ? `${T['page.action.selected']}（${selected.size}）` : T['page.action.selected']),
            h('span', { 'data-wc-act-h': '' }, T['page.action.selectedHint']))),
      )
    }

    /** Containment for the dialog's own render and lifecycle failures. */
    class CleanupBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        console.error('dsh-workspace-cleanup: dialog failed', error)
      }

      render() {
        if (this.state.error === null) return this.props.children
        return h(Modal, {
          open: true,
          onClose: () => {},
          title: T['dialog.title'],
          closeLabel: T['dialog.close'],
        }, h('p', {
          role: 'alert',
          style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
        }, String(this.state.error?.message ?? this.state.error)))
      }
    }

    /** The confirmation form: acknowledge, clean, report. */
    function CleanupForm({ request, dialogStore }) {
      const [acknowledged, setAcknowledged] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const [result, setResult] = React.useState(null)
      const [countdown, setCountdown] = React.useState(0)

      const targets = Array.isArray(request.rows) ? request.rows : []
      const scopeLabel = request.scope === 'selected'
        ? T['dialog.selected']
        : request.scope === 'workspace'
          ? T['dialog.workspace']
          : request.scope === 'bili'
            ? T['dialog.bili']
            : T['dialog.all']

      // 结果里只要有「记录被保留」的会话，就不自动刷新：那一刷会把还留在磁盘
      // 上的产物和可以重试的会话一起从视野里抹掉（这正是旧版“看着删干净了”的成因）。
      React.useEffect(() => {
        if (result === null || result.ok !== true) return undefined
        if ((result.partialCount ?? 0) > 0) return undefined
        setCountdown(Math.ceil(RELOAD_DELAY_MS / 1000))
        const tick = window.setInterval(() => {
          setCountdown((value) => (value > 0 ? value - 1 : 0))
        }, 1000)
        const timer = window.setTimeout(() => { window.location.reload() }, RELOAD_DELAY_MS)
        return () => {
          window.clearInterval(tick)
          window.clearTimeout(timer)
        }
      }, [result])

      const close = () => {
        if (busy) return
        dialogStore.close()
      }

      const confirm = () => {
        setBusy(true)
        setFailure(null)
        const request_body = { scope: request.scope, mode: request.mode, confirm: true }
        if (request.workspaceId) request_body.workspaceId = request.workspaceId
        if (Array.isArray(request.sessionIds)) request_body.sessionIds = request.sessionIds
        callHost('/clean', request_body)
          .then((payload) => { setResult(payload) })
          .catch((error) => { setFailure(error instanceof Error ? error.message : String(error)) })
          .finally(() => { setBusy(false) })
      }

      const done = result !== null && result.ok === true
      const okCount = (result?.results ?? []).filter((row) => row.ok === true).length
      const failCount = (result?.results ?? []).filter((row) => row.ok !== true).length
      const partialRows = (result?.results ?? []).filter((row) => row.ok === true && row.recordKept === true)
      const partialCount = partialRows.length

      const body = []
      if (done) {
        body.push(h('h3', {
          key: 'done',
          style: {
            margin: '0 0 6px',
            color: partialCount > 0 ? 'var(--dsw-alias-state-warn-primary)' : undefined,
          },
        }, partialCount > 0 ? T['dialog.done.partialTitle'] : T['dialog.done.title']))
        body.push(hint('done-summary', format(T['dialog.done.summary'], {
          count: result.results.length, ok: okCount, fail: failCount,
        })))
        if (failCount > 0) {
          const failed = result.results.filter((row) => row.ok !== true)
          body.push(h('div', { 'data-wc-h': '', key: 'failed-title' }, T['dialog.warnings']))
          body.push(listBox('failed-list', failed.map((row) => `${row.sessionId} — ${row.error ?? '未知原因'}`)))
        }
        if (partialCount > 0) {
          body.push(hint('done-partial', format(T['dialog.done.partial'], { count: partialCount })))
          body.push(h('div', { 'data-wc-h': '', key: 'partial-title' }, T['dialog.partialWarnings']))
          body.push(listBox('partial-list', partialRows.map((row) => {
            const name = typeof row.plan?.cwd === 'string' && row.plan.cwd !== '' ? row.plan.cwd : row.cwd ?? ''
            const errs = (row.errors ?? []).slice(0, 3).map((e) => `${e.step}: ${e.path ?? ''} — ${e.message}`)
            return `${row.sessionId}${name ? ' · ' + name : ''}\n${errs.join('\n') || '（无错误明细）'}`
          })))
        }
        body.push(hint('done-reload', format(partialCount > 0 ? T['dialog.done.noReload'] : T['dialog.done.reload'], { seconds: countdown })))
      } else {
        body.push(h('p', { 'data-wc-note': '', key: 'scope', style: { margin: '0 0 4px' } },
          format(T['dialog.targets'], { count: targets.length }) + ' ' + scopeLabel))
        if (targets.length === 0) {
          body.push(hint('none', T['dialog.none']))
        } else {
          body.push(listBox('targets', targets.map((row) => {
            const badges = []
            if (row.isBili) badges.push('B站')
            if (row.archived) badges.push('已归档')
            if (row.live) badges.push('运行中')
            const name = typeof row.title === 'string' && row.title.trim() !== '' ? row.title : row.sessionId
            return `${name}${badges.length ? '  [' + badges.join(' · ') + ']' : ''}\n${row.sessionId}${row.cwd ? ' · ' + row.cwd : ''}  ·  ${formatBytes(row.bytes)}`
          })))
          if (targets.some((row) => row.live)) {
            body.push(h('div', { 'data-wc-warn': '', key: 'live' }, [
              h(IconWarningOutlineRegular, { key: 'icon', size: 14 }),
              h('span', { key: 'text' }, T['dialog.live']),
            ]))
          }
        }
        body.push(hint('note', request.scope === 'workspace'
          ? T['dialog.workspaceNote']
          : request.scope === 'selected'
            ? T['dialog.selectedNote']
            : T['dialog.note']))
        body.push(h('div', { key: 'ack', style: { marginTop: 10 } },
          h(Checkbox, { checked: acknowledged, onChange: setAcknowledged, label: T['dialog.ack'] })))
        if (failure !== null) {
          body.push(h('p', {
            key: 'failure',
            role: 'alert',
            style: { margin: '8px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
          }, format(T['dialog.failed'], { reason: failure })))
        }
      }

      const footer = done
        ? [
          h(Button, { key: 'reload', variant: 'outline', onClick: () => { window.location.reload() } }, T['dialog.reloadNow']),
        ]
        : [
          h(Button, { key: 'cancel', variant: 'outline', disabled: busy, onClick: close }, T['dialog.cancel']),
          h(Button, {
            key: 'confirm',
            disabled: busy || acknowledged !== true || targets.length === 0,
            style: {
              background: 'var(--dsw-alias-state-error-primary)',
              color: '#fff',
              borderColor: 'transparent',
            },
            onClick: confirm,
          }, busy ? T['dialog.deleting'] : T['dialog.confirm']),
        ]

      return h(Modal, {
        open: true,
        onClose: close,
        title: T['dialog.title'],
        closeLabel: T['dialog.close'],
        description: scopeLabel,
        footer: h(React.Fragment, null, footer),
      }, h('div', null, body))
    }

    /** The overlay entry: one form per request, keyed so its state dies with it. */
    function CleanupDialog({ dialogStore }) {
      const request = React.useSyncExternalStore(dialogStore.subscribe, dialogStore.getSnapshot)
      if (request === null) return null
      return h(CleanupBoundary, { dialogStore },
        h(CleanupForm, {
          key: `${request.scope}:${String(request.nonce)}`,
          request,
          dialogStore,
        }))
    }

    /**
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', NS)
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove(), `${NS}: 设置页样式`)

      const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
      if (!slots) return

      const dialogStore = createStore()

      // The left-hand settings nav row, next to "账号与余额" and "刷B站". The
      // shell keys each row's icon on its section id and has no trash mapping, so
      // this row simply takes the shell's default gear: the plugin carries no icon
      // of its own. (An earlier revision shipped a trash icon in the label and hid
      // the shell's gear with CSS + a MutationObserver; both were dropped because
      // the shell-owned glyph is the one that cannot drift.)
      slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'workspace-cleanup',
        order: 35,
        label: () => T['nav'],
        inject: () => ({ dialogStore }),
      }, Panel))

      // The confirmation / result dialog, portaled over the whole frame.
      slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: 'workspace-cleanup-dialog',
        inject: () => ({ dialogStore }),
      }, CleanupDialog))
    }

    return { name: NS, inject: ['slots'], apply }
  },
})
