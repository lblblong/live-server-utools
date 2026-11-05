import { makeAutoObservable } from 'mobx'
import { onPluginEnterCBParams } from 'utools-helper/@types/utools'
import { isNotNil } from '../common/utils/other'
import { LiveServer, LiveServerState } from '../model/live-server'

const params = {
  host: '0.0.0.0',
  // 打开浏览器改由渲染层在「服务真正 ready」之后调用 utools.shellOpenExternal：
  // live-server 的 opn 在 listen 完成前触发时机不可靠，去掉后也能少一个已弃用的运行时依赖
  open: false,
  file: 'index.html',
}

/**
 * 持久化到 utools.db 的单条服务记录。
 * customPort 是自定义端口功能新增字段：旧数据没有该字段，读取时按 false 兼容。
 */
type StoredServer = {
  dir: string
  port: number
  customPort?: boolean
}

/** 服务实例类型：复用 model 里 server 字段的类型，避免在 store 里再 import 一次 preload */
type ServerInstance = NonNullable<LiveServer['server']>

/** 可手动指定的端口范围（与 TCP 端口范围一致） */
const MIN_PORT = 1
const MAX_PORT = 65535

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

  /**
   * 探测端口是否空闲。
   * 探测本身异常（非 ECONNREFUSED 的 socket 错误等）按「不可用」处理：宁可拒绝启动，也不冒着
   * 端口冲突的风险强行启动（启动结果拿不到监听错误时，UI 会误显示已启动）。
   */
  private async checkPortAvailable(port: number) {
    try {
      return await window.utils.isPortAvailable(port)
    } catch {
      return false
    }
  }

  /** 打开默认浏览器；打开失败只影响用户手动访问，不应被当成启动失败去回滚服务 */
  private openBrowser(port: number) {
    try {
      utools.shellOpenExternal(`http://localhost:${port}`)
    } catch {
      // 忽略：浏览器/系统协议处理异常不影响服务本身
    }
  }

  /**
   * 关闭 server。
   * closeServer 失败也必须让调用方继续复位 UI 状态（否则该行会卡在 loading，按钮永久禁用），
   * 因此这里吞掉异常：端口是否真正释放由系统回收 + 下次启动的端口探测兜底。
   */
  private async closeServerSafely(server?: ServerInstance) {
    if (!server) return
    try {
      await window.utils.closeServer(server)
    } catch {
      // 已在注释中说明：关闭失败不抛出
    }
  }

  /**
   * 写库的安全版。
   * 启停/删除都发生在按钮点击的异步链路里，flushDb 直接抛错会变成未处理的 Promise rejection；
   * 这里降级为通知。内存状态仍是当前真相，插件重载后以最后一次成功写库的数据为准。
   */
  private flushDbSafe() {
    try {
      this.flushDb()
    } catch {
      utools.showNotification('保存服务列表失败，请重启插件后重试')
    }
  }

  /**
   * 启动某个目录的服务；已在运行则打开浏览器。
   * options.silent=true 表示「调用方会自己提示错误」，目前只被 setPort 的重启链路使用，
   * 目的是避免同一个失败原因在 UI 上弹出两次通知。
   *
   * 关键时序：startLiveServer 是同步返回的（此时 listen 尚未完成），必须 await waitServerReady
   * 之后才置 on / 打开浏览器；失败则回滚到 off 并真实关闭，避免「UI 显示已启动但端口没绑上」。
   */
  async startServer(options?: { dir?: string; silent?: boolean }) {
    let dir = options?.dir
    const silent = options?.silent === true
    if (!dir) {
      try {
        dir = window.utils.openSelectDirectoryDialog({
          title: '请选择要启动实时文件服务的目录',
        })
      } catch {
        // 用户取消选择：调用方（悬浮「+」onClick、onPluginEnter）都没有 catch，
        // 这里直接返回，避免产生未处理的 Promise rejection
        return
      }
    }

    let liveServer = this.findLiveServer(dir)
    if (liveServer?.state === LiveServerState.loading) return
    if (liveServer?.state === LiveServerState.on) {
      this.openBrowser(liveServer.port)
      return
    }
    // 在第一个 await 之前同步置 loading：点击「启动」立刻有视觉反馈，同时起到防重入作用
    if (liveServer) liveServer.state = LiveServerState.loading

    let port: number | undefined
    let server: ServerInstance | undefined
    try {
      if (liveServer?.customPort) {
        // 自定义端口：严格使用记录中的端口，跳过 getCanUsePort 的自动递增
        const available = await this.checkPortAvailable(liveServer.port)
        if (!available) {
          // 失败必须回到 off：停在 loading 会让删除/启停按钮被永久禁用，形成无法恢复的死行
          liveServer.state = LiveServerState.off
          if (!silent) {
            utools.showNotification(`端口 ${liveServer.port} 已被占用，无法启动服务`)
          }
          return
        }
        port = liveServer.port
      } else {
        port = await window.utils.getCanUsePort([...this.usedPort], isNotNil(liveServer) ? liveServer!.port : 6600)
      }

      if (liveServer) {
        liveServer.port = port
      } else {
        liveServer = new LiveServer()
        liveServer.dir = dir
        liveServer.port = port
        liveServer.state = LiveServerState.loading
        this.liveServerList.push(liveServer)
      }

      server = window.utils.startLiveServer({
        ...params,
        root: dir,
        port,
      })
      // live-server 返回的 server 本身不带 shutdown，而 closeServer 依赖它。
      // 若 preload 侧已经在 start 内部装饰过，这里跳过，避免重复注册 connection/request 监听。
      if (typeof (server as any).shutdown !== 'function') {
        window.utils.httpShutdown(server as any)
      }

      // 真正的就绪信号：listening（失败/超时会 reject，由下面的 catch 统一回滚）
      await window.utils.waitServerReady(server)

      // 只有 ready 之后才置 on、登记端口、写库、打开浏览器
      this.usedPort.add(port)
      liveServer.server = server
      liveServer.state = LiveServerState.on
      this.flushDbSafe()
      this.openBrowser(port)
    } catch {
      // 端口分配失败（getCanUsePort 现在会 reject）、绑定失败、就绪超时：统一回滚，不留半启动状态
      if (port !== undefined) this.usedPort.delete(port)
      await this.closeServerSafely(server)
      if (liveServer) {
        liveServer.server = undefined
        liveServer.state = LiveServerState.off
      }
      this.flushDbSafe()
      if (!silent) {
        utools.showNotification(
          port !== undefined ? `端口 ${port} 启动失败，请检查端口是否被占用` : '启动失败，请检查所选目录是否可用'
        )
      }
    }
  }

  /**
   * 修改某个服务的端口（自定义端口）。
   * 统一返回 { ok, error } 而不抛错：调用方是输入框的「回车/失焦」保存，抛错会变成未处理的
   * Promise rejection，用户看不到任何反馈。
   *
   * 校验/执行顺序（顺序有边界含义，勿随意调整）：
   * 1. 目标存在且不处于 loading——启停过程中改端口会和启停流程并发，结果不可预期；
   * 2. 端口是 1-65535 的整数；
   * 3. 不与列表中其他服务的端口重复；
   * 4. 与当前端口相同：只补 customPort=true 并落库，不重启、也不做 TCP 探测
   *    —— 服务运行中时该端口正被自己占用，探测必然返回不可用，先探测会把「无变化」误判成错误；
   * 5. TCP 探测新端口是否空闲；
   * 6. 运行中：先停止再以新端口重启；重启失败则保持停止并返回错误（端口保留新值，不自动回退）。
   */
  async setPort(dir: string, port: number): Promise<{ ok: boolean; error?: string }> {
    const s = this.findLiveServer(dir)
    if (!s) return { ok: false, error: '目标服务不存在' }
    if (s.state === LiveServerState.loading) return { ok: false, error: '服务正在启停中，请稍后再试' }

    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
      return { ok: false, error: `端口必须是 ${MIN_PORT}-${MAX_PORT} 之间的整数` }
    }

    if (this.liveServerList.some((it) => it.dir !== dir && it.port === port)) {
      return { ok: false, error: `端口 ${port} 已被其他服务使用` }
    }

    if (s.port === port) {
      s.customPort = true
      this.flushDbSafe()
      return { ok: true }
    }

    const available = await this.checkPortAvailable(port)
    if (!available) return { ok: false, error: `端口 ${port} 已被占用` }

    const wasRunning = s.state === LiveServerState.on
    if (wasRunning) {
      // 先停：停完会释放旧端口，且能保证同一个目录不会同时挂着两个 server
      await this.stopServer({ dir })
    }

    s.port = port
    s.customPort = true

    if (wasRunning) {
      // silent=true：失败提示统一由本方法返回给 UI，避免 startServer 再弹一次
      await this.startServer({ dir, silent: true })
      if (s.state !== LiveServerState.on) {
        // 重启失败：服务保持停止，但保留用户刚设定的端口（不自动回退），方便用户改端口或再次手动启动
        this.flushDbSafe()
        return { ok: false, error: `端口 ${port} 启动失败，服务已停止` }
      }
    }

    this.flushDbSafe()
    return { ok: true }
  }

  /**
   * 停止服务。
   * 用 preload 的 closeServer（内部 shutdown 回调 + force 兜底）await 真实关闭，不再有固定 1s 假等待；
   * 关闭完成后立即置 off、清 usedPort、写库。
   * 对「不存在/已关闭/启停中」静默返回：调用方是按钮点击，不应产生未处理的 rejection。
   */
  async stopServer(options: { dir: string }) {
    const s = this.findLiveServer(options.dir)
    if (!s) return
    // 启停进行中不重复关闭：避免打断正在进行的 start，把刚要起来的 server 关掉
    if (s.state === LiveServerState.loading) return
    if (s.state === LiveServerState.off) {
      s.server = undefined
      return
    }
    // await 之前同步置 loading：点击「关闭」立刻有「停止中…」反馈，同时阻止并发关闭
    s.state = LiveServerState.loading
    const server = s.server
    await this.closeServerSafely(server)
    s.server = undefined
    s.state = LiveServerState.off
    this.usedPort.delete(s.port)
    this.flushDbSafe()
  }

  async delServer(options: { dir: string }) {
    const s = this.findLiveServer(options.dir)
    if (!s) return
    // 运行中的行先真实关闭再移除，避免留下看不见的 server 继续占用端口
    if (s.state === LiveServerState.on) {
      await this.stopServer(options)
    }
    this.liveServerList = this.liveServerList.filter((it) => it.dir !== options.dir)
    this.flushDbSafe()
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
      const it = utools.db.get<StoredServer[]>(getStorageID())
      if (!it || !it.data) return
      this.liveServerList = it.data.map((d) => {
        const liveServer = new LiveServer()
        liveServer.dir = d.dir
        liveServer.port = d.port
        // 旧数据没有 customPort 字段：只有明确为 true 才当自定义端口，缺省/其他值一律按自动分配
        liveServer.customPort = d.customPort === true
        liveServer.state = LiveServerState.off
        return liveServer
      })
    } catch (err) {
      alert(err)
    }
  }

  flushDb() {
    let it = utools.db.get<StoredServer[]>(getStorageID())

    const data: StoredServer[] = this.liveServerList.map((d) => {
      return {
        dir: d.dir,
        port: d.port,
        customPort: d.customPort,
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
