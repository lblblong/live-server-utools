import classNames from 'classnames'
import { Observer } from 'mobx-react'
import React from 'react'
import { Icon } from '../../components/icon'
import { LiveServerState } from '../../model/live-server'
import { StoreServer } from '../../store/server'
import styles from './index.module.scss'

export const IndexPage = () => {
  return (
    <Observer>
      {() => (
        <div className={styles.index}>
          <div
            className={styles.addBtn}
            onClick={() => {
              StoreServer.startServer()
            }}
          >
            <Icon value="add-line" />
          </div>
          <div className={styles.list}>
            {StoreServer.liveServerList.map((it) => {
              return (
                <div className={classNames(styles.item, { [styles.active]: it.server })}>
                  <div className={styles.lbox}>
                    <span className={styles.state}></span>
                    <span
                      className={styles.port}
                      onClick={() => utools.shellOpenExternal(`http://localhost:${it.port}`)}
                    >
                      {it.port}
                    </span>
                    <span className={styles.dir} onClick={() => utools.shellOpenExternal('file://' + it.dir)}>
                      {it.dir}
                    </span>
                  </div>

                  <div className={styles.rbox}>
                    <button
                      disabled={it.state === LiveServerState.loading}
                      className={classNames(styles.btn, styles.del)}
                      onClick={() => StoreServer.delServer({ dir: it.dir })}
                    >
                      删除
                    </button>
                    <button className={styles.btn} onClick={() => utools.shellOpenExternal('file://' + it.dir)}>
                      打开目录
                    </button>
                    <button
                      disabled={it.state === LiveServerState.loading}
                      className={styles.btn}
                      onClick={() => StoreServer.toggleServer(it)}
                    >
                      {it.server ? '关闭服务' : '启动服务'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </Observer>
  )
}
