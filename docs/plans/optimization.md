# 优化方案：性能/占用 与 操作流畅度（feature/optimize-performance）

> 基线（2026-11-05 11:4x 实测）：
> - 插件 asar：**5,123,292 bytes**
> - 渲染进程 build：**232,558 bytes / 16 files**（JS gzip 合计约 65KB）
> - `preload/node_modules`：152 个顶层包 / 1,201 个文件 / 4,457,290 bytes（含 typescript、utools-helper 等 dev link 的伪大小；打包时已排除）
>
> 目标：asar 明显缩小；启动/停止/改端口不再有 1s 假等待；持续运行不再累积 watcher；列表交互不整页重渲染。

## P0 · 性能与占用

1. **watcher 泄漏**：`preload/lib/live-server/index.js` 现在把 watcher 存模块级 `LiveServer.watcher`，每次 stop 不关闭、再次 start 覆盖旧引用 → 旧 watcher 永久失联且持续监听（CPU/句柄累积，热刷新重复广播）。
   - 修法：创建 watcher 后挂到 `server.watcher`；停止时由 preload 调 `server.watcher.close()`；lib 的 listen error 处理只清理当前实例（不再调全局 `LiveServer.shutdown()` 误杀其他服务）。
2. **停止流程 1s 假等待**：`src/store/server.ts` 用 `server.shutdown()`+`server.close()`+`setTimeout(1000)`。改为 preload 提供 `closeServer(server): Promise<void>`（shutdown 回调 + 500ms force 兜底），渲染层 `await` 后立刻置 off、清 usedPort。
3. **启动真实就绪**：`start()` 同步返回、listen 异步。preload 新增 `waitServerReady(server, timeoutMs=5000)`（listening 立即 resolve / error reject / 超时 reject），渲染层等 ready 再置 on，失败提示并回 off。
4. **端口分配反模式**：`getCanUsePort` 的 `new Promise(async …)` 改为 `async function`，异常正常 reject（不再出现永久 loading 死行）。
5. **依赖瘦身（占用）**：lib 里 opn / http-auth / cors / proxy-middleware / http-proxy 都是「默认路径不会走到」的可选依赖，改为分支内懒加载 + 非 `/ws` upgrade 加 `proxy.length` 守卫；随后从 `preload/package.json` 删除这些包与未使用的 `object-assign`，重装并重新打包。预期 asar 缩小约 0.6–1.2MB。
6. **热刷新注入的同步读**：每次 HTML 请求都 `fs.readFileSync` 整文件找注入标签；改为按 `path+mtime` 缓存（Map 上限 200），命中直接注入。
7. **移除无用指标上报**：`src/react/reportWebVitals.ts` + `web-vitals` 对插件无意义，删除导入/文件/依赖（build 体积小幅下降）。

## P1 · 操作与流畅度

8. **列表项独立渲染**：整页单 `<Observer>` 任一状态变化都会重渲染所有行；拆出 `ServerItem`（`memo` + `observer`），handler 用 `useCallback` 稳定引用，只重渲染变化的行。
9. **即时反馈**：点击启动/停止/改端口后立即进入 loading 视觉态（按钮文案「启动中…/停止中…」或 spinner），不再等 1s 才有反馈。
10. **打开浏览器时机**：`open` 从 live-server 侧（opn，listen 前不可靠）改到渲染层「ready 后」调用 `utools.shellOpenExternal`（更准，且能删 opn 依赖）。
11. **异常处理**：取消目录选择、启动失败、停止失败统一 `utools.showNotification`，不再产生未处理 Promise rejection。
12. 组件卸载/切换时清理进行中的编辑态与定时器，避免残留。

## 写域与任务

| 任务 | Owner | 写域 |
| --- | --- | --- |
| T1 preload 生命周期/依赖懒加载 | runtime-dev | `preload/src/`、`preload/lib/` |
| T2 渲染层性能与交互 | panel-dev | `src/` |
| T3 依赖裁剪 + 构建/打包体积复验 + 审查 | build-qa | `package.json`、`preload/package.json`、构建/打包脚本（只读 src/preload 代码） |
| T4 Lead 集成 | lead | 构建、asar 重打包与安装、提交 |

