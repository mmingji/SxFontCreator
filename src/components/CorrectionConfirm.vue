<script setup>
// 第 2 步：更正核对（阶段一「界面串联」B3b；规则见《决策记录》一-7、二-13）
// 职责：把「第 k 个被圈字 ↔ 更正册第 m 格」并排摆出来，允许**改派 / 删除 / 补录**，配对结果直接交给字体构建
//   （2026-10-13 起不需要点"确认"：程序给的配对默认生效）。
// 为什么必须有这一步：红圈识别与顺序配对都只是初值 —— 配对错一个字，整套字体就有一个字对错人。
//   界面上能改，是配对的最后一道闸（决策 一-7）。
// 数据来源：识别页记录在 store.scan.pages；配对初值由 lib/scanFlow.pairCorrections 算（纯逻辑、有测试）；
//   字形缩略图从 lib/scanCache 的"格子拼图"里按格裁（与第 2 步同一套精灵图做法，不额外占内存）；
//   **内存里没有时从落盘的字形分片重建**（lib/pageSheet.js）—— 刷新、关浏览器、分两次识别之后，
//   这一页仍然要能看到"这一格写的到底是什么"（2026-10-13 用户口径）。
import { computed, onMounted, ref, watch } from 'vue'
import { useProjectStore } from '../store/project.js'
import { SCAN_DEFAULTS, buildFinalGlyphPlan, pairCorrections } from '../lib/scanFlow.js'
import { pickCorrectionBookPages } from '../lib/scanMeta.js'
import { getPageCache } from '../lib/scanCache.js'
import { buildPageSheetFromStore } from '../lib/pageSheet.js'
import { continuousIndex } from '../lib/correctionMapper.js'
import { LAYOUT } from '../lib/layout.js'

const store = useProjectStore()
const images = ref({}) // fileIndex → { sheet }
const message = ref('')
const messageType = ref('info')
const initialStats = ref(null) // 配对初值的统计（用于提示"改动过没有"）
// 并排核对表**默认收起**（2026-10-13 用户口径）：它一屏放不下，而"有多少个字要更正、更正册覆盖了几个"
// 这两句在描述行里已经说清了 —— 想逐行核对再点开
const tableOpen = ref(false)
// 核对表**分页**（2026-10-14 用户口径："一页显示 20 条"）：全量下被圈字可能有几百条，
//   一屏铺出来既看不到头也找不到刚才改到哪一行；分页之后每页 20 条，改派 / 删除照旧逐行做。
const PAGE_SIZE = 20
const tablePage = ref(1)
// 按需重建缩略图的进度与失败原因（重建要解码这一页的掩膜，几十到几百毫秒）
const rebuilding = ref({})
const sheetError = ref({})

const pages = computed(() => store.scan.pages)
// 参与核对的更正册：**只收被采用的那一份**（2026-10-21 修）。
// 为什么必须这样：混批时同一页号可能有多份更正册（内容不同），配对初值只按文件序取第一份；
//   correctionCellMap 若把其余几份也收进来，后写会覆盖先写 —— 核对表显示的就是另一册的字形
//   （真机：主区是自定义档、核对表右列却是名句页的字）。两处必须用同一个"选册"函数。
const correctionPages = computed(() => pickCorrectionBookPages(pages.value).pages)
const hasCorrectionBook = computed(() => correctionPages.value.length > 0)

// 更正册的格（连续格号 → 页 / 格 / 判定），供候选下拉与"这一格有没有笔迹"判断
const correctionCellMap = computed(() => {
  const map = new Map()
  const pageIndex = new Map()
  for (const p of correctionPages.value) pageIndex.set(p.pageNumber, p.fileIndex)
  for (const p of correctionPages.value) {
    for (const c of p.cells || []) {
      // 连续格号（1 起）**调用权威实现**，不在这里手写一遍公式 —— 更正册的格号跨页连续
      // （第 2 页从 137 起），这个口径只有 correctionMapper.continuousIndex 一处（决策 一-7 的第 k 格）
      const contiguous = continuousIndex(p.pageNumber, c.index)
      map.set(contiguous, { contiguous, pageNumber: p.pageNumber, cellIndex: c.index, fileIndex: p.fileIndex, verdict: c.verdict })
    }
  }
  return map
})
const inkedCells = computed(() => [...correctionCellMap.value.values()].filter((c) => c.verdict !== 'empty'))

