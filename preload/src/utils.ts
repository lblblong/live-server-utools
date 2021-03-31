import * as net from "net"

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

export function getCanUsePort(usedPort: number[], port: number) {
  const lastPort = usedPort[usedPort.length - 1]

  return new Promise<number>(async (ok, _) => {
    let portOk = false
    let first = true
    while (!portOk) {
      const used = await portCheck(port)
      if (used) {
        if (first && lastPort) {
          port = lastPort + 1
          first = false
        } else {
          port++
        }
        continue
      } else {
        portOk = true
      }
    }
    ok(port)
  })
}

export function portCheck(port: number) {
  return new Promise<boolean>((ok, fail) => {
    const client = new net.Socket()
    client.once("connect", () => {
      ok(true)
    })
    client.once("error", (err: any) => {
      if (err.code !== "ECONNREFUSED") {
        fail(err)
      } else {
        ok(false)
      }
    })
    client.connect({ port, host: "127.0.0.1" }, () => {})
  })
}
