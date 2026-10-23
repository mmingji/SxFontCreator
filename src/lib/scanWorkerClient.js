// 识别链路的 Worker 客户端（决策 六-15）：界面只跟它打交道，不再直接调 recognizeBatch / recognizePage。
//
// 它做四件事：
//   ① **把 File 读成字节再 transfer**（零拷贝）：File 直接 postMessage 会被结构化克隆整份复制，
//      而单页彩色 8MB、几十页就是几百 MB 的复制 —— 读成 ArrayBuffer 后 transfer，Worker 那边零成本收下；
//   ② **按需把楷体字体字节传给 Worker**（只在 Worker 里还没建过候选库时传一次，4MB 级）；
//   ③ 把 Worker 的进度消息翻译成界面要的三个回调（`onStage` / `onPageStart` / `onPageIndex`）；
//   ④ **一次只跑一个任务**：Worker 是单例、内部循环是串行的，并发发起两个任务只会互相插队
//      （整批识别与单页重传本来也互斥：界面在两处都做了 `running` 判断）。
//
// 装载方式的硬约束见 workers/scanRecognition.worker.js 的头注释：file:// 下只有内联 worker 可用。
import { loadBuiltinFont } from '../lib/referenceFont.js'

// 装载：构建期内联的经典 worker（Vite 的 `?worker&inline`，见 vite.config.js 的 worker.format）
const createWorker = () => {
  // 动态 import 只在真正识别时发生；`?worker&inline` 会把 worker 的字节内联进主包
  return import('../workers/scanRecognition.worker.js?worker&inline').then((mod) => new mod.default())
}

let worker = null
let workerReady = null // Promise：装载完成（失败会清掉，允许重试）
let seq = 0
let activeRid = null
let queue = Promise.resolve() // 任务串行队列

// Worker 里有没有候选库：有没有传过字体字节就代表有没有建过（建库要字体）
let fontSent = false

/** 懒装载：第一次识别时才建 worker（首屏不该为它付出代价；失败不缓存，下次可重试） */
function ensureWorker() {
  if (worker) return Promise.resolve(worker)
  if (!workerReady) {
    workerReady = Promise.resolve()
      .then(() => createWorker())
      .then((w) => {
        worker = w
        return w
      })
      .catch((e) => {
        workerReady = null
        throw new Error('识别用的后台线程起不来：' + (e && e.message ? e.message : e))
      })
  }
  return workerReady
}

/** 丢掉当前 worker 与它的状态（换装载方式 / 出错后重来时用） */
export function resetWorker() {
  if (worker && typeof worker.terminate === 'function') {
    try { worker.terminate() } catch (e) { /* 已经没了就算了 */ }
  }
  worker = null
  workerReady = null
  activeRid = null
  fontSent = false
}

/** File → ArrayBuffer（读失败给中文原因，不让它变成一个看不懂的异常） */
async function readBytes(file) {
  try {
    return await file.arrayBuffer()
  } catch (e) {
    throw new Error('读取「' + (file && file.name ? file.name : '未命名文件') + '」失败：' + (e && e.message ? e.message : e))
  }
}

/** 把掩膜消息还原成界面与落盘要的形状（Uint8Array 视图；底层缓冲是刚 transfer 过来的那个） */
function reviveCache(cache) {
  if (!cache) return { thumb: null, sheet: null, masks: null, designSize: null }
  return {
    thumb: cache.thumb || null,
    sheet: cache.sheet || null,
    designSize: cache.designSize || null,
    masks: (cache.masks || []).map((m) => ({
      index: m.index,
      char: m.char,
      width: m.width,
      height: m.height,
      boxInSlice: m.boxInSlice,
      redPixelsRemoved: m.redPixelsRemoved,
      mask: new Uint8Array(m.mask)
    }))
  }
}

/**
 * 跑一个 Worker 任务（内部串行）。
 * @param {object} payload 发给 Worker 的消息（不含 rid / fontBytes）
 * @param {object} hooks { onStage, onPageStart, onPage, onPageIndex }
 * @returns {Promise<{pages:Array, caches:Map, summary:object|null, stopped:boolean}>}
 */
