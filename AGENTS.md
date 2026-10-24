# AGENTS.md — dsh-workspace-cleanup

Maintainer briefing: which DSH facts this package rests on, which of them were
learned the hard way, and how to prove a change is safe.

Human-facing usage lives in [README.md](README.md) (中文) and
[README.en.md](README.en.md).

## What it is

A DSH plugin with two halves and no build step.

| Half | File | Job |
|---|---|---|
| Host (Node) | `lib/index.js` | Three HTTP endpoints: scan every Workspace bucket with its Sessions and their display titles (plus the Ungrouped and cross-cutting B 站 buckets), clean one scope (`all` / `bili` / `workspace` / `selected`) through `dsh-session-purge`, answer health |
| Browser | `lib/client.js` | Hand-written `window.__ModuleLoader__` bundle: the settings nav row, the per-Workspace cleanup UI with fold toggles, ticked Session rows, the conditional "取消全部选中" button next to the always-on "清理选中会话" button, and the confirm dialog |
| Acceptance test | `verify/verify-host.mjs` | Drives bucketing, title folding and scope selection against a stub Host and a scratch DSH home |

Patch layer: `cordis.patch.yml` inserts one row (`id: workspace-cleanup`).

## The DSH facts everything rests on

### 1. "未分组" is a registry projection, and every Session lands in exactly one Workspace bucket

The sidebar's Ungrouped bucket is computed in `dsh-client-ui-workspace`:

```js
const accounted = new Set(workspaces.flatMap((w) => w.sessionIds))
const ungroupedMemberIds = list.ids.filter((id) => !accounted.has(id))
```

`WorkspaceEntity.sessionIds` is a getter that filters the durable record by
`candidateMatches(id, path)`, which is `sessionPaths.get(id) === path ||
missingSessionPaths.has(id)`. The registry builds `sessionPaths` from each
stored header's `cwd` (canonicalised through `realpathNormalize`). So a Session
is ungrouped when **no Workspace's filtered `sessionIds` accounts for it**.

This plugin reproduces exactly that on the Host: `sessionPersistence.list()`
minus the union of `workspaceRegistry.list()[*].sessionIds`. It then builds one
bucket per Workspace (registry order) plus the synthetic `ungrouped` bucket, and
assigns every Session to the bucket its `workspaceId` resolves to. Do not invent
a different rule (for example "no directory under `sessions/`"), or the plugin
will disagree with what the user sees in the sidebar.

The `workspace` scope resolves its id to a bucket **before** cleaning, so an
unknown or stale id is an empty target — it never falls back to clearing
everything.

### 2. The B 站 Sessions have a stable, recordable marker: their cwd

`dsh-bili-scroll` spawns its headless rounds with `cwd = stateDir`, and
`stateDirOf(ctx)` resolves to `<DSH_HOME>/bili-duty`. Every Session it creates
records that `cwd` in its header (`{ type: 'session', version: 4, id, cwd, ... }`).
That is the only reliable marker — the plugin does not write a sentinel into the
log, and there is no other field that distinguishes a B 站 Session from any
other ungrouped one.

