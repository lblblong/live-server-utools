# AGENTS.md — Live Server（uTools 插件）AI 协作入口

本文件面向任何能读取仓库文件的 AI 编程工具 / Agent。先读本文件，再按任务读对应源码与文档。
文档是导航与说明，**当前实现以源码为准**；发现文档与代码漂移时应修正文档，不要照过时描述改代码。

## 0. 必读技能（uTools 插件开发）

开发、修改或排查 uTools 插件前，若当前环境提供 `utools-plugin-dev` 技能（uTools 官方开发 Skill，内含官方 API 参考与开发规范），**必须先加载它**：以其中 `references/` 的官方文档作为 uTools API、参数、生命周期与运行行为的唯一依据，不得凭经验或本机环境推断。技能规范与项目文档冲突时，优先官方文档。

## 1. 项目事实

- 一句话：uTools 插件「Live Server」—— 给静态页面目录一键启动带 WebSocket 热刷新的本地 HTTP 服务，并提供管理面板（多目录、启停、端口/目录快捷打开）。
- 来源：fork 自 https://github.com/lblblong/live-server-utools 。当前远程：`origin` = MrTian257/live-server-utools，`upstream` = lblblong/live-server-utools；当前分支 `master`（上游历史 3 个提交）。**GitHub 网络当前不可达**（fetch 失败），不要假设能拉取远程或查阅线上 issue。
- 本机环境：Windows 11；uTools 7.8.0；Node v24.22.2（构建要求 **Node >= 24**，本机已用 Node 26.7.0 验证，见 §11）；npm 11.19.1 / yarn 1.22.22；npm 镜像 `registry.npmmirror.com` 可用；依赖已安装（node_modules 在本地，不入库）。
- 版本：`package.json` 0.1.0；`plugin.json` 0.0.1（不一致，统一口径待用户决定）。
- 平台：`plugin.json` 的 `platform` 仅 `win32`。

## 2. 技术栈

- **渲染进程（插件主界面）**：React 18 + MobX 6（`mobx-react-lite`）+ TypeScript 5 + **Vite 7**（`@vitejs/plugin-react`）；SCSS modules（`sass`），`src/pages/manager/index.module.scss` 通过 `@use` 引用 `src/assets/css/vs.scss` 变量；构建产物固定输出 `build/`（`base: './'`）。
- **预加载（Node 侧）**：独立 TS 工程 `preload/tsconfig.json`（ES2019/commonjs，`strict=false`），`tsc` 输出 `preload/dist/index.js`；运行时依赖 vendored `preload/lib/live-server`（改版 live-server 1.x）与 `preload/lib/http-shutdown`；依赖清单见 `preload/package.json`（chokidar 3 / connect / faye-websocket 0.11 / send 0.19 / serve-index / morgan；注入脚本的流式替换用内置 Transform 实现，已移除 event-stream）。2026-11-05 优化中已裁剪 opn / http-auth / cors / proxy-middleware / http-proxy / object-assign（默认路径不需要，见 §6-2/7）。
- **持久化**：uTools 内置 db（`utools.db`），key = `utools.getLocalId() + '_servers'`，value = `[{ dir, port, customPort? }]`（`customPort` 缺省 `false`，旧数据兼容）。
- **产物**：`build/`（渲染进程）、`preload/dist/index.js`（预加载）；`plugin.json` 的 `main` / `preload` 分别指向这两处。

## 3. 目录与职责

