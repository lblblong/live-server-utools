import classNames from 'classnames'
import { observer } from 'mobx-react'
import React, { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/icon'
import { LiveServer, LiveServerState } from '../../model/live-server'
import { StoreServer } from '../../store/server'
import styles from './index.module.scss'

interface PortEditorProps {
  /** 目标服务目录（store 以 dir 作为服务唯一标识） */
  dir: string
  /** 进入编辑时的端口值 */
  port: number
  /** 进入编辑时服务是否在运行：只用于保存成功后的提示文案（运行中=已在新端口重启） */
  wasRunning: boolean
  /** 退出编辑态（保存成功或用户取消） */
  onDone: () => void
  /** 保存中通知父级禁用其它行内按钮，避免「保存端口」与「启停/删除」并发 */
  onSavingChange: (saving: boolean) => void
}

/**
 * 行内端口编辑器。
 * 用独立函数组件 + useState 承载「输入文本 / 红框错误态 / 保存中」这些纯视图状态：
 * 父级会被 MobX 通知重渲染，若把这些状态放在父级会被旧值重置（表现为输入被吞）。
 * 放在子组件里则不受父级重渲染影响。
 */
const PortEditor = ({ dir, port, wasRunning, onDone, onSavingChange }: PortEditorProps) => {
  const [text, setText] = useState(String(port))
  const [saving, setSaving] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // 已结束（取消/保存成功）后组件会被卸载，卸载/失焦可能再触发一次 onBlur，用 ref 防止重复提交
  const finishedRef = useRef(false)
  // 保存中的同步守卫：setSaving 是异步渲染才生效的，失焦与回车的极端时序下 state 还来不及更新，
  // 用 ref 才能保证 setPort 不被并发调用两次（否则可能两次 stop/start 打架）
  const savingRef = useRef(false)

  useEffect(() => {
    // autoFocus 只负责聚焦；这里补上「选中当前值」，让用户可以直接覆盖输入
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
    return () => {
      // 卸载即视为本次编辑结束：例如编辑中删除了该行，父级会直接清掉编辑态并卸载本组件，
      // 此时若还有残余的 blur/focusout 触发 onBlur，不能再跑去保存一条已被删除的记录
      finishedRef.current = true
    }
  }, [])

  const save = async () => {
    if (finishedRef.current || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    onSavingChange(true)

    // 只接受纯数字：避免 Number('0x19a0') / Number('1e3') 这类被静默转换的输入；
    // 非法输入转成 NaN 交给 store 的数字校验返回统一错误文案（范围/重复校验同样只在 store 做）
    const trimmed = text.trim()
    const next = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN

    let result: { ok: boolean; error?: string }
    try {
      result = await StoreServer.setPort(dir, next)
    } catch {
      // store 已约定不抛错；这里兜底，避免保存失败变成未处理的 Promise rejection
      result = { ok: false, error: '端口修改失败，请重试' }
    }

    if (result.ok) {
      finishedRef.current = true
      // 端口没变时 store 只补 customPort 标记、不会重启，提示文案要区分「重启」与「仅标记」两种情况
      const unchanged = next === port
      if (unchanged) {
        utools.showNotification(`端口 ${next} 已设为自定义端口`)
      } else {
        utools.showNotification(wasRunning ? `已在新端口 ${next} 重启服务` : `端口已修改为 ${next}`)
      }
      onSavingChange(false)
      onDone()
      return
    }

    // 失败：保持编辑态 + 红框，提示具体原因（重新输入时清除红框）
    savingRef.current = false
    setSaving(false)
    onSavingChange(false)
    setInvalid(true)
    utools.showNotification(result.error || '端口修改失败')
  }

  const cancel = () => {
    // 保存中不允许取消：此时可能已经在「停止→重启」的中途，半途取消会留下状态不明的服务
    if (savingRef.current) return
    finishedRef.current = true
    onDone()
  }

  // 保存中用 readOnly 而不是 disabled：禁用处于焦点中的输入框会触发 blur，进而再进一次 save（重复提交）；
  // readOnly 既能阻止继续输入，又不会丢焦点/触发 blur。
  return (
    <input
      ref={inputRef}
      className={classNames(styles.portInput, { [styles.portInputError]: invalid })}
      value={text}
      readOnly={saving}
      inputMode="numeric"
      maxLength={5}
      aria-label="端口"
      onChange={(e) => {
        setText(e.target.value)
        if (invalid) setInvalid(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          save()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
      onBlur={() => {
        // 点击别处 = 保存；已被 Enter 提交或取消的编辑忽略这次 blur
        if (!finishedRef.current) save()
      }}
    />
  )
}

interface ServerItemProps {
  /** 该行对应的服务（MobX observable，本组件是 observer，只订阅自己行用到的字段） */
  item: LiveServer
  /** 是否正处于端口行内编辑 */
  editing: boolean
  /** 进入编辑时服务是否在运行（仅用于保存成功提示，编辑期间不变） */
  wasRunning: boolean
  /** 任意一行的端口保存进行中：期间禁用所有行的启停/删除按钮 */
  portSaving: boolean
  /** 是否已有某一行处于编辑态（用于禁用其它行的「修改端口」） */
  editingLocked: boolean
  onStartEdit: (item: LiveServer) => void
  onEditDone: () => void
  onSavingChange: (saving: boolean) => void
  onToggle: (item: LiveServer) => void
  onDelete: (item: LiveServer) => void
}

/**
 * 单行服务项。
 * 性能关键：memo + observer 组合 —— 父级因列表/局部状态变化重渲染时，props 未变（handler 全部稳定、
 * item 是同一个 observable 实例）的行会被 memo 跳过；而本行自身的 state/port/server 变化时，
 * observer 的订阅会只重渲染这一行，不再整页重渲染。
 * 注意顺序必须是 memo(observer(...))：observer 在外层，其内部订阅触发的更新不会被 memo 拦截。
 */
const ServerItem = memo(
  observer(function ServerItem(props: ServerItemProps) {
    const { item, editing, wasRunning, portSaving, editingLocked, onStartEdit, onEditDone, onSavingChange } = props
    const { onToggle, onDelete } = props
    const loading = item.state === LiveServerState.loading
    const actionsDisabled = loading || portSaving

    // 主按钮文案：store 在 await 之前同步置 loading，因此点击后立即显示「启动中…/停止中…」；
    // 端口保存期间优先显示「保存中…」（编辑行才需要）
    let primaryText = item.server ? '关闭服务' : '启动服务'
    if (portSaving && editing) {
      primaryText = '保存中…'
    } else if (loading) {
      primaryText = item.server ? '停止中…' : '启动中…'
    }

    return (
      <div className={classNames(styles.item, { [styles.active]: item.server })}>
        <div className={styles.lbox}>
          <span className={styles.state}></span>
          {editing ? (
            <PortEditor
              dir={item.dir}
              port={item.port}
              wasRunning={wasRunning}
              onDone={onEditDone}
              onSavingChange={onSavingChange}
            />
          ) : (
            <span className={styles.port} onClick={() => utools.shellOpenExternal(`http://localhost:${item.port}`)}>
              {item.port}
            </span>
          )}
          <span className={styles.dir} onClick={() => utools.shellOpenExternal('file://' + item.dir)}>
            {item.dir}
          </span>
        </div>

        <div className={styles.rbox}>
          <button
            disabled={actionsDisabled}
            className={classNames(styles.btn, styles.del)}
            // 阻止 mousedown 的默认焦点转移：否则输入框会先失焦 -> 触发 onBlur 保存，
            // 改过的端口会白做一次 stop+start 重启，且本次删除点击被吞掉、要再点一次。
            // preventDefault 只拦焦点转移，不拦 click，所以删除本身照常执行。
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              // 纵深防御：保存中不允许删除（正常路径下 actionsDisabled 已禁用按钮）。
              // 清编辑态的工作统一由父级 onDelete 处理，避免每个行各自持有编辑状态。
              if (portSaving) return
              onDelete(item)
            }}
          >
            删除
          </button>
          <button className={styles.btn} onClick={() => utools.shellOpenExternal('file://' + item.dir)}>
            打开目录
          </button>
          <button disabled={actionsDisabled} className={styles.btn} onClick={() => onToggle(item)}>
            {primaryText}
          </button>
          <button
            // 已在编辑任意一行时不再允许开启新的编辑（切行需要先保存/取消）
            disabled={loading || portSaving || editingLocked}
            className={styles.btn}
            onClick={() => onStartEdit(item)}
          >
            修改端口
          </button>
        </div>
      </div>
    )
  })
)

export const IndexPage = observer(function IndexPage() {
  // 正在编辑端口的服务（同一时刻只允许一行编辑，避免多个输入框并存互相干扰）
  const [portEditing, setPortEditing] = useState<{ dir: string; wasRunning: boolean } | null>(null)
  // 行内保存进行中：期间禁用所有行操作按钮，避免保存（可能触发停止+重启）与手动启停/删除并发
  const [portSaving, setPortSaving] = useState(false)

  // handler 用 useCallback 保持引用稳定：否则父级每次重渲染都会换函数引用，memo(ServerItem) 全部失效
  const handleStartEdit = useCallback((item: LiveServer) => {
    setPortEditing({ dir: item.dir, wasRunning: item.state === LiveServerState.on })
  }, [])

  const handleEditDone = useCallback(() => {
    setPortEditing(null)
    setPortSaving(false)
  }, [])

  const handleSavingChange = useCallback((saving: boolean) => {
    setPortSaving(saving)
  }, [])

  const handleToggle = useCallback((item: LiveServer) => {
    // store 内部已兜底（不抛错），这里用 void 明确「故意不 await」
    void StoreServer.toggleServer(item)
  }, [])

  const handleDelete = useCallback((item: LiveServer) => {
    // 删除的若是当前编辑行，必须先清编辑态：否则 portEditing 指向一条已不存在的记录，
    // 会一直残留并让所有行的「修改端口」永久禁用（没有其它地方会重置它）。
    // 用函数式更新读最新值，让 handler 本身保持零依赖、引用稳定。
    setPortEditing((prev) => (prev && prev.dir === item.dir ? null : prev))
    // 保存中删不了（按钮禁用）；这里兜底复位，避免极端时序下残留保存守卫
    setPortSaving(false)
    void StoreServer.delServer({ dir: item.dir })
  }, [])

  const list = StoreServer.liveServerList

  return (
    <div className={styles.index}>
      <div
        className={classNames(styles.addBtn, { [styles.addBtnDisabled]: portSaving })}
        onClick={() => {
          // 端口保存期间不能新增服务：此时 store 可能正在停止/重启，另起一路 startServer 会抢端口。
          // addBtn 是 div，没有原生 disabled，只能用点击守卫 + 视觉禁用态。
          if (portSaving) return
          void StoreServer.startServer()
        }}
      >
        <Icon value="add-line" />
      </div>
      <div className={styles.list}>
        {list.map((item) => (
          <ServerItem
            key={item.dir}
            item={item}
            editing={portEditing?.dir === item.dir}
            wasRunning={portEditing?.dir === item.dir && portEditing?.wasRunning === true}
            portSaving={portSaving}
            editingLocked={portEditing !== null}
            onStartEdit={handleStartEdit}
            onEditDone={handleEditDone}
            onSavingChange={handleSavingChange}
            onToggle={handleToggle}
            onDelete={handleDelete}
          />
        ))}
        {list.length === 0 && <div className={styles.empty}>暂无服务，点击右下角「+」选择目录即可启动</div>}
      </div>
    </div>
  )
})
