<script setup>
// 第 2 步：上传识别（阶段一「界面串联」B2；2026-10-11 起改用"从纸上认参考字定字序"的新模型）
// 职责：① 取这一轮要用的批次（**用户不再选**：进这一步时自动复用最近一个仍有效的，或顺手建一个）
//   ② 指定一个文件夹（系统文件夹对话框）→ 挑图片与字序文件 → 串行识别，边跑边显示、可中止
//   ③ 批次判定与**收批闸门**（单页失败跳过、批次级问题整批拦下）
//   ④ 结果**一页一张卡片**（状态 / 一行统计 / 看格子 / 重传 / 逐格确认；完整信息在 hover 里）
//   ⑤ 格级视图与单格放大（收进「看格子」弹窗，点开才渲染）
//   ⑥ 页脚读不出时手选页序（决策 二-7）与**逐格复核**（CharReview.vue）
// 数据来源：识别编排在 Worker 里（决策 六-15：预处理 / 切格 / 认参考字 / 提取四段重计算都搬过去了，
//   主线程只收发消息，界面在几十页连跑时保持可滚动），客户端封装在 lib/scanWorkerClient.js；
//   产物缓存（缩略图 / 掩膜）在 lib/scanCache.js，轻量页记录落盘在 store.scan —— 口径见 二-15 / 五-9。
import { computed, onMounted, ref, watch } from 'vue'
import { useProjectStore } from '../store/project.js'
import { SCAN_DEFAULTS, applyPageOrder, evaluateRescanAccept, evaluateScanGate, resolveBatchChars, summarizeBatch } from '../lib/scanFlow.js'
import { cancelTask, recognizeBatchInWorker, recognizePageInWorker } from '../lib/scanWorkerClient.js'
import { clearPageCache, getPageCache, putPageCache } from '../lib/scanCache.js'
import { clearGlyphs, glyphStoreStats, savePageGlyphs } from '../lib/glyphStore.js'
import { describeOrderFile } from '../lib/orderFile.js'
import { IMAGE_EXTENSIONS, collectDirectoryFiles, findOrderFile, naturalCompare, pickScanInputs } from '../lib/scanInput.js'
import { buildPageSheetFromStore } from '../lib/pageSheet.js'
import { LAYOUT } from '../lib/layout.js'
import CharReview from './CharReview.vue'
import CorrectionConfirm from './CorrectionConfirm.vue'

// ── 参考字候选库：现在归 Worker 所有（决策 六-15）────────────────────────────
// 这块原来是主线程建的（8274 字逐个渲染 + 取特征，约 2.3 秒、常驻约 32.6MB）。移进 Worker 之后：
//   · 主线程不必再持有那份数据（少 32.6MB），也不必再为"建库那几秒"卡住界面；
//   · 建库改由 Worker 内部完成，界面只在第一次识别时看到一句"正在准备参考字识别…"；
//   · 库的装载与生命周期都在 lib/scanWorkerClient.js 里（含"字体字节只传一次"）。
// **"这是不是自家模板印的纸"那条判据不变**：参考字覆盖率不达标仍然整页失败（决策 五-9 ④）。

const store = useProjectStore()

// ── 输入：**一个文件夹**（决策 二-18 / 六-13）───────────────────────────────
// 为什么是文件夹：纸与字序文件本来就是一起给用户的（第 1 步的压缩包），
//   让程序一次读全比"手动挑图片、再靠认字反推字序"少一个出错环节 —— 目录里那份 字序.json
//   直接把"这批纸按什么顺序排字"说死（决策 一-18），认参考字降为没有文件时的退路。
//
// 主路是 `showDirectoryPicker`（决策 六-13 改判）：它弹的是**系统原生文件夹对话框**（有路径面包屑、
//   能新建文件夹），正是用户要的"像装软件选路径那样"。代价是 Firefox / Safari 完全不支持它 ——
//   所以留了一条退路：不支持时自动改用 `<input webkitdirectory>`（普通文件选择器外壳，但能用），
//   并在界面上明说一句"换 Chrome / Edge 能看到系统文件夹对话框"（不静默降级）。
// 两条路最后都汇成同一份文件清单，再交给 lib/scanInput.js 的 pickScanInputs 挑图片与字序文件。
const scanInput = ref(null) // pickScanInputs 的产物：{ images, orderCandidates, ignoredSubdir, ignoredOther, folderName, total }
const orderFile = ref(null) // 读到的字序文件：{ ok, fileName, file, reason }
const readingDir = ref(false)
const folderName = ref('') // 这一轮选的文件夹名（句柄那条路直接有；webkitdirectory 从相对路径里取）
// 这台浏览器有没有系统文件夹对话框（Firefox / Safari 没有）—— 界面据此决定按钮形态与那句提示
const canPickDirectory = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
// 这一轮用的图片（File 数组，按文件名自然序）
const files = computed(() => (scanInput.value ? scanInput.value.images : []))
// 2026-10-13（用户口径）：手动去掉的图片单独存一份 —— 回执里要说清"N 张里有几张是自己去掉的"，
// 否则用户看到张数变少会以为程序漏读了；这些文件在「看文件清单」里可以一键放回。
const removedList = ref([])
// 选完文件夹之后的**常驻回执**（2026-10-13 用户要求"选完要有明确回显"）：
// 对话框里那一片空白（Windows 的文件夹对话框只列子文件夹）容易让人以为没选上，
// 所以选完必须明确写出"选的是哪个文件夹、里面有多少张可用图片"。
// 写成 computed 而不是在各处赋值：手动去掉几张之后这一行要**自己**跟着变（原来的写法会显示旧张数）。
//
// 2026-10-13 再改（用户口径：**没有轮次概念**）：回执分两种来源，说的都是"这批结果来自哪里"——
//   · 刚选过文件夹 → 内存里那份（可以逐张去掉 / 放回）；
//   · 刷新 / 关浏览器再回来 → 内存里的 File 对象已经没了，用识别时落盘的那份（store.scan.source，只读回显）。
//     原来这里在刷新后会显示成"还没有选文件夹"，与下面同一块里的识别汇总、字形落盘信息自相矛盾。
const storedSource = computed(() => store.scan.source || null)
// 清单能不能改：刷新之后不能（File 对象活不过刷新）—— 要调清单就重新选一次文件夹
const canEditList = computed(() => !!scanInput.value)
const dirNote = computed(() => {
  if (scanInput.value) {
    const name = scanInput.value.folderName || folderName.value || '（未命名文件夹）'
    const n = files.value.length
    if (!n) return '已选文件夹「' + name + '」· 没有可用的图片'
    return '已选文件夹「' + name + '」· ' + n + ' 张图片' +
      (removedList.value.length ? '（已手动去掉 ' + removedList.value.length + ' 张）' : '')
  }
  const s = storedSource.value
  if (!s) return ''
  return '文件夹「' + (s.folderName || '（未命名文件夹）') + '」· ' + (s.imageCount || 0) + ' 张图片'
})
// 这批结果用的图片名清单：两种来源同序（内存态取 File 的名字，落盘态直接是名字）
const listedImages = computed(() => (scanInput.value
  ? files.value.map((f) => f.name)
  : ((storedSource.value && storedSource.value.images) || [])))