/**
 * 被圈字所在的主区页的 fileIndex（缩略图按它取）。
 * 优先用**被圈清单里自带的那一个**（scanMeta.buildCorrectionInputs 写入）—— 以前这里按"页号 → fileIndex"
 * 反查，多页同号（右侧方块读不出又没有序列定位）时会串到别的页上，表现出来就是"主区缩略图是空的"。
 * 清单里没有这个字段时（旧版本落盘的数据）才退回按页号反查一次。
 */
function mainPageFileIndex(item) {
  if (item.fileIndex !== undefined && item.fileIndex !== null) return item.fileIndex
  const page = pages.value.find((p) => p.ok && p.kind !== 'correction' && p.pageNumber === item.pageNumber)
  return page ? page.fileIndex : null
}

// 生效清单：被圈字逐行 + 初值配对 + 用户调整（overrides）
const rows = computed(() => {
  const circled = store.correction.circled || []
  const initial = store.correction.pairs || []
  const overrides = store.correction.overrides || {}
  const usedBy = new Map()
  const list = circled.map((item, k) => {
    const base = initial.find((p) => p.order === k) || null
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, String(k))
    const assigned = hasOverride ? overrides[String(k)] : (base ? base.correctContinuousIndex : null)
    const cell = assigned !== null && assigned !== undefined ? correctionCellMap.value.get(assigned) : null
    if (assigned !== null && assigned !== undefined) usedBy.set(assigned, k)
    return {
      order: k,
      mainChar: item.char,
      mainCellIndex: item.mainCellIndex,
      mainPageNumber: item.pageNumber,
      // 主区那一格的**文件序号**：被圈清单里本来就带着它（scanMeta.buildCorrectionInputs 写的），
      // 取不到时退回按页号反查（见 mainPageFileIndex 的注释）
      mainFileIndex: mainPageFileIndex(item),
      assigned: assigned === undefined ? null : assigned,
      source: hasOverride ? (assigned === null ? 'removed' : 'manual') : (base ? base.source : 'blank'),
      cell
    }
  })
  return { list, usedBy }
})

const effectivePairs = computed(() => rows.value.list
  .filter((r) => r.assigned !== null && r.cell && r.cell.verdict !== 'empty')
  .map((r) => ({
    order: r.order,
    mainCellIndex: r.mainCellIndex,
    mainPageNumber: r.mainPageNumber,
    mainChar: r.mainChar,
    correctContinuousIndex: r.assigned,
    correctPageNumber: r.cell.pageNumber,
    correctCellIndex: r.cell.cellIndex,
    source: r.source === 'replacement' ? 'replacement' : (r.source === 'manual' ? 'manual' : 'main')
  })))

// 字体构建的输入计划：主区字形 + 更正覆盖（决策 一-7 的"保留主区原字形"在这里体现）
// （2026-10-13：这一块界面不再显示"主区 X 个字形"——那是识别结果，在上面那块里说；
//   这里只说更正册覆盖了几个字。plan 仍由第 3 步生成字体时算，不必在这里再算一遍。）