`isSameOrUnder` normalises `/` to `\`, strips trailing separators and compares
case-insensitively on Windows. The check is deliberately independent of
grouping: a B 站 Session that happens to be grouped is still a B 站 Session.

The B 站 bucket is therefore **cross-cutting**: it lists every B 站 Session
whatever Workspace owns it, so it can overlap a grouped bucket on purpose. The
two buckets own separate clean scopes; do not "fix" the overlap by filtering the
B 站 bucket down to ungrouped Sessions — that would break "仅B站会话".

### 2.1 The display title is folded from the Session's own log

The panel names a Session the way the sidebar does: **the last
`session/title` event in its log** (`{ type: 'session/title', data: { title } }`).
The harness's title service writes that event (fallback or provider), and the
sidebar's title projection folds it, so this plugin folds it the same way.

`foldTitle(events)` walks the log backwards for the last `session/title` whose
`data.title` is a non-empty string; with none, it takes the first
`user/message` whose `data.source.kind === 'user'`, joins its text blocks,
collapses whitespace and truncates to 80 characters. With neither, the title is
`null` and the panel shows the id.

`foldTitles(ctx, ids)` prefers the harness's own bulk fold —
`ctx.sessionQuery.readTitleSnapshots(ids)`, one corpus observation for every log
— and re-reads any Session that came back without a title (or whose fold threw)
through `sessionPersistence.open(id, 'read')`. A per-Session read failure leaves
that Session's title `null`; it never fails the whole scan.

Do not invent a different title source (for example the first assistant message
or the session id). The user asked for the name the workspace shows, and that is
the folded title.

### 3. Deletion is delegated to `dsh-session-purge` over HTTP

`dsh-session-purge` exposes `POST /plugins/dsh-session-purge/api/purge` with
`{ sessionId, mode, confirm }` and the marker header `x-dsh-session-purge: 1`.
This plugin calls it once per target Session.

**Do not `import` the purge package.** Profile bundles are installed as
symlinks (`node_modules/dsh-session-purge -> ../../plugins/dsh-session-purge`);
Node resolves `dsh-session-purge` from the plugin package's own directory, which
is *outside* the profile's `node_modules` tree, so the import would fail. A
request to the same in-process `webServer` (`ctx.webServer.getOrigin()`) has no
such problem and keeps a single deletion implementation.

### 4. The browser half is a loader bundle, not a built module

```js
window.__ModuleLoader__.load({
  id: 'dsh-workspace-cleanup',   // must equal the package name
  factory: (require) => { ... return { name, inject, apply } },
})
```

- `id` is the resolved package name.
- The factory returns the Cordis plugin namespace: `name`, `inject`, `apply`.
- `require('react')` and `require('@deepseek-ai/dsh-client-ui-primitives')`
  resolve against the shell's frozen static table.
- No build step: `lib/client.js` is the shipped artifact. Executing the file only
  registers the factory; the body runs at materialization.

### 5. Slot contracts

| Slot | Kind | What is registered |
|---|---|---|
| `settings.section` | list, root | One nav row. Built-ins: account `order: -10`, general `0`, plugins `15`, 刷B站 `30`; this plugin uses **35**. Registration options: `id`, `order`, `label` (string, `() => string`, or `() => ReactNode`). The section component receives the injected props (here `dialogStore`). |
| `shell.overlay` | list, root | The confirmation / result dialog, portaled over the whole frame by the shell's `Modal`. |

A registration's `inject` is a **factory** whose result is merged into the
component's props (`inject: () => ({ dialogStore })`). Dialog state is a
module-local store read with `React.useSyncExternalStore`; the dialog is a body
portal, so it is wrapped in an error boundary.

### 5.1 The settings nav icon is shell-owned

The shell renders each nav row as `navIcon(row.id)` followed by a label span,
where `navIcon` is a **hardcoded id map** in the shell's own code:

```js
function navIcon(id) {
  if (id === 'account') return <IconUserOutlineMedium />
  if (id === 'models') return <IconDataOutlineMedium />
  // …agent-presets, plugins, archived-sessions…
  return <IconSettingsOutlineMedium />   // the gear: the fallback for unknown ids
}
```

There is **no `icon` registration option** and **no trash/broom mapping** in this
DSH release. So a plugin cannot ask for a different glyph through the slot.

**This plugin registers a plain-text label and takes the default gear.** The
shell keys each row's icon on its section id, `workspace-cleanup` is not in the
map, so the row shows the gear. The plugin writes no icon element and no CSS
rule, so the row can never drift out of sync with the shell.

> **History (why there is no trash icon).** v0.1.1 shipped a trash icon by putting
> `<IconTrashOutlineMedium size={16} className="wc-nav-trash"/>` inside the label
> thunk and hiding the shell's gear for exactly that row:
>
> - CSS: `button.wCInkW_navCell:has(.wCInkW_navLabel svg.wc-nav-trash) .wCInkW_navIcon{display:none}`.
> - JS: a `MutationObserver` on `document.body` hiding `.wCInkW_navIcon` on any
>   `.wCInkW_navCell` whose `.wCInkW_navLabel` contains `svg.wc-nav-trash`.
>
> That depended on undocumented shell class names (`wCInkW_*`) and on the label
> carrying an svg. It was removed in v0.6.0 because changing the icon is
> bug-prone. If a real `icon` option ever appears, use it; until then, keep the
> label as plain text.

### 5.2 The workspace card has a fold toggle, and folding hides the clean button

Each `settings.section` render is a card per bucket, **folded by default**. The
card is a `div[data-wc-ws]`; its header box `div[data-wc-ws-head]` carries the
title/kind/count on the left, the per-Workspace clean button (when expanded) and
the state arrow on the right.

- **Clicking anywhere on the header box toggles fold/expand** (Enter / Space too,
  since the header has `role="button"` and `tabIndex={0}`). Only the header box
  toggles: the Session list that appears when expanded is deliberately not
  clickable for toggling.
- Folded state is a `Set` of expanded ids held in `Panel`'s `useState`, empty by
  default — so every bucket, including a new one from a later scan, starts
  folded.
- The arrow on the right shows the current state: `IconChevronUpOutlineMedium`
  (↑) when folded, `IconChevronDownOutlineMedium` (↓) when expanded.
- **When a bucket is folded, both its Session list and its "清理该工作区" button
  are not rendered.** That is deliberate: the user asked for the clean button to
  disappear while folded, so a collapsed card cannot be cleaned by accident.
- The clean button `stopPropagation`s so pressing it opens the dialog instead of
  folding the card.
- The two global bottom buttons are independent of folding and always render.
- Fold state is in-memory only — it resets on reload or when Settings is reopened.

**Each expanded card's Session list renders one row per Session.** A row is a
`li[data-wc-item]` with `role="checkbox"` and `tabIndex={0}`:

- **clicking anywhere on the row toggles the tick**; the checkbox on the left is
  a visual indicator (`data-wc-check` + `data-wc-check-inner`), not an interactive
  input, so there is no double-toggle.
- The row shows the **display title** (see §2.1) with badges, then the id / cwd
  line and the size.
- The row's `onClick` toggles `selected` (a `Set` of ticked ids in `Panel`'s
  `useState`). The **three global bottom buttons** include "清理选中会话", which
  is disabled while nothing is ticked and, when clicked, opens the confirm
  dialog scoped to `selected` with the ticked ids. It also shows the ticked count.
- A line above the actions shows "已选中 N 个会话" while anything is ticked, and
  the same row carries a **"取消全部选中"** button. That button is rendered
  **only while something is ticked** and, when clicked, calls
  `setSelected(() => new Set())` — it clears every tick and opens **no** dialog.
  Deleting the ticked Sessions is the bottom button's job alone; the two must not
  be merged back into one.

If the fold or ticking behaviour changes, extend `verify/verify-client.mjs`; it
renders `Panel` against a canned scan and drives the header's and the row's
`onClick`.

### 6. Routes, and why they carry a marker header

`ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), label)`
registers an endpoint.

**`/plugins` routes answer without the shell's session authorization.** That is
why `scan` and `clean` demand the header `x-dsh-workspace-cleanup: 1` and reject
an `Origin` that is not the request's own host. Without it, any local page could
POST a clean (a cross-origin simple request executes even though its response
cannot be read).

## Rules learned the hard way

| Rule | What happens if it is broken |
|---|---|
| **Never read or write a CJK-bearing file with PowerShell.** Use the file tools, and verify with Node `readFileSync(path, 'utf8')`. | Windows PowerShell 5.1 decodes BOM-less UTF-8 as GBK: `Get-Content package.json` prints mojibake for perfectly intact Chinese, and a `Set-Content` round-trip would destroy it for real. |
| **The Loader caches an imported Host module per package name.** Toggling or reinstalling the bundle does **not** re-read `lib/index.js`. | You keep testing the old revision and conclude a fix did not work. Host-half changes need a **DSH restart**. |
| **The browser half *is* hot.** `client-modules` derives a revision from the bundle file's mtime/size and pushes it into open pages. | You restart DSH for a cosmetic change. |
| **A new bundle needs a restart even though the client half is hot.** The profile is read at startup; until then the settings row does not exist. | You edit `lib/client.js`, see nothing, and conclude the slot id is wrong. |
| **`web_fetch` refuses loopback URLs** (`non-public IP address`). | You conclude an endpoint is unreachable. Probe it with `Invoke-WebRequest http://127.0.0.1:<port>/...` instead. |
| **The `clean` route must recompute its target list.** If it ever trusted a `sessionIds` array from the browser, a tampered request could widen the scope past the ungrouped bucket. | The whole safety argument in the README collapses. |
| **A `workspace` scope must resolve its id to a bucket before cleaning.** An unknown or stale id is an empty target, never a fallback to "clear everything". | A deleted or renamed Workspace could be used to wipe every ungrouped Session. |
| **Never delete a Workspace record.** The plugin only calls purge per Session; `detachSession` empties the bucket, the Workspace itself stays. | The user loses a Workspace they did not ask to remove, and its `path` registration disappears. |
| **The B 站 bucket overlaps grouped buckets on purpose.** It is cross-cutting, so filtering it down to ungrouped Sessions would break "仅B站会话". | B 站 Sessions that happen to be grouped stop being cleanable by the B 站 button. |
| **A folded card must not render its clean button.** Folding hides the Session list *and* the "清理该工作区" button together; rendering the button while folded defeats the whole point. | A collapsed Workspace can still be wiped by an accidental click. |
| **Only the header box toggles fold/expand.** The `onClick`/`onKeyDown` live on `div[data-wc-ws-head]`, not on the whole card or the Session list. | Clicking the expanded Session list folds the card, or text selection becomes impossible. |
| **The clean button must `stopPropagation`.** Otherwise clicking it also toggles the fold and the dialog opens on a card that is now folded. | The user opens the confirm dialog but the card collapses underneath them. |
| **Never treat "a Session is in a Workspace's record" as "it is grouped".** The entity's `sessionIds` getter filters by canonical cwd; the filtered value is the only one the sidebar uses. | You delete a Session the user can still see under a Workspace. |
| **A `selected` scope must only accept ids the Host sees.** The ticked ids are checked against the stored corpus first; an unknown id is ignored, never forwarded to purge. | A forged or stale id could reach a Session the user never saw in the scan. |
| **A ticked Session row must not widen the deletion scope.** The row toggles only the local `selected` set; the dialog carries `sessionIds` and the Host re-validates them. | The row's click handler starts deleting on its own, or the dialog sends ids the Host never saw. |
| **The "取消全部选中" button must not delete anything.** It calls `setSelected(() => new Set())` and opens **no** confirm dialog; deletion stays on the always-on bottom "清理选中会话" button. | The user clicks the clear button expecting to untick and loses Sessions instead. |
| **The display title must come from the log's `session/title`.** Folding the first assistant message, the id, or a provider's raw text instead would show a name the sidebar does not. | The user cannot tell which conversation a row is, and cleans the wrong one. |
| **`dsh-session-purge` must be installed and enabled.** This plugin only forwards to it. | `clean` returns a per-Session error (usually `HTTP 404`) and the UI shows it under "未能删除的会话". |

