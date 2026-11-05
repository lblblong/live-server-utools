import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * uTools 插件主界面构建配置。
 * - plugin.json 的 main 指向 build/index.html，因此产物目录固定为 build；
 * - base 必须是 './'，插件在 uTools 内以本地文件方式加载，绝对路径会失效；
 * - 运行环境为 uTools Runtime 的 Chromium 132（官方文档），target 直接对齐 chrome132：
 *   不做无意义的 ES 降级，产物更小、启动解析更快。
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'build',
    emptyOutDir: true,
    sourcemap: false,
    target: 'chrome132',
    cssTarget: 'chrome132',
  },
})
