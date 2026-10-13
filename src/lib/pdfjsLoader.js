// pdf.js 的加载与 worker 落位 —— 给模板预览用（components/PdfPreview.vue）。
// 为什么要抽成模块：worker 的落位在 file:// 交付形态下有一处不显然的坑（见下），
//   而"哪一步该加载 pdf.js"也要有个统一入口（现在只有第 1 步的预览用它）。
//
// 2026-10-13：原来这里还有一个 `readPdfTextItems()`（读模板 PDF 的文字层，给"凭纸恢复批次"用）——
//   那个功能从未接线（`components/RestoreBatch.vue` 与 `lib/restoreBatch.js` 都不存在），
//   入口「项目备份」也早在 2026-10-11 随决策 五-10 删掉了，该导出**全库零引用**，一并删除。
//
// 依赖：pdfjs-dist 是运行时依赖（2026-10-04 由 devDependencies 移入），这里**动态 import** ——
//   首屏与其它步骤都不会加载它，构建产物里它是独立 chunk。
// **为什么用 legacy 构建**（2026-10-08，实施计划 3.4）：pdf.js 的现代构建直接调用
//   `Promise.withResolvers`（Chrome 119）与 `structuredClone`（Chrome 98）且没有回退 ——
//   在旧浏览器（含 Win7 能装的最后一版 Chrome/Edge 109）上会直接抛 TypeError。
//   `pdfjs-dist/legacy/build/` 是官方为老环境准备的转译版（自带这些 API 的降级实现），
//   体积只多约 0.1MB。换成 legacy 后，"Chrome / Edge 90 以上"这条口径才真正成立；
//   `test/browser-support.mjs` 会扫产物，防止以后有人改回现代构建。
//
// **销毁要用加载任务**：`pdfjs.getDocument()` 返回的是加载任务，销毁必须 `task.destroy()` ——
//   `PDFDocumentProxy` 上没有 `destroy()`，写成 `doc.destroy()` 会抛 TypeError 而被吞掉，
//   结果是文档与它的 worker 一直不释放（PdfPreview 那边踩过，见该文件头注释）。
//
// worker 的来源分两种形态（决策 六-4 的交付形态是 file:// 版）：
//   ① 内联形态（交付产物）：worker 的字节被构建期内联，这里转成 **Blob URL** ——
//      file:// 下 `new Worker('./assets/pdf.worker.min.mjs')` 会被浏览器拦下
//      （实测报 `cannot be accessed from origin 'null'`，清单 三-8），而 Blob URL 可用；
//      pdf.js 只要求 workerSrc 是**字符串 URL**，所以这条路成立。
//   ② 普通形态（dev 服务器）：走 vite 的 ?url，它把 worker 作为独立资源发出来，不拖慢首屏。
import { ensureInlineBlobUrl, hasInlineAssets } from './inlineAssets.js'

// 模块与 worker 只加载一次（多次 import 同一模块不会重复下载）
let pdfjsPromise = null

/** @returns {Promise<object>} pdfjs 模块（GlobalWorkerOptions.workerSrc 已就位） */
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
      let workerSrc = null
      if (hasInlineAssets()) {
        try {
          workerSrc = await ensureInlineBlobUrl('pdf-worker', 'text/javascript')
        } catch (e) {
          workerSrc = null // 取不到就退回 ?url；两条都不行时 pdf.js 自己会报错，界面有中文兜底
        }
      }
      if (!workerSrc) {
        const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
        workerSrc = worker.default
      }
      pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
      return pdfjs
    })()
  }
  return pdfjsPromise
}