## Verifying a change

```sh
node --check lib/index.js
node --check lib/client.js
node verify/verify-host.mjs      # Host half: 94 assertions
node verify/verify-client.mjs    # Browser half: 65 assertions
# or: pnpm verify (both)
```

`verify/verify-host.mjs` is offline and self-contained: a scratch DSH home with
synthetic session directories, a stub `sessionPersistence`, a stub
`workspaceRegistry`, a stub `webServer`, and a `globalThis.fetch` stub that
records the purge calls. It asserts how Sessions are bucketed, how their titles
fold, and what the clean route actually forwards — every Session lands in
exactly one Workspace bucket, the B 站 bucket is cross-cutting, the title is the
last `session/title` (falling back to the first user message), a grouped Session
is never reached by `all`, a `workspace` scope reaches only its own bucket, a
`selected` scope reaches only the named Sessions and ignores forged ids, an
unknown id cleans nothing, and an empty scope makes no purge call. Extend it
whenever the classification, the title fold, or the scope set changes.

`verify/verify-client.mjs` loads `lib/client.js` in a `vm` sandbox with mocked
`window.__ModuleLoader__`, a small React-hooks simulator, and primitives, then
drives `apply()` and renders the `Panel` component against a canned scan. It
asserts the loader id, the two slots, the section order, that the nav label thunk
returns plain text (no icon element) and that the CSS carries no gear-hiding rule,
that each bucket renders one card, that the three global bottom buttons are still
present, the fold contract (every bucket starts folded, clicking the header box
expands it, the Session list does not toggle on click, the clean button does not
fold the card, folding everything leaves no clean button), and the ticking
contract (each row shows its display title and a checkbox, clicking anywhere on a
row ticks / unticks it, the button shows the ticked count, it is disabled while
nothing is ticked, and the confirm dialog carries the ticked ids), plus the
"取消全部选中" contract (the button appears only while something is ticked,
pressing it clears every tick, opens no dialog, disappears once nothing is ticked,
and the bottom button is disabled again). Extend it whenever the panel layout,
the fold or tick behaviour, the title display, the nav label, or the slot
contract changes.

