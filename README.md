# dsh-workspace-cleanup

**在 DeepSeek Harness 的「设置」里加一页「清理工作区」：列出所有工作区（含未分组、B 站）的会话，可一键清掉某个工作区的全部会话，也可清理全部未分组或仅 B 站会话。删除复用 `dsh-session-purge`。**

[English](README.en.md) | 简体中文

> ⚠️ 删除不可撤销。点「确认清理」前会先列出这次会删哪些会话，勾选「我已知晓：删除后无法恢复」后才能动手。清理某个工作区只会删掉它的会话，**工作区本身保留**（清空后仍是一个空工作区）。

## 它解决什么问题

DSH 的会话持久化层**没有删除接口**：`@deepseek-ai/dsh-session-persistence` 明确写着 *"No deletion or retention API"*。侧栏「⋯」里的「删除对话…」（来自 `dsh-session-purge`）能删**一个**会话，但没人批量维护：

- **刷B站插件**每跑一轮就 spawn 一个 headless 会话，`cwd` 是 `<DSH_HOME>/bili-duty`，没有对应工作区 → 落在「未分组」；
- 一些会话的 `cwd` 后来变了、或压根没记录 `cwd`，也会掉进「未分组」；
- 已分组工作区里的会话同样越堆越多，日志文件一直堆在 `<DSH_HOME>/sessions/<项目>/<会话id>/` 里。

本插件把这些会话**按工作区分桶**列出来，并提供两种清理方式：**清掉某个工作区的全部会话**，或**清掉未分组 / B 站会话**。

## 界面

左下角打开「设置」，左侧导航里 **「清理工作区」** 和「账号与余额」「刷B站」并列（`settings.section`，`order: 35`）。这一行用外壳给未知 section id 的默认**齿轮**图标。

点进去是清理页。页面按工作区分桶展示，**默认全部收纳**，每个桶一张卡片：

- **点方框（标题那一行）任意位置**即可在「收纳」与「展开」之间切换（也支持回车 / 空格）；
- 方框右侧有一个箭头：**↑ 表示当前已收纳，↓ 表示当前已展开**；
- 展开时才显示该桶的会话列表和右侧的 **「清理该工作区」** 按钮——点击会清掉这个桶里的全部会话，工作区记录本身不动；
- 会话列表里**每条会话显示它在工作区里的名字（标题）**——取自会话日志里最后的 `session/title` 事件，没有就回落到会话 id；左侧带**勾选框**，**点会话任意位置即可选中 / 取消**；
- 会话列表区域不参与切换点击。

> **收纳与安全**：默认收纳，方框里只显示工作区名字；「清理该工作区」按钮只在展开时出现，收纳时按钮和会话列表一起消失，避免误触。点方框任意处即可切换。

扫描结果顶部显示「N 个工作区 · M 个会话」。勾选会话后，会出现「已选中 N 个会话」以及一个 **「取消全部选中」** 按钮——点它清空所有勾选，不会打开确认框、也不会删除任何会话。删除勾选会话仍然只用页底常驻的「清理选中会话」按钮。

页底保留三个全局按钮：

| 按钮 | 行为 |
|---|---|
| **清理全部未分组** | 删除**所有未分组会话**（含 B 站会话、掉进未分组的其它会话）。已分组工作区的会话**不会**被删。 |
| **仅B站会话** | 只删除**刷B站插件调用模型产生的会话**（按记录的 `cwd` 判定），与分组无关。 |
| **清理选中会话** | 删除你**勾选**的会话，可以跨工作区、跨桶；没有勾选时按钮禁用。 |

点任一按钮弹出确认框，逐条列出会删的会话（显示标题，含 B 站 / 已归档 / 运行中徽标），勾选确认后才会真正删除。删除成功后页面自动重新加载刷新列表。

> **导航图标**：设置页左侧那一行的图标由 DSH 的设置外壳决定——外壳按 section id 硬编码图标、未知 id 回落到**齿轮**，且没有暴露图标选项。本插件**不自带图标**，直接用外壳给的默认齿轮。早期版本曾把垃圾桶图标塞进 label、再用 CSS `:has()` + MutationObserver 隐藏外壳齿轮，现已移除（改图标容易出 bug）。

## 工作原理

### 1. 会话怎么分桶

与浏览器端 `WorkspaceBrowser` 完全一致：**已存储会话中，被某个工作区的 `sessionIds` 记到的就归那个工作区，其余归「未分组」**。

- 从 `ctx.sessionPersistence.list()` 读全部已存储会话头；
- 从 `ctx.workspaceRegistry.list()` 读所有工作区，用它们过滤后的 `sessionIds` 建立 `sessionId → 工作区` 映射；
- 映射之外的会话进「未分组」桶。

工作区注册表自己会按会话头的 `cwd` 过滤成员（`WorkspaceEntity.sessionIds` 只保留 `candidateMatches(id, path)` 的），所以 cwd 对不上的会话天然落进未分组——本插件复用这套口径，不自己另立标准。