function runTask(payload, hooks = {}) {
  const task = async () => {
    const w = await ensureWorker()
    const rid = ++seq
    activeRid = rid
    // 字体字节：只在 Worker 还没建过候选库时传（4MB 级、一次性）。
    // 为什么每次都尝试：Worker 可能是刚被重建的（出错重试 / 页面重挂载），它那边没有库就得有字节
    let fontBytes = null
    if (!fontSent) {
      fontBytes = await loadBuiltinFont()
      fontSent = true
    }
    const pages = []
    const caches = new Map()
    let summary = null
    let stopped = false
    // 重复页的去重结论（2026-10-14 修）：它是在 Worker 的逐页循环**之后**算出来的，逐页那批 page 消息里
    //   还没有 `duplicateOf` —— 只能随 `done` 一起回来，再由界面补写进 store（见 store.applyScanDuplicates）
    let duplicates = []
    // 整页失败但右侧方块同页号的那些件（同样只能随 done 回来，见 scanFlow.markDuplicatePages）
    let failedDuplicates = []
    // 单页任务只有一条 `page` 消息，**没有** `done`（见 worker 的 handlePage）——
    // 所以那一类必须"收到 page 就结束"。整批任务靠 `done` 结束，并留一条兜底：
    // 页数已经收满也结束（万一 done 丢了，界面不该永远停在"正在识别"）。
    const singlePage = payload.type === 'page'
    const expectedPages = singlePage ? 1 : (payload.files || []).length
    await new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        // 收尾：不管成功还是失败都要摘掉监听（否则几十页会攒下几十对监听器）
        w.removeEventListener('message', onMessage)
        w.removeEventListener('error', onError)
        fn(value)
      }
      // 在飞的落盘回调（每页一个，见下面 page 分支的 onPageIndex）
      const pendingCallbacks = []
      // 收尾：**先把还在飞的 onPageIndex 等完**再结束这次任务。
      // 为什么必须等：done / stopped / 页数收满这三种收尾，都可能在上一条 page 消息的 onPageIndex
      //   还没跑完时就到了（事件监听器各跑各的，互不阻塞）—— 而界面在那个回调里落盘字形，
      //   每页要编码 136 张掩膜 PNG（约 1 秒）。不等的话"识别完成"会先上屏，用户此时刷新或关浏览器，
      //   **最后几页的字形分片就永远没落盘**。真机表现：刷新后更正核对里更正册那一列缩略图整列空白
      //   （更正册恰好是目录里的最后一页），而且再也补不回来，只能重新识别一次。
      const settle = () => {
        Promise.allSettled(pendingCallbacks).then(() => finish(resolve))
      }
      const onMessage = async (event) => {
        const msg = event.data || {}
        // Worker 内部崩了（未捕获异常 / 未处理的 promise 拒绝）：它上报的 rid 是 null。
        // 这时当前任务不可能再正常完成 —— 立刻明确失败，而不是让界面一直停在"正在…"上。
        if (msg.type === 'error' && (msg.rid === null || msg.rid === undefined)) {
          resetWorker()
          finish(reject, new Error(msg.message || '识别线程内部出错'))
          return
        }
        if (msg.rid !== rid) return // 上一轮遗留的消息（正常不会出现，防一手）
        try {
          if (msg.type === 'stage') {
            if (typeof hooks.onStage === 'function') hooks.onStage(msg.text)
          } else if (msg.type === 'pageStart') {
            if (typeof hooks.onPageStart === 'function') hooks.onPageStart(msg.pageNo, msg.total)
          } else if (msg.type === 'page') {
            pages.push(msg.record)
            const cache = reviveCache(msg.cache)
            const index = typeof msg.index === 'number' ? msg.index : pages.length - 1
            caches.set(index, cache)
            // 回调带上 cache：界面拿到页记录的同时就要把缩略图与掩膜收下（掩膜是下一步合成字体的原料）。
            // **要 await**：界面在这个回调里落盘字形与页记录 —— 不等它的话，"识别完成"这句话可能比
            //   落盘提示先出现，而用户看到的顺序就成了"说完了才写盘"（冒烟里当场抓到过这个时序）。
            if (typeof hooks.onPageIndex === 'function') {
              const p = Promise.resolve(hooks.onPageIndex(msg.record, index, cache))
              pendingCallbacks.push(p)
              await p
            }
            if (singlePage || (expectedPages > 0 && pages.length >= expectedPages)) settle()
          } else if (msg.type === 'stopped') {
            stopped = true
            settle()
          } else if (msg.type === 'done') {
            summary = msg.summary || null
            stopped = !!msg.stopped
            duplicates = Array.isArray(msg.duplicates) ? msg.duplicates : []
            failedDuplicates = Array.isArray(msg.failedDuplicates) ? msg.failedDuplicates : []
            settle()
          } else if (msg.type === 'error') {
            finish(reject, new Error(msg.message || '后台线程报错'))
          }
        } catch (e) {
          // 处理消息时出错（回调里抛、或消息形状不对）：**立刻明确失败**，不要让界面停在"正在…"上
          finish(reject, e)
        }
      }
      const onError = (event) => {
        // Worker 自身的错误（脚本装载失败 / 未捕获异常）：把现场说清楚，并丢掉这个实例（下次重建）
        resetWorker()
        finish(reject, new Error('识别线程出错：' + ((event && event.message) || '未知原因')))
      }
      w.addEventListener('message', onMessage)
      w.addEventListener('error', onError)
      Promise.resolve(fontBytes)
        .then((bytes) => {
          const message = { ...payload, rid }
          const transfer = []
          // 图片字节一律**转移**（零拷贝）：files[].bytes 是整批那条路，payload.bytes 是单页那条路
          for (const f of payload.files || []) if (f.bytes) transfer.push(f.bytes)
          if (payload.bytes) transfer.push(payload.bytes)
          if (bytes) {
            // transfer 列表里只能是**可转移对象**（ArrayBuffer / MessagePort…）——
            // 直接放 Uint8Array 会报 `does not have a transferable type`（踩过一次）；
            // 这些 Uint8Array 都是刚刚独立分配的（file.arrayBuffer / 内联解码），没有别的视图共享缓冲
            message.fontBytes = bytes.buffer
            transfer.push(bytes.buffer)
          }
          w.postMessage(message, transfer)
        })
        .catch((e) => finish(reject, e))
    }).finally(() => {
      activeRid = null
    })
    return { pages, caches, summary, stopped, duplicates, failedDuplicates }
  }
  const next = queue.then(task, task)
  queue = next.catch(() => {}) // 队列自身不因某次失败中断
  return next
}

