// 识别链路的 Web Worker（决策 六-15：把四段重计算搬出主线程）
//
// 职责：收下「图片字节 + 参数」，在 Worker 里跑完一页的
//   预处理 → 切格（含方向自动纠正）→ 认参考字与定字序 → 红圈识别 → 字形提取 → 缩略图 PNG，
//   把页记录与掩膜发回主线程。**界面因此在几十页连跑时保持可滚动**（原来这些都跑在主线程上）。
//
// 为什么整条链路都搬进来，而不是只搬预处理：四段里任何一段留在主线程，那一秒的卡顿就还在；
//   而且它们之间的中间产物（灰度图 / 定位矩阵 / 掩膜）本来就不该跨线程搬来搬去（单页彩色 8MB 级）。
//
// 为什么必须在 Worker 内自建参考字候选库（决策 六-15 ⑧）：
//   库约 32.6MB（8274 × 32×32 Float32 + 签名位图），实测 transfer 要 19ms 且会把主线程那份搬空；
//   而 Worker 里 OffscreenCanvas + FontFace 都可用（探针实测），所以只把**楷体字体字节**传进来一次，
//   在这里建库并常驻 —— 字体字节是 4MB 级、一次性，库的构建约 2.3 秒（只付一次）。
//
// 装载方式（决策 六-15 ⑤ 的硬约束）：**必须由 Vite 的 `?worker&inline` 内联**。
//   实测 file:// 下同目录的 worker 脚本文件会被 `origin 'null'` 拦下（module 形态的 Blob worker 也不行），
//   只有经典（非 module）Blob URL worker 能起来 —— 这个文件本身没有 module 语法（只有 import/export，
//   由构建期打包成经典脚本），因此能在 file:// 的真实交付物里跑起来。
import { recognizePage, summarizeBatch } from '../lib/scanFlow.js'
import { buildLibrary } from '../lib/referenceCharReader.js'

// 参考字候选库：模块级常驻（一个 Worker 会话只建一次）
let library = null
// 字体字节：主线程只在第一次请求时把楷体子集传进来（4MB 级、一次性），后续轮次不再传
let fontBytes = null

// 当前这一轮是否已被要求停止：`batch` 与 `cancel` 都是消息，所以停止请求会在两步之间被看到 ——
// 与主线程旧口径一致（"当前这一页处理完就停"），不打断正在跑的那一页
let cancelled = false

/** 把 ArrayBuffer 还原成 File（recognizePage 的入口签名要 File：它用 file.name 与 createImageBitmap(file)） */
function toFile(bytes, name, type) {
  return new File([bytes], name, { type: type || '' })
}

/** 建库（幂等；失败不缓存失败结果，下一轮可以重试） */
async function ensureLibrary(rid) {
  if (library) return library
  post({ type: 'stage', rid, text: '正在准备参考字识别（首次约 2~3 秒，之后不用再等）' })
  if (!fontBytes) throw new Error('Worker 里还没有字体字节：请重新发起一次识别')
  const face = new FontFace('sxfont-refchar-worker', fontBytes)
  await face.load()
  // Worker 里没有 document.fonts，但 `self.fonts` 是存在的（探针实测）—— 加了才保证 OffscreenCanvas 能取到它
  if (self.fonts && typeof self.fonts.add === 'function') self.fonts.add(face)
  library = await buildLibrary({ fontFamily: 'sxfont-refchar-worker' })
  return library
}

/** 掩膜与缩略图回传时要 transfer 的底层缓冲（转移是零拷贝，不转移就得整份复制一遍）。
 *  注意 transfer 列表里只能放 ArrayBuffer 而不是 Uint8Array 视图（主线程那边同样踩过一次）。 */
function transferablesOf(cache) {
  const list = []
  for (const m of (cache && cache.masks) || []) {
    if (m && m.mask && m.mask.buffer instanceof ArrayBuffer) list.push(m.mask.buffer)
  }
  return list
}

/** 把页记录里的掩膜字段剥掉（掩膜只走 cache，record 是落盘的轻量记录 —— 与主线程口径一致） */
function toMessage(cache) {
  return {
    thumb: cache ? cache.thumb : null,
    sheet: cache ? cache.sheet : null,
    designSize: cache ? cache.designSize : null,
    masks: ((cache && cache.masks) || []).map((m) => ({
      index: m.index,
      char: m.char,
      width: m.width,
      height: m.height,
      boxInSlice: m.boxInSlice,
      redPixelsRemoved: m.redPixelsRemoved,
      mask: m.mask
    }))
  }
}

