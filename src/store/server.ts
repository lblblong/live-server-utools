import { makeAutoObservable } from 'mobx'
import { onPluginEnterCBParams } from 'utools-helper/@types/utools'
import { isNotNil } from '../common/utils/other'
import { LiveServer, LiveServerState } from '../model/live-server'

const params = {
  host: '0.0.0.0',
  open: true,
  file: 'index.html',
}

function getStorageID() {
  return utools.getLocalId() + '_servers'
}

class Store {
  constructor() {
    makeAutoObservable(this)
    utools.onPluginEnter(this.onPluginEnter)
    utools.onPluginReady(() => {
      this.loadDb()
    })
  }

  onPluginEnter = (params: onPluginEnterCBParams) => {
    utools.getCurrentFolderPath()
    let dir: string | undefined

    switch (params.type) {
      case 'window':
        dir = utools.getCurrentFolderPath()
        this.startServer({ dir })
        break
      case 'text':
        break
    }
  }

  liveServerList: LiveServer[] = []
  usedPort = new Set<number>()

  findLiveServer(dir: string) {
    return this.liveServerList.find((it) => {
      return it.dir === dir
    })
  }

  async startServer(options?: { dir?: string }) {
    let dir = options?.dir
    if (!dir) {
      dir = window.utils.openSelectDirectoryDialog({
        title: '请选择要启动实时文件服务的目录',
      })
    }

    let liveServer = this.findLiveServer(dir)
    if (liveServer?.state === LiveServerState.loading) return
    if (liveServer?.state === LiveServerState.on) {
      utools.shellOpenExternal(`http://localhost:${liveServer.port}`)
      return
    }
    if (liveServer) liveServer.state = LiveServerState.loading

    const port = await window.utils.getCanUsePort([...this.usedPort], isNotNil(liveServer) ? liveServer!.port : 6600)
    if (liveServer) {
      liveServer.port = port
    } else {
      liveServer = new LiveServer()
      liveServer.dir = dir
      liveServer.port = port
      liveServer.state = LiveServerState.loading
      this.liveServerList.push(liveServer)
    }

    let server = window.utils.startLiveServer({
      ...params,
      root: dir,
      port,
    })

    window.utils.httpShutdown(server as any)
    this.usedPort.add(port)
    liveServer.server = server
    liveServer.state = LiveServerState.on
    this.flushDb()
  }

  async stopServer(options: { dir: string }) {
    const s = this.findLiveServer(options.dir)
    if (!s) throw Error('目标服务不存在')
    if (s.state === LiveServerState.off) {
      s.state = LiveServerState.off
      s.server = undefined
      throw Error('目标服务已关闭')
    }
    s.state = LiveServerState.loading
    return new Promise<void>((ok) => {
      s.server?.shutdown(() => {})
      s.server?.close()
      setTimeout(() => {
        s.state = LiveServerState.off
        s.server = undefined
        this.usedPort.delete(s.port)
        ok()
      }, 1000)
    })
  }

  async delServer(options: { dir: string }) {
    const s = this.findLiveServer(options.dir)
    if (!s) return
    if (s.state === LiveServerState.on) {
      await this.stopServer(options)
    }
    this.liveServerList = this.liveServerList.filter((it) => it.dir !== options.dir)
    this.flushDb()
  }

  toggleServer = async (it: LiveServer) => {
    if (it.state === LiveServerState.on) {
      await this.stopServer({ dir: it.dir })
    } else {
      await this.startServer({ dir: it.dir })
    }
  }

  loadDb = () => {
    try {
      const it = utools.db.get<
        {
          dir: string
          port: number
        }[]
      >(getStorageID())
      if (!it || !it.data) return
      this.liveServerList = it.data.map((d) => {
        const liveServer = new LiveServer()
        liveServer.dir = d.dir
        liveServer.port = d.port
        liveServer.state = LiveServerState.off
        return liveServer
      })
    } catch (err) {
      alert(err)
    }
  }

  flushDb() {
    let it = utools.db.get<
      {
        dir: string
        port: number
      }[]
    >(getStorageID())

    const data = this.liveServerList.map((d) => {
      return {
        dir: d.dir,
        port: d.port,
      }
    })

    if (!it) {
      it = {
        _id: getStorageID(),
        data: data,
      }
    } else {
      it.data = data
    }

    const { ok, error } = utools.db.put(it)
    if (!ok) {
      throw Error(error)
    }
  }
}

export const StoreServer = new Store()
