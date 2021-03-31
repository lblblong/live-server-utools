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
  server?: Server
}