**B 站桶是横切的**：它列出所有 `cwd` 位于 `<DSH_HOME>/bili-duty` 内的会话，**不管它属于哪个工作区**。因此 B 站会话可能同时出现在某个工作区桶和 B 站桶里——这是刻意的，两个桶各管各的清理范围。

### 2. 会话名（标题）从哪来

**取自会话日志里最后的 `session/title` 事件**——这正是 DSH 标题服务写入、侧栏显示的那个名字，所以清理页里每条会话显示的名字和侧栏一致。

- 宿主端优先用 `ctx.sessionQuery.readTitleSnapshots()` 批量折叠（一次观察读完所有日志）；
- 没覆盖到、或折叠失败的会话，再单独 `sessionPersistence.open(id, 'read')` 读日志；
- 日志里没有 `session/title` 时，回落到第一条用户消息（截断到 80 字符）；再没有就显示会话 id。

### 3. 「B站会话」怎么算

**看会话头记录的工作目录 `cwd` 是否位于 `<DSH_HOME>/bili-duty` 内**（大小写不敏感、`/` 与 `\` 都认）。刷B站插件 spawn headless 会话时 `cwd` 固定是插件家目录，所以这条路最准。

### 4. 删除复用 `dsh-session-purge`

**本插件不自己删文件**，而是对每个目标会话调用已安装的 `dsh-session-purge` 的

```
POST /plugins/dsh-session-purge/api/purge   { sessionId, mode, confirm: true }
```

（带 `x-dsh-session-purge: 1` 标记头）。这样删除逻辑只有一份：id 校验、`cwd` 归属校验、DSH 数据目录保护、共享附件扫描、运行中会话先停止再归档，全部由 purge 插件的宿主端强制，前端说了不算。

之所以用 HTTP 而不是 `import`，是因为 profile 里的 bundle 是**符号链接**，Node 从插件包目录解析不到同 profile 的 `dsh-session-purge`；而调用同一个进程内的 web server 不受这个限制。

默认模式是 `artifacts`（删除会话记录 + 该会话在其工作目录内产出的文件）。位于 `~/.dsh` 内的文件 purge 插件会一律保留。

### 5. 清理某个工作区时发生了什么

以工作区 A 为例：点 A 卡片右边的「清理该工作区」→ 确认框列出 A 的全部会话 → 确认后，宿主端**重新推导** A 桶里的会话清单，逐个调 purge 删除。

- **A 的工作区记录不会被删**：注册表里 A 仍在，只是 `sessionIds` 被清空（由 purge 的 `detachSession` 完成），侧栏里 A 变成一个**空工作区**；
- A 目录本身（`path`）不动，A 里产出的、位于工作目录内的文件按 purge 的规则删除；
- 其它工作区的会话一个都不碰。

## 安全边界（全部在宿主端强制）

- **目标清单在宿主端重算**：浏览器只提交「范围（`all` / `bili` / `workspace` / `selected`）+ 工作区 id / 会话 id 列表 + 模式 + 确认」，宿主端从会话日志重新推导要删哪些会话，前端内存里的数据改不了范围。
- **工作区记录永不删除**：`workspace` 范围只清会话，工作区本身保留。
- **未知 / 过期的工作区 id 清不到东西**：宿主端先把 id 解析成桶，解析不到就是空目标，不会退化成「清全部」。
- **勾选清理只接受宿主端认识的会话**：`selected` 范围会先拿浏览器传来的 id 列表去对已存储会话，对不上的直接忽略，不会因为一个伪造 id 而多删东西。
- **`/plugins` 路由不受登录态保护**：两个写接口额外要求本插件自己的标记头 `x-dsh-workspace-cleanup: 1`，并在带 `Origin` 时校验同源。别的网页发起的跨站请求设不了这个头（会先触发预检），因此无法借你的浏览器触发清理。
- **范围/模式白名单**：`scope ∈ {all, bili, workspace, selected}`，`mode ∈ {record, artifacts, everything}`，其余一律 400。
- 复用 purge 插件的全部删除安全规则（见 [dsh-session-purge](https://github.com/hshh603/dsh-session-purge)）。

## 安装

插件是一个标准的 DSH bundle 包，`cordis.patch.yml` 已随包提供：

```yaml
- insert:
    - id: workspace-cleanup
      name: dsh-workspace-cleanup
```

### 方式一：插件管理器 / `plugin_manager` 工具

把本目录的**绝对路径**作为安装目标（宿主会读取该目录的 `package.json`），安装后它会自动加入 profile 的 `dsh.profile.bundles` 并启用。

### 方式二：手工链接（等价于其它本机插件）

```powershell
# 1. profile 的 package.json 加依赖 + bundle
#    dependencies:  "dsh-workspace-cleanup": "link:../../plugins/dsh-workspace-cleanup"
#    dsh.profile.bundles: 追加 "dsh-workspace-cleanup"

# 2. 建符号链接
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-workspace-cleanup" "%USERPROFILE%\.dsh\plugins\dsh-workspace-cleanup"

