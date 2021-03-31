import * as httpShutdown from "../lib/http-shutdown"
import { start as startLiveServer } from "../lib/live-server"
import { getCanUsePort, openSelectDirectoryDialog } from "./utils"

const utils = {
  startLiveServer,
  httpShutdown,
  getCanUsePort,
  openSelectDirectoryDialog,
}

declare global {
  interface Window {
    utils: typeof utils
  }
}

type StartOptions = {
  host?: string
  port?: number
  root?: string
  open?: boolean
}

export interface Server {
  close(): void
  shutdown(callback: () => void): void
  address(): { port: number }
}

window.utils = utils
