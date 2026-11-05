import * as httpShutdown from "../lib/http-shutdown"
import { start as startLiveServerRaw } from "../lib/live-server"
import { closeServer, getCanUsePort, isPortAvailable, openSelectDirectoryDialog, waitServerReady } from './utils'

// http-shutdown 是 CommonJS 函数模块（module.exports = addShutdown），运行时可直接调用；
// 但命名空间导入在 TS 里被推断为「模块对象」而没有调用签名，因此显式断言成函数类型。
// 只影响类型，不改变运行时行为；渲染进程调用 window.utils.httpShutdown(server) 依赖它。
const httpShutdownFn = httpShutdown as unknown as (server: any) => any

// lib 的 index.d.ts 与下面的 Server 契约已同步（listening/once/removeListener/forceShutdown?/watcher?）。
// 保留这次显式断言：一是把返回值收敛成「渲染层可见的 Server」类型，二是防止将来 lib 类型回退时调用处悄悄退化成 any。
const startLiveServer = startLiveServerRaw as (options?: StartOptions, callback?: () => void) => Server

const utils = {
  startLiveServer,
  httpShutdown: httpShutdownFn,
  getCanUsePort,
  // 端口占用探测（true=空闲）；供「自定义端口」在启动前校验，自动进入 Window.utils 类型
  isPortAvailable,
  // 启动/停止的真实完成信号：渲染层 await 后再切 UI 状态，替代历史实现的固定 setTimeout
  waitServerReady,
  closeServer,
  openSelectDirectoryDialog,
}

declare global {
  interface Window {
    utils: typeof utils
  }
}

/** startLiveServer 可透传的 live-server 选项；只列本插件会用的字段，其余选项按 any 透传 */
export type StartOptions = {
  host?: string
  port?: number
  root?: string
  open?: boolean | string | string[]
  /** 入口文件（未命中静态资源时回退到它），如 index.html */
  file?: string
  /** 只监听这些路径，默认 [root] */
  watch?: string[]
  /** 忽略监听的额外规则（glob 或函数） */
  ignore?: any[]
  /** 忽略监听的正则 */
  ignorePattern?: RegExp
  /** 热刷新合并窗口（ms，live-server 默认 100） */
  wait?: number
  logLevel?: number
  [key: string]: any
}

/**
 * preload 暴露给渲染层的 server 契约。
 * 运行时对象是 Node 的 http.Server，叠加 http-shutdown 与改版 live-server 挂载的成员。
 */
export interface Server {
  close(): void
  shutdown(callback: () => void): void
  address(): { port: number }
  /** http.Server 自带：是否已进入 listening（waitServerReady 据此判断无需等待） */
  listening: boolean
  /** EventEmitter：waitServerReady 订阅 listening/error，结算后需要退订 */
  once(event: string, listener: (...args: any[]) => void): any
  removeListener(event: string, listener: (...args: any[]) => void): any
  /** http-shutdown 挂载后才有：强制销毁全部连接（closeServer 的兜底路径） */
  forceShutdown?(callback?: () => void): void
  /** 改版 lib 挂在 server 实例上的文件监听器（旧版本无此字段，closeServer 做了存在性判断） */
  watcher?: { close(): any } | null
}

window.utils = utils
