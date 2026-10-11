<script setup>
// 第 3 步：上传识别（阶段一「界面串联」B2；2026-10-11 起改用"从纸上认参考字定字序"的新模型）
// 职责：① 取这一轮要用的批次（**用户不再选**：进这一步时自动复用最近一个仍有效的，或顺手建一个）
//   ② 准备参考字候选库 → 多选扫描件 → 串行识别，边跑边显示、可中止（决策 二-1：绝不能整批读进内存）
//   ③ 批次判定与**收批闸门**（单页失败跳过、批次级问题整批拦下）
//   ④ 页级结果（缩略图 / 页号来源 / 定位到的字序 / 写出格数 / 需要逐格确认的格数 / 失败原因标红）
//   ⑤ 格级视图（136 格拼图 + 判定覆盖 + 单格放大看笔迹与统计）
//   ⑥ 页脚读不出时手选页序（拖动 + 数字，决策 二-7）与**逐格复核**（CharReview.vue）
// 数据来源：编排在 lib/scanFlow.js，产物缓存（缩略图 / 掩膜）在 lib/scanCache.js，
//   参考字候选库在 lib/referenceCharReader.js（浏览器侧渲染，约 2~3 秒，建一次整个会话复用），
//   轻量页记录落盘在 store.scan —— 口径见《决策记录》二-15 / 五-9。
import { computed, onMounted, ref, watch } from 'vue'
import { useProjectStore } from '../store/project.js'
import { applyPageOrder, evaluateRescanAccept, evaluateScanGate, recognizeBatch, recognizePage, resolveBatchChars, summarizeBatch } from '../lib/scanFlow.js'
import { clearPageCache, getPageCache, putPageCache } from '../lib/scanCache.js'
import { clearGlyphs, glyphStoreStats, savePageGlyphs } from '../lib/glyphStore.js'
import { buildLibrary } from '../lib/referenceCharReader.js'
import { loadBuiltinFont } from '../lib/referenceFont.js'
import { LAYOUT } from '../lib/layout.js'
import CharReview from './CharReview.vue'

// ── 参考字候选库（认字与定字序都要它）──────────────────────────────────────
// 为什么要缓存：建一次要 8274 字逐个渲染 + 取特征，实测约 2.3 秒 —— 一轮识别（可能几十页）只该付一次。
// 为什么放在模块级而不是组件里：组件会在离开第 3 步时卸载（App.vue 是 v-if 挂载），
//   放在组件里等于"每次回来都重建一遍"，用户会以为程序卡住。
// 为什么用 Promise 而不是"建好的库"：并发的两个入口（整批识别与单页重传）不能各建一份。
let libraryPromise = null
let library = null // buildLibrary 的产物（建好后一直留着；纯数据，约 10MB）

/** 取候选库：第一次调用才真建（先注册内置楷体，再渲染字表）。失败时不缓存失败结果，允许重试 */
function ensureLibrary(onProgress) {
  if (!libraryPromise) {
    libraryPromise = (async () => {
      // 参考字一律用**内置楷体**渲染（纸上那套参考字就是它印的 —— 换个字体就认不出来）
      const bytes = await loadBuiltinFont()
      const face = new FontFace('sxfont-refchar', bytes)
      await face.load()
      document.fonts.add(face)
      library = await buildLibrary({ fontFamily: 'sxfont-refchar', onProgress })
      return library
    })().catch((e) => {
      libraryPromise = null // 失败不留缓存：下次点识别还能再试一次（字体读取失败多半是临时的）
      throw e
    })
  }
  return libraryPromise
}

const store = useProjectStore()

const files = ref([]) // 用户选的扫描件（File 对象；只在内存里，不上传）
const running = ref(false)
const stage = ref('')
const progress = ref({ done: 0, total: 0 })
const images = ref({}) // fileIndex → { thumb, sheet }（来自内存缓存，用于渲染；不落盘）
const openIndex = ref(null) // 展开格级视图的页
const zoomIndex = ref(null) // 单格放大
const reviewIndex = ref(null) // 打开逐格复核的页（fileIndex）
const reviewOpen = ref(false)
const message = ref('')
const messageType = ref('info') // info | error | done
const dragFrom = ref(null)
const savedStats = ref(null) // 已落盘的字形统计（分片键里的字与体积）
let cancelled = false

