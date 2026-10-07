import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 构建形态（决策记录 六-4：交付形态不提前锁定，两种都要能出）：
//   ① `npm run build`      → dist/：ES module 多文件（按需分块，首屏 app.js 约 130KB），
//      适合"多文件 + 本地启动脚本"（访问 localhost，存储与加载限制都不存在）。
//   ② `npm run build:file` → dist-file/：**IIFE 单包**（`--mode file` 切换），
//      为的是能 **file:// 双击打开** —— `type="module"` 的脚本在 file:// 下会被浏览器按 CORS 拦下
//      （origin 为 null），整个应用起不来；IIFE 是普通脚本，不受这条限制。
// 两条共同的约定：base 用相对路径（产物换目录、打包、双击都不受影响）、固定文件名（离线分发便于人工核对）。
// IIFE 的代价：它**不支持代码分割**，所以必须 inlineDynamicImports —— 原本按需加载的 chunk
//   （pdf.js 约 474KB、模板面板约 1.2MB、字体合成约 372KB 等）会合并进同一个 app.js。
export default defineConfig(({ mode }) => {
  const forFile = mode === 'file'
  return {
    plugins: [vue(), forFile ? fileProtocolHtml() : null].filter(Boolean),
    base: './',
    build: {
      target: 'es2020',
      cssCodeSplit: false,
      chunkSizeWarningLimit: 8000,
      outDir: forFile ? 'dist-file' : 'dist',
      rollupOptions: {
        output: forFile
          ? {
              format: 'iife',
              inlineDynamicImports: true,
              entryFileNames: 'assets/app.js',
              assetFileNames: 'assets/[name][extname]'
            }
          : {
              entryFileNames: 'assets/app.js',
              assetFileNames: 'assets/[name][extname]',
              chunkFileNames: 'assets/[name].js'
            }
      }
    }
  }
})

// file:// 形态的 HTML 收尾：把 vite 默认加的 module / crossorigin 属性去掉。
// 为什么需要它：即使 output.format 设成 iife，vite 生成的 index.html 里**仍然是**
//   `<script type="module" crossorigin src="./assets/app.js">` —— 而 file:// 下浏览器会按
//   "模块脚本 + CORS" 处理它（origin 为 null），脚本根本不执行、页面一片空白。
//   实测确认过这一点，所以这里显式改写标签：去掉 type="module" 与 crossorigin，
//   让它变成普通脚本（普通脚本与样式表不受 file:// 的读取限制）。
function fileProtocolHtml() {
  return {
    name: 'sx-file-protocol-html',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html
          .replace(/<script type="module" crossorigin /g, '<script ')
          .replace(/ crossorigin(?=[ >])/g, '')
      }
    }
  }
}