const canOpenFileList = computed(() => {
  if (running.value) return false
  if (canEditList.value) return files.value.length > 0 || orderCandidates.value.length > 0
  return listedImages.value.length > 0 || !!(storedSource.value && storedSource.value.orderFileName)
})
// 字序文件候选与"正在用的那一份"：正在用的不可移除（移掉它这一轮就退化成"认纸面参考字"定字序）
const orderCandidates = computed(() => (scanInput.value ? scanInput.value.orderCandidates : []))
const activeOrderName = computed(() => (orderFile.value && orderFile.value.ok ? orderFile.value.fileName : ''))
// 可移除的候选：**只有两个及以上候选时才谈得上"多余的"**，且正在用的那一份永远不在其中
const removableOrderFiles = computed(() => orderCandidates.value.length < 2
  ? []
  : orderCandidates.value.filter((f) => f.name !== activeOrderName.value))
// 「看文件清单」弹窗：列出这一轮挑中的图片与字序文件，图片可以逐张移除
const fileListOpen = ref(false)
// 「看跳过的页」弹窗：识别时被跳过的那几十页，原因往往一模一样（比如整批都不是本程序的纸），
// 常驻在页面上会把这一页撑得很长 —— 收进弹窗，页面上只留一个带数量的入口。
const skippedOpen = ref(false)
// 正在按需重建的页（缩略图只在内存里活一次会话，刷新后要按需从落盘字形重画）：fileIndex 集合
const rebuilding = ref({})
// 重建失败的页与原因（例如这一页的字形已被"清空识别结果"删掉）：界面据此给中文说明，而不是空一块白
const sheetError = ref({})
const running = ref(false)
const stage = ref('')
// 进度（决策 二-18 ④ 要显示四件事）：当前动作、页进度、还剩几步、预计剩余时间
// 每页固定这么几个动作（与 scanFlow 里 stage() 的调用点一一对应），"还剩几步"按它折算
const STAGES_PER_PAGE = 5
const progress = ref({ done: 0, total: 0, currentPage: 0, stageIndex: 0, etaMs: null })
let runStartedAt = 0
const stageIndexOf = (text) => {
  const order = ['预处理', '切格', '认参考字', '红圈', '提取']
  for (let i = 0; i < order.length; i++) if (text.indexOf(order[i]) >= 0) return i + 1
  return 0
}
// 剩余步数 = 剩余整页 × 每页动作数 + 这一页还没走完的动作（粗算，只用来给用户一个量级）
const remainingSteps = computed(() => {
  const left = Math.max(0, progress.value.total - progress.value.done)
  const inPage = Math.max(0, STAGES_PER_PAGE - progress.value.stageIndex)
  return left * STAGES_PER_PAGE + inPage
})
// 预计剩余时间：按"已处理页的平均耗时"外推。**前 2 页不报** —— 刚开局那两页的数字只会乱跳
const etaLabel = computed(() => {
  if (!running.value || progress.value.etaMs === null) return ''
  const sec = Math.round(progress.value.etaMs / 1000)
  if (sec < 60) return '约 ' + Math.max(1, sec) + ' 秒'
  return '约 ' + Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒'
})
const images = ref({}) // fileIndex → { thumb, sheet }（来自内存缓存，用于渲染；不落盘）
const IMAGE_HINT = IMAGE_EXTENSIONS.join(' / ')
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

// 这一轮的识别汇总（2026-10-13 用户口径）：原来"识别完成：N 页，用时 X 秒"与"这批共 N 页：可用…"
// 各占一行、还分处两块，现在并成一句，跟在「已选文件夹「X」· N 张图片」后面 —— 一眼看完"选了什么、跑出什么"。
// 放在内存里（runInfo）而不是落盘：刷新之后"用时"本来就没有意义，剩下的统计仍由 store 里的页记录给出。
const runInfo = ref(null) // { stopped:boolean, pages:number, seconds:string }
const runSummary = computed(() => {
  const g = gate.value
  const parts = []
  if (runInfo.value) {
    parts.push((runInfo.value.stopped ? '已中止：' : '识别完成：') + runInfo.value.pages + ' 页，用时 ' + runInfo.value.seconds + ' 秒')
  }
  if (pages.value.length) {
    parts.push('可用 ' + g.usablePages + ' 页' + (g.skipped.length ? '、跳过 ' + g.skipped.length + ' 页' : '') +
      '；写出 ' + stats.value.written + ' 格（可疑 ' + stats.value.suspect + '），被红笔圈 ' + stats.value.marked +
      ' 个，去重后 ' + stats.value.uniqueChars + ' 个字')
    // 整批被拦下时给一句结论；**原因不留在这里**，它常驻在下面（拦下的原因必须一眼看到，不跟着详情进弹窗）
    if (g.blockers.length) parts.push('这一批被拦下（原因见下）')
  }
  return parts.join(' · ')
})
// 更正册的识别结果（2026-10-13 用户口径：这一块要"包括更正册的识别结果"）——
// 这里只说**识别事实**（更正册几页、写出几格）；"覆盖了几个被圈的字"属配对结论，在下面的更正核对里说。
const correctionScanResult = computed(() => {
  const list = pages.value.filter((p) => p.ok && p.kind === 'correction')
  if (!list.length) return ''
  let cells = 0
  for (const p of list) for (const c of p.cells || []) if (c.verdict !== 'empty') cells++
  return '更正册 ' + list.length + ' 页：写出 ' + cells + ' 格'
})

