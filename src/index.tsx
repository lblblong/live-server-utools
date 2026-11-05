import './assets/icon/fonts/icon.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { IndexPage } from './pages/manager'

const container = document.getElementById('root')

if (!container) {
  // 入口 HTML 与构建产物不匹配时尽早失败，避免 React 在 null 上挂载后出现难排查的白屏
  throw new Error('未找到插件挂载节点 #root')
}

// React 18 的 createRoot：uTools Runtime 为 Chromium 132，原生支持并发渲染
createRoot(container).render(
  <React.StrictMode>
    <IndexPage />
  </React.StrictMode>
)