/**
 * 整批识别（界面的主路径）。
 * @param {File[]} files 扫描件（按文件名自然序，由调用方排好）
 * @param {object} options 与 lib/scanFlow.recognizeBatch 同名同义（chars / orderChars / orderPages /
 *   extraSequences / sheetPages），另加三个回调：`onStage`（阶段中文文案）、
 *   `onPageStart(pageNo, total)`、`onPageIndex(record, index, cache)`（每页完成，可 async —— 客户端会等它）
 * @returns {Promise<{pages:Array, caches:Map, summary:object|null, stopped:boolean}>}
 *   pages 是按文件顺序的页记录；caches 是 fileIndex → { thumb, sheet, masks }
 */
export async function recognizeBatchInWorker(files, options = {}) {
  const list = []
  for (const f of files) list.push({ name: f.name, type: f.type || '', bytes: await readBytes(f) })
  return await runTask({
    type: 'batch',
    files: list,
    chars: options.chars || '',
    orderChars: options.orderChars || '',
    orderPages: typeof options.orderPages === 'number' ? options.orderPages : undefined,
    extraSequences: Array.isArray(options.extraSequences) ? options.extraSequences : undefined,
    sheetPages: typeof options.sheetPages === 'number' ? options.sheetPages : undefined,
    extractOptions: options.extractOptions || undefined,
    markOptions: options.markOptions || undefined
  }, options)
}

/**
 * 识别一页（单页重传用）：与 lib/scanFlow.recognizePage 的返回形状一致。
 * @returns {Promise<{record:object, cache:object}>}
 */
export async function recognizePageInWorker(file, options = {}) {
  const fileIndex = typeof options.fileIndex === 'number' ? options.fileIndex : 0
  const res = await runTask({
    type: 'page',
    files: [],
    bytes: await readBytes(file),
    fileName: file.name,
    fileType: file.type || '',
    chars: options.chars || '',
    orderChars: options.orderChars || '',
    orderPages: typeof options.orderPages === 'number' ? options.orderPages : undefined,
    extraSequences: Array.isArray(options.extraSequences) ? options.extraSequences : undefined,
    fileIndex,
    pageNumberOverride: typeof options.pageNumberOverride === 'number' ? options.pageNumberOverride : undefined,
    extractOptions: options.extractOptions || undefined,
    markOptions: options.markOptions || undefined
  }, options)
  const record = res.pages[0]
  if (!record) throw new Error('识别线程没有返回这一页的结果')
  // 取 cache：单页任务**只可能有一条**，所以按 fileIndex 取不到时退回那唯一一条
  // （2026-10-15 修一个真缺陷：这条兜底原来没有，而 Worker 的单页消息曾经不带 index ——
  //   取不到就 `reviveCache(null)` 给一个空 cache，调用方拿它落盘就把分片覆盖成 0 格，
  //   字形与缩略图一起丢，且**不报错**。现在消息必带 index，这里只是第二道保险。）
  const cache = res.caches.get(fileIndex) || res.caches.values().next().value || reviveCache(null)
  if (!cache || !cache.masks) throw new Error('识别线程没有回传这一页的笔迹数据（掩膜为空）—— 请重试一次这一页')
  return { record, cache }
}

/** 请求中止当前任务：**当前这一页处理完就停**（与旧口径一致）；已识别的页保留 */
export function cancelTask() {
  if (worker && activeRid !== null) {
    try { worker.postMessage({ type: 'cancel' }) } catch (e) { /* worker 已经没了 */ }
  }
}

// 页面卸载时收掉线程（避免 dev 热更新反复堆积 worker）
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => resetWorker())
}

// 2026-10-13：这里原来还有一个 `PAGE_CELLS_IN_WORKER = LAYOUT.perPage`（本想当"页内格数只有一处权威"
// 的口径锚点），但它全库零引用、还让本文件多背一个 LAYOUT import —— 已删。
// 页内格数的权威处本来就只有 layout.js 的 LAYOUT.perPage（决策 六-9），不必在每个文件里再声明一次。