const keptInMain = computed(() => rows.value.list.filter((r) => r.assigned === null || !r.cell || r.cell.verdict === 'empty'))
// 与第 3 步同源的"字形计划"：**按不同的字**统计更正册覆盖了几个字。
// 为什么要单独算：核对表里的行数（`effectivePairs.length`）数的是**处**——同一个字在两处被圈就是两行，
//   而字体里一个字只有一个字形，第 3 步与产物统计用的都是"不同的字"。两个数摆在一起说清，
//   用户才不会觉得两处对不上（真机上问过"覆盖字形数目前不一致"）。
const plan = computed(() => buildFinalGlyphPlan(pages.value, {
  pairs: effectivePairs.value,
  circled: store.correction.circled || []
}))
const coveredChars = computed(() => plan.value.replaced)
// 有没有手动调整过（改派 / 删除）：决定「恢复默认」能不能点
const hasOverrides = computed(() => Object.keys(store.correction.overrides || {}).length > 0)
const extraCells = computed(() => {
  const used = new Set(rows.value.list.map((r) => r.assigned).filter((v) => v !== null))
  return inkedCells.value.filter((c) => !used.has(c.contiguous) && c.contiguous > rows.value.list.length)
})

function setMessage(text, type) {
  message.value = text
  messageType.value = type || 'info'
}

// ── 核对表分页（2026-10-14 用户口径：一页 20 条）──────────────────────────
// 页码越界时（改了配对之后行数变少 / 换了被圈清单）自动退到最后一页，不留一个空白页
const tablePageCount = computed(() => Math.max(1, Math.ceil(rows.value.list.length / PAGE_SIZE)))
const pagedRows = computed(() => {
  const from = (tablePage.value - 1) * PAGE_SIZE
  return rows.value.list.slice(from, from + PAGE_SIZE)
})
watch(tablePageCount, (n) => { if (tablePage.value > n) tablePage.value = n })
// 每次展开都从第 1 页看起（收起前的页码留着只会让人以为表头那几行丢了）
watch(tableOpen, (open) => { if (open) tablePage.value = 1 })

/**
 * 更正册页的**指纹**（2026-10-15 修一个真缺陷）：作废 / 重传 / 补传更正册之后，配对必须跟着重算。
 * 原来 `ensurePairing` 的签名只写"有没有更正册页 + 被圈字清单"，于是"作废 → 重传"之后签名又回到原样、
 * 函数直接早退，核对表还挂着"作废那一下算出来的那套（全都对不上）"—— 真机反馈正是"对应关系没有更新"。
 * 指纹里放：每一张更正册页的序号 / 是否可用 / 页号 / **有笔迹的格号**（格内容变了也算换过册子）。
 */
function bookFingerprint() {
  return pages.value
    .filter((p) => p.kind === 'correction')
    .map((p) => p.fileIndex + ':' + (p.ok ? '1' : '0') + ':' + (p.pageNumber || '-') + ':' +
      (p.cells || []).filter((c) => c.verdict !== 'empty').map((c) => c.index).join('.'))
    .join('|')
}

// 首次进入（或被圈清单 / 更正册变了）时算一次配对初值；**用户调整过就不覆盖**（除非更正册换过）
function ensurePairing(force) {
  const signature = (store.correction.circled || []).map((c) => c.pageNumber + ':' + c.mainCellIndex).join(',')
  const book = bookFingerprint()
  const current = book + '#' + signature
  const bookChanged = !!initialStats.value && initialStats.value.book !== book
  if (!force && initialStats.value && initialStats.value.signature === current && !bookChanged) return
  // 更正册换过（作废 / 重传 / 补传）时**必须重算**，连手动调整一起作废 —— 那些调整指向的"第 k 格"
  //   可能已经不是原来那一格了（与"被圈字变了就作废配对"同一口径，见八-14 ④）；重算时会清掉 overrides
  if (!force && !bookChanged && Object.keys(store.correction.overrides || {}).length) return
  const mapped = pairCorrections(pages.value)
  store.setCorrectionResult({
    pairs: mapped.pairs,
    unmatched: mapped.unmatched,
    discarded: mapped.discarded,
    extra: mapped.extra,
    messages: mapped.messages,
    stats: mapped.stats,
    circled: mapped.circled
  })
  initialStats.value = { signature: current, book, stats: mapped.stats }
  if (bookChanged && !force) {
    setMessage('更正册变了（作废 / 重传 / 补传）：配对已按新的识别结果重算' +
      (mapped.pairs.length ? '，覆盖 ' + mapped.pairs.length + ' 处' : '') + '；之前的手动调整已作废', 'info')
  }
}

