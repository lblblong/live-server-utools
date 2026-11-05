# 需求方案：自定义端口（feature/custom-port）

## 1. 目标

允许用户为单个服务手动指定端口；自定义端口在启动/重启时被**严格使用**，端口被占用时报错提示，而不是静默换端口。

## 2. 现状

- 端口自动分配：首次从 6600 起，冲突时按 `usedPort` 末位 +1 递增（`preload/src/utils.ts#getCanUsePort`）。
- 端口只持久化在 `utools.db`（`{ dir, port }`），UI 不可编辑；点击端口号 = 打开浏览器（README 既有行为）。
- 启动为 fire-and-forget，端口绑定失败当前不会反馈到 UI（见 AGENTS.md 风险 3）。

## 3. 交互设计

- 列表每行右侧新增「修改端口」文本按钮（`loading` 时禁用），与「删除/打开目录/启动服务」同组。
- 点击后端口位置变为行内输入框（autoFocus、选中当前值），Enter 或失焦保存，Esc 取消。
- 校验：整数 1–65535；不能与列表中其他服务的端口重复；必须通过 TCP 探测确认实际空闲。
- 成功：`utools.showNotification` 提示；若服务正在运行 → 先停止，再以新端口重启，并提示已在新端口重启。
- 失败：提示具体原因，保持编辑态（红框），不重启服务。
- 保留「点击端口号打开浏览器」的旧行为不变。

## 4. 数据模型

`LiveServer` 增加 `customPort: boolean`（默认 `false`）；持久化结构改为 `{ dir, port, customPort }`，旧数据缺字段按 `false` 兼容。

- `customPort = false`：沿用自动分配（`getCanUsePort`）。
- `customPort = true`：启动时严格使用该端口；启动前用 `isPortAvailable` 校验，占用则不启动并提示。

## 5. 契约（preload ↔ 渲染层）

- `preload/src/utils.ts` 新增 `isPortAvailable(port: number): Promise<boolean>`：`true` = 空闲；非 `ECONNREFUSED` 的探测异常按「不可用」处理（安全侧）。
- 修复 `portCheck`：探测结束（成功/失败）后销毁 socket，避免句柄泄漏。
- `preload/src/index.ts` 的 `utils` 对象暴露 `isPortAvailable`（自动进入 `Window.utils` 类型）。
- 渲染层新增 `StoreServer.setPort(dir, port): Promise<{ ok: boolean; error?: string }>`。

## 6. 边界与失败处理

- 端口被系统其他进程占用 → 提示「端口 xxx 已被占用」。
- 端口与列表里其他服务重复 → 提示「该端口已被其他服务使用」。
- 服务运行中改端口 → 停止 + 重启；重启失败则保持停止并提示，不自动回退。
- 与当前端口相同 → 视为无变化，仅标记 `customPort = true`。
- 编辑保存期间禁用相关按钮，避免并发启停。

## 7. 不在本次范围

- 构建链修复（`preload` link 依赖、Node 24 + CRA4 md4）—— 单独需求。
- 新增服务时在创建流程里指定端口（通过列表行编辑覆盖，暂不做弹窗）。
- 端口只监听 `127.0.0.1`、启动失败检测重构、删除确认等 —— 不在本次。

## 8. 写域

| Agent | 写域 |
| --- | --- |
| `runtime-dev` | `preload/src/` |
| `panel-dev` | `src/` |
| `build-qa` | 只读审查（不改代码） |
| `lead` | `docs/`、`README.md`、`AGENTS.md`、提交 |

## 9. 验证（交用户自测）

1. 未运行服务改端口 → 保存后启动，浏览器打开新端口。
2. 运行中改端口 → 服务自动重启到新端口，旧端口释放。
3. 输入非法值 / 端口被占用 / 与其他服务重复 → 提示且不生效、不重启。
4. 重启 uTools 后端口与 `customPort` 保留；旧数据（无 `customPort`）正常加载。
5. 点击端口号仍能打开浏览器；点「修改端口」可编辑。

## 10. 已知限制（本次不修）

- `isPortAvailable` 用 TCP 连接 `127.0.0.1` 探测，而服务监听 `0.0.0.0`：仅绑定具体 LAN IP 的进程、Windows 保留端口段或「探测→绑定」TOCTOU 仍可能漏检；最终绑定失败时错误只出现在 preload 控制台（启动失败检测属既有缺陷，见 AGENTS 风险 2/3）。
- 每次改端口都会走一次 stop + start，而 lib 从不关闭 chokidar watcher → 每改一次多一个 watcher（既有缺陷，见 AGENTS 风险 6）。
- 自动分配只认运行时 `usedPort`；`setPort` 查重按记录级端口（含未运行行）。两套口径不同，属已知差异。