const pages = computed(() => store.scan.pages)
const batch = computed(() => store.scanBatch)
const chars = computed(() => store.scan.chars || resolveBatchChars(batch.value))
const stats = computed(() => store.scanGlyphStats)
// 收批闸门：能不能进下一步（规则在 lib/scanMeta.js，这里只渲染结论）
const gate = computed(() => evaluateScanGate({
  summary: store.scan.summary || { problems: [] },
  pages: pages.value
}))

// ── 页级结果里的"新模型"信息（定位到的字序 / 还要确认几格）──────────────────
// 序列标签：与 lib/referenceCharReader.js 的两份全序一一对应（页记录里只留了 key）
function sequenceLabel(seqKey) {
  return seqKey === 'rank' ? '使用频率序' : '笔画序'
}
// 序列定位命中时，这一页是全序里从第几个字开始的一段 —— 页号由它反推（纸面自己说得清是第几页）
function locatedStartPage(page) {
  return Math.floor(page.located.start / LAYOUT.perPage) + 1
}
// 还要人工确认的格 = 认不准的格 ∪ 还没认出字的格（两者可能重叠，按格号去重）
function reviewCount(page) {
  const set = new Set(page.unsureCells || [])
  const list = page.pageChars || []
  for (let i = 0; i < LAYOUT.perPage; i++) if (!list[i]) set.add(i)
  return set.size
}
const reviewPage = computed(() => pages.value.find((p) => p.fileIndex === reviewIndex.value) || null)
function openReview(page) {
  reviewIndex.value = page.fileIndex
  reviewOpen.value = true
  openIndex.value = null
  zoomIndex.value = null
}
function closeReview() {
  reviewOpen.value = false
}

// 页脚读不出的页才允许手选页序：页脚解出来的页序是权威的（决策 二-7）。
// **序列定位成功的页除外**：那种页的页序是"纸面上的参考字"定死的（比页脚更硬），而且它的每格字
// 已经由那一段全序给出 —— 再按批次的全局字序重排一次只会把对的改成错的（新模型下的字序来源变了）。
function needsManualOrder(page) {
  return !!(page.ok && !page.footerOk && page.pageNumberSource !== 'sequence')
}
function setMessage(text, type) {
  message.value = text
  messageType.value = type || 'info'
}

onMounted(() => {
  // 批次是内部容器：进来就取一个（复用最近一个仍有效的，或自动补一个）—— 用户不必也不能再选它
  store.ensureScanBatch()
  // 界面重挂载时把还活着的内存缓存接回来（缩略图与掩膜不落盘）
  const restored = {}
  for (const page of store.scan.pages) {
    const cache = getPageCache(page.fileIndex)
    if (cache) restored[page.fileIndex] = { thumb: cache.thumb, sheet: cache.sheet }
  }
  if (Object.keys(restored).length) images.value = restored
  // 字形是**落盘**的（分片键）：刷新后仍能拿去生成字体，所以这里把已落盘的量显示出来
  glyphStoreStats().then((s) => { savedStats.value = s }).catch(() => {})
})

// 批次被删掉（批次管理里删的正是当前这一批）时立刻补一个：让"在第 3 步就一定有批次"成为不变量 ——
// 否则字形会落到 `default` 分片键上（既不属于任何批次、也没法在批次管理里清掉，冒烟里踩到过）
watch(() => store.scan.batchId, (id) => {
  if (!id) store.ensureScanBatch()
})

function onPickFiles(event) {
  const picked = Array.from(event.target.files || [])
  files.value = picked
  event.target.value = '' // 清空 input，便于再次选择同一批文件
  setMessage(picked.length ? '已选择 ' + picked.length + ' 个文件：点「开始识别」逐页处理（串行，逐页释放内存）' : '', 'info')
}