// 缩略图：从内存缓存（lib/scanCache 的"格子拼图"）里取。识别完才有的东西，所以每次识别结果变化都要重取
function restoreImages() {
  const restored = {}
  for (const page of pages.value) {
    const cache = getPageCache(page.fileIndex)
    if (cache && cache.sheet) restored[page.fileIndex] = { sheet: cache.sheet }
  }
  images.value = restored
  // 上一轮重建失败的原因跟着作废（重新识别之后可能就有数据了）
  sheetError.value = {}
}

// ── 缩略图的落盘兜底（2026-10-13）──────────────────────────────────────────
// 背景：格子拼图只放内存（清单 四-27 的口径），刷新页面 / 关掉浏览器 / 分两次识别之后就没有了；
//   而**字形掩膜是落盘**的，所以这里按需从分片重画一张 —— 用户看到的是缩略图，不是"不可用"。
// 需要缩略图的是两类页：被圈字所在的主区页、以及配对到的更正册页。
const neededFileIndexes = computed(() => {
  // 更正册页排在最前（2026-10-13）：要看的正是"更正册上写的是什么"，而重建是逐页解码掩膜
  // （几十到几百毫秒一页）—— 主区页多的时候，先出更正册那一列才符合用户看表的顺序
  const correctionBook = new Set()
  const mainSheets = new Set()
  for (const r of rows.value.list) {
    if (r.cell && r.cell.fileIndex !== undefined) correctionBook.add(r.cell.fileIndex)
    if (r.mainFileIndex !== null && r.mainFileIndex !== undefined) mainSheets.add(r.mainFileIndex)
  }
  return [...correctionBook, ...mainSheets]
})

// 缩略图重建失败的页（原因在 sheetError 里）。
// 为什么要在区块里说一遍：那原因原来只写在缩略图的 title 上 —— 触屏看不到、鼠标也要悬停，
//   用户看到的就是"一块灰"，与"这一格本来就没有笔迹"长得一样（2026-10-13 复现确认的第二种缺陷）。
const thumbErrorFiles = computed(() => Object.keys(sheetError.value || {}).map((k) => Number(k)))
// 正在重建的页（2026-10-15）：斜纹底那几个缩略图是"还没画出来"，不是"这一格没有笔迹" ——
//   原来只有"重建不了"时才有一句提示，正在重建时界面上什么都不说，用户看到的就是"偶现没有字形"。
const rebuildingFiles = computed(() => Object.keys(rebuilding.value || {}).map((k) => Number(k)))
// 分片**根本不存在**时「重新重建」没有意义（点多少次都一样）—— 那种情况只给「重传 / 重新识别」这条出路；
// 只有「偶发读失败」（并发、事务被中止）才值得给重试按钮（2026-10-15 用户口径：点了没用的按钮只会让人困惑）
const thumbRetryable = computed(() => thumbErrorFiles.value.some((i) => !/没有落盘|找不到/.test(String(sheetError.value[i] || ''))))
/** 重建失败之后的重试：清掉失败记录再补一遍（分片偶尔读不到、或上一次撞上并发时会需要） */
function retrySheets() {
  sheetError.value = {}
  ensureMissingSheets()
}
function thumbFailReason(fileIndex) {
  const page = pages.value.find((p) => p.fileIndex === fileIndex)
  const name = page && page.fileName ? page.fileName : ('第 ' + (fileIndex + 1) + ' 个文件')
  return name + '：' + sheetError.value[fileIndex]
}

