type StartOptions = {
  host?: string
  port?: number
  root?: string
  open?: boolean
}

export function start(options?: StartOptions, callback?: any): Server
export function shutdown(): any

export class Server {
  close(): void
  shutdown(callback: () => void): void
  address(): { port: number }
}