// ── 页级结果里的"新模型"信息（定位到的字序 / 还要确认几格）──────────────────
// 序列标签：与 lib/referenceCharReader.js 的两份全序一一对应（页记录里只留了 key）
function sequenceLabel(seqKey) {
  return seqKey === 'rank' ? '使用频率序' : '笔画序'
}
// 序列定位命中时，这一页是全序里从第几个字开始的一段 —— 页号由它反推（纸面自己说得清是第几页）
function locatedStartPage(page) {
  return Math.floor(page.located.start / LAYOUT.perPage) + 1
}
// 这一页的字是**从哪儿来的**（决策 一-18 ⑤）：三种来源对用户的信任度不同，必须在界面上说清 ——
//   file 文件夹里的字序文件（文件给死的）/ sequence 纸面参考字序列定位（认出来的）/ cells 逐格认字（猜的）
function orderSourceLabel(page) {
  if (page.orderSource === 'file') {
    const hit = page.located && page.located.seqKey === 'file'
    return '来自文件夹里的字序文件' + (hit ? '（在文件里定位到第 ' + locatedStartPage(page) + ' 页起）' : '（按页脚页号取）')
  }
  if (page.orderSource === 'sequence') {
    return sequenceLabel(page.located ? page.located.seqKey : '') + ' · 第 ' + locatedStartPage(page) + ' 页起'
  }
  if (page.orderSource === 'cells') return '逐格认字（认不准的格需要人工确认）'
  return ''
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

// 批次为空时立刻补一个，让"在第 2 步就一定有批次"成为不变量 ——
// 否则字形会落到 `default` 分片键上（既不属于任何批次、也没有入口能清掉，冒烟里踩到过）。
// 什么情况下会变空：清空识别结果（决策 五-11 会把 batchId 置空）、或项目被清空后重新进来
watch(() => store.scan.batchId, (id) => {
  if (!id) store.ensureScanBatch()
})

// ── 目录选择：两条入口，同一套下游处理 ─────────────────────────────────────
// 允许测试在页面里替换"怎么拿到目录内容"这一步（决策 六-13 的冒烟口径：不再靠 CDP 喂件）。
// 挂到 window 上是**唯一**能让自动化脚本介入的地方：系统目录对话框无法无人值守驱动，
//   而识别这一整条链路（挑图片、读字序文件、逐页识别、落盘）都该被冒烟覆盖 —— 替换的只是"选目录"那一下。
// 默认实现就是真实调用：拿目录句柄 → 读根层文件（lib/scanInput.js 的 collectDirectoryFiles）。
let pickDirectoryImpl = async () => {
  const handle = await window.showDirectoryPicker({ mode: 'read' })
  return await collectDirectoryFiles(handle)
}

/** 选一个文件夹：拿到文件清单后统一走 applyDirFiles() */
async function onPickDirClick() {
  if (running.value || readingDir.value) return
  readingDir.value = true
  try {
    const res = await pickDirectoryImpl()
    if (!res) return // 用户取消（AbortError 由下面接住，这里兜住"返回空"的实现）
    applyDirFiles(res.files || [], res.folderName || '', res.subdirFiles || 0)
  } catch (e) {
    // 用户点了取消：不是错误，什么都不做（静默返回，界面不弹红字）
    if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return
    setMessage('读取文件夹失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    readingDir.value = false
  }
}

/** 退路：`<input webkitdirectory>`（Firefox / Safari 没有系统文件夹对话框时用） */
function onPickDirInput(event) {
  const picked = Array.from(event.target.files || [])
  event.target.value = '' // 清空 input，便于再次选同一个文件夹（File 引用仍然有效）
  // 子目录里的文件会一起给出来（带 webkitRelativePath）—— 数量由 pickScanInputs 数出来并报到界面上
  const folder = picked.length && picked[0].webkitRelativePath
    ? picked[0].webkitRelativePath.split('/')[0]
    : ''
  applyDirFiles(picked, folder, 0)
}

/**
 * 拿到文件清单之后一件件做：挑图片 / 找字序文件 → 把结果讲给用户听。
 * 这是两条入口**共用**的一段 —— 识别下游不关心文件是从系统对话框还是普通选择器来的。
 * @param {File[]} picked 目录根层 + 子目录里的全部文件
 * @param {string} folder 目录名（句柄那条路直接给；webkitdirectory 从相对路径取）
 * @param {number} subdirFiles 句柄那条路数出来的"子文件夹里的文件数"（webkitdirectory 那条路是 0，它自己会算）
 */
async function applyDirFiles(picked, folder, subdirFiles) {
  orderFile.value = null
  folderName.value = folder || ''
  removedList.value = [] // 换了一个文件夹：上一轮手动去掉的那几张与这一轮无关
  runInfo.value = null // 上一轮的识别汇总也跟着作废（下面的统计由新清单重新算）
  if (!picked.length) {
    scanInput.value = null
    setMessage(folder ? '文件夹「' + folder + '」里没有文件' : '这个文件夹里没有文件', 'error')
    return
  }
  readingDir.value = true
  try {
    const input = pickScanInputs(picked)
    if (!input.folderName) input.folderName = folderName.value
    scanInput.value = input
    // 字序文件：固定名「字序.json」优先，读不了再试目录里别的 .json（决策 一-18 ② 的容错）
    const found = await findOrderFile(input.orderCandidates, { perPage: LAYOUT.perPage })
    orderFile.value = found
    // ① 回执行由 dirNote（computed）常驻给出："选了哪个文件夹、几张图片"
    // ② 下面这段是一次性的说明：忽略了什么、字序从哪来
    const name = input.folderName || '（未命名文件夹）'
    const parts = ['文件夹「' + name + '」：找到 ' + input.images.length + ' 张图片']
    const ignored = input.ignoredSubdir || subdirFiles
    if (ignored) parts.push('忽略了子文件夹里的 ' + ignored + ' 个文件')
    if (input.ignoredOther) parts.push('跳过了 ' + input.ignoredOther + ' 个非图片文件')
    if (!input.images.length) {
      parts.push('这个文件夹里没有可用的图片（支持 ' + IMAGE_HINT + '），请确认选的是扫描件所在的那一层')
    }
    if (found.ok) {
      parts.push('字序文件：' + found.fileName + '（' + describeOrderFile(found.file) + '）—— 按它定字序')
    } else if (input.orderCandidates.length) {
      parts.push('字序文件读不了，改用「认纸面参考字」定字序：' + found.reason)
    } else {
      parts.push('文件夹里没有字序文件，改用「认纸面参考字」定字序（要求这份纸是本程序模板印的）')
    }
    setMessage(parts.join('；'), input.images.length ? 'info' : 'error')
  } finally {
    readingDir.value = false
  }
}

// ── 「看文件清单」弹窗：这批结果用的是哪些文件，不要的可以去掉（2026-10-13 用户口径）──────
/**
 * 去掉一张图片：识别时就不读它了（**只动这份清单，磁盘上的文件一个不动**）。
 * 为什么要能做：目录里常混着上一次的废纸、预览图、别的扫描件；一张坏页会把整批的字序对错，
 *   而"重新选一个干净的文件夹"对用户来说成本更高。
 */
function removeImage(file) {
  if (!scanInput.value || running.value) return
  const rest = scanInput.value.images.filter((f) => f !== file)
  if (rest.length === scanInput.value.images.length) return
  removedList.value = [...removedList.value, file]
  scanInput.value = { ...scanInput.value, images: rest }
  setMessage(rest.length
    ? '已去掉「' + (file.name || '（无名文件）') + '」，还剩 ' + rest.length + ' 张图片要识别'
    : '已去掉「' + (file.name || '（无名文件）') + '」：没有可识别的图片了，放回它或重新选一个文件夹', rest.length ? 'info' : 'warn')
}

/** 把去掉的图片放回来（按文件名自然序插回原位） */
function restoreImage(file) {
  if (!scanInput.value) return
  removedList.value = removedList.value.filter((f) => f !== file)
  const merged = [...scanInput.value.images, file].sort((a, b) => naturalCompare(a.name, b.name))
  scanInput.value = { ...scanInput.value, images: merged }
  setMessage('已把「' + (file.name || '（无名文件）') + '」放回（共 ' + merged.length + ' 张）', 'info')
}

/**
 * 去掉一个**多余的字序文件候选**（用户 2026-10-13 口径）：
 *   · 正在用的那一份**不给移除入口** —— 移掉它整批就退化成"认纸面参考字"定字序，
 *     那是会影响整批结果的开关，不该混在"清理多余文件"里；
 *   · 目录里只有一份 json 时也不给移除（没有"多余的"可言）；
 *   · 两份及以上时才列出其余候选，供清掉"另存一份 / 拷贝过来的旧字序"。
 */
function removeOrderCandidate(file) {
  if (!scanInput.value || running.value) return
  scanInput.value = { ...scanInput.value, orderCandidates: scanInput.value.orderCandidates.filter((f) => f !== file) }
  setMessage('已去掉字序文件候选「' + file.name + '」；识别时用的仍是「' + (activeOrderName.value || '（没有可用的字序文件）') + '」', 'info')
}

// 按钮只有一个（2026-10-13 用户口径：去掉「换一个文件夹」，把「重读上次的文件夹」改成「重新选择文件夹」）：
// 语义就是"再选一次" —— 每次点都重新弹系统对话框，不再区分"重读上次那个目录"这条捷径。
const pickLabel = computed(() => {
  if (readingDir.value) return '正在读取…'
  if (!files.value.length) return '选择文件夹'
  return '重新选择文件夹'
})

onMounted(() => {
  // 给自动化脚本留一个注入口（默认是真实实现）：见上面 pickDirectoryImpl 的注释
  window.__sxScanPickDir = {
    set(fn) { pickDirectoryImpl = typeof fn === 'function' ? fn : pickDirectoryImpl },
    reset() {
      pickDirectoryImpl = async () => {
        const handle = await window.showDirectoryPicker({ mode: 'read' })
        return await collectDirectoryFiles(handle)
      }
    }
  }
})

async function start() {
  if (running.value) return
  if (!files.value.length) {
    setMessage('还没有可识别的图片：先点上面的「选择文件夹」，指向扫描件所在的那一层', 'error')
    return
  }
  // 批次是内部容器：再取一次（复用最近一个仍有效的，或自动补一个）—— 界面上已经无处可选它。
  // 2026-10-11（决策 五-9）：这里原来还有一道"作废批次要显式放行"的拦截，随那个勾选框一起去掉了 ——
  // 批次对用户不可见，也就没有"作废"这回事（改选字不再作废批次，见 store.setSelection）
  const currentBatch = store.ensureScanBatch()
  // 字序文件（有就用它，没有就走"认参考字"那条退路，决策 一-18 ⑤）
  const withOrderFile = !!(orderFile.value && orderFile.value.ok)
  const orderChars = withOrderFile ? orderFile.value.file.chars : ''
  const orderPages = withOrderFile ? orderFile.value.file.pageCount : undefined
  running.value = true
  cancelled = false
  openIndex.value = null
  zoomIndex.value = null
  closeReview()
  images.value = {}
  sheetError.value = {} // 新一轮识别会重新生成拼图，上一轮的"重建失败"不该留着
  rebuilding.value = {}
  progress.value = { done: 0, total: files.value.length, currentPage: 0, stageIndex: 0, etaMs: null }
  runStartedAt = performance.now()
  const t0 = runStartedAt
  try {
    // ① 参考字候选库与四段重计算都在 Worker 里（决策 六-15）：主线程只等消息，界面保持可滚动。
    //    "这是不是自家模板印的纸"那条判据不变（决策 五-9 ④：参考字覆盖率不达标就整页失败）。
    setMessage('正在准备参考字识别…（首次约 2~3 秒，之后不用再等）', 'info')
    clearPageCache()
    // 同一批重新识别：先把这批已落盘的字形清掉，避免旧页与新页混在一起（分片键是按批次 + 页序写的）
    await clearGlyphs({ batchId: store.scan.batchId })
    savedStats.value = null
    // 把"这批结果来自哪里"记下来（文件夹名 / 图片名清单 / 字序文件摘要）：刷新之后界面靠它回显来源，
    // 而不是显示成"还没有选文件夹"（2026-10-13 用户口径：没有轮次概念，界面说的就是当前数据的状态）
    store.beginScanRun({
      batchId: store.scan.batchId,
      chars: orderChars || resolveBatchChars(currentBatch),
      source: {
        folderName: (scanInput.value && scanInput.value.folderName) || folderName.value || '',
        images: files.value.map((f) => f.name),
        imageCount: files.value.length,
        orderFileName: withOrderFile ? orderFile.value.fileName : '',
        orderNote: withOrderFile ? describeOrderFile(orderFile.value.file) : '',
        at: new Date().toISOString()
      }
    })
    setMessage(
      '正在识别 ' + files.value.length + ' 张图片（单页约 1~2 秒；中途可以点「中止」，已识别的页会保留）' +
        (withOrderFile ? '；字序按文件夹里的字序文件对应' : '；字序靠认纸面参考字定位'),
      'info'
    )
    const res = await recognizeBatchInWorker(files.value, {
      // 字序文件优先（决策 一-18）：给了它，序列定位只在文件那一个全序里找起点
      chars: orderChars || resolveBatchChars(currentBatch),
      orderChars,
      orderPages,
      // 页数口径：有字序文件时以文件声明的页数为准（识别侧汇总自检页要用它）
      sheetPages: orderPages,
      onPageStart: (pageNo, total) => {
        progress.value = { ...progress.value, currentPage: pageNo, total, stageIndex: 0 }
      },
      onStage: (text) => {
        stage.value = text
        progress.value = { ...progress.value, stageIndex: stageIndexOf(text) }
      },
      // 每页回来就立刻落盘 + 上屏。落盘走 await（客户端会等它）：**先写盘、再报"识别完成"** ——
      // 不等的话用户会看到"识别完成"比"字形已落盘"先出现（冒烟里抓到的时序问题）。
      // 这不影响 Worker：它在发完这一页的消息后就继续算下一页了，主线程等的是自己的 IndexedDB 事务。
      onPageIndex: async (record, index, cache) => {
        putPageCache(index, cache)
        images.value = { ...images.value, [index]: { thumb: cache.thumb, sheet: cache.sheet } }
        store.appendScanPage(record)
        // 预计剩余时间按"已处理页的平均耗时"外推；前 2 页不报（刚开局的数字只会乱跳）
        const done = progress.value.done + 1
        const total = progress.value.total
        const elapsed = performance.now() - runStartedAt
        progress.value = {
          ...progress.value,
          done,
          total,
          stageIndex: STAGES_PER_PAGE,
          etaMs: done >= 2 && done < total ? (elapsed / done) * (total - done) : null
        }
        // 字形**逐页落盘**（掩膜存 PNG，分片键）：关掉浏览器或刷新后不用重扫，
        // 字体合成（下一步）直接从这里取原料 —— 口径见《决策记录》二-16
        const saved = await savePageGlyphs({
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
        if (!saved.ok) setMessage('字形落盘失败（识别结果仍在内存里，但刷新会丢）：' + saved.error, 'error')
        savedStats.value = await glyphStoreStats().catch(() => savedStats.value)
      }
    })
    store.finishScanRun({ summary: res.summary })
    const secs = ((performance.now() - t0) / 1000).toFixed(1)
    // 落盘自检（2026-10-13）：识别完成之后再核一遍"有结果的页是不是都落盘了" ——
    //   漏落盘的后果是**刷新之后那几页的字形再也找不回来**（字体里会少几个字，更正核对里那一列图是空的）。
    //   客户端已经会等所有落盘回调收尾（见 lib/scanWorkerClient.js 的 settle），这里只是一道兜底：
    //   真报出来就必须让用户看见，不能让他以为"识别完成 = 一切都存好了"。
    const okPages = res.pages.filter((p) => p.ok).length
    savedStats.value = await glyphStoreStats().catch(() => savedStats.value)
    if (savedStats.value && savedStats.value.pages < okPages) {
      setMessage('识别了 ' + okPages + ' 页，但字形只落盘了 ' + savedStats.value.pages + ' 页：请重新点一次「开始识别」，' +
        '在落盘补齐之前别刷新页面（否则缺的那几页要重扫）', 'error')
    }
    // 这一轮的结论并进「已选文件夹…」那一行（2026-10-13 用户口径），这里不再各报一遍；
    // 但**识别过程中的错误**（字形落盘失败等）要留着，不能被清掉
    runInfo.value = { stopped: !!res.stopped, pages: res.pages.length, seconds: secs }
    if (messageType.value !== 'error') setMessage('', 'info')
  } catch (e) {
    setMessage('识别失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    running.value = false
    stage.value = ''
  }
}

function stop() {
  cancelled = true
  // 中止请求要**跨线程**送过去（决策 六-15 ③）：Worker 是消息驱动的，所以它在两步之间才会看到 ——
  // 表现与旧口径完全一致："当前这一页处理完就停"（不打断正在跑的那一页）
  cancelTask()
  setMessage('已请求中止：当前这一页处理完就停（已识别的页会保留）', 'info')
}

function clearAll() {
  if (running.value) return
  // 只清"结果"：选好的文件夹与手动去掉的清单都留着 —— 用户点"清空结果"多半是想重跑一遍，不是想重新选目录
  images.value = {}
  openIndex.value = null
  zoomIndex.value = null
  runInfo.value = null
  sheetError.value = {}
  rebuilding.value = {}
  clearPageCache()
  // 字形是落盘的：清结果要连分片键一起清，否则下次识别会与旧字形混在一起
  clearGlyphs({ batchId: store.scan.batchId }).then((r) => {
    savedStats.value = null
    setMessage('已清空识别结果、内存缓存与落盘的字形' + (r && r.removed ? '（删除 ' + r.removed + ' 页分片）' : ''), 'info')
  })
  store.clearScan()
}

// ── 单页重传（清单 一-8）──────────────────────────────────────────────────
// 场景：某一页写坏了 / 扫描有折痕，重扫那一页就够，不必整批重来（整批 61 页要重跑约 100 秒）。
// 三条口径（2026-10-08 用户拍板，见《决策记录》八-14）：
//   ① 入口在**每张结果卡片**上（2026-10-12 起卡片化，按钮名"重传"）—— 局部、明确，
//      现有的"整批识别"流程一个字不改；
//   ② **复用原页的 fileIndex**：分片键（`sxfont.glyphs.v1.<批次>.<fileIndex>`）与内存缓存都按它命名，
//      复用即"原地覆盖"，页序机制一行都不用动；
//   ③ 整页失败、或页脚校验码与当前用的批次不符 → **明确失败、不写入**（静默拿错数据比拒绝处理糟得多，沿用二-6 的口径）。
const rescanning = ref(null) // 正在重传的页 fileIndex（同一时刻只允许一页在跑）

async function rescanPage(page, event) {
  const file = (event.target.files || [])[0]
  event.target.value = '' // 清空，便于再选同一个文件
  if (!file || running.value || rescanning.value !== null) return
  // 批次是内部容器：重传前也取一次（复用最近一个，或自动补一个）—— 字形分片键是「批次 + 页序」，
  // 批次为空会落成 `default` 键，之后既不属于任何批次、也没有入口能清掉（冒烟里踩到过）
  const currentBatch = store.ensureScanBatch()
  rescanning.value = page.fileIndex
  setMessage('正在重传第 ' + (page.pageNumber || '?') + ' 页（' + file.name + '）…', 'info')
  try {
    const expectedBatchCode = currentBatch && typeof currentBatch.batchCode === 'number' ? currentBatch.batchCode : null
    // 重传这一页也走 Worker（决策 六-15）与同一个字序来源：文件夹里有字序文件就按文件定（决策 一-18），
    // 没有才走"认纸面参考字"（否则这一页的字会退回按**批次的全局字序**取 —— 自定义选字的纸会被张冠李戴）
    const { record, cache } = await recognizePageInWorker(file, {
      chars: chars.value,
      orderChars: orderFile.value && orderFile.value.ok ? orderFile.value.file.chars : '',
      orderPages: orderFile.value && orderFile.value.ok ? orderFile.value.file.pageCount : undefined,
      expectedBatchCode,
      fileIndex: page.fileIndex, // 复用原页序号：分片键与缓存键都按它覆盖
      pageNumberOverride: page.pageNumber || undefined,
      onStage: (text) => setMessage('正在重传第 ' + (page.pageNumber || '?') + ' 页（' + file.name + '）：' + text, 'info')
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
    // 被圈字变了 → 之前的更正配对失效（配对依赖被圈字清单）：清掉并明确提示去下面的更正核对重来
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
        (markedChanged ? '。这一页的被圈字有变化，之前的更正配对已作废，请在下面的「更正核对」里重新核对' : '') +
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

// ── 结果卡片（2026-10-12 用户口径，决策 八-16 ④⑤）──────────────────────────
// 卡片上只放四样：文件名、状态（颜色 + 一个短词）、一行统计、三个操作。
// 缩略图与 136 格视图收进「看格子」弹窗（点开才渲染），完整信息塞进 title（hover 才看）——
// 五六十页时旧的行式列表既常驻几十张 dataURL 图、又被页数拉得很长，卡片化之后列表长度与图片都受控。
// 状态四态与通用版 二-3 的配色一致：成功 = 绿、失败 = 红、待处理 = 橙、更正册 = 青（不是"失败"，是另一类件）。
function cardClass(page) {
  if (!page.ok) return 'is-failed'
  if (page.kind === 'correction') return 'is-correction'
  if (page.needReview) return 'is-review'
  return 'is-ok'
}
function cardStatusLabel(page) {
  if (!page.ok) return '失败'
  if (page.kind === 'correction') return '更正册'
  if (page.needReview) return '待确认'
  return '已识别'
}
// 页号与"这个页号是怎么来的"：序列定位 > 页脚读出 > 手选 —— 三种来源的可信度不同，必须逐页说清
function pageNumberLabel(page) {
  if (page.kind === 'correction' && page.pageNumber) return '更正册第 ' + page.pageNumber + ' 页（页脚校验码 0）'
  if (page.pageNumberSource === 'sequence') return '第 ' + page.pageNumber + ' 页（按纸面参考字序定位）'
  if (page.footerOk) return '第 ' + page.pageNumber + ' 页（页脚读出）'
  if (page.pageNumber) return '第 ' + page.pageNumber + ' 页（手选）'
  return '页号待手选'
}
// hover 的完整信息（多行）：页号来源 / 校验码 / 方向纠正 / 四角误差 / 字序来源 / 写出统计
function cardTitle(page) {
  const lines = [page.fileName, pageNumberLabel(page)]
  const bits = []
  if (page.footerOk && page.kind !== 'correction') {
    bits.push('校验码 ' + page.batchCode + (page.batchMatch === false ? '（与所选批次不符）' : '（与所选批次一致）'))
  }
  if (page.orientation && page.orientation.corrected) bits.push('已自动转正 ' + page.orientation.turns * 90 + ' 度')
  if (page.cornerMaxError !== null && page.cornerMaxError !== undefined) bits.push('四角误差 ' + page.cornerMaxError + ' 像素')
  if (bits.length) lines.push(bits.join(' · '))
  if (page.orderSource) lines.push('字序：' + orderSourceLabel(page))
  // 认不出整页字序的页（自定义选字的纸）：有多少格要人工过一眼 —— 完整说法在 hover 里，
  // 卡片上只在「逐格确认」按钮上带一个数字（八-16 ④ 的按钮带计数）
  if (page.ok && page.needReview) {
    const n = reviewCount(page)
    lines.push(n ? '需要确认 ' + n + ' 格（整页字序没认出来，逐格认字的结果要你过一眼）' : '已全部确认')
  }
  if (page.ok) {
    lines.push('写出 ' + page.counts.written + ' 格（可疑 ' + page.counts.suspect + '）· 被圈 ' + page.counts.marked + ' 个' +
      (page.counts.uncertain ? ' · 归属待确认 ' + page.counts.uncertain : ''))
  } else {
    lines.push(page.reason || '这一页没能识别')
  }
  if (needsManualOrder(page)) lines.push('页脚读不出页号：可在「看格子」里手选页序，或拖到另一张卡片上交换')
  return lines.join('\n')
}
// 弹窗里的一行摘要：与 hover 同一份信息，压成一行（弹窗顶部）
function sheetSummary(page) {
  return cardTitle(page).split('\n').slice(1).join('；')
}

// 弹窗里那一页的页记录（由「看格子」设置 openIndex；没有打开时是 null，弹窗整块不渲染）
const sheetPage = computed(() => pages.value.find((p) => p.fileIndex === openIndex.value) || null)

// ── 格级视图（在「看格子」弹窗里渲染）────────────────────────────────────
function togglePage(page) {
  if (!page.ok) return
  openIndex.value = openIndex.value === page.fileIndex ? null : page.fileIndex
  zoomIndex.value = null
  if (openIndex.value !== null) ensureSheet(page)
}

/**
 * 按需把这一页的格子拼图补上（2026-10-13 用户口径：刷新 / 重进之后也要能看字）。
 * 为什么需要：拼图只在内存缓存里活一次会话（清单 四-27 的口径），而**字形掩膜是落盘的** ——
 * 刷新过页面就直接从落盘分片重画一张，而不是告诉用户"缩略图不可用"。
 * 已经有的不再重画；同一页正在重建时不重复发起。
 */
async function ensureSheet(page) {
  if (!page || !page.ok) return
  const has = images.value[page.fileIndex] && images.value[page.fileIndex].sheet
  if (has || rebuilding.value[page.fileIndex]) return
  rebuilding.value = { ...rebuilding.value, [page.fileIndex]: true }
  try {
    const res = await buildPageSheetFromStore({
      batchId: store.scan.batchId,
      fileIndex: page.fileIndex,
      cellThumbSize: SCAN_DEFAULTS.cellThumbSize,
      // 被红笔圈掉的格：落盘的掩膜里没有这个信息，从页记录取（否则重建的图会丢掉红框）
      markedCells: (page.cells || []).filter((c) => c.marked).map((c) => c.index)
    })
    if (res.ok) {
      images.value = {
        ...images.value,
        [page.fileIndex]: { ...(images.value[page.fileIndex] || {}), sheet: res.sheet }
      }
    } else {
      sheetError.value = { ...sheetError.value, [page.fileIndex]: res.reason }
    }
  } finally {
    const next = { ...rebuilding.value }
    delete next[page.fileIndex]
    rebuilding.value = next
  }
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
  // 格号一律**1 起**显示（内部 cell.index 是 0 起）：用户数格子是从 1 数起的，
  // 而"第 0 格"这种说法在界面上只会让人怀疑是不是少了一格
  return '第 ' + (cell.index + 1) + ' 格' + (cell.char ? '「' + cell.char + '」' : '') +
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
    <!-- ① 识别方式：指定一个文件夹（说明已收进下面的提示行与《使用说明》，这里不再重复一遍） -->
    <!-- 2026-10-11（决策 二-18 / 一-18）：不再手动挑图片、也不再选批次 ——
         给一个文件夹，程序读里面的图片与 字序.json；没有字序文件时才靠"认纸面参考字"定字序。
         批次在界面上彻底消失（进这一步时程序自动复用最近一个，一个都没有就顺手建一个） -->
    <div class="panel-row">
      <div class="panel-field">
        <span class="field-label">识别方式</span>
        <!-- 选目录的两句要点并进这一行（2026-10-13 用户口径：原来单独一段太长、与这一行说的是一件事）：
             ① 字序从哪来；② 系统文件夹对话框为什么看起来是空的（Windows 只列子文件夹），不写清用户会以为没选上 -->
        <span class="panel-hint" data-role="scan-mode">
          选一个文件夹即可：程序读里面的图片，字序优先按第 1 步压缩包里的 <strong>字序.json</strong> 定，没有就用纸面上的参考字。<template
            v-if="canPickDirectory"
          >对话框只列子文件夹、不列文件，<strong>列表是空的也没关系</strong> —— 底部「文件夹」框里显示的就是你选中的那一层，直接确认即可。</template><template
            v-else
          >这台浏览器没有系统文件夹对话框（Firefox / Safari 不支持），这里改用普通文件夹选择器，功能一样；想要系统对话框请用 Chrome 或 Edge（86+）。</template>
        </span>
      </div>
    </div>

    <!-- ② 文件夹与进度 -->
    <div class="panel-row">
      <div class="panel-field">
        <!-- 主路：系统文件夹对话框（showDirectoryPicker）。
             2026-10-13 用户口径：只留一个按钮 —— 去掉「换一个文件夹」，「重读上次的文件夹」改成
             「重新选择文件夹」，点它就重新弹对话框（不再有"直接重读上次那个目录"这条捷径）。
             退路：这台浏览器没有这个接口（Firefox / Safari）时改用 <input webkitdirectory>，
             那句说明已并进上面的「识别方式」里（不静默降级） -->
        <template v-if="canPickDirectory">
          <button
            class="primary"
            type="button"
            data-role="pick-dir"
            :disabled="running || readingDir"
            @click="onPickDirClick"
          >
            {{ pickLabel }}
          </button>
        </template>
        <label v-else class="file-button" data-role="pick-dir">
          选择文件夹
          <input
            type="file"
            webkitdirectory
            directory
            multiple
            :disabled="running || readingDir"
            @change="onPickDirInput"
          />
        </label>
        <button
          class="primary"
          data-role="scan-start"
          :disabled="running || readingDir || !files.length"
          :title="files.length ? '' : '先点左边的「选择文件夹」，指向扫描件所在的那一层'"
          @click="start"
        >开始识别</button>
        <button v-if="running" type="button" data-role="scan-stop" @click="stop">中止</button>
        <span v-if="readingDir" class="panel-hint">正在读取文件夹…</span>
      </div>
    </div>
    <!-- ③ 扫描识别的状态与结果（2026-10-13 用户口径：把原来散在三处的信息合成一块）：
         来源回执（哪个文件夹、多少张图）+ 识别汇总 + 更正册的识别结果 + 字形落盘统计
         + 拦下的原因与提示 + 数据兜底说明。合并的理由是原来这三处各说一遍页数、
         分处三块，而且刷新之后回执会显示成"还没有选文件夹"、与同一页里的结果自相矛盾。
         **「清空结果」不在这一块里** —— 它挪到步骤标题行右侧（见下面的 Teleport），
         与第 1 步「更新预览」同一个位置。 -->
    <div v-if="pages.length || dirNote" class="scan-status" data-role="scan-status">
      <p class="scan-status-title">扫描识别的状态与结果</p>
      <!-- 来源：刷新前是内存里那份（可去掉 / 放回），刷新后是识别时落盘的那份（只读回显） -->
      <p v-if="dirNote" class="panel-hint" data-role="dir-note">
        <strong>{{ dirNote }}</strong>
        <span v-if="runSummary" data-role="run-summary"> · {{ runSummary }}</span>
      </p>
      <!-- 更正册的识别结果（用户口径：这一块要包括它） -->
      <p v-if="correctionScanResult" class="panel-hint" data-role="correction-scan-result">{{ correctionScanResult }}</p>
      <!-- 字形落盘：下一步生成字体直接用它，刷新或关浏览器都不用重扫 -->
      <p v-if="savedStats && savedStats.glyphs" class="panel-hint" data-role="glyph-saved">
        字形已落盘：{{ savedStats.pages }} 页 / {{ savedStats.glyphs }} 个字 / {{ (savedStats.bytes / 1024 / 1024).toFixed(1) }} MB
        —— 存的是笔迹掩膜（PNG 无损），<strong>刷新或关掉浏览器后不用重扫</strong>，下一步生成字体直接用它
      </p>

      <!-- 收批闸门：**拦下的原因与提示常驻在这里**（必须一眼看到，不跟着详情进弹窗）；
           逐页的"跳过：第 N 个文件…"清单收进「看跳过的 N 页」弹窗 —— 它常常几十条、原因还一模一样 -->
      <ul v-if="gate.blockers.length" class="scan-problems">
        <li v-for="(text, i) in gate.blockers" :key="'b' + i" class="error">拦下：{{ text }}</li>
      </ul>
      <ul v-if="gate.notes.length" class="scan-problems">
        <li v-for="(text, i) in gate.notes" :key="'n' + i" class="info">{{ text }}</li>
      </ul>
      <p v-if="gate.canProceed" class="panel-message done">
        这一批可以继续：<span v-if="(store.correction.circled || []).length">被红笔圈掉的字在下面的「更正核对」里可以逐行核对与调整（不改就是程序按识别结果配的那一套，直接用于生成字体）</span><span v-else>主区没有被红笔圈掉的字，可以直接进第 3 步「生成」了</span>
      </p>
      <!-- 数据兜底的口径（决策 五-10 ②）：识别结果与字形都落在本机浏览器里，刷新与关浏览器都不丢；
           会丢的只有"清浏览器数据 / 换电脑 / 换浏览器"，那时把文件夹重指一次重跑即可 -->
      <p class="step-note" data-role="data-note">
        识别结果与字形保存在<strong>本机浏览器</strong>里，刷新与关浏览器都不丢；清理浏览器数据或换电脑才会没有 —— 那时重指一次文件夹重跑即可。
        扫描件原图程序不留，请自己留一份。
      </p>

      <div class="scan-status-actions">
        <button class="text" type="button" data-role="file-list" :disabled="!canOpenFileList" @click="fileListOpen = true">
          看文件清单
        </button>
        <button v-if="gate.skipped.length" class="text" type="button" data-role="skipped-open" @click="skippedOpen = true">
          看跳过的 {{ gate.skipped.length }} 页
        </button>
      </div>
    </div>
    <!-- 「清空结果」：放在步骤标题行右侧（2026-10-13 用户口径 —— 与第 1 步「更新预览」同一个位置）。
         它作用的是"结果"，所以只要有结果就给入口；识别进行中禁点 -->
    <Teleport to="#step-head-actions">
      <button class="text" type="button" data-role="scan-clear" :disabled="running || !pages.length" @click="clearAll">
        清空结果
      </button>
    </Teleport>
    <!-- 进度（决策 二-18 ④）：在做什么 / 已完几页 / 还剩几步 / 预计还要多久 -->
    <p v-if="running" class="panel-hint" data-role="scan-progress">
      当前：第 {{ progress.currentPage }} / {{ progress.total }} 页 · {{ stage || '准备中' }}；
      进度 {{ progress.done }} / {{ progress.total }} 页；
      还剩 {{ progress.total - progress.done }} 页（约 {{ remainingSteps }} 步）<span v-if="etaLabel">，预计还要 {{ etaLabel }}</span>
    </p>
    <p v-if="message" class="panel-message" :class="messageType" data-role="scan-message">{{ message }}</p>

    <!-- ④ 结果总览：**一页一张小卡片**（2026-10-12 决策 八-16 ④⑤）——
         卡片只有文件名、状态、一行统计与三个操作；缩略图与 136 格视图收进「看格子」弹窗、点开才加载；
         完整信息（页号来源 / 校验码 / 方向纠正 / 四角误差 / 字序来源 / 写出统计）在 hover 的 title 里 -->
    <div v-if="pages.length" class="scan-cards" data-role="scan-cards">
      <div
        v-for="page in pages"
        :key="page.fileIndex"
        class="scan-card"
        :class="[cardClass(page), { active: openIndex === page.fileIndex }]"
        :data-file-index="page.fileIndex"
        :data-page-number="page.pageNumber === null ? '' : page.pageNumber"
        :data-ok="page.ok ? '1' : '0'"
        :data-status="cardStatusLabel(page)"
        :data-role="'scan-card'"
        :title="cardTitle(page)"
      >
        <div class="scan-card-head">
          <!-- 拖动改页序：只有页脚读不出的页可以拖（页脚读出的页序是权威的，决策 二-7） -->
          <span
            class="scan-card-handle"
            :class="{ draggable: needsManualOrder(page) }"
            :draggable="needsManualOrder(page)"
            title="页脚读不出版号的页可以拖到另一张卡片上交换页序"
            @dragstart="onDragStart(page)"
            @dragover.prevent
            @drop="onDropPage(page)"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path d="M6 3h4M6 8h4M6 13h4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </span>
          <span class="scan-card-name" :title="page.fileName">{{ page.fileName }}</span>
          <span class="scan-card-badge">{{ cardStatusLabel(page) }}</span>
        </div>
        <p class="scan-card-stats">
          <template v-if="page.ok">
            写出 {{ page.counts.written }} 格（可疑 {{ page.counts.suspect }}）· 被圈 {{ page.counts.marked }} 个<span
              v-if="page.counts.uncertain"
            > · 归属待确认 {{ page.counts.uncertain }}</span>
          </template>
          <template v-else>{{ page.reason }}</template>
        </p>
        <div class="scan-card-actions">
          <button class="text" type="button" :disabled="!page.ok" data-role="view-cells" @click="togglePage(page)">
            {{ openIndex === page.fileIndex ? '收起格子' : '看格子' }}
          </button>
          <!-- 单页重传（清单 一-8）：只重扫这一页、原地替换它的结果与字形，不必整批重来。
               2026-10-12 按用户口径由实体按钮改成文本按钮「重传」，位置紧跟「看格子」之后 -->
          <label
            class="scan-card-rescan"
            :class="{ disabled: running || rescanning !== null }"
            data-role="rescan-page"
            title="重扫这一页并替换它的识别结果与字形（其它页不动）"
          >
            {{ rescanning === page.fileIndex ? '重传中…' : '重传' }}
            <input
              type="file"
              accept="image/*"
              :disabled="running || rescanning !== null"
              @change="rescanPage(page, $event)"
            />
          </label>
          <!-- 认不出整页字序的页（自定义选字的纸）：认不准的格 + 还没认出来的格交人过一眼。
               全部确认完之后入口仍留着（想再核对一遍 / 改某个字还能进去），只是文案改成"已全部确认" -->
          <button
            v-if="page.needReview"
            class="text"
            type="button"
            data-role="review-chars"
            @click="openReview(page)"
          >
            逐格确认{{ reviewCount(page) ? '（' + reviewCount(page) + '）' : '（已全部确认）' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 单页详情（弹窗）：136 格视图 + 单格放大 + 页脚读不出时手选页序。
         为什么收进弹窗：60 页时行内展开会把列表撑得很长，而且每页那 136 个格子的覆盖层与格子拼图会常驻 DOM -->
    <div v-if="sheetPage" class="backup-overlay" @click.self="togglePage(sheetPage)">
      <div class="backup-modal scan-sheet-modal" role="dialog" aria-label="这一页的格子" data-role="scan-sheet">
        <div class="backup-head">
          <h3>{{ sheetPage.fileName }}</h3>
          <button class="text" type="button" data-role="sheet-close" @click="togglePage(sheetPage)">关闭</button>
        </div>
        <p class="panel-hint">{{ sheetSummary(sheetPage) }}</p>

        <!-- 拼图只在内存里活一次会话（清单 四-27 的口径），刷新之后**按需从落盘的字形重画** ——
             所以这里不再说"缩略图不可用"，而是给"正在重建 / 重建不了（附中文原因）"两种确切状态 -->
        <div v-if="!images[sheetPage.fileIndex] || !images[sheetPage.fileIndex].sheet" class="panel-hint" data-role="sheet-rebuild">
          <template v-if="rebuilding[sheetPage.fileIndex]">正在从落盘的字形重建这一页的格子图…</template>
          <template v-else-if="sheetError[sheetPage.fileIndex]">
            这一页的格子图没能重建：{{ sheetError[sheetPage.fileIndex] }} —— 重新点「开始识别」跑一遍就能看到
          </template>
          <template v-else>正在读取这一页的格子图…</template>
        </div>
        <div v-else class="scan-grid-wrap">
          <img class="scan-grid-sheet" :src="images[sheetPage.fileIndex].sheet" alt="136 格缩略图" />
          <span
            v-for="cell in sheetPage.cells"
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
            <strong>第 {{ zoomCell.cell.index + 1 }} 格{{ zoomCell.cell.char ? '「' + zoomCell.cell.char + '」' : '' }}</strong>
            <p class="panel-hint">{{ zoomIsMarkedLabel }}</p>
          </div>
        </div>

        <!-- 页脚读不出页号的页：在这里手选（页脚读出的页序是权威的，其余页不给这个入口） -->
        <div v-if="needsManualOrder(sheetPage)" class="scan-order">
          手选页序
          <input
            type="number"
            min="1"
            :max="batch ? batch.pageCount : 999"
            :value="sheetPage.pageNumber || ''"
            :disabled="running"
            @change="onOrderInput(sheetPage, $event.target.value)"
          />
        </div>
      </div>
    </div>

    <p v-if="!pages.length && !running" class="panel-hint">
      选好文件夹后点「开始识别」：程序对每张图片逐页做「预处理 → 切格（方向不对会自动转正）→
      按字序文件对齐（没有文件时认纸面上的参考字）→ 红圈识别 → 字形提取」，
      并把每页的页号来源、写出格数与可疑格报给你；认不准的格会开一个「逐格确认」让你过一眼。
    </p>

    <!-- 这批结果用的文件（2026-10-13 用户口径）：能看清挑了哪些图片与字序文件，不要的去掉再识别。
         只动本轮的清单 —— 磁盘上的文件一个都不动（浏览器本来也删不了用户的文件）。
        **刷新之后是只读回显**：图片内容不会留在浏览器里（落盘的只有文件名），
        要调整清单就重新选一次文件夹；这一块说的始终是"这批结果的来源"，没有轮次之分 -->
    <div v-if="fileListOpen" class="backup-overlay" @click.self="fileListOpen = false">
      <div class="backup-modal" role="dialog" aria-label="这批结果用的文件" data-role="file-list-modal">
        <div class="backup-head">
          <h3>这批结果用的文件</h3>
          <button class="text" type="button" data-role="file-list-close" @click="fileListOpen = false">关闭</button>
        </div>
        <p class="panel-hint">
          识别只读这一层里的图片与字序文件。<template v-if="canEditList">不要的文件在这里去掉，识别时就不会读它 —— <strong>磁盘上的文件不会被删</strong>。</template><template v-else>这是上次识别时用的清单（<strong>只能看</strong>）：图片内容不会留在浏览器里，要调整清单请点上面的「重新选择文件夹」再识别一次。</template>
        </p>

        <div class="file-group">
          <p class="file-group-title">字序文件</p>
          <ul class="file-list" data-role="file-list-orders">
            <template v-if="canEditList">
              <li v-for="f in orderCandidates" :key="'o' + f.name">
                <span class="file-name">{{ f.name }}</span>
                <span v-if="f.name === activeOrderName" class="file-tag">正在使用</span>
                <span v-else class="file-tag muted">候选</span>
                <button
                  v-if="removableOrderFiles.indexOf(f) >= 0"
                  class="text"
                  type="button"
                  data-role="order-remove"
                  @click="removeOrderCandidate(f)"
                >
                  去掉
                </button>
              </li>
              <li v-if="!orderCandidates.length" class="file-note">
                没有字序文件：识别时靠认纸面参考字定字序（要求这份纸是本程序模板印的）
              </li>
            </template>
            <template v-else>
              <li v-if="storedSource && storedSource.orderFileName">
                <span class="file-name">{{ storedSource.orderFileName }}</span>
                <span class="file-tag">这次识别用的</span>
              </li>
              <li v-else class="file-note">没有字序文件：这次识别靠认纸面参考字定的字序</li>
            </template>
          </ul>
          <p v-if="canEditList && orderCandidates.length > 1" class="panel-hint">
            这个文件夹里有 {{ orderCandidates.length }} 个 json 文件：字序按"固定名优先"挑中了「{{ activeOrderName || '（都不合格式）' }}」——
            多余的是"另存一份 / 从别处拷来的"旧字序，可以在这里去掉，免得以后挑错。
          </p>
          <p v-else-if="canEditList && orderCandidates.length === 1 && activeOrderName" class="panel-hint">
            只有一个字序文件，它就是识别时用的那一份，不能在这里去掉（去掉它整批就改成认纸面参考字定字序了）。
          </p>
          <p v-else-if="!canEditList && storedSource && storedSource.orderNote" class="panel-hint">
            字序文件：{{ storedSource.orderNote }}
          </p>
        </div>

        <div class="file-group">
          <p class="file-group-title">图片（{{ listedImages.length }}）</p>
          <ul class="file-list" data-role="file-list-images">
            <li v-for="(name, i) in listedImages" :key="'i' + name + i">
              <span class="file-index">{{ i + 1 }}</span>
              <span class="file-name">{{ name }}</span>
              <button
                v-if="canEditList"
                class="text"
                type="button"
                data-role="image-remove"
                @click="removeImage(files[i])"
              >
                去掉
              </button>
            </li>
            <li v-if="!listedImages.length" class="file-note">还没有图片：点上面的「选择文件夹」，指向扫描件所在的那一层</li>
          </ul>
        </div>

        <div v-if="canEditList && removedList.length" class="file-group">
          <p class="file-group-title">已去掉的图片（{{ removedList.length }}）</p>
          <ul class="file-list" data-role="file-list-removed">
            <li v-for="(f, i) in removedList" :key="'r' + f.name + i">
              <span class="file-name">{{ f.name }}</span>
              <button class="text" type="button" data-role="image-restore" @click="restoreImage(f)">放回</button>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <!-- 跳过的页（详情弹窗）：整批被跳过时往往几十条、原因还一模一样，收在这里看 -->
    <div v-if="skippedOpen" class="backup-overlay" @click.self="skippedOpen = false">
      <div class="backup-modal" role="dialog" aria-label="跳过的页" data-role="skipped-modal">
        <div class="backup-head">
          <h3>跳过的 {{ gate.skipped.length }} 页</h3>
          <button class="text" type="button" data-role="skipped-close" @click="skippedOpen = false">关闭</button>
        </div>
        <ul class="scan-problems">
          <li v-for="item in gate.skipped" :key="'s' + item.fileIndex" class="warn">
            跳过：第 {{ item.fileIndex + 1 }} 个文件{{ item.fileName ? '（' + item.fileName + '）' : '' }} —— {{ item.reason }}
          </li>
        </ul>
      </div>
    </div>

    <!-- 逐格复核（2026-10-11 新模型）：认不出整页字序的页在这里逐格确认 / 手输 -->
    <CharReview v-if="reviewPage" :page="reviewPage" :open="reviewOpen" @close="closeReview" />

    <!-- 更正核对（原独立的第 2 步，2026-10-11 并入本页 —— 决策 八-15 ④）：
         它是识别结果的下一步处理，不该另占一步；有识别结果时就挂在这里 -->
    <CorrectionConfirm v-if="pages.length && !running" />
  </div>
</template>
