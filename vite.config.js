import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 构建形态：交付形态尚未定案（决策记录 六-4，单文件便携版与"多文件 + 本地启动脚本"二选一），
// 因此这里只保证两件事，不提前锁定形态：
// 1) base 用相对路径 —— 产物换目录、打成压缩包都不影响加载；
// 2) JS 依赖打进单个入口文件 —— 将来要用 vite-plugin-singlefile 内联时不必再拆分。
export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    target: 'es2020',
    cssCodeSplit: false,
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      output: {
        // 固定文件名：离线分发时便于人工核对产物（本地场景没有 hash 缓存的收益）
        entryFileNames: 'assets/app.js',
        assetFileNames: 'assets/[name][extname]',
        chunkFileNames: 'assets/[name].js'
      }
    }
  }
})