async function start() {
  if (running.value) return
  if (!files.value.length) {
    setMessage('还没有选择扫描件', 'error')
    return
  }
  // 批次是内部容器：再取一次（复用最近一个仍有效的，或自动补一个）—— 界面上已经无处可选它。
  // 2026-10-11（决策 五-9）：这里原来还有一道"作废批次要显式放行"的拦截，随那个勾选框一起去掉了 ——
  // 批次对用户不可见，也就没有"作废"这回事（改选字不再作废批次，见 store.setSelection）
  const currentBatch = store.ensureScanBatch()
  running.value = true
  cancelled = false
  openIndex.value = null
  zoomIndex.value = null
  closeReview()
  images.value = {}
  progress.value = { done: 0, total: files.value.length }
  const t0 = performance.now()
  try {
    // ① 参考字候选库：认字与定字序都靠它。建一次约 2~3 秒（8274 字逐个渲染 + 取特征），
    //    建好后整个会话复用 —— 所以放在"清空上一轮结果"之前：准备失败时不该把已有结果清掉
    setMessage('正在准备参考字识别…（首次约 2~3 秒，之后不用再等）', 'info')
    const lib = await ensureLibrary((done, total) => {
      setMessage('正在准备参考字识别…（' + done + ' / ' + total + '）', 'info')
    })
    if (cancelled) {
      setMessage('已中止：参考字还没准备完，这一批没有开始识别', 'info')
      return
    }
    clearPageCache()
    // 同一批重新识别：先把这批已落盘的字形清掉，避免旧页与新页混在一起（分片键是按批次 + 页序写的）
    await clearGlyphs({ batchId: store.scan.batchId })
    savedStats.value = null
    store.beginScanRun({ batchId: store.scan.batchId, chars: resolveBatchChars(currentBatch) })
    setMessage('正在识别…（单页约 1~2 秒，51 页约 85 秒；中途可以点「中止」，已识别的页会保留）', 'info')
    const res = await recognizeBatch(files.value, {
      batch: currentBatch,
      // 传了它才做"认参考字 + 定字序"；不传就退回旧的"按批次全局字序取字"口径
      library: lib,
      onStage: (text) => { stage.value = text },
      shouldStop: () => cancelled,
      onPage: async (record, index, total, cache) => {
        putPageCache(index, cache)
        images.value = { ...images.value, [index]: { thumb: cache.thumb, sheet: cache.sheet } }
        store.appendScanPage(record)
        progress.value = { done: index + 1, total }
        // 字形**逐页落盘**（掩膜存 PNG，分片键）：关掉浏览器或刷新后不用重扫，
        // 字体合成（下一步）直接从这里取原料 —— 口径见《决策记录》二-16
        const res = await savePageGlyphs({
          batchId: store.scan.batchId,
          fileIndex: index,
          pageNumber: record.pageNumber,
          glyphs: (cache.masks || []).map((m) => ({
            char: m.char,
            cellIndex: m.index,
            mask: m.mask,
            width: m.width,
            height: m.height,
            boxInSlice: m.boxInSlice
          }))
        })
        if (!res.ok) setMessage('字形落盘失败（识别结果仍在内存里，但刷新会丢）：' + res.error, 'error')
        savedStats.value = await glyphStoreStats().catch(() => savedStats.value)
      }
    })
    store.finishScanRun({ summary: res.summary })
    const secs = ((performance.now() - t0) / 1000).toFixed(1)
    setMessage(
      (res.stopped ? '已中止：' : '识别完成：') + res.pages.length + ' 页，用时 ' + secs + ' 秒；' +
        (res.summary.ok ? '这一批可以继续' : '这一批被拦下（见下面的原因）'),
      res.summary.ok ? 'done' : 'error'
    )
  } catch (e) {
    setMessage('识别失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    running.value = false
    stage.value = ''
  }
}

function stop() {
  cancelled = true
  setMessage('已请求中止：当前这一页处理完就停（已识别的页会保留）', 'info')
}

function clearAll() {
  if (running.value) return
  files.value = []
  images.value = {}
  openIndex.value = null
  zoomIndex.value = null
  clearPageCache()
  // 字形是落盘的：清结果要连分片键一起清，否则下次识别会与旧字形混在一起
  clearGlyphs({ batchId: store.scan.batchId }).then((r) => {
    savedStats.value = null
    setMessage('已清空识别结果、内存缓存与落盘的字形' + (r && r.removed ? '（删除 ' + r.removed + ' 页分片）' : ''), 'info')
  })
  store.clearScan()
}

// ── 单页重传（清单 一-8）──────────────────────────────────────────────────
// 场景：某一页写坏了 / 扫描有折痕，重扫那一页就够，不必整批重来（整批 51 页要重跑约 85 秒）。
// 三条口径（2026-10-08 用户拍板，见《决策记录》八-14）：
//   ① 入口在页级结果的每一行 —— 局部、明确，现有的"整批识别"流程一个字不改；
//   ② **复用原页的 fileIndex**：分片键（`sxfont.glyphs.v1.<批次>.<fileIndex>`）与内存缓存都按它命名，
//      复用即"原地覆盖"，页序机制一行都不用动；
//   ③ 整页失败、或页脚校验码与所选批次不符 → **明确失败、不写入**（静默拿错数据比拒绝处理糟得多，沿用二-6 的口径）。
const rescanning = ref(null) // 正在重传的页 fileIndex（同一时刻只允许一页在跑）

async function rescanPage(page, event) {
  const file = (event.target.files || [])[0]
  event.target.value = '' // 清空，便于再选同一个文件
  if (!file || running.value || rescanning.value !== null) return
  // 批次是内部容器：重传前也取一次（复用最近一个仍有效的，或自动补一个）—— 字形分片键是「批次 + 页序」，
  // 批次为空会落成 `default` 键，之后既不属于任何批次、也没法在批次管理里清掉（冒烟里踩到过）
  const currentBatch = store.ensureScanBatch()
  rescanning.value = page.fileIndex
  setMessage('正在重传第 ' + (page.pageNumber || '?') + ' 页（' + file.name + '）…', 'info')
  try {
    // 重传也走"从纸上认参考字"的同一条路（候选库已建好就直接用）：
    // 否则这一页的字会退回按**批次的全局字序**取 —— 自定义选字的纸会被张冠李戴
    const lib = library || await ensureLibrary((done, total) => {
      setMessage('正在准备参考字识别…（' + done + ' / ' + total + '）', 'info')
    })
    const expectedBatchCode = currentBatch && typeof currentBatch.batchCode === 'number' ? currentBatch.batchCode : null
    const { record, cache } = await recognizePage(file, {
      chars: chars.value,
      library: lib,
      expectedBatchCode,
      fileIndex: page.fileIndex, // 复用原页序号：分片键与缓存键都按它覆盖
      pageNumberOverride: page.pageNumber || undefined
    })
    if (!record.ok) {
      setMessage('这一页没能识别：' + record.reason + '。原来的结果与字形都没动，可以重扫一页再试', 'error')
      return
    }
    // 收不收这一页的判据抽在 scanMeta.evaluateRescanAccept 里（纯函数、有单测）：
    // 整页失败与校验码不符都属"明确失败、不写入"（静默拿错数据比拒绝处理糟得多，沿用二-6 的口径）
    const verdict = evaluateRescanAccept({ record, batchCode: currentBatch ? currentBatch.batchCode : null })
    if (!verdict.accept) {
      setMessage(verdict.message, 'error')
      return
    }
    const saved = await savePageGlyphs({
      batchId: store.scan.batchId,
      fileIndex: page.fileIndex,
      pageNumber: record.pageNumber,
      glyphs: (cache.masks || []).map((m) => ({
        char: m.char,
        cellIndex: m.index,
        mask: m.mask,
        width: m.width,
        height: m.height,
        boxInSlice: m.boxInSlice
      }))
    })
    if (!saved.ok) {
      setMessage('这一页识别成功，但字形落盘失败（结果只在内存里，刷新会丢）：' + saved.error, 'error')
    }
    // 被圈字变了 → 之前的更正配对失效（配对依赖被圈字清单）：清掉并明确提示去第 4 步重新核对
    const markedChanged = (page.markedCells || []).join(',') !== (record.markedCells || []).join(',')
    if (markedChanged) store.resetCorrection()
    // 重算整批汇总（页号重复 / 批次码不符 / 缺页 / 收批闸门都读它）；顺序保持原位置，不把这一页挪到最后
    const nextPages = store.scan.pages.map((p) => (p.fileIndex === page.fileIndex ? record : p))
    if (!nextPages.some((p) => p.fileIndex === page.fileIndex)) nextPages.push(record)
    const summary = summarizeBatch(nextPages, {
      expectedBatchCode,
      sheetPages: batch.value ? batch.value.pageCount : undefined
    })
    putPageCache(page.fileIndex, cache)
    images.value = { ...images.value, [page.fileIndex]: { thumb: cache.thumb, sheet: cache.sheet } }
    if (openIndex.value === page.fileIndex) openIndex.value = null
    zoomIndex.value = null
    const res = store.replaceScanPage({ fileIndex: page.fileIndex, record, summary })
    savedStats.value = await glyphStoreStats().catch(() => savedStats.value)
    setMessage(
      '已重传第 ' + (record.pageNumber || page.pageNumber || '?') + ' 页（' + file.name + '）：写出 ' +
        record.counts.written + ' 格 / 被圈 ' + record.counts.marked + ' 个' +
        (res.replaced ? '' : '（结果里原本没有这一页，已补上）') +
        (markedChanged ? '。这一页的被圈字有变化，之前的更正配对已作废，请到第 4 步重新核对' : '') +
        '。这一页的字形已更新，字体要重新生成才生效',
      markedChanged ? 'info' : 'done'
    )
  } catch (e) {
    setMessage('重传失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    rescanning.value = null
  }
}

// ── 手选页序（决策 二-7）：改数字或拖动都能改 ────────────────────────────
function applyOrder(overrides, note) {
  const next = applyPageOrder(pages.value, overrides, chars.value, {
    sheetPages: batch.value ? batch.value.pageCount : undefined,
    expectedBatchCode: batch.value ? batch.value.batchCode : undefined
  })
  store.setScanPageOrder({ overrides, pages: next.pages, summary: next.summary })
  if (note) setMessage(note, 'info')
}
function onOrderInput(page, value) {
  const n = Number(value)
  if (!n || n < 1) {
    setMessage('页号要填 1 以上的整数', 'error')
    return
  }
  const overrides = { ...store.scan.orderOverrides, [page.fileIndex]: n }
  applyOrder(overrides, '已把 ' + page.fileName + ' 的页序手选为第 ' + n + ' 页；识别结果（笔迹）不变，只是"这一页对应哪些字"跟着改')
}
function onDragStart(page) {
  if (!needsManualOrder(page)) return
  dragFrom.value = page.fileIndex
}
function onDropPage(target) {
  const from = dragFrom.value
  dragFrom.value = null
  if (from === null || from === target.fileIndex) return
  const source = pages.value.find((p) => p.fileIndex === from)
  if (!source || !needsManualOrder(source) || !needsManualOrder(target)) {
    setMessage('页脚读出页序的页不能拖动改序（页脚是权威的）；只有页脚读不出的页才需要手选', 'error')
    return
  }
  // 交换两页的页序（都还没手选时用"文件顺序"作为初始值）
  const overrides = { ...store.scan.orderOverrides }
  const a = source.pageNumber || source.fileIndex + 1
  const b = target.pageNumber || target.fileIndex + 1
  overrides[source.fileIndex] = b
  overrides[target.fileIndex] = a
  applyOrder(overrides, '已交换两页的页序：' + source.fileName + ' → 第 ' + b + ' 页，' + target.fileName + ' → 第 ' + a + ' 页')
}

// ── 格级视图 ─────────────────────────────────────────────────────────────
function togglePage(page) {
  if (!page.ok) return
  openIndex.value = openIndex.value === page.fileIndex ? null : page.fileIndex
  zoomIndex.value = null
}
const COLS = LAYOUT.cols
const ROWS = LAYOUT.rows
function cellStyle(cell) {
  const col = cell.index % COLS
  const row = Math.floor(cell.index / COLS)
  return {
    left: (col / COLS) * 100 + '%',
    top: (row / ROWS) * 100 + '%',
    width: 100 / COLS + '%',
    height: 100 / ROWS + '%'
  }
}
function cellClass(cell) {
  return [
    'verdict-' + cell.verdict,
    { marked: cell.marked, uncertain: cell.uncertain, zoomed: zoomIndex.value === cell.index }
  ]
}
function cellTitle(cell) {
  return '第 ' + cell.index + ' 格' + (cell.char ? '「' + cell.char + '」' : '') +
    '：' + (cell.verdict === 'empty' ? '没写' : (cell.verdict === 'suspect' ? '可疑（偏淡或太小）' : '有笔迹')) +
    '，墨迹 ' + cell.inkPixels + ' 像素' +
    (cell.marked ? '，被红笔圈掉' : '') +
    (cell.uncertain ? '，红圈压在两格之间、归属待确认' : '')
}
const zoomCell = computed(() => {
  const page = pages.value.find((p) => p.fileIndex === openIndex.value)
  if (!page || zoomIndex.value === null) return null
  const cell = (page.cells || []).find((c) => c.index === zoomIndex.value) || null
  return cell ? { page, cell } : null
})
// 用格子拼图做"精灵图"放大单格：background-size 放大 17×8 倍、再按格号取偏移（不额外占内存）
const zoomStyle = computed(() => {
  if (!zoomCell.value) return {}
  const sheet = images.value[zoomCell.value.page.fileIndex]
  const col = zoomCell.value.cell.index % COLS
  const row = Math.floor(zoomCell.value.cell.index / COLS)
  return {
    backgroundImage: sheet && sheet.sheet ? 'url(' + sheet.sheet + ')' : 'none',
    backgroundSize: COLS * 100 + '% ' + ROWS * 100 + '%',
    backgroundPosition: (col / (COLS - 1)) * 100 + '% ' + (row / (ROWS - 1)) * 100 + '%'
  }
})
const zoomIsMarkedLabel = computed(() => {
  const z = zoomCell.value
  if (!z) return ''
  const c = z.cell
  const parts = []
  parts.push(c.verdict === 'empty' ? '这一格没写' : (c.verdict === 'suspect' ? '有笔迹但可疑（偏淡或写得太小）' : '有笔迹'))
  parts.push('墨迹 ' + c.inkPixels + ' 像素' + (c.inkPixelsOutside ? '（其中 ' + c.inkPixelsOutside + ' 在书写格之外）' : ''))
  if (c.redPixelsRemoved) parts.push('已剔除红圈像素 ' + c.redPixelsRemoved + ' 个')
  if (c.marked) parts.push('被红笔圈掉（这个字会用更正册上的字形覆盖）')
  if (c.uncertain) parts.push('红圈压在两格之间，归属待确认（建议优先核对）')
  const ov = c.overflow || {}
  const out = (ov.top || 0) + (ov.left || 0) + (ov.bottom || 0) + (ov.right || 0)
  if (out) parts.push('笔画越出书写格：上 ' + (ov.top || 0) + ' / 左 ' + (ov.left || 0) + ' / 下 ' + (ov.bottom || 0) + ' / 右 ' + (ov.right || 0) + ' 像素')
  return parts.join('；')
})
</script>

<template>
  <div class="step-body">
    <!-- ① 识别方式 -->
    <!-- 2026-10-11（决策 五-9）：批次在界面上彻底消失 —— 原来这里还有一个「批次管理」入口与两个勾选框
         （"确认这批扫描件属于所选批次"、"我知道这是作废模板"），它们都建立在"批次对用户可见"之上；
         批次退成内部容器后一并去掉（进这一步时程序自动复用最近一个仍有效的批次，一个都没有就顺手建一个） -->
    <div class="panel-row">
      <div class="panel-field">
        <span class="field-label">识别方式</span>
        <span class="panel-hint" data-role="scan-mode">
          按纸面上印的<strong>参考字</strong>认出这一页写了哪些字、该按什么字序对应 —— 不需要你先选批次
        </span>
      </div>
    </div>

    <!-- ② 文件与进度 -->
    <div class="panel-row">
      <div class="panel-field">
        <label class="file-button">
          选择扫描件
          <input type="file" multiple accept="image/*" :disabled="running" @change="onPickFiles" />
        </label>
        <button class="primary" :disabled="running || !files.length" @click="start">开始识别</button>
        <button v-if="running" type="button" @click="stop">中止</button>
        <button class="text" type="button" :disabled="running || !pages.length" @click="clearAll">清空结果</button>
        <span class="panel-hint">
          {{ files.length }} 个文件<span v-if="running">；{{ stage }}（{{ progress.done }} / {{ progress.total }} 页）</span>
        </span>
      </div>
    </div>
    <p v-if="message" class="panel-message" :class="messageType">{{ message }}</p>
    <p v-if="savedStats && savedStats.glyphs" class="panel-hint">
      字形已落盘：{{ savedStats.pages }} 页 / {{ savedStats.glyphs }} 个字 / {{ (savedStats.bytes / 1024 / 1024).toFixed(1) }} MB
      —— 存的是笔迹掩膜（PNG 无损），<strong>刷新或关掉浏览器后不用重扫</strong>，下一步生成字体直接用它
    </p>

    <!-- ③ 批次判定与收批闸门 -->
    <div v-if="pages.length" class="scan-summary">
      <p class="panel-hint">
        这批共 {{ pages.length }} 页：可用 {{ gate.usablePages }} 页<span v-if="gate.skipped.length">、跳过 {{ gate.skipped.length }} 页</span>；
        写出 {{ stats.written }} 格（可疑 {{ stats.suspect }}），被红笔圈 {{ stats.marked }} 个，去重后 {{ stats.uniqueChars }} 个字
      </p>
      <ul v-if="gate.blockers.length" class="scan-problems">
        <li v-for="(text, i) in gate.blockers" :key="'b' + i" class="error">拦下：{{ text }}</li>
      </ul>
      <ul v-if="gate.skipped.length" class="scan-problems">
        <li v-for="item in gate.skipped" :key="'s' + item.fileIndex" class="warn">
          跳过：第 {{ item.fileIndex + 1 }} 个文件{{ item.fileName ? '（' + item.fileName + '）' : '' }} —— {{ item.reason }}
        </li>
      </ul>
      <ul v-if="gate.notes.length" class="scan-problems">
        <li v-for="(text, i) in gate.notes" :key="'n' + i" class="info">{{ text }}</li>
      </ul>
      <p v-if="gate.canProceed" class="panel-message done">
        这一批可以继续：点上方「制作流程」里的第 4 步「更正核对」进去（只有被红笔圈掉的字才需要更正册）
      </p>
      <!-- 决策 五-3：「识别完成」这个节点提醒一次导出项目包备份（不做常驻计数） -->
      <p v-if="gate.canProceed && store.backupReminder" class="step-note backup-reminder" data-role="backup-reminder">
        这一批已经识别完并落盘了，但<strong>项目还没备份</strong>：数据只在本机浏览器里，清缓存或换电脑就没了 ——
        建议现在导出一次项目包（含选字、批次、识别进度与全部字形）。
        <button type="button" class="text" @click="store.openBackup()">立即导出项目包</button>
      </p>
    </div>

    <!-- ④ 页级结果 + ⑤ 格级视图 -->
    <div v-if="pages.length" class="scan-pages">
      <div
        v-for="page in pages"
        :key="page.fileIndex"
        class="scan-page-row"
        :class="{ failed: !page.ok, active: openIndex === page.fileIndex }"
        :data-file-index="page.fileIndex"
        :data-page-number="page.pageNumber === null ? '' : page.pageNumber"
        :data-ok="page.ok ? '1' : '0'"
      >
        <span
          class="scan-page-handle"
          :class="{ draggable: needsManualOrder(page) }"
          :draggable="needsManualOrder(page)"
          title="页脚读不出的页可以拖到另一页上交换页序"
          @dragstart="onDragStart(page)"
          @dragover.prevent
          @drop="onDropPage(page)"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M6 3h4M6 8h4M6 13h4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </span>
        <img
          v-if="images[page.fileIndex] && images[page.fileIndex].thumb"
          class="scan-page-thumb"
          :src="images[page.fileIndex].thumb"
          alt="页面缩略图"
        />
        <span v-else class="scan-page-thumb empty">无缩略图</span>

        <div class="scan-page-info">
          <span class="scan-page-name">{{ page.fileName }}</span>
          <span class="scan-page-meta">
            页号：
            <template v-if="page.kind === 'correction' && page.pageNumber">更正册第 {{ page.pageNumber }} 页（页脚校验码 0）</template>
            <template v-else-if="page.pageNumberSource === 'sequence'">第 {{ page.pageNumber }} 页（按纸面参考字序定位）</template>
            <template v-else-if="page.footerOk">第 {{ page.pageNumber }} 页（页脚读出）</template>
            <template v-else-if="page.pageNumber">第 {{ page.pageNumber }} 页（手选）</template>
            <template v-else>待手选</template>
            <template v-if="page.footerOk && page.kind !== 'correction'">
              · 校验码 {{ page.batchCode }}
              <span :class="page.batchMatch === false ? 'error' : 'ok'">{{ page.batchMatch === false ? '（与所选批次不符）' : '（与所选批次一致）' }}</span>
            </template>
            <template v-if="page.orientation && page.orientation.corrected"> · 已自动转正 {{ page.orientation.turns * 90 }} 度</template>
            <template v-if="page.cornerMaxError !== null"> · 四角误差 {{ page.cornerMaxError }} 像素</template>
          </span>
          <!-- 定字序的结果（2026-10-11 新模型）：这一页是某个全序的连续一段 → 整页 136 个字全部确定 -->
          <span v-if="page.located" class="scan-page-order" data-role="scan-located">
            字序：{{ sequenceLabel(page.located.seqKey) }} · 第 {{ locatedStartPage(page) }} 页起（校验码 {{ page.batchCode }}）
          </span>
          <span v-if="page.ok" class="scan-page-stats">
            写出 {{ page.counts.written }} 格（可疑 {{ page.counts.suspect }}）· 被圈 {{ page.counts.marked }} 个<span
              v-if="page.counts.uncertain"
            > · 归属待确认 {{ page.counts.uncertain }}</span>
          </span>
          <span v-else class="scan-page-stats error">{{ page.reason }}</span>
          <!-- 认不出整页字序的页（自定义选字的纸）：认不准的格 + 还没认出来的格交人过一眼。
               全部确认完之后入口仍留着（想再核对一遍 / 改某个字还能进去），只是文案改成"已全部确认" -->
          <span v-if="page.needReview" class="scan-page-review">
            {{ reviewCount(page) ? '需要确认 ' + reviewCount(page) + ' 格' : '已全部确认' }}
            <button type="button" class="text" data-role="review-chars" @click="openReview(page)">逐格确认</button>
          </span>
          <span v-if="needsManualOrder(page)" class="scan-order">
            手选页序
            <input
              type="number"
              min="1"
              :max="batch ? batch.pageCount : 999"
              :value="page.pageNumber || ''"
              :disabled="running"
              @change="onOrderInput(page, $event.target.value)"
            />
          </span>
        </div>

        <button class="text" type="button" :disabled="!page.ok" @click="togglePage(page)">
          {{ openIndex === page.fileIndex ? '收起格子' : '看格子' }}
        </button>

        <!-- 单页重传（清单 一-8）：只重扫这一页、原地替换它的结果与字形，不必整批重来 -->
        <label
          class="file-button"
          :class="{ disabled: running || rescanning !== null }"
          data-role="rescan-page"
          title="重扫这一页并替换它的识别结果与字形（其它页不动）"
        >
          {{ rescanning === page.fileIndex ? '重传中…' : '重传这一页' }}
          <input
            type="file"
            accept="image/*"
            :disabled="running || rescanning !== null"
            @change="rescanPage(page, $event)"
          />
        </label>

        <!-- 格级视图：136 格拼图 + 判定覆盖层；点单格放大 -->
        <div v-if="openIndex === page.fileIndex" class="scan-cell-grid">
          <div v-if="!images[page.fileIndex] || !images[page.fileIndex].sheet" class="panel-hint">
            格子缩略图不可用（刷新页面后内存缓存会清空）—— 重新点「开始识别」跑一遍就能看到
          </div>
          <div v-else class="scan-grid-wrap">
            <img class="scan-grid-sheet" :src="images[page.fileIndex].sheet" alt="136 格缩略图" />
            <span
              v-for="cell in page.cells"
              :key="cell.index"
              class="scan-cell"
              :class="cellClass(cell)"
              :style="cellStyle(cell)"
              :data-index="cell.index"
              :data-verdict="cell.verdict"
              :data-marked="cell.marked ? '1' : '0'"
              :title="cellTitle(cell)"
              @click="zoomIndex = cell.index"
            ></span>
          </div>
          <p class="panel-hint">
            蓝框 = 有笔迹、橙框 = 可疑（偏淡或太小）、红框 = 被红笔圈掉、黄虚线 = 圈压在两格之间（归属待确认）；点任意一格看放大与统计
          </p>

          <div v-if="zoomCell" class="scan-cell-zoom">
            <div class="scan-cell-zoom-img" :style="zoomStyle"></div>
            <div class="scan-cell-zoom-info">
              <strong>第 {{ zoomCell.cell.index }} 格{{ zoomCell.cell.char ? '「' + zoomCell.cell.char + '」' : '' }}</strong>
              <p class="panel-hint">{{ zoomIsMarkedLabel }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <p v-if="!pages.length && !running" class="panel-hint">
      选好扫描件后点「开始识别」：程序会逐页做「预处理 → 切格（方向不对会自动转正）→ 认纸面上的参考字
      （认出这一页写了哪些字、该按什么字序对应）→ 红圈识别 → 字形提取」，
      并把每页的页号来源、写出格数与可疑格报给你；认不出整页字序的页会开一个「逐格确认」让你过一眼，
      红笔圈掉的字留到下一步核对。
    </p>

    <!-- 逐格复核（2026-10-11 新模型）：认不出整页字序的页在这里逐格确认 / 手输 -->
    <CharReview v-if="reviewPage" :page="reviewPage" :open="reviewOpen" @close="closeReview" />
  </div>
</template>
