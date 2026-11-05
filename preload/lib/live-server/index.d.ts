/**
 * preload/lib/live-server（改版 live-server）的类型声明。
 *
 * 运行时：start() 返回的是原生 http.Server，并被挂上 http-shutdown 的 shutdown/forceShutdown
 * 以及本次启动的 chokidar watcher。这里把这些扩展成员声明出来，与 preload/src/index.ts 暴露给
 * 渲染层的 Server 契约保持一致，避免调用方到处写 as any。
 *
 * 可选能力：opn / http-auth / cors / proxy-middleware / http-proxy 的 npm 包已按要求从 preload
 * 依赖中裁剪；传入对应参数时 index.js 会通过 optionalRequire 抛出「当前构建未内置 xxx」的说明性
 * 错误（opn 例外，只告警不阻断启动）。
 */
export type StartOptions = {
  host?: string
  port?: number
  root?: string
  /** 打开浏览器的子路径；传 false 抑制（本插件由渲染层用 utools.shellOpenExternal 接管） */
  open?: boolean | string | string[]
  /** 入口文件（未命中静态资源时回退到它），如 index.html */
  file?: string
  /** 只监听这些路径，默认 [root] */
  watch?: string[]
  /** 忽略监听的额外规则（glob 或函数） */
  ignore?: any[]
  /** 忽略监听的正则 */
  ignorePattern?: RegExp
  /** 热刷新合并窗口（ms，默认 100） */
  wait?: number
  logLevel?: number
  /** 是否整页 reload；false 时 .css 变更广播 refreshcss */
  fullReload?: boolean
  /** live-server 其它透传选项（mount/middleware/https/proxy 等） */
  [key: string]: any
}

/** 启动回调：在 chokidar ready 时触发，不是 listen 完成 */
export type StartCallback = () => void

export function start(options?: StartOptions, callback?: StartCallback): Server
export function shutdown(): any

export class Server {
  close(): void
  shutdown(callback: () => void): void
  address(): { port: number }
  /** 原生 http.Server：是否已进入 listening */
  listening: boolean
  /** EventEmitter：订阅 listening/error 后需要能退订 */
  once(event: string, listener: (...args: any[]) => void): any
  removeListener(event: string, listener: (...args: any[]) => void): any
  /** http-shutdown 挂载后才有：强制销毁全部连接 */
  forceShutdown?(callback?: () => void): void
  /** 本次启动的 chokidar watcher（停止时由 preload 调 close） */
  watcher?: { close(): any } | null
}
