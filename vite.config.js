import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const ROOT = dirname(fileURLToPath(import.meta.url))
// 程序版本（写进项目包清单，便于将来判断"这个包是哪个版本导的"）
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// 构建形态（决策记录 六-4，2026-10-07 用户拍板）：**只出 file:// 版** ——
//   产物是一个文件夹，双击 `index.html` 即用，不需要任何本地服务或启动脚本。
// 因此这里有两条与常规 vite 工程不同的约定：
//   ① **IIFE 单包**：`type="module"` 的脚本在 file:// 下会被按 CORS 拦下（origin 为 null），
//      IIFE 是普通脚本，不受这条限制。代价是它不支持代码分割，必须 inlineDynamicImports ——
//      原本按需加载的 chunk 会合并进同一个 app.js（约 2.4MB）。
//   ② **按需内联**：file:// 下 fetch / XHR 读同目录文件都会被拦（实测见《待办与风险清单》三-8），
//      所以字体、pdf.js worker、woff2 wasm、《使用说明》由本文件的插件在构建期生成
//      `assets/inline-*.js`（base64 挂在 window.__SX_INLINE_ASSETS__ 上），运行时按需插 <script> 取回。
//      合计约 12MB，但**首屏只加载 app.js** —— 字体在真正要印模板时才载入（用户拍板"按需加载"）。
// 本地开发（`npm run dev`）不走这条路：dev 下没有内联标记，各调用方照旧 fetch / 用 ?url。

// 需要内联成 `assets/inline-<name>.js` 的资源：name 是运行时约定（见 src/lib/inlineAssets.js）
// 导出是给下游用的单源：`scripts/pack-dist.mjs`（打包时核对产物）与 `test/pack-dist.mjs`（断言包内容）
export const INLINE_ASSETS = [
  { name: 'font-lxgw', file: 'public/fonts/lxgw-wenkai-subset.ttf', kind: 'base64' },
  { name: 'font-yozai', file: 'public/fonts/yozai-subset.ttf', kind: 'base64' },
  // pdf.js 走 **legacy 构建**（实施计划 3.4）：现代构建直接调用 Promise.withResolvers（Chrome 119）
  // 与 structuredClone（Chrome 98）且无回退，旧浏览器（含 Win7 的 Chrome 109）会直接抛错
  { name: 'pdf-worker', file: 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', kind: 'base64' },
  { name: 'woff2-wasm', file: 'public/woff2.wasm', kind: 'base64' },
  { name: 'guide-html', file: 'public/使用说明.html', kind: 'text' }
]

// 已经内联进脚本、不必再随产物复制一份的文件（否则交付体积白翻一倍）
// 同样导出给下游：打包前用它拦下"构建收尾没跑完"的产物（否则交付 zip 里会多带 9MB）
export const DROP_AFTER_BUILD = [
  'fonts/lxgw-wenkai-subset.ttf',
  'fonts/yozai-subset.ttf',
  'woff2.wasm',
  'favicon.svg', // 页签图标已内嵌进 index.html 的 data URI
  'assets/pdf.worker.min.mjs' // worker 已内联，运行时走 Blob URL
]

function fileBuildPlugin() {
  return {
    name: 'sx-file-build',
    // ① 把 vite 默认的模块脚本改写成普通脚本，并注入形态标记
    //    （即使设了 output.format = 'iife'，vite 产出的 index.html 里仍是 `<script type="module" crossorigin>`，
    //     实测确认过：file:// 下它根本不会执行，页面一片空白）
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html
          .replace(/<script type="module" crossorigin /g, '<script ')
          .replace(/ crossorigin(?=[ >])/g, '')
          .replace(
            '<head>',
            '<head>\n    <script>window.__SX_FILE_BUILD__ = true</script>'
          )
      }
    },
    // ② 生成内联资源脚本
    generateBundle() {
      for (const item of INLINE_ASSETS) {
        const abs = join(ROOT, item.file)
        if (!existsSync(abs)) {
          this.warn('内联资源缺失，已跳过：' + item.file)
          continue
        }
        const raw = readFileSync(abs)
        const value = item.kind === 'text'
          ? JSON.stringify(raw.toString('utf8'))
          : JSON.stringify(raw.toString('base64'))
        this.emitFile({
          type: 'asset',
          fileName: 'assets/inline-' + item.name + '.js',
          source: 'window.__SX_INLINE_ASSETS__ = window.__SX_INLINE_ASSETS__ || {};\n'
            + 'window.__SX_INLINE_ASSETS__[' + JSON.stringify(item.name) + '] = ' + value + ';\n'
        })
      }
    },
    // ③ 收尾：删掉已内联的重复文件
    writeBundle(options) {
      const outDir = options.dir || resolve(ROOT, 'dist')
      for (const rel of DROP_AFTER_BUILD) {
        const abs = join(outDir, rel)
        if (existsSync(abs)) rmSync(abs)
      }
    }
  }
}

export default defineConfig({
  plugins: [vue(), fileBuildPlugin()],
  // 相对路径：产物换目录、打包发送、双击打开都不受影响
  base: './',
  // 程序版本注入（项目包清单里要写它；避免为读一个字符串再引一份 package.json 副本）
  define: { __APP_VERSION__: JSON.stringify(PKG.version) },
  build: {
    target: 'es2020',
    cssCodeSplit: false,
    chunkSizeWarningLimit: 8000,
    outDir: 'dist',
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        // 固定文件名：离线分发时便于人工核对产物（本地场景没有 hash 缓存的收益）
        entryFileNames: 'assets/app.js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
})