| 路径 | 职责 |
| --- | --- |
| `src/index.tsx` | 渲染入口：`createRoot` 挂载 `IndexPage`（StrictMode），引入图标字体 CSS |
| `src/pages/manager/` | 管理面板 UI：列表、状态点、端口/目录快捷打开、修改端口（行内编辑）、删除/打开目录/启停按钮、悬浮新增按钮；`index.module.scss` 样式 |
| `src/store/server.ts` | 单例 `StoreServer`：服务启停、端口分配调用、uTools 事件与 db 持久化 |
| `src/model/live-server.ts` | 领域模型：`LiveServer`（state/dir/port/customPort/server）、`LiveServerState`（on/off/loading）；第 2 行 `import { Server } from 'preload'` 是根 `preload` link 依赖的类型耦合点 |
| `src/components/icon/` | 字体图标组件 `<Icon value="add-line" />` → `icon-{value}` 类名 |
| `src/common/utils/other.ts` | `isNil` / `isNotNil` |
| `src/assets/css/vs.scss` | 全局 scss 变量：`$color-primary: #5d9cec`、`$color-third: #f2237b` |
| `src/assets/icon/fonts/` | 图标字体资源（`icon.css` 被入口引入） |
| `preload/src/index.ts` | 预加载入口：把 `{ startLiveServer, httpShutdown, getCanUsePort, isPortAvailable, waitServerReady, closeServer, openSelectDirectoryDialog }` 挂到 `window.utils`，并声明 `Window.utils` / `Server` / `StartOptions` 类型 |
| `preload/src/utils.ts` | 目录选择对话框、TCP 端口探测与可用端口分配、`isPortAvailable`、`waitServerReady`（真实 listening/error）、`closeServer`（shutdown 回调 + 500ms force 兜底，含 watcher 关闭） |
| `preload/lib/live-server/` | 改版 live-server：静态服务 + serve-index + chokidar 监听（watcher 挂在 server 实例上）+ 注入热刷新脚本（`injected.html`，按 path+mtime 缓存检测；流式替换用内置 Transform）；`opn`/`http-auth`/`cors`/`proxy-middleware`/`http-proxy` 为已裁剪的可选能力 |
| `preload/lib/http-shutdown/` | 给 server 挂 `shutdown(cb)` / `forceShutdown(cb)`，跟踪并销毁空闲连接 |
| `public/` | 静态资源（favicon / robots / manifest），由 Vite 原样复制到 `build/`；主界面入口是根目录 `index.html` |
| `plugin.json` | uTools 插件清单：命令 `Live Server` + 超级面板「启动实时文件服务」（匹配 `explorer.exe`） |
| `vite.config.ts` / `tsconfig.json` / `index.html` | 渲染进程构建配置（Vite 7，`base: './'`）与主界面 HTML 入口 |
| `assets/logo.png` | 插件图标 |

## 4. 运行时架构

渲染进程与 preload **没有 IPC**：preload 在渲染上下文执行并直接 `window.utils = { ... }` 暴露 Node 能力，React 侧调用 `window.utils.*`。

启动时序：

1. uTools 加载插件 → `preload/dist/index.js` 执行，挂载 `window.utils`；触发 `onPluginReady` → `StoreServer.loadDb()` 从 `utools.db` 恢复 `{dir, port}` 列表（状态一律为 off）。
2. 用户进入插件：`utools.onPluginEnter(params)`：
   - `type === 'window'`（资源管理器右键/超级面板）→ `utools.getCurrentFolderPath()` 取当前目录 → `startServer({ dir })`；
   - `type === 'text'` → 当前无逻辑。
3. `startServer(dir)`：无 dir → 弹出目录选择框；同名目录已有记录且 `loading` → 直接返回；已 `on` → `utools.shellOpenExternal('http://localhost:<port>')`。
4. 端口：`getCanUsePort([...usedPort], 已有 ? port : 6600)` —— 用 TCP connect `127.0.0.1` 判断占用；默认 6600 起，冲突时先跳到 usedPort 数组末位（Set 插入序，不是最大端口）+1，再逐个 +1。**自定义端口（`customPort=true`）例外**：严格使用记录端口，启动前用 `isPortAvailable` 校验，占用则提示并保持 off，不自动递增。
5. `window.utils.startLiveServer({ host: '0.0.0.0', open: false, file: 'index.html', root: dir, port })` → vendored live-server `start()`：connect 静态服务 + serve-index + 注入 reload 脚本 + chokidar 监听；浏览器不再由 lib 的 opn 打开（渲染层 ready 后调用 `utools.shellOpenExternal`）。
6. `window.utils.httpShutdown(server)` 给 server 挂 `shutdown(cb)`；随后渲染层 `await window.utils.waitServerReady(server)`，只有真正 listening 后才 `usedPort.add(port)`、`state = on`、`flushDb()` 写库并打开浏览器；失败则回滚 off。
7. 停止：渲染层 `await window.utils.closeServer(server)`（内部先关 `server.watcher`，再 `shutdown(cb)` + 500ms force 兜底），完成即置 off、清 `usedPort`，不再有固定 1s 假等待。
8. 热刷新：live-server 在 HTML 的 `</body>` / `</svg>` / `</head>` 前注入 `injected.html`；浏览器连 `ws://host/path/ws`；文件变更广播 `reload`，`.css` 变更广播 `refreshcss`。
9. 服务由插件 preload 进程持有：插件退出/重载时进程销毁，服务随之结束（代码未显式清理）。

