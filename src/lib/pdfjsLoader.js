// pdf.js 的加载与 worker 落位 —— 由两处共用：模板预览（components/PdfPreview.vue）与
// 「凭纸恢复批次」里读模板 PDF 的文字层（components/RestoreBatch.vue）。
// 为什么要抽出来：worker 的落位在 file:// 交付形态下有一处不显然的坑（见下），两处各写一遍迟早会分叉。
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

/**
 * 读一份 PDF 每页的**文字项**（每页一次 getTextContent）。
 * 给"从模板 PDF 恢复字序"用：模板里每个参考字是**逐格单独绘制**的，所以文字项与格位一一对应。
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<{pages:Array<{pageNumber:number,items:Array<{str:string,x:number,y:number}>}>, numPages:number}>}
 *   x / y 是 PDF 用户空间坐标（pt，原点左下）—— 与 layout.cellRect 同一坐标系，直接用即可
 */
export async function readPdfTextItems(bytes) {
  const pdfjs = await loadPdfjs()
  const task = pdfjs.getDocument({ data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) })
  const doc = await task.promise
  try {
    const pages = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      // disableCombineTextItems：不要让 pdf.js 把相邻的文字项合并 —— 合并了就分不清哪一项属于哪一格
      const content = await page.getTextContent({ disableCombineTextItems: true })
      pages.push({
        pageNumber: i,
        items: (content.items || []).map((it) => ({
          str: it.str,
          x: it.transform ? it.transform[4] : 0,
          y: it.transform ? it.transform[5] : 0
        }))
      })
    }
    return { pages, numPages: doc.numPages }
  } finally {
    // 销毁走**加载任务**（PDFDocumentProxy 上没有 destroy()，写成 doc.destroy() 会抛 TypeError 被吞掉，
    // 结果是文档与 worker 一直不释放 —— PdfPreview 那边踩过，见该文件头）
    await task.destroy().catch(() => {})
  }
}
