import { makeAutoObservable } from 'mobx'
import { Server } from 'preload'

export enum LiveServerState {
  on,
  off,
  loading,
}

export class LiveServer {
  constructor() {
    makeAutoObservable(this)
  }

  state = LiveServerState.off
  dir = ''
  port = 6600
  /**
   * 是否由用户自定义端口（默认 false，沿用自动分配）。
   * - true：启动/重启时严格使用 `port`，被占用即提示并保持 off，不再自动递增（见 StoreServer.startServer）；
   * - false：走 getCanUsePort 自动分配，行为与旧版本一致。
   * 注意：旧版本持久化数据没有该字段，loadDb 读取时按 false 兼容（缓存里缺字段不能当 true）。
   */
  customPort = false
  server?: Server
}