/** 缺哪一页就补哪一页；已经在重建的不重复发起（解码一页的掩膜要几十到几百毫秒） */
async function ensureMissingSheets() {
  for (const fileIndex of neededFileIndexes.value) {
    const has = images.value[fileIndex] && images.value[fileIndex].sheet
    if (has || rebuilding.value[fileIndex]) continue
    rebuilding.value = { ...rebuilding.value, [fileIndex]: true }
    try {
      const page = pages.value.find((p) => p.fileIndex === fileIndex)
      const res = await buildPageSheetFromStore({
        fileIndex,
        cellThumbSize: SCAN_DEFAULTS.cellThumbSize,
        // 红框（被红笔圈掉）不进掩膜，得从页记录取；否则重建的图会丢掉这个记号
        markedCells: ((page && page.cells) || []).filter((c) => c.marked).map((c) => c.index)
      })
      if (res.ok) images.value = { ...images.value, [fileIndex]: { sheet: res.sheet } }
      else sheetError.value = { ...sheetError.value, [fileIndex]: res.reason }
    } finally {
      const next = { ...rebuilding.value }
      delete next[fileIndex]
      rebuilding.value = next
    }
  }
}

/** 缩略图位置的那句提示（挂在 title 上）：重建中 / 重建不了 / 正常 */
function thumbNote(fileIndex) {
  if (rebuilding.value[fileIndex]) return '这一页的缩略图正在从落盘的字形重建…'
  if (sheetError.value[fileIndex]) return '缩略图没能重建（' + sheetError.value[fileIndex] + '）'
  if (!(images.value[fileIndex] && images.value[fileIndex].sheet)) return '这一页没有可用的缩略图'
  return ''
}

onMounted(() => {
  restoreImages()
  if (store.scan.pages.length) ensurePairing(false)
  else setMessage('还没有识别结果：先在上面选好文件夹并完成识别', 'error')
  ensureMissingSheets()
})

// 2026-10-11：更正核对并入「识别」这一步之后，本组件挂在识别页里、**不会再被重新挂载** ——
// 识别结果一变（重新识别 / 重传某一页）必须自己跟上：重取缩略图 + 重算配对初值。
// 签名只看"哪些页可用、每页被圈了哪些格、哪些页被判成重复页"，这几项变了配对才需要重算。
// **2026-10-14 补 duplicateOf**：重复页是"不算可用"的那一类（被判重的页不参与配对候选），
//   而这个字段是识别收尾时补写进 store 的 —— 它一变，配对就必须重算（否则配对还按 29 条被圈字算）。
// **2026-10-15 补**：签名里再加"更正册页有笔迹的格" —— 重传一张"内容不同但仍可用"的更正册件时，
//   只有 ok 位看不出变化，核对表会停在旧配对上（真机反馈："作废更正册再重传之后对应关系没有更新"）。
const scanSignature = computed(() => pages.value
  .map((p) => p.fileIndex + ':' + (p.ok ? '1' : '0') + ':' +
    (p.duplicateOf === undefined || p.duplicateOf === null ? '' : p.duplicateOf) + ':' +
    (p.markedCells || []).join('.') + ':' +
    (p.kind === 'correction'
      ? (p.cells || []).filter((c) => c.verdict !== 'empty').map((c) => c.index).join('.')
      : ''))
  .join('|'))
watch(scanSignature, () => {
  restoreImages()
  if (pages.value.length) ensurePairing(false)
  // 重新识别 / 重传某一页之后，缺缩略图的页要重新发起重建（内存缓存已经换了）
  ensureMissingSheets()
})