## Change → restart matrix

| Changed | To see it |
|---|---|
| `lib/client.js` | HMR pushes the new bundle into open pages. But the row only appears after the profile is re-read (restart) the first time. |
| `lib/index.js` | **Restart DSH.** |
| `cordis.patch.yml`, `package.json` | Re-apply the plugin (plugin manager enable) or restart. |
| `README.md`, `AGENTS.md`, `CHANGELOG.md` | Nothing. |

## When someone reports something

| Report | Look at | Most likely |
|---|---|---|
| "没有「清理工作区」这一页" | `cordis_inspect_query` (client `Slots`, root `settings.section`) for the `workspace-cleanup` occupant | The browser half did not load, or the profile has not been re-read since install (restart). |
| "「清理全部未分组」把某个工作区的会话也删了" | The scan list, then `collect`'s accounted set | The Workspace registry filtered that Session out (its cwd no longer matches), so the sidebar itself would have shown it under 未分组 too. |
| "「清理该工作区」一条都没删" | `clean`'s bucket lookup and the `workspaceId` the browser sent | The id is stale (Workspace renamed/deleted) or the client half is old and omits `workspaceId`. |
| "B 站桶里出现了某个工作区的会话" | `plan.groups.find(g => g.kind === 'bili')` | That is the cross-cutting bucket working as designed; the Workspace bucket still lists it too. |
| "「仅B站会话」一条都没删" | `plan.bili` and each Session's recorded `cwd` | The scroll plugin changed its spawn cwd; update `BILI_DIR_NAME` / `isSameOrUnder`. |
| "清理报 HTTP 404 / 找不到路由" | `dsh-session-purge`'s health endpoint | The purge plugin is not installed or disabled. |
| "提示「缺少插件请求标记」" | The client bundle's `x-dsh-workspace-cleanup` header vs the Host's `requireOwnPage` | An old browser half paired with a new Host half; reload the page, restart DSH. |
| "点完没反应 / 列表没刷新" | Whether the page reloaded after the clean | `api-session/removed` did not reach the page; the dialog reloads on success, and that is the guarantee. |