## 5. 构建与运行（CRA4 历史记录，已于 2026-11-05 废弃）

> ⚠️ 本节是迁移前的 CRA4（react-scripts 4 + craco）分析，**已不再适用**。当前构建链为 Vite 7 + React 18 + TypeScript 5，完整命令见 §11。保留本节仅用于理解历史问题（Node 24 下 CRA4 无法构建是迁移的直接原因）。

> 以下为 2026-11-04 静态核对结论（本机 Node v24.22.2、uTools 7.8.0）；未实际安装依赖或构建。

- **安装阻塞**：根 `package.json` 的 `dependencies` 里有 `"preload": "link:E:/code/pro/utools/preload"`（原作者机器路径），本机无 E: 盘；`yarn.lock` 里对应键仍是 `preload@link:../preload`（与 package.json 不一致）→ `yarn install --frozen-lockfile` 必失败；即便悬空 link 装上了，解析也走 `node_modules/preload/main = ./dist/index.js`（无 `types` 字段），`preload/dist` 缺失即 TS2307。
  修复方向（待需求定）：① 改 `"preload": "file:./preload"`；② 用 tsconfig `paths` 指向 `preload/src/index.ts`；③ 删依赖 + 渲染侧本地声明类型。
  ⚠️ 关键约束：`Server` 类型导入点在 `src/model/live-server.ts:2`，而 `Window.utils` 的全局声明**唯一来源**是 `preload/src/index.ts` 的 `declare global`；若只补 `Server` 类型，`src/store/server.ts` 里 4 处 `window.utils.*` 会报 TS2339。
- **构建顺序**：必须先构建 preload，再构建根（根 tsconfig 无 `paths`，`preload` 类型靠 `node_modules/preload/dist/index.d.ts`）。
- **渲染进程构建会因 Node 24 失败**：CRA4（webpack4）默认使用 md4，本机实测 `crypto.createHash('md4')` → `ERR_OSSL_EVP_UNSUPPORTED`；需在 `NODE_OPTIONS` 加 `--openssl-legacy-provider`（Windows cmd：`set NODE_OPTIONS=--openssl-legacy-provider&& yarn build`，或用 cross-env），实测该参数可用。
- **可用脚本**：根 `build`（craco build → `build/`）、`serve`（build + cra-build-watch 热构建）；preload 目录内 `build` / `serve`（tsc -p → `preload/dist/index.js` + `index.d.ts`）。
- **失效脚本**（不要用）：根 `build:preload`、`serve:preload`（指向不存在的 `preload/index.ts` → `build-preload`）、`build:demo`（`.env.staging` 不存在）、`commit`（`git-cz` 未声明依赖）；**没有 `start` 脚本**。
- **依赖安装**：preload 的运行依赖只能 `cd preload && yarn`，且必须在根 install 之后（preload devDeps 全是 `link:../node_modules/*`）；npm 不可行（不支持 `link:` 协议，且 `preload/package-lock.json` 陈旧：name 为 `react.tp`、lockfileVersion 1）。
- **`.env` / sourcemap**：`.env` 只关 JS sourcemap（`GENERATE_SOURCEMAP = false`），CRA4 仍会产出 CSS `.map`；preload `tsconfig` 的 `inlineSourceMap: true` 与提交 f4d74e0「去除 sourcemap」口径不一致。
- **打包进 uTools**：uTools 7.8 的插件目录（`%APPDATA%\uTools\plugins`）实际是 `<hash>.asar`（+ `<hash>.asar.unpacked`）而**不是裸目录**，直接拷目录不成立；本地预览用 uTools 开发者工具指向本仓库目录；发布需 `.upx`/asar 打包（仓库目前无脚本）。
  必须进包的文件：`plugin.json`、`build/`、`preload/dist/`、`preload/lib/`（`injected.html` 由 `fs.readFileSync(__dirname)` 运行时读取，漏了热刷新会崩）、`preload/node_modules/`、`assets/logo.png`；不要把 `preload/lib/live-server/package-lock.json`（约 105KB）打进包。