function post(message, transfer) {
  if (transfer && transfer.length) self.postMessage(message, transfer)
  else self.postMessage(message)
}

/** 识别一页（单页重传也走这里） */
async function handlePage(msg) {
  const { rid } = msg
  try {
    if (msg.fontBytes) fontBytes = msg.fontBytes
    await ensureLibrary(rid)
    const lib = library
    const { record, cache } = await recognizePage(toFile(msg.bytes, msg.fileName, msg.fileType), {
      chars: msg.chars,
      library: lib,
      orderChars: msg.orderChars,
      orderPages: msg.orderPages,
      expectedBatchCode: typeof msg.expectedBatchCode === 'number' ? msg.expectedBatchCode : null,
      fileIndex: msg.fileIndex,
      pageNumberOverride: msg.pageNumberOverride,
      onStage: (text) => post({ type: 'stage', rid, text })
    })
    // **单页只发这一条**（没有 done）：主线程收到它就结束这一轮（见 scanWorkerClient 的说明）
    post({ type: 'page', rid, record, cache: toMessage(cache) }, transferablesOf(cache))
  } catch (e) {
    post({ type: 'error', rid, message: e && e.message ? e.message : String(e) })
  }
}

/** 整批识别：逐页串行（决策 二-1）、每页发一次、可中止 */
async function handleBatch(msg) {
  const { rid } = msg
  const files = msg.files || []
  const pages = []
  try {
    if (msg.fontBytes) fontBytes = msg.fontBytes
    await ensureLibrary(rid)
    const lib = library
    for (let i = 0; i < files.length; i++) {
      if (cancelled) {
        post({ type: 'stopped', rid })
        break
      }
      const f = files[i]
      post({ type: 'pageStart', rid, pageNo: i + 1, total: files.length })
      const { record, cache } = await recognizePage(toFile(f.bytes, f.name, f.type), {
        chars: msg.chars,
        library: lib,
        orderChars: msg.orderChars,
        orderPages: msg.orderPages,
        expectedBatchCode: typeof msg.expectedBatchCode === 'number' ? msg.expectedBatchCode : null,
        fileIndex: i,
        onStage: (text) => post({ type: 'stage', rid, text })
      })
      pages.push(record)
      post({ type: 'page', rid, index: i, record, cache: toMessage(cache) }, transferablesOf(cache))
      if (cancelled) {
        post({ type: 'stopped', rid })
        break
      }
    }
    // 整批汇总在主线程算会更方便，但它是纯函数、放这里也一样；放这里能少一次全量页记录回传。
    // **注意**：主线程仍会用同一份 summarizeBatch 复核（页记录它也有），两处结果必须一致。
    const summary = summarizeBatch(pages, {
      expectedBatchCode: typeof msg.expectedBatchCode === 'number' ? msg.expectedBatchCode : null,
      sheetPages: typeof msg.orderPages === 'number' ? msg.orderPages : msg.sheetPages
    })
    post({ type: 'done', rid, summary, count: pages.length, stopped: cancelled })
  } catch (e) {
    post({ type: 'error', rid, message: e && e.message ? e.message : String(e) })
  }
}

self.onmessage = (event) => {
  const msg = event.data || {}
  if (msg.type === 'cancel') {
    cancelled = true
    return
  }
  cancelled = false
  if (msg.type === 'page') return void handlePage(msg)
  if (msg.type === 'batch') return void handleBatch(msg)
}

// 兜底：任何在 promise 之外冒出来的异常都要**回一句话给主线程**，否则界面会一直停在"正在…"上
// （这正是"识别线程卡住"最难受的形态：没有报错、也没有结果）。这类错误本身已经带上 rid 之外的上下文，
// 所以用一个专门的类型上报，主线程据此立刻失败并说明是后台线程崩了。
self.addEventListener('error', (event) => {
  post({
    type: 'error',
    rid: null,
    message: '识别线程内部出错：' + ((event && event.message) || '未知原因')
  })
})
self.addEventListener('unhandledrejection', (event) => {
  const reason = event && event.reason
  post({
    type: 'error',
    rid: null,
    message: '识别线程内部出错：' + ((reason && reason.message) || reason || '未知原因')
  })
})
