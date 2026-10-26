# dsh-workspace-cleanup

**Adds a "Clean workspaces" page to the DeepSeek Harness settings: it lists every
Workspace's Sessions (plus the Ungrouped and B 站 buckets), lets you clear one
Workspace's Sessions with a single click, and also cleans all ungrouped or B 站
Sessions. Deletion reuses `dsh-session-purge`.**

[简体中文](README.md) | English

> ⚠️ Deletion cannot be undone. Before anything is removed the dialog lists
> exactly which Sessions will go, and the "Delete" button stays disabled until
> you tick "I understand this cannot be undone". Cleaning a Workspace removes
> only its Sessions; **the Workspace record itself is kept** (it becomes an
> empty Workspace).

This plugin adds bulk workspace session deletion and is built on top of dsh-session-purge, the underlying session-deletion plugin. **You must install dsh-session-purge before using it.**

The **dsh-session-purge** plugin files have been uploaded to **Releases**.

## The problem it solves

DSH's session persistence layer has **no deletion API**: `@deepseek-ai/dsh-session-persistence`
documents *"No deletion or retention API"*. The sidebar's "⋯ → Delete
conversation…" (from `dsh-session-purge`) removes **one** Session, but nothing
batch-maintains the rest:

- the **B 站 scroll plugin** spawns a headless Session every round with
  `cwd = <DSH_HOME>/bili-duty`, which has no Workspace, so it lands under
  "Ungrouped";
- Sessions whose `cwd` later changed, or that recorded no `cwd`, fall there too;
- the Sessions inside grouped Workspaces pile up just as much, their log files
  sitting under `<DSH_HOME>/sessions/<project>/<session-id>/`.

This plugin buckets every Session **by Workspace** and offers two ways to clean:
**clear one Workspace's whole Session set**, or **clear the ungrouped / B 站
Sessions**.

## UI

Open **Settings** from the bottom-left; the left nav gets a **"Clean
workspaces"** row next to "Account & balance" and "B 站"
(`settings.section`, `order: 35`). That row takes the **default gear** the shell
draws for ids it does not know.

The page shows one card per bucket, **all folded by default**:

- **click anywhere on the header box** to toggle between folded and expanded
  (Enter / Space also work);
- the arrow on the right of the box shows the current state: **↑ folded, ↓
  expanded**;
- the bucket's Session list and the **"Clean this workspace"** button only appear
  when expanded — clicking it removes every Session in that bucket, leaving the
  Workspace record untouched;
- each Session row shows **the name it has in the workspace** (the title, taken
  from the last `session/title` event in its log, falling back to the id) with a
  **checkbox** on the left: **click anywhere on the row to tick / untick it**;
- the Session list area itself does not toggle.

> **Folding and safety**: every bucket starts folded, so the box shows only the
> Workspace name. The "Clean this workspace" button is rendered only while
> expanded; folding hides the button *and* the Session list together, so a
> folded card cannot be cleaned by accident.

The header shows "N workspaces · M sessions". Once sessions are ticked, a line
shows "N sessions ticked" plus a **"Clear all ticks"** button — pressing it
clears every tick without opening the dialog and deletes nothing. Deleting the
ticked sessions stays on the always-on bottom **"Clean ticked sessions"**
button.

The three global buttons stay at the bottom:

| Button | Behaviour |
|---|---|
| **Clean all ungrouped** | Deletes **every ungrouped Session** (including B 站 Sessions and other strays). Sessions belonging to a Workspace are **not** removed. |
| **B 站 Sessions only** | Deletes only the **Sessions the B 站 plugin produced by calling the model** (identified by their recorded `cwd`), independent of grouping. |
| **Clean ticked sessions** | Deletes the Sessions you **ticked**, across Workspaces and buckets. Disabled while nothing is ticked. |

Either button opens a confirmation dialog listing the Sessions to be removed
(showing their titles, with B 站 / archived / running badges); nothing is deleted
until you tick the acknowledgement. On success the page reloads to refresh the
list.

> **Nav icon**: the settings shell picks each row's icon from a hardcoded id map
> and falls back to a gear for ids it does not know; it exposes no icon option.
> This plugin carries **no icon of its own** and simply uses that default gear.
> An earlier revision shipped a trash icon inside the label and hid the shell's
> gear for exactly that row (CSS `:has()` + a MutationObserver); it was dropped
> because customising the glyph is bug-prone.

## How it works

### 1. How Sessions are bucketed

Exactly the browser's `WorkspaceBrowser` rule: **of the stored Sessions, the ones
a Workspace's `sessionIds` accounts for belong to that Workspace; everything else
goes to "Ungrouped".**

- read every stored header through `ctx.sessionPersistence.list()`;
- read every Workspace through `ctx.workspaceRegistry.list()` and build a
  `sessionId → Workspace` map from their filtered `sessionIds`;
- Sessions outside the map land in the Ungrouped bucket.