- **无用/闲置依赖**（候选清理，需需求确认）：`sass-loader@10`（CRA4 实际用嵌套 8.0.2）、`passport`、`@types/js-cookie`、`craco-alias`。
- **类型版本待验证**：`@types/react` 锁 16.14.2，而 `jsx: react-jsx`（该版本是否有可用的 `jsx-runtime.d.ts` 需装依赖后确认；不行则升 `@types/react@17`）。
- 版本口径：`plugin.json` 0.0.1 与 `package.json` 0.1.0 不一致（以谁为准待用户定）。

## 6. 已知风险与坑（按影响排序）

> 2026-11-05 性能/流畅度优化（分支 `feature/optimize-performance`）已修复 2、3、5、6、7、9、10、11（key）、13 中标注「已修复」的部分；同日将构建链迁移到 Vite 7 + React 18 + TypeScript 5（要求 Node >= 24）。1、4、8、12 仍存在，见各条说明。对应方案与体积数据见 `docs/plans/optimization.md`。

1. **构建链现状**：CRA4 在 Node >= 24 无法构建（webpack4 md4 / postcss exports），已于 2026-11-05 迁移到 Vite 7 + React 18 + TypeScript 5，命令见 §11；§5 为历史记录。
2. **一次端口冲突可能误杀别的服务（最高危运行时缺陷）**：~~listen error 里 `e.toString().red` 打印 undefined 并调用全局 `LiveServer.shutdown()` 关掉别的服务~~ **已修复**：error 只关当前实例的 watcher/server，日志改为 `console.error(e)`；模块级 `LiveServer.shutdown()` 仅保留为兼容 API。
3. **启动是 fire-and-forget**：~~start() 同步返回、UI 立刻置 on~~ **已修复**：新增 `waitServerReady`（listening/error/5s 超时），渲染层 await 后才置 on，失败回滚 off 并提示。
4. **端口探测/分配**：TCP connect 127.0.0.1 判断占用、默认 6600；冲突时跳 `[...usedPort]` 的**末位 + 1（Set 插入序）**再逐个 +1；探测成功后已 `close` socket（此前泄漏已修）；另加 800ms 超时（超时按占用处理）与 200 次探测上限，避免防火墙 DROP / 端口段占满时卡死。**仍存在**：无「探测→预留」机制 → 两路 startServer 可能拿到同一端口（TOCTOU）；**自定义端口探测只连 127.0.0.1，而服务绑 0.0.0.0**：仅绑定具体 LAN IP 的进程、Windows 保留端口段或探测→绑定 TOCTOU 仍可能漏检（见 `docs/plans/custom-port.md`）。
5. **`new Promise(async …)` 反模式**：**已修复**：`getCanUsePort` 改为 `async function`，异常可 reject，不再出现永久 loading 死行。
6. **停止不彻底 / watcher 泄漏**：**已修复**：`closeServer` 用 shutdown 回调 + 500ms force 兜底，并先关闭挂在 server 上的 chokidar watcher；UI 不再固定等 1s。残留：`usedPort` 仍只在内存、`loadDb` 不恢复。
7. **多服务并存假设不成立**：**已修复**：lib 把 watcher 挂到各自 server 实例；非 `/ws` upgrade 且无 proxy 时安全断开（旧实现抛 TypeError）；error 路径不再调全局 shutdown。残留：`LiveServer.server/watcher/logLevel` 模块级字段仍存在（仅兼容用）。
8. **`file: 'index.html'` + `serve-index`**：所有 404 都回 `index.html`(200)，缺失资源不再 404；`host: '0.0.0.0'` + 目录列举 + 无认证 → 局域网可访问（安全面待需求确认）。
9. **错误处理/反馈缺失**：**已修复主要路径**：取消目录选择不再产生未处理 rejection；启动失败/超时、写库失败都收敛为通知；启动失败统一回 off。残留：极端异步边界仍以 `utools.showNotification` 为主。
10. **状态双口径**：**已修复**：按钮文案改由 `state===loading` 驱动（启动中…/停止中…/保存中…），active 样式仍按 `server` 真值。
11. **MobX/React 细节**：**已修复** 列表 `key`、空态、按钮即时反馈；残留：`.lbox/.dir` 的 `min-width: 0`、删除二次确认未处理；`file://` 路径已由 `toFileUrl`（反斜杠/空格/中文/UNC）规范化。
12. **初始化顺序无防护**：若 `onPluginEnter` 先于 `onPluginReady`，`startServer` 新增的行可能被随后 `loadDb` 覆盖（丢 server 引用、状态回 off）；`onPluginEnter` 重复调用 `getCurrentFolderPath()`。**仍存在**。
13. **构建联动陷阱（已随构建链迁移消失）**：旧 CRA 脚本的 `--esModuleInterop` 问题不再存在；`preload/src/index.ts` 保留 `httpShutdown` 的调用签名断言，删除会导致渲染层 `window.utils.httpShutdown(...)` 类型报错。`lib/live-server/index.d.ts` 已同步 `StartOptions`/`Server` 扩展。
14. **模板残留**：已删除 CRA 的 `public/index.html`，根 `index.html` 标题改为 `Live Server`；`public/manifest.json` 仍引用不存在的 logo192/logo512（页面未引用，可后续清理）。
15. **无自动化测试**：迁移时移除 CRA 的 `src/react/setupTests.ts` 与 testing-library 依赖；当前无测试用例。