# 3. 重启 DSH
```

**生效时机**：宿主半（`lib/index.js`）的改动需要**重启 DSH**（Loader 按包名缓存已导入的模块）；浏览器半（`lib/client.js`）改完文件后由 `client-modules` 的 HMR 直接送进已打开的页面，无需刷新。但**新插件要出现在设置页，必须重启一次**（profile 在启动时读取）。

## 开发

```text
dsh-workspace-cleanup/
├── package.json          # 包清单：dsh.bundle.patch + dsh.client.platform
├── cordis.patch.yml      # profile 里挂载本插件的 bundle 层
├── lib/
│   ├── index.js          # 宿主半：scan / clean / health 三个接口 + 分桶推导
│   └── client.js         # 浏览器半：设置页条目 + 工作区清理 UI + 确认弹窗
├── verify/
│   ├── verify-host.mjs    # 离线验证套件（94 项断言，宿主半）
│   └── verify-client.mjs  # 离线验证套件（65 项断言，浏览器半）
├── README.md
├── AGENTS.md             # 维护者须知
└── CHANGELOG.md
```

两个半都不需要构建步骤：宿主半是普通 ESM，浏览器半是手写的 `window.__ModuleLoader__` bundle。

```sh
node verify/verify-host.mjs   # 或 pnpm verify（两个套件都跑）
node verify/verify-client.mjs
```

宿主套件用临时 DSH home 和桩 `sessionPersistence` / `workspaceRegistry` / `webServer`，覆盖分桶、标题折叠与范围：每个会话恰好落进一个工作区桶、B 站桶横切、标题取日志里最后的 `session/title`、`all` 只清未分组、`workspace` 只清指定桶、`selected` 只清勾选且忽略伪造 id、未知 id 清不到东西、空范围不发起 purge、`requireOwnPage` 拒绝缺标记/跨站、scan/clean 路由的白名单校验等。浏览器套件在 `vm` 沙箱里加载 `lib/client.js`（桩 `window.__ModuleLoader__` / `react` / primitives，含一个 hook 模拟器），验证两个槽位注册、导航 label 是纯文本且 CSS 里没有隐藏齿轮的规则、每个桶一张卡片、页底三个全局按钮仍在、**收纳行为**（默认全部收纳、点方框头部展开、会话列表不参与切换点击、清理按钮不会误折叠）、以及**勾选**：每条会话显示标题与勾选框、点行任意位置选中 / 取消、按钮显示选中数、无勾选时禁用、确认弹窗带勾选的会话 id；外加**「取消全部选中」**：勾选时才出现、点击清空全部勾选且不打开确认框、清空后按钮消失、页底按钮重新禁用。

## 已知限制

- **未分组 = 注册表口径**：一个会话只要被某个工作区记名就不会被「清理全部未分组」选中，哪怕它的 `cwd` 其实已经对不上。这是刻意的——宁可少删，不可误删。
- **B 站会话靠 `cwd` 认**：如果刷B站插件改了 spawn 时的工作目录，需要同步改这里的 `BILI_DIR_NAME` / 判定逻辑。
- **B 站桶会与分组桶重叠**：B 站会话若恰好属于某个工作区，会同时出现在该工作区桶和 B 站桶里。清理时以你点的那个桶为准。
- **收纳状态是内存态，且默认全部收纳**：哪个工作区被展开只保存在当前页面，刷新或重新打开设置页会恢复成全部收纳。清理成功后页面会自动重载，展开状态随之重置。
- **会话名来自日志**：标题取自会话日志里最后的 `session/title` 事件，和侧栏显示的是同一个名字。没有标题事件的会话会回落到第一条用户消息（截断 80 字符），再没有就显示会话 id。
- **勾选是内存态**：勾选了哪些会话只保存在当前页面，刷新或重新打开设置页会清空。清理成功后页面会自动重载，勾选随之重置。
- **只删会话与产出文件**：`~/.dsh` 内的文件（例如刷B站的日报、日志）purge 插件一律保留，本插件不会绕过这层保护。
- **正在运行/打开的会话**：先 `stopActivity: true` 归档再删；Windows 上若日志仍被占用会失败并在结果里列出原因，等当前回合结束后重试。
- **列表刷新**：`api-session/removed` 是尽力而为地广播；可靠做法是重新加载页面，成功后对话框就是这么做的。
- **只验证过 DSH `0.2.0-rc.2`**。其它版本请先跑离线验证，再核对 `settings.section` 与 `shell.overlay` 两个槽位契约。
- **导航图标用外壳默认齿轮**：设置外壳按 section id 硬编码图标、未知 id 回落齿轮，且没有图标选项。本插件不自带图标、也不写任何隐藏规则，所以外壳改 id 映射或 `wCInkW_*` class 名都不影响本插件（旧版在 label 里塞垃圾桶、并用 CSS `:has()` + MutationObserver 隐藏齿轮，已移除）。

## 许可

[MIT](LICENSE)
