import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * uTools 插件主界面构建配置。
 * - plugin.json 的 main 指向 build/index.html，因此产物目录固定为 build；
 * - base 必须是 './'，插件在 uTools 内以本地文件方式加载，绝对路径会失效；
 * - target es2020 覆盖 uTools Runtime（Chromium 132）能力，无需为旧浏览器降级。
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'build',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
})