## 7. Agent 团队与写域

团队由 Lead 统一调度；**同一文件同一时间只允许一个 Agent 写**。

| Agent | 角色 | 写域 |
| --- | --- | --- |
| `lead` | 需求接入、拆解、集成、文档、git 提交（不 push） | `AGENTS.md`、`docs/`、最终整合 |
| `panel-dev` | 渲染进程 UI/状态（React/MobX/SCSS） | `src/` |
| `runtime-dev` | 预加载/Node 侧（live-server 生命周期、端口、关闭、注入） | `preload/src/`、`preload/lib/`（第三方库尽量不改；必须改时在提交信息中说明） |
| `build-qa` | 构建/打包/依赖/插件清单 + 静态审查与回归清单 | `package.json`、`tsconfig.json`、`vite.config.ts`、`index.html`、`plugin.json`、构建脚本；审查时只读 `src/`、`preload/` |

团队约定：

- 动手前在共享任务板登记 write scope；跨域改动由 Lead 协调并拆分。
- 不做与当前需求无关的改动；用户要求最小改动时，禁止顺带重构。
- 提交由 Lead 统一执行（中文信息，`feat:` / `fix:` / `docs:` / `chore:` 前缀）；**任何人不得 `git push`**。
- 临时产物放 `.scratch/`（未跟踪）；长期文档放 `docs/`。

## 8. 需求接入与开发流程

1. 用户提出需求 → Lead 复述目标、范围、验收口径与影响文件；信息不足时只问关键一问，不逐项确认。
2. 用户给出分支后开工（新需求默认从 `master` 切新分支/worktree；用户指定分支则从其分支）；Lead 先把开发计划/方案写入 `docs/`。
3. 按写域派发：`panel-dev` / `runtime-dev` / `build-qa`；任务板登记依赖关系与 write scope。
4. 开发完成后：补齐注释 → 静态自检 → 不跑 dev server、不打包、不冒烟。依赖已安装，可直接 `tsc --noEmit` 做类型检查。**静态语法检查用 bun（本机 1.3.14）**：`bun -e "new Bun.Transpiler({loader:'tsx'|'ts'}).transformSync(src)"` 或 `bun build <file> --no-bundle`；`.ts` / `.tsx` 均有效，可用负控样本验证灵敏度。**不要用 `node --check` 检查 TS** —— 实测对类型语法错误静默通过（假阳性），不能作为依据。
5. Lead 汇总 diff 并自审（`git status` 确认只含本次改动）→ 中文提交（不 push）→ 交用户自测。
6. 用户确认后再谈发布打包（打包属用户确认范围）。

## 9. 代码与文档约定

- **注释**：所有新增/修改代码必须带合适注释 —— 关键逻辑、非显而易见的取舍、边界条件、回归原因都要写清，不产出无注释代码块。
- **格式**：prettier（`semi: false`、单引号、2 空格、`printWidth: 120`）；组件用函数式 + `Observer`。
- **状态管理**：MobX `makeAutoObservable`；服务状态统一用 `LiveServerState`；不要把 React 局部状态与 MobX 混用。
- **渲染进程不能直接 require Node 模块**（Vite 浏览器环境）：一切 Node 能力经 `window.utils` 暴露，并同步维护 `preload/src/index.ts` 的 utils 对象与 `Window.utils` 声明。
- **文档**：本文件与 `docs/` 是长期文档；`.scratch/` 只放临时验证材料。
- **不要提交**：`build/`、`preload/dist/`、`node_modules/`、`.scratch/`、个人配置；`.eslintcache` 属历史遗留已被跟踪，不要新增这类缓存文件。