function applyOverride(order, value) {
  const overrides = { ...(store.correction.overrides || {}) }
  if (value === null) overrides[String(order)] = null
  else overrides[String(order)] = value
  const next = rows.value.list.map((r) => {
    if (r.order !== order) return r
    const assigned = value
    const cell = assigned === null ? null : correctionCellMap.value.get(assigned)
    return { ...r, assigned, cell, source: value === null ? 'removed' : 'manual' }
  })
  const pairs = next
    .filter((r) => r.assigned !== null && r.cell && r.cell.verdict !== 'empty')
    .map((r) => ({
      order: r.order,
      mainCellIndex: r.mainCellIndex,
      mainPageNumber: r.mainPageNumber,
      mainChar: r.mainChar,
      correctContinuousIndex: r.assigned,
      correctPageNumber: r.cell.pageNumber,
      correctCellIndex: r.cell.cellIndex,
      source: r.source === 'manual' ? 'manual' : (r.source === 'replacement' ? 'replacement' : 'main')
    }))
  store.setCorrectionOverrides({ overrides, pairs, unmatched: [] })
  setMessage(value === null
    ? '已删除这一对：「' + (next.find((r) => r.order === order) || {}).mainChar + '」将保留主区原字形'
    : '已把「' + (next.find((r) => r.order === order) || {}).mainChar + '」改派到更正册第 ' + value + ' 格', 'info')
}

/**
 * 恢复默认（2026-10-13 用户口径）：**清掉手动调整**，回到程序按识别结果给出的那一套配对。
 * 为什么要有它：配对是自动的、默认就生效，用户改派 / 删除之后需要一个"退回去"的入口 ——
 *   原来那个「按识别结果重算配对」按钮其实做不到这件事（手动调整优先于重算结果，点了看不出变化）。
 * 实现走 ensurePairing(true)：它会重算初值并清空 overrides（store.setCorrectionResult 里做的）。
 */
function restoreDefaults() {
  const n = Object.keys(store.correction.overrides || {}).length
  if (!n) {
    setMessage('没有手动调整过，当前就是程序按识别结果给出的配对', 'info')
    return
  }
  ensurePairing(true)
  setMessage('已恢复默认：' + n + ' 处手动调整（改派 / 删除）已清除，回到程序按识别结果给出的配对', 'done')
}

// 精灵图：从"格子拼图"里裁出某一格（与第 2 步单格放大同一套做法）
function cellThumbStyle(fileIndex, cellIndex) {
  const sheet = images.value[fileIndex]
  if (!sheet || !sheet.sheet) return {}
  const col = cellIndex % LAYOUT.cols
  const row = Math.floor(cellIndex / LAYOUT.cols)
  return {
    backgroundImage: 'url(' + sheet.sheet + ')',
    backgroundSize: LAYOUT.cols * 100 + '% ' + LAYOUT.rows * 100 + '%',
    backgroundPosition: (col / (LAYOUT.cols - 1)) * 100 + '% ' + (row / (LAYOUT.rows - 1)) * 100 + '%'
  }
}
</script>

