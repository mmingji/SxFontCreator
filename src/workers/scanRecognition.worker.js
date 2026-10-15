// 识别链路的 Web Worker（决策 六-15：把四段重计算搬出主线程）
//
// 职责：收下「图片字节 + 参数」，在 Worker 里跑完一页的
//   预处理 → 切格（含方向自动纠正）→ 认参考字与定字序 → 红圈识别 → 字形提取 → 缩略图 PNG，
//   把页记录与掩膜发回主线程。**界面因此在几十页连跑时保持可滚动**（原来这些都跑在主线程上）。
//
// 与主线程的分工（**只有编排一行不重复**）：一页的完整计算只有 `lib/scanFlow.recognizePage` 一份；
//   逐页串行、可中止、整批汇总也只有 `lib/scanFlow.recognizeBatch` 一份 —— 本文件只负责
//   "把消息翻译成调用、把结果与掩膜发回去"。因此两条跑法（主线程 / Worker）跑的**是同一份编排代码**，
//   差别只在计算发生在哪个线程（决策 六-15 ⑨ 的口径）。
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
import { recognizeBatch, recognizePage } from '../lib/scanFlow.js'
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

/**
 * 整批识别：逐页串行（决策 二-1）、每页发一次、可中止。
 * **逐页循环复用 `scanFlow.recognizeBatch`**（2026-10-13 改）：原来这里自己写了一遍同样的循环，
 *   与主线程那份是同一段逻辑的两份实现 —— 改一处漏一处只是时间问题。现在：
 *   · 循环、串行、中止、整批汇总（`summarizeBatch`）全部由 `recognizeBatch` 负责；
 *   · 这里只做"翻译"：把它的回调转成给主线程的消息、把每页的掩膜 transfer 过去。
 *   Worker 与主线程跑的因此是**同一份编排代码**，只有计算所在的线程不同（决策 六-15 ⑨ 的口径）。
 */
async function handleBatch(msg) {
  const { rid } = msg
  const files = msg.files || []
  try {
    if (msg.fontBytes) fontBytes = msg.fontBytes
    await ensureLibrary(rid)
    const lib = library
    const res = await recognizeBatch(files.map((f) => toFile(f.bytes, f.name, f.type)), {
      chars: msg.chars,
      library: lib,
      orderChars: msg.orderChars,
      orderPages: msg.orderPages,
      expectedBatchCode: typeof msg.expectedBatchCode === 'number' ? msg.expectedBatchCode : null,
      sheetPages: typeof msg.sheetPages === 'number' ? msg.sheetPages : undefined,
      // 中止：`recognizeBatch` 在每页开始前问一次 —— 与"当前这一页处理完就停"的口径一致
      shouldStop: () => cancelled,
      onPageStart: (pageNo, total) => post({ type: 'pageStart', rid, pageNo, total }),
      onStage: (text) => post({ type: 'stage', rid, text }),
      onPage: (record, index, total, cache) => {
        post({ type: 'page', rid, index, record, cache: toMessage(cache) }, transferablesOf(cache))
      }
    })
    // 主线程**直接用这一份汇总**（它自己的页记录也一样，但两处各算一遍只会多一处可能不一致的地方）。
    // 中止过就单独发一条 stopped，让客户端知道"是停下来而不是跑完了"。
    // `duplicates` 必须一起发（2026-10-14 修）：去重是在逐页循环**之后**算的，逐页那一批 page 消息里
    //   还没有 `duplicateOf`，主线程的页记录只能靠这条消息补齐 —— 否则界面上的「重复页」标记、
    //   统计与更正配对全按未去重的页算（真机表现：同一个字在配对表里出现四行）。
    if (res.stopped) post({ type: 'stopped', rid })
    post({
      type: 'done',
      rid,
      summary: res.summary,
      count: res.pages.length,
      stopped: res.stopped,
      duplicates: res.duplicates || [],
      // 整页失败、但页脚读出了同一个页号的那些件（折角页 / 去阴影页…）：界面据此说明"它其实是重复的"
      failedDuplicates: res.failedDuplicates || []
    })
  } catch (e) {
    post({ type: 'error', rid, message: e && e.message ? e.message : String(e) })
  }
}

self.onmessage = (event) => {
  const msg = event.data || {}
  if (msg.type === 'cancel') {
    // 中止请求：**只置标志、不回话**（决策 二-18：当前这一页处理完就停，不打断正在跑的那一页）。
    // 这里绝不能顺手把标志清掉 —— 它由 `handleBatch` 在每页开始前读（`shouldStop`）
    cancelled = true
    return
  }
  if (msg.type === 'page') {
    cancelled = false
    return void handlePage(msg)
  }
  if (msg.type === 'batch') {
    // 新一轮开始才清标志（2026-10-15 收紧：原来任何非 cancel 消息都会清它 ——
    //   将来再加一种消息类型，就会把刚收到的中止请求悄悄吞掉）
    cancelled = false
    return void handleBatch(msg)
  }
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