## 验收

1. `preload/src` 编译（`npx tsc -d -p tsconfig.json`）通过；根 `yarn build`（Node 20.20.2 + `NODE_OPTIONS=--openssl-legacy-provider`）通过。
2. T1/T2 diff 经 build-qa 静态审查通过，无无关改动。
3. 指标对比：asar 体积、build 体积、preload 运行时包数量均下降；停止链路无固定 1s 等待；watcher 随 server 关闭。
4. 重打包 asar 并替换安装到 uTools，用户可实测：启停/改端口立即响应、热刷新正常、长时间运行无重复 reload。

## 实测结果（2026-11-05，含 T4 收尾）

| 指标 | 基线 | 优化后 | 变化 |
| --- | --- | --- | --- |
| 插件 asar | 5,123,292 B | **4,300,447 B** | **-822,845 B（-16.1%）** |
| asar 条目 | 1,535 | 1,344 | -191 |
| build | 232,558 B / 16 files | 235,841 B / 15 files | +3,283 B（-1 个分包；gzip 合计 ≈ 66.9KB） |
| 打进 asar 的 preload/node_modules | 1,201 files / 4,457,290 B | 1,047 files / 3,724,475 B | -154 files / -732,815 B |
| preload 运行依赖 | 8 直接 | 8 直接 | 裁掉 opn/http-auth/cors/proxy-middleware/http-proxy/object-assign + 10 个传递依赖 |

构建：preload `tsc -d` exit 0；根 `craco build` Compiled successfully；asar 回读 `missing=[]`、`requiredDepsPresent=true`、无原生模块；打包内容冒烟（stub `window/utools` require `preload/dist/index.js`）`window.utils` 7 个 API 均可调用。

已安装：新 asar 覆盖 `%APPDATA%\uTools\plugins\<hash>.asar`（旧版备份在 `%APPDATA%\uTools\plugin-backups\`），重启 uTools 生效。

### 行为变化（需知晓）

- 浏览器打开时机：由 live-server 的 opn 改为渲染层 `waitServerReady` 成功后 `utools.shellOpenExternal`；改端口重启成功也会按旧行为打开新端口。
- 可选能力移除：live-server 的 htpasswd / cors / proxy / opn 能力随依赖裁剪不可用；显式传参时 `optionalRequire` 抛说明性错误（opn 缺失仅告警）。
- 非 `/ws` 且未配置 proxy 的 WebSocket 升级请求现在主动断开（旧实现会抛 TypeError）。
- 启动失败（端口占用/超时）会回滚为 off 并通知；新建记录失败后仍留在列表（可重试或删除），与旧行为一致。

### 2026-11-05 二轮优化（Vite 迁移后）

- 端口探测加 800ms 超时（超时按占用处理）与 200 次上限，避免防火墙 DROP/端口段占满时 UI 永久 loading。
- closeServer 只在 500ms 兜底超时时才 forceShutdown；正常 shutdown 回调不再多余强制关闭。
- 移除已废弃的 event-stream：注入脚本改为内置 Transform（替换首个 `</body>` 等标签），修复了原实现 "替换时重复保留 tag 导致 Content-Length 少 7 字节" 的隐患，并用 30B/50KB/200KB 三档响应验证长度一致。
- 渲染层改用 mobx-react-lite（原 mobx-react 仅用到 observer），Vite target 对齐 chrome132。
- 目录打开改用 toFileUrl（反斜杠/空格/中文/UNC 规范化），修复 Windows 上 "打开目录" 可能无响应。
- 体积：asar 2,199,805 → 2,062,842 字节（-137KB）；构建 JS 220.36KB → 216.21KB（gzip 68.05KB）。

### 已知残留

- `waitServerReady` 5s 超时按启动失败回滚（极慢机器可能误报）。
- 停止后立刻用同一自定义端口重启，存在极短窗口被 `isPortAvailable` 误判（closeServer 在 force 兜底后立即 resolve，未等 'close' 事件）。
- `usedPort` 仍只在内存；多服务“探测→预留”TOCTOU 未解决。
- Electron 内实际运行（启停/热刷新）仍建议用户自测；自动化截图对 uTools 窗口不可靠。