<template>
  <div class="step-body">
    <!-- data-role：更正核对并入识别页之后，同一页里有两套消息与按钮（识别的、更正的），
         自动化测试与样式钩子都要能把它们分开 -->
    <p v-if="message" class="panel-message" :class="messageType" data-role="correction-message">{{ message }}</p>

    <div v-if="!pages.length" class="panel-hint">
      这一步需要先在上面完成识别（主区写了字的页，以及用红笔圈掉错字的那几页）。
    </div>

    <template v-else>
      <!-- 这一块**只讲更正册**（2026-10-13 用户口径）：与上面「扫描识别的状态与结果」重复的
           （主区被圈几个字、主区一共几个字形）都去掉了 —— 那些在上面的块里已经说过一遍。
           "更正册几页、写出几格"也属识别结果，同样在上面那块里说；这里只讲配对结论。
           描述行 2026-10-13 再改：**跟在「更正对应」这四个字后面**（与第 2 步标题行的写法一致） -->
      <p class="scan-status-title corr-title">
        更正对应
        <span class="panel-hint" data-role="correction-summary">
          更正册覆盖 <strong>{{ effectivePairs.length }}</strong> 处（涉及 <strong>{{ coveredChars }}</strong> 个不同的字）<template v-if="keptInMain.length">；其余 <strong>{{ keptInMain.length }}</strong> 个被圈的字保留主区原字形</template><template v-else>，被圈的字全部配上了更正册的格</template><span v-if="!hasCorrectionBook">（还没上传更正册）</span>。
          改派 / 删除即时生效，生成字体直接用它 —— 没改过就是程序按识别结果配的那一套。
        </span>
      </p>

      <p v-if="!hasCorrectionBook && (store.correction.circled || []).length" class="step-note">
        主区有被圈掉的字，但没上传更正册：这些字会保留主区原字形（写错的那个）。
        要更正的话，把第 1 步压缩包里的更正册（空白 5 页那张）写好、和主区放进同一个文件夹，再识别一次。
      </p>

      <ul v-if="(store.correction.messages || []).length" class="scan-problems">
        <li v-for="(m, i) in store.correction.messages" :key="i" :class="m.level === 'warn' ? 'warn' : 'info'">{{ m.text }}</li>
      </ul>

      <!-- 并排核对表：**默认收起**（2026-10-13 用户口径），点这个按钮才铺开逐行看 / 逐行改。
           展开时这一行右侧给「恢复默认」：**清掉手动调整**、回到程序按识别结果给出的配对
           （2026-10-13 用户口径：原来那个「按识别结果重算配对」实际做不到这件事，已去掉） -->
      <div v-if="rows.list.length" class="corr-toggle">
        <button class="text accent" type="button" data-role="correction-table-toggle" @click="tableOpen = !tableOpen">
          {{ tableOpen ? '收起核对表' : '看核对表（' + rows.list.length + ' 对）' }}
        </button>
        <span v-if="!tableOpen" class="panel-hint">每一对是「主区写错的字 ↔ 更正册重写的格」；改派 / 删除都在表里</span>
        <button
          v-if="tableOpen"
          class="text corr-restore"
          type="button"
          data-role="correction-restore"
          :disabled="!hasOverrides"
          :title="hasOverrides ? '清掉改派 / 删除，回到程序按识别结果给出的配对' : '还没有手动调整过'"
          @click="restoreDefaults"
        >恢复默认</button>
      </div>
      <p v-else class="panel-hint">主区没有检测到被红笔圈掉的字：这份更正册暂时没有可对应的对象。</p>

      <!-- 缩略图重建失败：把原因写到页面上（原来只在缩略图的 title 里，触屏根本看不到），并给出出路 ——
           字形分片缺失时那一页的图补不出来，只能重传这一页或重新识别 -->
      <p v-if="tableOpen && rebuildingFiles.length" class="panel-hint" data-role="thumb-rebuilding">
        正在从落盘的字形里重建 {{ rebuildingFiles.length }} 页的格子图（斜纹底的那些就是还没画出来的）……
      </p>
      <p v-if="tableOpen && thumbErrorFiles.length" class="step-note" data-role="thumb-error-note">
        有 {{ thumbErrorFiles.length }} 页的格子图没能从落盘的字形里重建（{{ thumbErrorFiles.map((i) => thumbFailReason(i)).join('；') }}）——
        用第 2 步结果卡片上的「重传」把这一页补一次，或重新识别一遍；这几页的字形可能没有落盘。
        <button v-if="thumbRetryable" class="text" type="button" data-role="thumb-retry" @click="retrySheets">重新重建这几页</button>
      </p>

      <div v-if="rows.list.length && tableOpen" class="corr-table" data-role="correction-table">
        <div class="corr-head">
          <span>#</span><span>主区（写错的字）</span><span>更正册（重写的字）</span><span>操作</span>
        </div>
        <div
          v-for="row in pagedRows"
          :key="row.order"
          class="corr-row"
          :class="{ replaced: row.assigned !== null && row.cell, removed: row.assigned === null }"
          :data-order="row.order"
          :data-char="row.mainChar || ''"
          :data-assigned="row.assigned === null ? '' : row.assigned"
        >
          <span class="corr-index">{{ row.order + 1 }}</span>
          <span class="corr-side">
            <span
              class="corr-thumb"
              :class="{ pending: !!thumbNote(row.mainFileIndex) }"
              :style="cellThumbStyle(row.mainFileIndex, row.mainCellIndex)"
              :title="thumbNote(row.mainFileIndex)"
            ></span>
            <span class="corr-text">
              「{{ row.mainChar }}」<br />
              第 {{ row.mainPageNumber }} 页 · 第 {{ row.mainCellIndex + 1 }} 格
            </span>
          </span>
          <span class="corr-side">
            <template v-if="row.assigned !== null && row.cell && row.cell.verdict !== 'empty'">
              <span
                class="corr-thumb"
                :class="{ pending: !!thumbNote(row.cell.fileIndex) }"
                :style="cellThumbStyle(row.cell.fileIndex, row.cell.cellIndex)"
                :title="thumbNote(row.cell.fileIndex)"
              ></span>
              <span class="corr-text">
                第 {{ row.assigned }} 格（第 {{ row.cell.pageNumber }} 页 · 第 {{ row.cell.cellIndex + 1 }} 格）<br />
                <span class="corr-tag">{{ row.source === 'replacement' ? '补写' : (row.source === 'manual' ? '手动指定' : '顺序配对') }}</span>
              </span>
            </template>
            <template v-else>
              <span class="corr-thumb empty"></span>
              <span class="corr-text">
                没有对应格<br />
                <span class="corr-tag muted">保留主区原字形</span>
              </span>
            </template>
          </span>
          <span class="corr-actions">
            <select
              :value="row.assigned === null ? '' : String(row.assigned)"
              @change="applyOverride(row.order, $event.target.value === '' ? null : Number($event.target.value))"
            >
              <option value="">（不更正 · 保留主区原字形）</option>
              <option
                v-for="cell in inkedCells"
                :key="cell.contiguous"
                :value="String(cell.contiguous)"
                :disabled="rows.usedBy.has(cell.contiguous) && rows.usedBy.get(cell.contiguous) !== row.order"
              >
                更正册第 {{ cell.contiguous }} 格{{ rows.usedBy.has(cell.contiguous) && rows.usedBy.get(cell.contiguous) !== row.order ? '（已用于第 ' + (rows.usedBy.get(cell.contiguous) + 1) + ' 个字）' : '' }}
              </option>
            </select>
            <button v-if="row.assigned !== null" class="text" type="button" @click="applyOverride(row.order, null)">删除这一对</button>
          </span>
        </div>
      </div>

      <!-- 分页（2026-10-14 用户口径：一页 20 条）—— 被圈字多时逐行核对才不会迷路；
           上一页 / 下一页用默认文本色（这两个不是"推荐动作"，只是翻页） -->
      <div v-if="tableOpen && rows.list.length > PAGE_SIZE" class="table-pager" data-role="correction-pager">
        <button class="text" type="button" :disabled="tablePage <= 1" @click="tablePage--">上一页</button>
        <button class="text" type="button" :disabled="tablePage >= tablePageCount" @click="tablePage++">下一页</button>
        <span class="panel-hint">
          第 {{ tablePage }} / {{ tablePageCount }} 页（共 {{ rows.list.length }} 对，每页 {{ PAGE_SIZE }} 对）
        </span>
      </div>

      <p v-if="tableOpen && extraCells.length" class="panel-hint">
        更正册上还有 {{ extraCells.length }} 个多写的格没配上（{{ extraCells.map((c) => '第 ' + c.contiguous + ' 格').join('、') }}）——
        可以把上面的某一对改派到这些格，或确认是写多了。
      </p>
      <!-- 原来这里还有「确认这份更正对应」与「按识别结果重算配对」两个按钮（2026-10-13 用户拍板去掉）：
           配对默认就生效，不需要点一下确认；要退回程序给的配对，用上面核对表那一行右侧的「恢复默认」 -->
    </template>
  </div>
</template>