## 10. 事实核验

- 依赖与脚本以 `package.json`、`yarn.lock`、`preload/package.json` 为准。
- 插件清单与命令以 `plugin.json` 为准。
- 运行时行为以 `preload/src/`、`preload/lib/live-server/`、`src/store/server.ts` 为准。
- 构建配置以 `vite.config.ts`、`index.html`、`tsconfig.json`、`preload/tsconfig.json` 为准。
- 文档不得把未验证的计划、测试结果或历史实现写成当前事实。

## 11. 构建与安装（2026-11-05 升级后实测）

### 环境

- 构建要求 **Node >= 24**（根 `package.json` 的 `engines` 字段）。本机用 Volta 的 **Node 26.7.0** 实测通过。
- uTools 插件运行时由 uTools Runtime 决定（官方文档：Electron 34.5.8 / Chromium 132 / Node.js 20.19.1），与本机 Node 版本无关；preload 侧按 Node 20 能力编写即可。
- 构建链：**Vite 7 + React 18 + TypeScript 5**；preload 仍由独立 tsc 工程编译为 CommonJS（target ES2019，无 tslib 依赖）。
- 迁移原因：原 CRA4（webpack4）在 Node >= 24 无法构建（md4 摘要与 postcss exports 限制），且 uTools 官方开发工具已采用 Vite 模板，因此替换构建工具而不是降级 Node。

### 安装依赖

```powershell
yarn install --ignore-engines                      # 根目录
cd preload; yarn install --ignore-engines; cd ..   # preload 运行依赖（devDeps 是 link:../node_modules/*，必须在根安装之后）
```

- 依赖解析走 `registry.npmmirror.com`（lockfile 已指向该镜像）；拉包报证书过期时检查系统时间或改用镜像。

### 开发与构建

```powershell
yarn dev                                  # Vite 开发服务器
yarn build                                # 先 tsc preload，再 vite build -> build/
npx tsc --noEmit -p tsconfig.json         # 渲染层类型检查
cd preload; npx tsc -d -p tsconfig.json   # 仅重建 preload
```

- 根 `tsconfig.json` 使用 `moduleResolution: Bundler`，并通过 `paths` 把 `preload` 映射到 `preload/src/index.ts`（类型单一来源）；Vite 实际打包时 `import { Server } from 'preload'` 是纯类型导入，会被移除，不需要运行时解析。
- `vite.config.ts` 的 `base: './'` 必须保留：插件在 uTools 内以本地文件加载 `build/index.html`，绝对资源路径会失效；`build.target/cssTarget` 对齐 uTools Runtime 的 `chrome132`，不做无意义的 ES 降级。
- 入口 HTML 是仓库根目录的 `index.html`（Vite 约定）；`public/` 下文件由 Vite 原样复制到 `build/`。
- 构建产物：`build/`（渲染）、`preload/dist/`（预加载）；两者都被 .gitignore 排除。

### 打包成 uTools 插件 asar

- 组装：`plugin.json` + `build/` + `preload/{package.json,dist,lib,node_modules}` + `assets/logo.png`；排除 preload 的 dev link（typescript / utools-helper / @types）。
- 打包：用 `asar@3.2.0` 的 `createPackage(stage, out)`（脚本 `.scratch/pack-plugin.js` 可用并回读校验）。
- `plugin.json` 必须带 `name`（与已安装插件目录内 plugin.json 的 `name` 保持一致，可复用该插件的 utools.db 历史数据）。

### 安装到 uTools（本地验证方式）

1. 备份现有插件 asar：`%APPDATA%\uTools\plugins\<hash>.asar` → `%APPDATA%\uTools\plugin-backups\`。
2. 用新 asar 覆盖同名文件。
3. 结束所有 `uTools.exe` 进程后重新启动 uTools（必须重启才会重新挂载插件）。
4. 在 uTools 里搜 `Live Server` 打开即可；若异常，恢复备份并重启。

### 注意事项

- uTools 7.8 的插件目录是 `<hash>.asar`（不是裸目录）；`.upx` 不能直接安装，`.upxs` 需要开发者签名，因此本机离线安装走「替换已安装 asar」。
- uTools 主窗口默认隐藏，显示热键以 uTools 设置为准（见 `%APPDATA%\uTools\settings` 的 `showHotKey`）；Electron 窗口的屏幕截图可能黑屏或截不到内容，不要依赖截图验证。
