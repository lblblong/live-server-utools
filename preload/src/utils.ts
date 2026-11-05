import * as net from "net"
import type { Server } from './index'

export function openSelectDirectoryDialog(options: {
  title: string
  buttonLabel?: string
}) {
  const paths = utools.showOpenDialog({
    ...options,
    properties: ["openDirectory"],
  })
  if (!paths || paths.length === 0) throw Error("用户取消选择")
  return paths[0]
}

/**
 * 从 port 开始向上找一个可用端口（自动递增，语义与历史实现保持一致）。
 *
 * 回归说明：历史实现是 `new Promise(async (ok) => …)` —— async executor 内抛出的异常不会 reject
 * 外层 Promise，portCheck 一旦 reject（EHOSTUNREACH / EACCES 等）调用方就永久 pending（UI 卡死
 * loading）。改成 async function 后异常会正常向上 reject，由调用方 try/catch 处理。
 */
export async function getCanUsePort(usedPort: number[], port: number): Promise<number> {
  const lastPort = usedPort[usedPort.length - 1]
  let first = true
  while (true) {
    const used = await portCheck(port)
    if (!used) return port
    // 首次冲突且已有其它服务端口时，跳到「最后一个已用端口 + 1」；否则逐个 +1（与原逻辑逐字一致）
    if (first && lastPort) {
      port = lastPort + 1
      first = false
    } else {
      port++
    }
  }
}

/**
 * 探测 127.0.0.1 指定端口的连通性。
 * - resolve true：端口已被占用（TCP 连接建立成功）
 * - resolve false：端口空闲（ECONNREFUSED）
 * - reject：非 ECONNREFUSED 的探测异常（如 EHOSTUNREACH / EACCES），由调用方决定如何处理
 *
 * 注意：无论探测结果如何都必须销毁 socket —— 连接成功时若不销毁，每次探测都会留下一条长连接
 * （句柄泄漏，且该连接会被 http-shutdown 当作 idle 连接统计）。这是本函数的历史缺陷修复点。
 */
export function portCheck(port: number) {
  return new Promise<boolean>((ok, fail) => {
    const client = new net.Socket()
    // connect / error 只会先到其一，用 settled 保证 Promise 只结算一次
    let settled = false
    const settle = (used: boolean, err?: any) => {
      if (settled) return
      settled = true
      // 先销毁再结算：锁住「探测结束即释放句柄」，异常路径也不会漏
      client.destroy()
      if (err) fail(err)
      else ok(used)
    }
    client.once('connect', () => {
      settle(true)
    })
    client.once('error', (err: any) => {
      if (err.code !== 'ECONNREFUSED') {
        settle(false, err)
      } else {
        settle(false)
      }
    })
    client.connect({ port, host: '127.0.0.1' }, () => {})
  })
}

/**
 * 判断端口是否可用（true = 空闲，可以绑定）。
 *
 * 取舍：探测异常（非 ECONNREFUSED，如 EHOSTUNREACH / EACCES / 端口越界）一律按「不可用」处理。
 * 这里选安全侧 —— 自定义端口启动是 fire-and-forget（绑定失败不会反馈到 UI，见 AGENTS.md 风险 3），
 * 宁可提示「端口不可用」，也不要放行后再静默启动失败；代价是极端网络环境下可能误报。
 */
export function isPortAvailable(port: number): Promise<boolean> {
  // portCheck 的语义是「true = 已被占用」，这里取反；then 的第二个回调吞掉探测异常并返回 false，
  // 保证 isPortAvailable 永不 reject，渲染层可直接 await 而不必再包 try/catch。
  return portCheck(port).then((used) => !used, () => false)
}

/**
 * 等待 server 真正进入监听状态。
 *
 * 背景：live-server 的 start() 是同步返回的（此时 listen 还没完成），渲染层若立刻置 on 会出现
 * 「UI 显示已启动、实际端口没起来」。本函数提供真实的就绪信号：
 * - server.listening 已为 true：立即 resolve（可能发生在 start 返回后又过了一个 tick）
 * - 'listening' 事件：resolve
 * - 'error' 事件（如 EADDRINUSE）：reject 原始错误，交给渲染层提示并回 off
 * - 超时（默认 5000ms）：reject，避免渲染层永久 loading
 * 结算后统一移除监听器并清掉定时器，避免每次启动都在 server 上残留一对闭包。
 */
export function waitServerReady(server: Server, timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!server) {
      reject(new Error('waitServerReady: server 不存在'))
      return
    }
    if (server.listening) {
      resolve()
      return
    }

    let settled = false
    let timer: any = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      timer = null
      server.removeListener('listening', onListening)
      server.removeListener('error', onError)
    }

    const settle = (err?: any) => {
      if (settled) return
      settled = true
      cleanup()
      if (err) reject(err instanceof Error ? err : new Error(String(err)))
      else resolve()
    }

    const onListening = () => settle()
    const onError = (err: any) => settle(err || new Error('server 启动失败'))

    server.once('listening', onListening)
    server.once('error', onError)
    timer = setTimeout(() => settle(new Error(`启动超时：${timeoutMs}ms 内未进入监听状态`)), timeoutMs)
  })
}

/**
 * 关闭一个 live server（stop 链路统一入口）：文件监听器 + HTTP server + 残留连接。
 *
 * 流程：先关闭 watcher（停止监听、释放 chokidar 句柄）→ 有 http-shutdown 挂载的 `shutdown` 时优先走它
 * （server.close + 销毁 idle 连接），在它的回调或 500ms 兜底后调用 `forceShutdown`（存在时）收尾，
 * 确保浏览器 keep-alive / WebSocket 长连接不会让端口继续被占着。
 *
 * 边界与取舍：
 * - 幂等：重复调用、server 已关闭、watcher 已关闭都只会快速 resolve；
 * - 永不 reject：调用方 await 后即可置 off，不需要再包 try/catch；
 * - 未挂载 httpShutdown（启动早期失败/旧路径）时回退 `server.close()`；
 * - 兜底 500ms 是上限不是固定等待：正常情况 shutdown 回调会先触发并立刻 resolve。
 */
export function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!server) {
      resolve()
      return
    }

    let settled = false
    let timer: any = null

    // 兜底强制关闭：http-shutdown 挂载后有 forceShutdown（销毁全部连接），否则退回普通 close
    const forceClose = () => {
      try {
        if (typeof server.forceShutdown === 'function') server.forceShutdown()
        else server.close()
      } catch (err) {
        // server 未监听/已关闭时 close 是空操作；这里只保证 closeServer 永不 reject
        console.error('closeServer: 强制关闭失败', err)
      }
    }

    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      timer = null
      forceClose()
      resolve()
    }

    // 1) 先关 watcher：旧实现从不在 stop 时关闭，watcher 会随启停不断累积并继续广播 reload
    try {
      if (server.watcher && typeof server.watcher.close === 'function') {
        const closing = server.watcher.close()
        // chokidar 的 close() 会返回 Promise；这里没人 await，兜住避免 unhandledRejection
        if (closing && typeof closing.catch === 'function') closing.catch(() => {})
      }
    } catch (err) {
      console.error('closeServer: 关闭 watcher 失败', err)
    }

    // 2) 兜底定时器：keep-alive 长连接可能让 shutdown 的 close 回调迟迟不到
    timer = setTimeout(finish, 500)

    // 3) 优先使用 http-shutdown 的 shutdown（其回调在 server 完全关闭后触发）
    try {
      if (typeof server.shutdown === 'function') server.shutdown(finish)
      else finish()
    } catch (err) {
      console.error('closeServer: shutdown 失败', err)
      finish()
    }
  })
}