The registry itself filters a Workspace's members by the header's canonical
`cwd` (`WorkspaceEntity.sessionIds` keeps only `candidateMatches(id, path)`), so a
Session whose cwd no longer matches is ungrouped by construction. This plugin
reuses that rule; it does not invent a different one.

**The B 站 bucket is cross-cutting**: it lists every Session whose `cwd` lies
inside `<DSH_HOME>/bili-duty`, **whatever Workspace owns it**. So a B 站 Session
can appear in both a Workspace bucket and the B 站 bucket — deliberately, because
each bucket owns its own clean scope.

### 2. Where a Session's display name comes from

**From the last `session/title` event in its log** — the very name the harness's
title service writes and the sidebar shows, so the cleanup page names a Session
the way the sidebar does.

- The Host prefers `ctx.sessionQuery.readTitleSnapshots()` to fold them in bulk
  (one corpus observation reads every log);
- Sessions that come back without a title, or whose fold fails, are re-read from
  their log through `sessionPersistence.open(id, 'read')`;
- a log with no `session/title` falls back to the first user message (truncated
  to 80 characters); with neither, the id is shown.

### 3. What counts as a "B 站 Session"

**Whether the header's recorded `cwd` lies inside `<DSH_HOME>/bili-duty`**
(case-insensitive, both `/` and `\` accepted). The scroll plugin spawns its
headless rounds with `cwd = stateDir`, and `stateDirOf(ctx)` resolves to
`<DSH_HOME>/bili-duty`, so every Session it creates records that `cwd`.

### 4. Deletion is delegated to `dsh-session-purge`

**This plugin deletes nothing itself.** For each target Session it calls the
installed `dsh-session-purge` endpoint

```
POST /plugins/dsh-session-purge/api/purge   { sessionId, mode, confirm: true }
```

(with the `x-dsh-session-purge: 1` marker header). That keeps a single deletion
implementation: id validation, cwd containment, DSH-home protection, the shared
attachment scan and stop-and-archive of a live Session are all enforced by the
purge plugin's Host half, not by the browser.

HTTP is used instead of an `import` because profile bundles are **symlinks**;
Node cannot resolve `dsh-session-purge` from the plugin package's own directory,
while a request to the same in-process web server has no such problem.

The default mode is `artifacts` (delete the Session record plus the files it
wrote inside its own working directory). Files inside `~/.dsh` are always kept
by the purge plugin.

### 5. What happens when you clean one Workspace

Take Workspace A: click "Clean this workspace" on A's card → the dialog lists A's
Sessions → on confirmation the Host **recomputes** A's bucket and purges each
Session.

- **A's Workspace record is not deleted**: A stays in the registry, its
  `sessionIds` emptied (by purge's `detachSession`), so the sidebar shows A as an
  **empty Workspace**;
- A's directory (`path`) is untouched; the files A produced inside its working
  directory are removed by the purge rules;
- no Session belonging to another Workspace is touched.

## Safety boundaries (all enforced on the Host)

- **The target list is recomputed on the Host.** The browser sends only a scope
  (`all` / `bili` / `workspace` / `selected`), a Workspace id or a Session id
  list, a mode and a confirmation; the Host derives the Sessions to remove from
  the stored logs, so page state cannot widen the scope.
- **A Workspace record is never deleted.** The `workspace` scope clears Sessions
  only.
- **An unknown or stale Workspace id cleans nothing.** The Host resolves the id to
  a bucket first; an unresolvable id is an empty target, never a fallback to
  "clear everything".
- **Ticked cleaning only accepts Sessions the Host knows.** The `selected` scope
  checks the browser's id list against the stored corpus first; an id it does not
  recognise is ignored rather than allowed to widen the deletion.
- **`/plugins` routes are not protected by the shell's session authorization.**
  Both write endpoints therefore demand this plugin's own marker header
  `x-dsh-workspace-cleanup: 1` and reject a cross-origin `Origin`. Another local
  page cannot set that header without a preflight the server does not answer.
- **Scope and mode are whitelisted**: `scope ∈ {all, bili, workspace, selected}`,
  `mode ∈ {record, artifacts, everything}`; anything else is a `400`.
- It inherits every deletion safety rule from the purge plugin (see
  [dsh-session-purge](https://github.com/hshh603/dsh-session-purge)).

## Installation

The plugin is a standard DSH bundle; `cordis.patch.yml` ships in the package:

```yaml
- insert:
    - id: workspace-cleanup
      name: dsh-workspace-cleanup
```

### Option 1: plugin manager / `plugin_manager` tool

Pass this directory's **absolute path** as the install target (the Host reads its
`package.json`); it is added to the profile's `dsh.profile.bundles` and enabled.

### Option 2: manual link (same as the other local plugins)

```powershell
# 1. add the dependency and bundle to the profile's package.json
#    dependencies:  "dsh-workspace-cleanup": "link:../../plugins/dsh-workspace-cleanup"
#    dsh.profile.bundles: append "dsh-workspace-cleanup"

# 2. create the junction
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-workspace-cleanup" "%USERPROFILE%\.dsh\plugins\dsh-workspace-cleanup"

# 3. restart DSH
```

**When it takes effect**: Host-half changes to `lib/index.js` need a **DSH
restart** (the Loader caches imported modules by package name). The browser half
(`lib/client.js`) is pushed into open pages by `client-modules` HMR without a
refresh. But a **new bundle needs one restart** for its settings row to appear,
because the profile is read at startup.

## Development

```text
dsh-workspace-cleanup/
├── package.json          # dsh.bundle.patch + dsh.client.platform
├── cordis.patch.yml      # bundle layer mounted into the profile
├── lib/
│   ├── index.js          # Host half: scan / clean / health routes + bucketing
│   └── client.js         # Browser half: settings row + workspace cleanup UI + confirm dialog
├── verify/
│   ├── verify-host.mjs    # offline suite (94 assertions, Host half)
│   └── verify-client.mjs  # offline suite (65 assertions, browser half)
├── README.md
├── AGENTS.md             # maintainer briefing
└── CHANGELOG.md
```

Neither half needs a build step: the Host half is plain ESM, the browser half is
a hand-written `window.__ModuleLoader__` bundle.

```sh
node verify/verify-host.mjs   # or: pnpm verify (both suites)
node verify/verify-client.mjs
```

The Host suite uses a scratch DSH home and stub `sessionPersistence` /
`workspaceRegistry` / `webServer` services. It covers bucketing, titles and scope:
every Session lands in exactly one Workspace bucket, the B 站 bucket is
cross-cutting, the title comes from the last `session/title` event, `all` reaches
only ungrouped Sessions, `workspace` reaches only the named bucket, `selected`
reaches only ticked Sessions and ignores forged ids, an unknown id cleans
nothing, an empty scope makes no purge call, `requireOwnPage` rejects a missing
marker and cross-origin requests, and the scan / clean routes enforce their
whitelists. The browser suite loads `lib/client.js` in a `vm` sandbox (stub
`window.__ModuleLoader__` / `react` / primitives, with a small hooks simulator),
and checks the two Slot registrations, that the nav label is plain text and the
CSS carries no gear-hiding rule, that each bucket renders one card, that the
three global bottom buttons are still present, the **fold** behaviour (every
bucket starts folded, clicking the header box expands it, the Session list does
not toggle on click, the clean button does not fold the card, folding everything
leaves no clean button), and **ticking**: each row shows its display title and a
checkbox, clicking anywhere on the row ticks / unticks it, the button shows the
ticked count, it is disabled while nothing is ticked, and the confirm dialog
carries the ticked ids; plus **"Clear all ticks"**: the button appears only while
something is ticked, pressing it clears every tick without opening the dialog,
it disappears once nothing is ticked, and the bottom button is disabled again.

## Known limitations

- **Ungrouped means the registry's rule.** A Session that any Workspace records is
  not selected by "Clean all ungrouped", even if its `cwd` no longer matches. That
  is deliberate — delete less rather than more.
- **B 站 Sessions are recognised by `cwd`.** If the scroll plugin changes the
  directory it spawns rounds in, `BILI_DIR_NAME` / the check must be updated.
- **The B 站 bucket overlaps grouped buckets.** A B 站 Session that happens to
  belong to a Workspace appears in both that Workspace's bucket and the B 站
  bucket. Cleaning follows whichever bucket you clicked.
- **The fold state is in-memory and folded by default.** Which Workspaces are
  expanded lives only in the current page; reload or reopen Settings to fold
  them all again. A successful clean reloads the page, so the expanded set
  resets then too.
- **The display name comes from the log.** The title is the last
  `session/title` event, the same name the sidebar shows. A log with no title
  event falls back to the first user message (truncated to 80 characters), and
  with neither, the id is shown.
- **Ticking is in-memory.** Which Sessions are ticked lives only in the current
  page; reload or reopen Settings to clear them. A successful clean reloads the
  page, so the ticked set resets then too.
- **Only Sessions and produced files are removed.** Files inside `~/.dsh` (for
  example the B 站 daily report and logs) are always kept by the purge plugin;
  this plugin does not bypass that protection.
- **A live / open Session** is stopped and archived first; on Windows a still
  open log handle makes the deletion fail and the reason is listed in the
  result — retry after the current turn ends.
- **List refresh**: `api-session/removed` is broadcast on a best-effort basis;
  the reliable path is reloading the page, which the dialog does on success.
- **Only verified against DSH `0.2.0-rc.2`.** On other versions run the offline
  suite first and re-check the `settings.section` and `shell.overlay` contracts.
- **The nav icon is the shell's default gear.** The shell hardcodes icons by
  section id and falls back to a gear for unknown ids, with no icon option. This
  plugin carries no icon and writes no hiding rule, so changes to the shell's id
  map or the `wCInkW_*` classes cannot affect it. (An earlier revision put a
  trash icon in the label and hid the shell's gear with CSS `:has()` + a
  MutationObserver; it was removed.)

## License

[MIT](LICENSE)
