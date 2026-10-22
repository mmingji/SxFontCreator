<script setup>
// 第 2 步：上传识别（阶段一「界面串联」B2；2026-10-11 起改用"从纸上认参考字定字序"的新模型）
// 职责：① 指定一个文件夹（系统文件夹对话框）→ 挑图片与字序文件 → 串行识别，边跑边显示、可中止
//   ② **收批闸门**（单页失败跳过；右侧方块读不出只提示，页号与字序由纸面参考字定）
//   ③ 结果**一页一张卡片**（状态 / 一行统计 / 看格子 / 作废 / 重传；完整信息在 hover 里）
//   ④ 格级视图与单格放大（收进「看格子」弹窗，点开才渲染）
// 2026-10-15 用户拍板去掉的两条界面操作：**手选页序**（含拖动排序）与**逐格确认** ——
//   前者把准确性交给用户填数字（顺序一错整批错字），后者在"每页自证"落地后已无必要：
//   右侧方块里那 12 位现在是"这一页那些字的指纹"，识别端能自己验出字序对不对（见 lib/pageCode.js）。
// 数据来源：识别编排在 Worker 里（决策 六-15：预处理 / 切格 / 认参考字 / 提取四段重计算都搬过去了，
//   主线程只收发消息，界面在几十页连跑时保持可滚动），客户端封装在 lib/scanWorkerClient.js；
//   产物缓存（缩略图 / 掩膜）在 lib/scanCache.js，轻量页记录落盘在 store.scan —— 口径见 二-15 / 五-9。
import { computed, onMounted, ref, watch } from 'vue'
import { useProjectStore } from '../store/project.js'
import { SCAN_DEFAULTS, evaluateRescanAccept, evaluateScanGate, markDuplicatePages, summarizeBatch } from '../lib/scanFlow.js'
import { correctionBookStats, pickCorrectionBookPages, usableForGlyphs } from '../lib/scanMeta.js'
import { cancelTask, recognizeBatchInWorker, recognizePageInWorker } from '../lib/scanWorkerClient.js'
import { clearPageCache, getPageCache, putPageCache } from '../lib/scanCache.js'
import { clearGlyphs, deleteGlyphPage, glyphStoreStats, savePageGlyphs } from '../lib/glyphStore.js'
import { describeOrderFile } from '../lib/orderFile.js'
import { IMAGE_EXTENSIONS, collectDirectoryFiles, findOrderFile, naturalCompare, pickScanInputs } from '../lib/scanInput.js'
import { clearScanDirHandle, loadScanDirHandle, requestScanDirPermission, saveScanDirHandle } from '../lib/scanDirHandle.js'
import { setScanRunning } from '../lib/scanRunState.js'
import { buildPageSheetFromStore } from '../lib/pageSheet.js'
import { LAYOUT, CM } from '../lib/layout.js'
import { CELL_PAD_PT } from '../lib/gridDetector.js'
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
//   让程序一次读全比"手动挑图片、再靠认字反推字序"少一个出错环节 —— 目录里那份 字序.sxorder
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
  // 刚选完文件夹、但这一轮没有拿到可用图片（空目录 / 全是非图片文件）：说这一轮的情况，
  // 不退回"上次识别的来源"（那会让用户以为结果是这个文件夹跑出来的）
  if (pendingPick.value) return '已选文件夹「' + (folderName.value || '（未命名文件夹）') + '」· 没有可用的图片'
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
const message = ref('')
const messageType = ref('info') // info | error | done
// 按钮行里的提示（2026-10-14 用户口径）："还没有可识别的图片…"这类**与那一下点击直接相关**的话，
// 放在「开始识别 / 重新识别」按钮后面，不再另占一行橙色提示条 —— 用户看到的就是"点了这里、为什么没动"
const startNotice = ref('')
const savedStats = ref(null) // 已落盘的字形统计（分片键里的字与体积）
// 已请求中止、还在等这一页跑完（2026-10-15 用户口径："点中止第一次像没反应" —— 立即给按钮与进度行一个反馈）
const stopping = ref(false)
let cancelled = false

const pages = computed(() => store.scan.pages)
// 结果卡片的展示顺序（**2026-10-15 用户口径**，扩展 2026-10-14 的"更正册永远排前面"）：
//   更正册 → 已识别的主区页 → 已作废 → 失败 → 重复页；同组内保持原来的文件顺序。
//   为什么这么排：一眼扫过去先看到"能用的"（更正册与已识别的主区页），再看"要处理的"
//   （作废 / 失败），最后才是"程序已经替你忽略掉的"（重复页）—— 正好是"结果 → 要不要处理 → 被忽略的"
//   这个阅读顺序。只影响渲染顺序，不动 fileIndex / 页序 / 分片键那些真正决定数据的字段。
function cardGroupRank(page) {
  // **"已作废"必须最先判**（2026-10-15 真机反馈："作废更正册再重传之后，看着乱序了"）——
  //   原来先判 `kind === 'correction'`，于是"已作废的更正册件"被归进更正册那一组、
  //   排在**可用的更正册前面**，看上去就像整列顺序被打乱了。作废属于"要处理的"，
  //   不管它原来是什么件，都排到更正册与已识别主区页之后。
  if (page.voided) return 2 // 已作废（用户主动清掉、等着重传）
  if (page.kind === 'correction') return 0 // 更正册永远最前
  if (isDuplicateDropped(page)) return 4 // 重复页（程序已自动忽略，只作说明）
  if (!page.ok) return 3 // 识别失败
  return 1 // 已识别的主区页
}
// 组内排序用**人读页号**（主区页 = 页码；更正册 = 它自己的 1 起页号）；页号没定出来的排组尾
function pageSortNumber(page) {
  return Number.isInteger(page.pageNumber) && page.pageNumber > 0 ? page.pageNumber : 9999
}
const orderedPages = computed(() => pages.value
  .map((p, i) => ({ p, i }))
  // 2026-10-19 用户口径：**同组内按页码排**（原来按文件顺序，补传 / 重传之后看着乱）；
  //   同页号或都没有页号时才退回文件顺序（稳定排序，保证渲染顺序确定）。
  .sort((a, b) => (cardGroupRank(a.p) - cardGroupRank(b.p)) ||
    (pageSortNumber(a.p) - pageSortNumber(b.p)) ||
    (a.i - b.i))
  .map((x) => x.p))
// 这一轮的字序：**只来自目录里的字序文件**（决策 一-18）—— 批次已彻底删除（2026-10-15），
//   没有文件时这一项为空，每页的字完全由纸面参考字定（序列定位）或逐格认字 + 右侧方块里的校验码自证。
//   识别时把它透传给识别线程（scanFlow 的 orderChars）。
const chars = computed(() => (orderFile.value && orderFile.value.ok ? orderFile.value.file.chars : ''))

// 补写清单（重写清单 / 未收录字）作为**候选全序**传给识别线程：重写模板与补写模板上的字既不在
//   字序文件里、也不是任何预置全序的连续段（补写页的页号接在现有纸之后），所以单独带一份下去 ——
//   补写页靠它 + 纸面参考字 + 右侧方块里的校验码自证（见 lib/scanFlow.js 的 ③.5 / ③.6）。一条都没有时返回 undefined。
function rewriteExtraSequences() {
  const text = store.rewriteChars.join('')
  if (!text) return undefined
  return [{ key: 'rewrite', label: '重写清单', chars: Array.from(text) }]
}
const stats = computed(() => store.scanGlyphStats)
// 收批闸门：能不能进下一步（规则在 lib/scanMeta.js，这里只渲染结论）
const gate = computed(() => evaluateScanGate({
  summary: store.scan.summary || { problems: [] },
  pages: pages.value
}))
// 消息区折叠（G，2026-10-21 用户口径）：提示条目经常有五六条，全铺开把结果挤出首屏。
// 默认只留 2 条摘要，其余收进「展开全部 N 条」—— 拦下原因（blockers）不折叠，它必须一眼看到。
const NOTES_LIMIT = 2
const notesExpanded = ref(false)
const visibleNotes = computed(() => notesExpanded.value
  ? gate.value.notes
  : gate.value.notes.slice(0, NOTES_LIMIT))
const hiddenNoteCount = computed(() => Math.max(0, gate.value.notes.length - NOTES_LIMIT))
// 更正册与主区的"字数对账"（2026-10-21 用户口径）：两边的数量对不上就一定是出问题了，
// 必须在识别完成后用红字提醒、让人去核对 —— 否则更正册错位，成字会悄悄换错字。
// 计数口径见 scanMeta.correctionBookStats：留空的格也算一个位置、作废后补写只算一个。
const correctionMismatch = computed(() => {
  if (running.value || !showResult.value) return null
  const mainCircled = pages.value
    .filter((p) => usableForGlyphs(p) && p.kind !== 'correction' && p.counts)
    .reduce((sum, p) => sum + (p.counts.marked || 0), 0)
  if (!mainCircled) return null
  const book = correctionBookStats(pages.value)
  if (!book.lastUsed) return null // 没有更正册：由「更正核对」那一块说"还没有更正册"，不重复
  if (book.logical === mainCircled) return null
  return { mainCircled, ...book }
})
// 同页号有多份"内容不同"的更正册（混批）：程序按文件序先用第一份，其余不参与配对 —— 必须明说
const correctionBookConflicts = computed(() => (running.value || !showResult.value)
  ? []
  : pickCorrectionBookPages(pages.value).conflicts)
// 主区有红圈、却**没有任何更正文**（没传更正册 / 册子一个字没写）：这些字会保留主区原字形（写错的那一版），
// 用户 2026-10-21 要求提到识别结果这块、用红字说清 —— 灰字提示在「更正对应」里太靠下，容易被当成"没配上也正常"。
const missingCorrectionBook = computed(() => {
  if (running.value || !showResult.value) return null
  const mainCircled = pages.value
    .filter((p) => usableForGlyphs(p) && p.kind !== 'correction' && p.counts)
    .reduce((sum, p) => sum + (p.counts.marked || 0), 0)
  if (!mainCircled) return null
  if (correctionBookStats(pages.value).lastUsed) return null // 有更正文 → 交给"对不上"那条判
  const hasBookPage = pages.value.some((p) => usableForGlyphs(p) && p.kind === 'correction')
  return { mainCircled, hasBookPage }
})

// 这一轮的识别汇总（2026-10-13 用户口径）：原来"识别完成：N 页，用时 X 秒"与"这批共 N 页：可用…"
// 各占一行、还分处两块，现在并成一句，跟在「已选文件夹「X」· N 张图片」后面 —— 一眼看完"选了什么、跑出什么"。
// 放在内存里（runInfo）而不是落盘：刷新之后"用时"本来就没有意义，剩下的统计仍由 store 里的页记录给出。
const runInfo = ref(null) // { stopped:boolean, pages:number, seconds:string }
// 2026-10-13 用户口径：**刚选完文件夹、还没识别这一批** —— 这时界面上不该再显示上一批的结论
//   （真机反馈："还没开始识别就给出没有可用的结论，实际上点击识别又是能出结果的"）。
// 什么时候置真：选完文件夹（applyDirFiles）；什么时候置假：开始识别（结果换成这一批的）、清空结果（回初始态）。
const pendingPick = ref(false)
// 当前展示的结果是不是**现在这批**的：刚选完文件夹还没点识别时为假 —— 页卡片、更正核对、汇总都跟着它走
const showResult = computed(() => pages.value.length > 0 && !pendingPick.value)
// 更正册的识别结果（2026-10-13 用户口径：这一块要"包括更正册的识别结果"）——
// 这里只说**识别事实**（更正册几页、写出几格）；"覆盖了几个被圈的字"属配对结论，在下面的更正核对里说。
// **2026-10-14 用户口径**：这一段并进上面的识别汇总、一行展示（原来是下面另起一行）——
//   "这一批跑出了什么"本来就是一件事，分两行反而要多读一遍。
const correctionScanResult = computed(() => {
  const list = pages.value.filter((p) => p.ok && p.kind === 'correction')
  if (!list.length) return ''
  let cells = 0
  for (const p of list) for (const c of p.cells || []) if (c.verdict !== 'empty') cells++
  return '更正册 ' + list.length + ' 页：写出 ' + cells + ' 格'
})
// 识别跑到一半被刷新 / 关掉浏览器（2026-10-15 用户口径："正在识别过程中刷新页面，识别就中断了，
//   且没有任何记录"）：页记录其实是**逐页落盘**的（每页一次 400ms 防抖写），所以已识别的页与字形都还在；
//   缺的只是"整批汇总"——它是收尾时才写的（`finishScanRun`），而 `beginScanRun` 会把它清空。
//   拿它当"这一批跑完了没有"的判据最干净：有页、没有汇总 = 上一轮被打断了。
const interruptedRun = computed(() => !running.value && pages.value.length > 0 &&
  (!store.scan.summary || store.scan.stopped))
const runSummary = computed(() => {
  if (!showResult.value) return ''
  const g = gate.value
  const parts = []
  if (runInfo.value) {
    parts.push((runInfo.value.stopped ? '已中止：' : '识别完成：') + runInfo.value.pages + ' 页，用时 ' + runInfo.value.seconds + ' 秒')
  }
  if (pages.value.length) {
    parts.push('可用 ' + g.usablePages + ' 页' + (g.skipped.length ? '、跳过 ' + g.skipped.length + ' 页' : '') +
      '；写出 ' + stats.value.written + ' 格（可疑 ' + stats.value.suspect + '），被红笔圈 ' + stats.value.marked +
      ' 个，去重后 ' + stats.value.uniqueChars + ' 个字')
    // 2026-10-13 用户口径：这里不再接一句"这一批被拦下（原因见下）"——
    //   真机上明明出了结果（可用 11 页）却因为"有 9 页重复"被拦下，容易让人以为这批白跑了；
    //   拦下的原因仍然**常驻在下面**（真的整批失败时那条一定在）。
    // 2026-10-14：重复页改成**自动去重**，这里补一句结果（详情在下面的提示列表里）
    const dropped = pages.value.filter(isDuplicateDropped).length
    if (dropped) parts.push('其中 ' + dropped + ' 页是重复的、已自动忽略')
  }
  // 更正册的识别结果接在汇总后面（同一条描述行、分号分隔 —— 2026-10-14 用户口径）
  if (correctionScanResult.value) parts.push(correctionScanResult.value)
  return parts.join('；')
})

// ── 页级结果里的"新模型"信息（定位到的字序 / 还要确认几格）──────────────────
// 序列标签：与 lib/referenceCharReader.js 的两份全序一一对应（页记录里只留了 key）。
// 2026-10-20：原来只认 rank、其余一律"笔画序" —— 内置的试打页字序（single）也被误标成"笔画序"
//   （冒烟里 hover 显示"字序：笔画序"、而纸面条码写的是"单页试打 · 按使用频率"）。
function sequenceLabel(seqKey) {
  if (seqKey === 'rank') return '使用频率序'
  if (seqKey === 'single') return '单页试打的名句序'
  if (seqKey === 'barcode') return '底部条码给的字序'
  if (seqKey === 'file') return '字序文件里的字序'
  return '笔画序'
}
// 序列定位命中时，这一页是全序里从第几个字开始的一段 —— 页号由它反推（纸面自己说得清是第几页）
function locatedStartPage(page) {
  return Math.floor(page.located.start / LAYOUT.perPage) + 1
}
// 这一页的字是**从哪儿来的**（决策 一-18 ⑤）：三种来源对用户的信任度不同，必须在界面上说清 ——
//   file 文件夹里的字序文件（文件给死的）/ sequence 纸面参考字序列定位（认出来的）/ cells 逐格认字（猜的）
function orderSourceLabel(page) {
  // 2026-10-18（一-20）：**底部条码**排在最前 —— 它给的是纸面自己写的字序，比"认出来的"更硬
  if (page.orderSource === 'barcode') return '来自底部条码（纸面自己写的字序）'
  if (page.orderSource === 'file') {
    const hit = page.located && page.located.seqKey === 'file'
    return '来自文件夹里的字序文件' + (hit ? '（在文件里定位到第 ' + locatedStartPage(page) + ' 页起）' : '（按右侧方块里的页号取）')
  }
  if (page.orderSource === 'sequence') {
    return sequenceLabel(page.located ? page.located.seqKey : '') + ' · 第 ' + locatedStartPage(page) + ' 页起'
  }
  if (page.orderSource === 'rewrite') return '补写清单（重写模板 / 未收录字，靠纸面参考字与右侧方块里的校验码认）'
  if (page.orderSource === 'cells') return '逐格认字'
  return ''
}
function setMessage(text, type) {
  message.value = text
  messageType.value = type || 'info'
}

onMounted(() => {
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

// ── 目录选择：两条入口，同一套下游处理 ─────────────────────────────────────
// 允许测试在页面里替换"怎么拿到目录内容"这一步（决策 六-13 的冒烟口径：不再靠 CDP 喂件）。
// 挂到 window 上是**唯一**能让自动化脚本介入的地方：系统目录对话框无法无人值守驱动，
//   而识别这一整条链路（挑图片、读字序文件、逐页识别、落盘）都该被冒烟覆盖 —— 替换的只是"选目录"那一下。
// 默认实现就是真实调用：拿目录句柄 → 读根层文件（lib/scanInput.js 的 collectDirectoryFiles）。
// **句柄一起回传**（2026-10-14）：界面把它存进本机存储，刷新之后点「重新识别」就能直接
//   对同一个文件夹再识别一次，不必让用户重选（见 lib/scanDirHandle.js）。
async function pickDirectoryDefault() {
  const handle = await window.showDirectoryPicker({ mode: 'read' })
  const res = await collectDirectoryFiles(handle)
  return { ...res, handle }
}
let pickDirectoryImpl = pickDirectoryDefault

/** 选一个文件夹：拿到文件清单后统一走 applyDirFiles() */
async function onPickDirClick() {
  if (running.value || readingDir.value) return
  readingDir.value = true
  try {
    const res = await pickDirectoryImpl()
    if (!res) return // 用户取消（AbortError 由下面接住，这里兜住"返回空"的实现）
    // 记下句柄（不 await、也不提示失败：它只是"刷新后省一次点击"，坏了不影响任何功能）
    if (res.handle) saveScanDirHandle(res.handle)
    applyDirFiles(res.files || [], res.folderName || '', res.subdirFiles || 0)
  } catch (e) {
    // 用户点了取消：不是错误，什么都不做（静默返回，界面不弹红字）
    if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return
    setMessage('读取文件夹失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    readingDir.value = false
  }
}

/**
 * 刷新页面之后点「重新识别」：**直接对上次那个文件夹再识别一次**（2026-10-14 用户口径）。
 * 为什么能做到：选文件夹时把目录句柄存了本机（lib/scanDirHandle.js）。刷新后权限回到 prompt，
 *   而点这个按钮正是"用户手势"—— 就在这里申请一次读取权限。
 * 拿不回权限 / 浏览器存不了句柄时**不静默**：给一句中文提示，让用户点「重选文件夹」，
 *   并说明这是浏览器的限制（不是程序坏了）。
 * @returns {Promise<boolean>} 文件清单是否已经恢复（true 时调用方继续识别）
 */
async function recoverDirFromHandle() {
  readingDir.value = true
  startNotice.value = ''
  try {
    const handle = await loadScanDirHandle()
    if (!handle) return false
    const granted = await requestScanDirPermission(handle)
    if (!granted) {
      startNotice.value = '上次那个文件夹还没有读取授权：点左边的「' + pickBtnName.value +
        '」再选一次就行（浏览器只允许在你亲自点击时读取它）'
      return false
    }
    const res = await collectDirectoryFiles(handle)
    await applyDirFiles(res.files || [], res.folderName || '', res.subdirFiles || 0)
    return files.value.length > 0
  } catch (e) {
    startNotice.value = '上次那个文件夹读不了了（' + (e && e.message ? e.message : e) +
      '）：点左边的「' + pickBtnName.value + '」再选一次'
    return false
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
  // 选完文件夹就进入"这一批还没识别"的状态：上一批的页卡片、汇总、拦下结论先收起来，
  // 否则用户看到的是"还没开始识别就给出没有可用的结论"（2026-10-13 用户口径）
  pendingPick.value = true
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
    // 字序文件：当前固定名「字序.sxorder」优先，其次是别的 .sxorder，再次是旧版的 字序.json / 别的 .json
    //   （2026-10-16 改扩展名，旧包不作废；次序与判据在 lib/orderFile.js 的 orderFilePriority）
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

// 按钮只有一个（2026-10-13 用户口径：去掉「换一个文件夹」，把「重读上次的文件夹」改成「重选文件夹」）：
// 语义就是"再选一次" —— 每次点都重新弹系统对话框，不再区分"重读上次那个目录"这条捷径。
// 2026-10-14 用户口径：**识别过之后按钮就改名**（"选择文件夹"→"重选文件夹"、"开始识别"→"重新识别"），
//   刷新页面也一样 —— 判据是**落盘的识别来源**（store.scan.source），不是内存里有没有选过文件。
const pickedOnce = computed(() => !!storedSource.value || pages.value.length > 0 || !!scanInput.value)
// 「选择文件夹」只在**没选过**的时候这么说；选过（或刷新后还记着上次那个文件夹）就叫「重选文件夹」，
// 因为它真的会再弹一次系统对话框（判定用落盘的识别来源，刷新后也保持）
// 注意：**提示文案里要用 pickBtnName，不要用 pickLabel** —— 后者在读取期间会变成"正在读取…"，
// 写进"请点左边的「…」"就成了一句看不懂的话（2026-10-15 自查发现）
const pickBtnName = computed(() => (pickedOnce.value ? '重选文件夹' : '选择文件夹'))
const pickLabel = computed(() => {
  if (readingDir.value) return '正在读取…'
  return pickBtnName.value
})
// 「开始识别 / 重新识别」的改名时机（2026-10-14 用户口径，**修订 八-18 ㉟②**）：
//   判据是"**这一批**有没有识别结果"，不是"选过没选过文件夹" —— 刚选完文件夹（结果已收起）、
//   或换了一个文件夹时，按钮回到「开始识别」；识别结束之后才叫「重新识别」。
//   （旧口径按 pickedOnce 改名，于是"第二次选择文件夹后"按钮仍写着「重新识别」，用户当场指出不对。）
const hasRunResult = computed(() => pages.value.length > 0 && !pendingPick.value)
const startLabel = computed(() => (hasRunResult.value ? '重新识别' : '开始识别'))

onMounted(() => {
  // 给自动化脚本留一个注入口（默认是真实实现）：见上面 pickDirectoryImpl 的注释
  window.__sxScanPickDir = {
    set(fn) { pickDirectoryImpl = typeof fn === 'function' ? fn : pickDirectoryImpl },
    // 复位走**同一份默认实现**（不再在这里抄一遍"弹对话框 + 读文件"）——
    // 抄一遍就会多一处"改了默认实现却忘了这里"的地方，而这里正是自动化脚本复位后要用的那条路
    reset() { pickDirectoryImpl = pickDirectoryDefault }
  }
})

async function start(options = {}) {
  if (running.value) return
  // 没有文件时**先试"用上次那个文件夹"**（2026-10-14 用户口径）：刷新页面之后点「重新识别」，
  // 程序应当直接对已选的文件夹再识别一次，而不是让用户重选一遍。句柄存在本机、权限在这个手势里申请；
  // 恢复不了（没存过 / 权限被拒 / 浏览器存不了句柄）才给提示，并说清那是浏览器的限制。
  if (!files.value.length) {
    const recovered = await recoverDirFromHandle()
    if (!recovered) {
      if (!startNotice.value) {
        startNotice.value = '还没有可识别的图片：点左边的「' + pickBtnName.value + '」选一次扫描件所在的文件夹'
      }
      return
    }
  }
  startNotice.value = ''
  // 2026-10-13 用户口径：**第 3 步已经有生成信息时，重新识别要先问一句** ——
  //   整批重新识别会把那份字体产物与体检清单一起清掉（`store.beginScanRun` 里 clearFont()）。
  //   用户点「继续识别」才真的开始（skipConfirm 由弹窗传进来）。
  if (!options.skipConfirm && (store.font.built || store.font.checkup)) {
    restartOpen.value = true
    return
  }
  // 字序文件（有就用它，没有就走"认纸面参考字"那条路，决策 一-18 ⑤）
  const withOrderFile = !!(orderFile.value && orderFile.value.ok)
  const orderChars = withOrderFile ? orderFile.value.file.chars : ''
  const orderPages = withOrderFile ? orderFile.value.file.pageCount : undefined
  // 补写清单（重写清单 / 未收录字，决策 八-8）：这些页的字既不在字序文件里、也不是任何预置全序的
  //   连续段，所以作为**候选全序**单独传给识别线程 —— 闸门分档与页级校验码都靠它认这一页
  const extraSequences = rewriteExtraSequences()
  running.value = true
  // 第 3 步的「生成字体」据此禁用（识别进行中不许生成：结果还在一页页进来，生成完也得再生成一次）
  setScanRunning(true)
  cancelled = false
  openIndex.value = null
  zoomIndex.value = null
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
    // 同一轮重新识别：先把已落盘的字形清掉，避免旧页与新页混在一起（分片键是按页序写的）
    await clearGlyphs()
    savedStats.value = null
    // 把"这批结果来自哪里"记下来（文件夹名 / 图片名清单 / 字序文件摘要）：刷新之后界面靠它回显来源，
    // 而不是显示成"还没有选文件夹"（2026-10-13 用户口径：没有轮次概念，界面说的就是当前数据的状态）
    // 同时把"刚选完文件夹"这个状态收掉：从这一刻起，页面上显示的结果就是这一批的
    pendingPick.value = false
    store.beginScanRun({
      chars: orderChars,
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
      chars: orderChars,
      orderChars,
      orderPages,
      extraSequences,
      // 页数口径：有字序文件时以文件声明的页数为准（识别侧汇总与缺页统计要用它）
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
    store.finishScanRun({ summary: res.summary, stopped: res.stopped })
    // 重复页的结论要**补写回页记录**（2026-10-14 修一个真缺陷）：去重是在 Worker 的逐页循环之后才
    //   算出来的，逐页那批消息里还没有 duplicateOf —— 不补写的话，卡片不标「重复页」、统计与更正配对
    //   全按未去重的页算（真机：12 份同一张纸 → "被红笔圈 29 个"、配对里同一个字出现四行）
    store.applyScanDuplicates(res.duplicates, res.failedDuplicates)
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
    stopping.value = false
    setScanRunning(false)
    stage.value = ''
  }
}

function stop() {
  cancelled = true
  // 中止请求要**跨线程**送过去（决策 六-15 ③）：Worker 是消息驱动的，所以它在两步之间才会看到 ——
  // 表现与旧口径完全一致："当前这一页处理完就停"（不打断正在跑的那一页，一页最多约 2 秒）。
  // **2026-10-15 用户反馈"点中止第一次像没反应"**：那两秒里界面上什么都没有变，所以现在：
  //   ① 按钮立刻变成「正在中止…」并禁点（避免连点）；② 进度行末尾挂一句"已请求中止…"；
  //   ③ 收尾之后由 `scan-interrupted` 那条提示条给出最终结论（中止已落盘，刷新也还在）。
  stopping.value = true
  cancelTask()
  setMessage('已请求中止：当前这一页处理完就停（已识别的页会保留）', 'info')
}

// ── 重新识别前的确认（2026-10-13 用户口径）──────────────────────────────────
// 第 3 步已经有生成信息（字体产物 / 体检清单）时，点「开始识别」先弹一句：
// 整批重新识别会把那些信息一起清掉（这是用户要的"同步清空"，但得先让他知道）。
const restartOpen = ref(false)
function confirmRestart() {
  restartOpen.value = false
  start({ skipConfirm: true })
}

function clearAll() {
  if (running.value) return
  // 只清"结果"：选好的文件夹与手动去掉的清单都留着 —— 用户点"清空结果"多半是想重跑一遍，不是想重新选目录。
  // 但**界面回到初始状态**（2026-10-13 用户口径）：整块「扫描识别的状态与结果」跟着消失，
  // 只留按钮行与「已选文件夹…」那条回执（回执是"选完要有明确回显"的要求，不属于识别结果）
  pendingPick.value = false
  images.value = {}
  openIndex.value = null
  zoomIndex.value = null
  runInfo.value = null
  sheetError.value = {}
  rebuilding.value = {}
  clearPageCache()
  // 字形是落盘的：清结果要连分片键一起清，否则下次识别会与旧字形混在一起。
  // 2026-10-13 改：**按全量清**（不带批次），不再只清当前批次 —— 第 3 步原来那块「清理数据」已删，
  //   这里是"清空识别结果"唯一的入口，而按批次清会留下"别的批次 / 批次 id 为空时落的 default 分片"：
  //   它们既不属于当前批次、也没有任何入口能管（冒烟实测：清完还剩 1 份分片，刷新后仍在）。
  clearGlyphs({}).then((r) => {
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
//   ② **复用原页的 fileIndex**：分片键（`sxfont.glyphs.v2.<fileIndex>`）与内存缓存都按它命名，
//      复用即"原地覆盖"，页序机制一行都不用动；
//   ③ 整页失败（含页级校验没通过）→ **明确失败、不写入**（静默拿错数据比拒绝处理糟得多，沿用二-6 的口径）。
const rescanning = ref(null) // 正在重传 / 补传（同一时刻只允许一件在跑；'supplement' 表示补传那一批）

/**
 * 单页识别 → 归位 → 落盘（**「重传」与「补传扫描件」共用这一条**，2026-10-15 用户口径：
 *   "卡片上的重传的逻辑应该和补传扫描件的逻辑保持一致"）。
 *
 * 归位规则（两者的差别只在这里）：
 *   · 传了 `fileIndex`（重传）：**原地覆盖**原来那一页 —— 卡片位置不跳、页序机制一行不动；
 *   · 没传（补传）：**按识别出的页号找同一个位置** —— 已经有这一页就覆盖它（连同落盘字形），
 *     没有就追加成一页新的。
 * 收不收这一页只由 `evaluateRescanAccept` 判（2026-10-15 起**不再用右侧方块里的校验码拦**，只拒"整页没识别"）。
 *
 * 2026-10-15 修三处真缺陷（都在这一条路上）：
 *   ① **页记录的身份必须回写成落点**：补传不传 fileIndex，Worker 那边只能落成 0，而 target 是按页号
 *      找出来的真实落点 —— 不回写的话页记录自称 0 号、字形却写在 target 的分片键上，凡是按 fileIndex
 *      匹配的地方（去重 / 作废 / 替换 / 缩略图重建 / 字形取原料）全会认错页。
 *   ② **拿不到笔迹掩膜时不许落盘**：`cache.masks` 为空（不是"这一页确实空白"的 `[]`，而是取不到）
 *      时，原来会照样 `savePageGlyphs`，把这一页的分片**覆盖成 0 格** —— 字形与缩略图一起丢。
 *   ③ **被圈字清单变化就作废更正配对**：这条原来只写在「重传」那条路上，补传没有 ——
 *      补传一版重写过的纸之后，更正册里的旧配对会继续盖着这一页的新字形。
 *
 * @param {File} file 新扫的那一张
 * @param {object} [opts]
 * @param {number|null} [opts.fileIndex] 指定落点（重传传原页的 fileIndex）
 * @param {number|null} [opts.fallbackPageNumber] 右侧方块读不出时的兜底页号（重传传原页的页号）
 * @returns {Promise<{ok:boolean, reason?:string, replaced?:boolean, target?:number,
 *   pageNumber?:number|null, written?:number, marked?:number, saved?:number,
 *   markedChanged?:boolean, markedCells?:string}>}
 */
async function ingestOnePage(file, opts = {}) {
  const { record, cache } = await recognizePageInWorker(file, {
    chars: chars.value,
    // 字序来源与整批识别一致：文件夹里有字序文件就按文件定（决策 一-18），没有才走"认纸面参考字"
    orderChars: orderFile.value && orderFile.value.ok ? orderFile.value.file.chars : '',
    orderPages: orderFile.value && orderFile.value.ok ? orderFile.value.file.pageCount : undefined,
    // 补写清单（重写清单 / 未收录字）作为候选全序：这类页的字不在字序文件里，靠它 + 右侧方块里的校验码认
    extraSequences: rewriteExtraSequences(),
    fileIndex: opts.fileIndex === null || opts.fileIndex === undefined ? undefined : opts.fileIndex,
    pageNumberOverride: opts.fallbackPageNumber || undefined,
    onStage: (text) => setMessage('正在识别「' + file.name + '」：' + text, 'info')
  })
  const verdict = evaluateRescanAccept({ record })
  if (!verdict.accept) return { ok: false, reason: verdict.message }

  // 落点：指定了就用它；否则按"页号 + 件类型"找同页（更正册只能落在更正册页上）
  let target = opts.fileIndex
  if (target === null || target === undefined) {
    const same = store.scan.pages.find((p) => p.ok && p.pageNumber &&
      p.pageNumber === record.pageNumber &&
      (p.kind === 'correction') === (record.kind === 'correction'))
    target = same ? same.fileIndex : store.scan.pages.reduce((m, p) => Math.max(m, p.fileIndex), -1) + 1
  }
  // ① 身份回写：页记录里的 fileIndex 必须等于它真正的落点（见函数头注释）
  record.fileIndex = target
  // ③ 覆盖前的被圈字清单（重传与补传共用同一判据）
  const previous = store.scan.pages.find((p) => p.fileIndex === target) || null
  const markedBefore = ((previous && previous.markedCells) || []).join(',')

  // ② 掩膜取不到（null）时**不落盘、不覆盖内存缓存**：宁可这一页保持原样并明确报错，
  //    也不能把好端端的分片写成 0 格（那正是"作废后重传、再生成少字形"的成因）
  const hasMasks = Array.isArray(cache.masks)
  let saved = null
  if (hasMasks) {
    saved = await savePageGlyphs({
      fileIndex: target,
      pageNumber: record.pageNumber,
      glyphs: cache.masks.map((m) => ({
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
  }

  const nextPages = store.scan.pages.map((p) => (p.fileIndex === target ? record : p))
  if (!nextPages.some((p) => p.fileIndex === target)) nextPages.push(record)
  // 归位之后要重算两件事，判据都与整批识别共用：
  //   ① 重复页去重（补进来的件可能与已有的页同号 —— 采用哪一份要跟着重挑）
  //   ② 整批汇总（页号重复 / 缺页 / 收批闸门都读它）
  const { duplicates, failedDuplicates } = markDuplicatePages(nextPages)
  const summary = summarizeBatch(nextPages, {
    sheetPages: orderFile.value && orderFile.value.ok ? orderFile.value.file.pageCount : undefined
  })
  // 掩膜拿不到时**保留内存里原有的那一份**（不拿空 cache 盖掉它）
  if (hasMasks) {
    putPageCache(target, cache)
    images.value = { ...images.value, [target]: { thumb: cache.thumb, sheet: cache.sheet } }
  }
  if (openIndex.value === target) openIndex.value = null
  zoomIndex.value = null
  const res = store.replaceScanPage({ fileIndex: target, record, summary })
  store.applyScanDuplicates(duplicates, failedDuplicates)
  // ④ 新写的字形**自动移出重写清单**（2026-10-15 用户拍板）：重写清单的语义是"先不进字体、
  //    以后补上"—— 补上了自然要回来（不自动移出的话，新字形会被 excluded 挡在字体外，补写白写）。
  //    旧字形不会丢：主区那份仍在落盘分片里，只是排在前面、输给新写的（buildGlyphFont 后到优先）。
  const writtenChars = (record.cells || [])
    .filter((c) => c.char && c.verdict !== 'empty')
    .map((c) => c.char)
  const rewriteCleared = store.clearRewriteFor(writtenChars)
  // ③ 被圈字清单变了 → 之前的更正配对失效（配对依赖被圈字清单，一-7 / 八-14 ④）
  const markedChanged = markedBefore !== (record.markedCells || []).join(',')
  if (markedChanged) store.resetCorrection()
  savedStats.value = await glyphStoreStats().catch(() => savedStats.value)
  return {
    ok: true,
    replaced: res.replaced,
    target,
    pageNumber: record.pageNumber,
    written: record.counts.written,
    marked: record.counts.marked,
    saved: saved ? saved.count : 0,
    markedChanged,
    rewriteCleared,
    markedCells: (record.markedCells || []).join(',')
  }
}

/** 重传这一页（清单 一-8）：入口在每张结果卡片上，点它会弹文件选择器挑新扫的那一张 */
async function rescanPage(page, event) {
  const file = (event.target.files || [])[0]
  event.target.value = '' // 清空，便于再选同一个文件
  if (!file || running.value || rescanning.value !== null) return
  rescanning.value = page.fileIndex
  try {
    const r = await ingestOnePage(file, { fileIndex: page.fileIndex, fallbackPageNumber: page.pageNumber })
    if (!r.ok) {
      setMessage(r.reason, 'error')
      return
    }
    // 被圈字变了 → 配对已在 ingestOnePage 里作废（重传与补传共用同一判据），这里只负责说清楚
    setMessage(
      '已重传第 ' + (r.pageNumber || page.pageNumber || '?') + ' 页（' + file.name + '）：写出 ' +
        r.written + ' 格（' + r.saved + ' 格已落盘）/ 被圈 ' + r.marked + ' 个' +
        (r.rewriteCleared && r.rewriteCleared.length
          ? '；其中 ' + r.rewriteCleared.length + ' 个字已有新写的字形，已自动移出重写清单（' + r.rewriteCleared.join('、') + '）'
          : '') +
        (r.markedChanged ? '。这一页的被圈字有变化，之前的更正配对已作废，请在下面的「更正核对」里重新核对' : '') +
        '。这一页的字形已更新，字体要重新生成才生效',
      r.markedChanged ? 'info' : 'done'
    )
  } catch (e) {
    setMessage('重传失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    rescanning.value = null
  }
}

/**
 * 补传扫描件（2026-10-15 用户口径）：识别跑完之后又补扫了几页 —— 把那些件一次丢进来即可，
 * 不必整批重来。归位规则与「重传」完全一致（见 ingestOnePage）：**同一页就覆盖、新页就追加**。
 * 补完会同步作废第 3 步的字体产物与体检清单（`replaceScanPage` 里做的），并当场给一句提示。
 */
async function supplementFiles(event) {
  const list = Array.from(event.target.files || [])
  event.target.value = ''
  if (!list.length || running.value || rescanning.value !== null) return
  rescanning.value = 'supplement'
  let added = 0
  let replaced = 0
  let markedChanged = 0
  const clearedRewrite = []
  const failed = []
  try {
    for (const file of list) {
      try {
        const r = await ingestOnePage(file)
        if (!r.ok) {
          failed.push(file.name + '：' + r.reason)
          continue
        }
        if (r.replaced) replaced++
        else added++
        if (r.markedChanged) markedChanged++
        for (const ch of r.rewriteCleared || []) clearedRewrite.push(ch)
      } catch (e) {
        failed.push(file.name + '：' + (e && e.message ? e.message : e))
      }
    }
    setMessage(
      '补传完成：新增 ' + added + ' 页' + (replaced ? '、覆盖 ' + replaced + ' 页' : '') +
        (clearedRewrite.length
          ? '；' + clearedRewrite.length + ' 个字已有新写的字形，已自动移出重写清单（' + clearedRewrite.join('、') + '）'
          : '') +
        (markedChanged ? '；有 ' + markedChanged + ' 页的被圈字与原来不同，更正配对已按新的结果重算' : '') +
        (failed.length ? '；' + failed.length + ' 张没能收下（' + failed.join('；') + '）' : '') +
        '。第 3 步的字体产物与体检清单已作废，回第 3 步点「生成字体」重新生成一次即生效',
      failed.length ? 'info' : 'done'
    )
  } finally {
    rescanning.value = null
  }
}

// ── 作废一页（2026-10-15 用户口径：结果卡片上的「作废」）────────────────────────
// 与「重传」是一对：重传 = 立刻用新扫的件替换这一页；作废 = 先把它清掉（卡片留着），
//   之后想什么时候重扫都行。语义与"整批重新识别"类似但**只作用于这一页**。
const voidTarget = ref(null)
function openVoid(page) {
  if (running.value) return
  voidTarget.value = page
}
async function confirmVoid() {
  const page = voidTarget.value
  voidTarget.value = null
  if (!page || running.value) return
  // ① 落盘的字形按页删掉（不删的话下次生成字体还会把它当"这一页的字形"）
  const removed = await deleteGlyphPage({ fileIndex: page.fileIndex })
    .catch(() => ({ ok: false, removed: 0 }))
  // ② 内存里的分片缓存与缩略图也清掉
  clearPageCache(page.fileIndex)
  const nextImages = { ...images.value }
  delete nextImages[page.fileIndex]
  images.value = nextImages
  if (openIndex.value === page.fileIndex) openIndex.value = null
  if (zoomIndex.value !== null) zoomIndex.value = null
  // ③ 页记录降级成"已作废"占位 + 重算整批汇总与去重（这一页退出全部统计）
  const preview = store.scan.pages.map((p) => (p.fileIndex === page.fileIndex ? { ...p, ok: false, voided: true } : p))
  const { duplicates, failedDuplicates } = markDuplicatePages(preview)
  const summary = summarizeBatch(preview, {
    sheetPages: orderFile.value && orderFile.value.ok ? orderFile.value.file.pageCount : undefined
  })
  store.voidScanPage({ fileIndex: page.fileIndex, summary })
  store.applyScanDuplicates(duplicates, failedDuplicates)
  savedStats.value = await glyphStoreStats().catch(() => savedStats.value)
  setMessage('已作废「' + page.fileName + '」：这一页的识别结果与字形都清掉了 —— 卡片还留着，' +
    '点「重传」可以把这一页重新扫进来；第 3 步的字体要重新生成才生效' +
    (removed && removed.removed ? '' : '（这一页本来就没有落盘的字形）'), 'info')
}
// ── 手选页序：**2026-10-15 用户拍板彻底去掉** ──────────────────────────────
// 原来右侧方块读不出的页要靠用户在卡片上填页号、或拖着缩略图排页序（决策 二-7）。现在不做了：
//   · 右侧方块读不出时，页号与整页字序由**纸面参考字序列定位**定（决策 五-9 的新模型）；
//   · 定不出来的页，页级校验码也帮不上（它本来就要求先猜出"这一页是哪些字"），整页明确失败、重扫即可。
// 去掉的理由：这条操作把"识别准确性"的最后一公里交给了用户，而它本身极易出错（顺序一错整批错字）；
//   而序列定位 + 页级校验码已经把这件事变成程序能自证的。相关字段（scan.orderOverrides）只留给旧数据兼容。

// ── 结果卡片（2026-10-12 用户口径，决策 八-16 ④⑤）──────────────────────────
// 卡片上只放四样：文件名、状态（颜色 + 一个短词）、一行统计、三个操作。
// 缩略图与 136 格视图收进「看格子」弹窗（点开才渲染），完整信息塞进 title（hover 才看）——
// 五六十页时旧的行式列表既常驻几十张 dataURL 图、又被页数拉得很长，卡片化之后列表长度与图片都受控。
// 状态四态（外加"重复页"）：成功 = 绿、失败 = 红、待处理 = 橙、更正册 = 青（不是"失败"，是另一类件）；
// 2026-10-14 新增"重复页"（灰）：同一页号有多份时程序自动采用效果最好的一份，其余标 `duplicateOf`
//   —— 它们既不算可用页、也不算失败页（口径见 lib/scanMeta.js 的 dedupeDuplicatePages）
function isDuplicateDropped(page) {
  return !!page && page.duplicateOf !== undefined && page.duplicateOf !== null
}
function cardClass(page) {
  if (isDuplicateDropped(page)) return 'is-duplicate'
  // 已作废（2026-10-15）：灰掉，与"失败"分开说 —— 它不是识别失败，是用户主动清掉的
  if (page.voided) return 'is-voided'
  if (!page.ok) return 'is-failed'
  if (page.kind === 'correction') return 'is-correction'
  return 'is-ok'
}
function cardStatusLabel(page) {
  if (isDuplicateDropped(page)) return '重复页'
  if (page.voided) return '已作废'
  if (!page.ok) return '失败'
  if (page.kind === 'correction') return '更正册'
  return '已识别'
}
/** 被采用的那一份的文件名（"重复页"卡片上要说清结果里用的是哪一份）——
    两种情形都走它：**识别成功但被判重**的页（`duplicateOf`），与**整页失败、右侧方块却同页号**的页
    （`failedDuplicateOf`，折角页 / 去阴影页那种） */
function adoptedName(page) {
  const idx = page.duplicateOf !== undefined && page.duplicateOf !== null
    ? page.duplicateOf
    : page.failedDuplicateOf
  const adopted = pages.value.find((p) => p.fileIndex === idx)
  return adopted ? adopted.fileName : ('第 ' + (idx + 1) + ' 个文件')
}
// 页号与"这个页号是怎么来的"（可信度不同，必须逐页说清）：
//   条码 / 指纹反推 / 序列定位（都由纸面自证）> 右侧方块读出 > 重传沿用原页
function pageNumberLabel(page) {
  if (page.kind === 'correction' && page.pageNumber) return '更正册第 ' + page.pageNumber + ' 页'
  if (page.pageNumberSource === 'barcode') return '第 ' + page.pageNumber + ' 页（按底部条码）'
  if (page.pageNumberSource === 'code') return '第 ' + page.pageNumber + ' 页（按右侧方块里的校验码反推）'
  if (page.pageNumberSource === 'sequence') return '第 ' + page.pageNumber + ' 页（按纸面参考字序定位）'
  if (page.footerOk) return '第 ' + page.pageNumber + ' 页（右侧方块读出）'
  if (page.pageNumber) return '第 ' + page.pageNumber + ' 页（沿用原页）'
  return '页号没定出来'
}
// hover 的完整信息（多行）：页号来源 / 本页校验码 / 方向纠正 / 四角误差 / 字序来源 / 写出统计
function cardTitle(page) {
  const lines = [page.fileName, pageNumberLabel(page)]
  const bits = []
  if (page.footerOk && page.kind !== 'correction' && page.pageCode) {
    const agree = page.pageCheck ? page.pageCheck.agree : null
    bits.push('本页校验码 ' + page.pageCode +
      (agree === true ? '（与识别出的字序一致）' : (agree === false ? '（与识别出的字序对不上）' : '')))
  }
  if (page.kind === 'correction') {
    bits.push(page.legacyPaper
      ? '更正册（旧版本印的纸：那批右侧方块里没有本页校验码，按更正册收下）'
      : '更正册（按页号区间识别，没有本页校验码）')
  }
  // 2026-10-13：右侧方块读不出、方向是按纸面参考字救回来的页，说清它是怎么定的
  if (page.orientation && page.orientation.rescuedByReference) {
    bits.push('右侧方块读不出：方向按纸面参考字定（认得出 ' + (page.orientation.rescueSure || 0) + ' 格' +
      (page.orientation.rescueLocated ? '、字序也定位上了' : '') + '）')
  } else if (page.orientation && page.orientation.corrected) {
    bits.push('已自动转正 ' + page.orientation.turns * 90 + ' 度')
  }
  if (page.cornerMaxError !== null && page.cornerMaxError !== undefined) bits.push('四角误差 ' + page.cornerMaxError + ' 像素')
  if (bits.length) lines.push(bits.join(' · '))
  if (page.orderSource) lines.push('字序：' + orderSourceLabel(page))
  // 重复页（2026-10-21 用户口径）：卡片正文说"已自动忽略"、hover 却只报统计，会让人以为两边信息打架。
  // 这里说清"统计是它自己的、未计入结果"，与卡片正文同一口径。
  if (isDuplicateDropped(page)) {
    lines.push('重复页：与「' + adoptedName(page) + '」的页号相同，已自动忽略（下面的统计是这一页自己的，未计入结果）')
  }
  // A1（2026-10-21 用户口径）：没有底部条码的页 = 降级路径 —— 字序只能靠序列定位 / 逐格认字推断，
  //   与"条码自证"不是一个可靠性。卡片上给一个短标记，hover 里说清字序从哪来。
  if (page.ok && page.barcodeOk === false && page.kind !== 'correction') {
    lines.push('无底部条码：字序来自' + (orderSourceLabel(page) || '推断') + '（降级路径，可靠性低于条码自证）')
  }
  if (page.ok) {
    lines.push('写出 ' + page.counts.written + ' 格（可疑 ' + page.counts.suspect + '）· 被圈 ' + page.counts.marked + ' 个' +
      (page.counts.uncertain ? ' · 归属待确认 ' + page.counts.uncertain : ''))
  } else {
    lines.push(page.reason || '这一页没能识别')
  }
  return lines.join('\n')
}
// 弹窗里的一行摘要：与 hover 同一份信息，压成一行（弹窗顶部）
function sheetSummary(page) {
  return cardTitle(page).split('\n').slice(1).join('；')
}

// 弹窗里那一页的页记录（由「看格子」设置 openIndex；没有打开时是 null，弹窗整块不渲染）
const sheetPage = computed(() => pages.value.find((p) => p.fileIndex === openIndex.value) || null)

// ── 格级视图（在「看格子」弹窗里渲染）────────────────────────────────────
// 2026-10-22 用户口径：卡片上的按钮**固定写「看格子」**，它只负责打开 / 切到这一页，
//   不负责关闭（弹窗右上角已有「关闭」）—— 按钮不再随弹窗状态改文案。
function togglePage(page) {
  if (!page.ok) return
  openIndex.value = page.fileIndex
  zoomIndex.value = null
  ensureSheet(page)
}
function closeSheet() {
  openIndex.value = null
  zoomIndex.value = null
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
// 越线冗余说明（2026-10-22 用户要求）：把"多收多少、什么收得进、什么收不进"写在单格弹窗里。
// 数值取自版式契约（CELL_PAD_PT 由中缝推导，改版式时自动跟着变），不在这里手写死。
const zoomOverflowHint = '笔画越线：每格切片会多收书写格外 ' + CELL_PAD_PT + 'pt（约 ' +
  (CELL_PAD_PT / CM * 10).toFixed(1) + 'mm）—— 这个范围内的越线笔画会进字形' +
  '（越线时字形等比缩小、不裁掉笔画）；再往外就切不到、不会收进字体。'
const zoomIsMarkedLabel = computed(() => {  const z = zoomCell.value
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
    <!-- ① 识别方式：指定一个文件夹。
         2026-10-13 用户口径：**整行说明去掉**（"选一个文件夹即可…直接确认即可"那一整段）——
            它说的与这一步的说明、按钮本身重复，界面上每多一段长文，真正的操作就更难找。
         仍保留的只有一条：**这台浏览器没有系统文件夹对话框**（Firefox / Safari 走退路）——
            "不静默降级"是决策 六-13 的要求，所以那句挪到下面按钮行里，只在缺这个接口时出现。
         2026-10-11（决策 二-18 / 一-18）：不再手动挑图片、也不再选批次 ——
            给一个文件夹，程序读里面的图片与 字序.sxorder；没有字序文件时才靠"认纸面参考字"定字序 -->

    <!-- ② 文件夹与进度 -->
    <div class="panel-row">
      <div class="panel-field">
        <!-- 主路：系统文件夹对话框（showDirectoryPicker）。
             2026-10-13 用户口径：只留一个按钮 —— 去掉「换一个文件夹」，「重读上次的文件夹」改成
             「重新选择文件夹」，点它就重新弹对话框（不再有"直接重读上次那个目录"这条捷径）。
             退路：这台浏览器没有这个接口（Firefox / Safari）时改用 <input webkitdirectory>，
             那句说明跟在按钮后面（只在缺这个接口时出现，不静默降级） -->
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
          :disabled="running || readingDir"
          :title="files.length ? '' : '还没有文件：点左边的「' + pickBtnName + '」选一个文件夹；直接点本按钮会先试着用上次那个文件夹'"
          @click="start()"
        >{{ startLabel }}</button>
        <button v-if="running" type="button" data-role="scan-stop" :disabled="stopping" @click="stop">{{ stopping ? '正在中止…' : '中止' }}</button>
        <!-- 补传扫描件（2026-10-15 用户口径）：识别跑完之后又补扫了几页时用 ——
             把那些件一次丢进来，按页号归位（**同一页就覆盖、新的一页就追加**，与卡片上的「重传」同一条逻辑），
             补完会作废第 3 步的字体产物并给提示，不必整批重来 -->
        <label
          v-if="showResult"
          class="inline-file-button"
          :class="{ disabled: running || rescanning !== null }"
          data-role="supplement-pages"
          title="补扫的页丢进来：按页号归位（已有这一页就覆盖它、没有就追加一页）；补完第 3 步的字体要重新生成"
        >
          {{ rescanning === 'supplement' ? '补传中…' : '补传扫描件' }}
          <input
            type="file"
            accept="image/*"
            multiple
            :disabled="running || rescanning !== null"
            @change="supplementFiles"
          />
        </label>
        <span v-if="readingDir" class="panel-hint">正在读取文件夹…</span>
        <!-- 与这一下点击直接相关的话放在按钮后面（2026-10-14 用户口径）：
             "还没有可识别的图片…"原来另占一整行橙色提示条，离按钮很远 -->
        <span v-if="startNotice" class="panel-hint scan-start-note" data-role="start-notice">{{ startNotice }}</span>
        <!-- 只有缺 showDirectoryPicker 的浏览器才说这一句（Firefox / Safari 走 <input webkitdirectory> 退路） -->
        <span v-if="!canPickDirectory" class="panel-hint" data-role="no-dir-picker">
          这台浏览器没有系统文件夹对话框（Firefox / Safari 不支持），这里改用普通文件夹选择器，功能一样；想要系统对话框请用 Chrome 或 Edge（86+）。
        </span>
      </div>
    </div>
    <!-- ③ 扫描识别的状态与结果（2026-10-13 用户口径，两轮下来的定版）：
         标题行 = 「扫描识别的状态与结果」+ 灰色的来源回执（哪个文件夹、多少张图）+ 操作按钮
           （「看文件清单」，以及有跳过页时的「看跳过的 N 页」）—— 按钮跟着回执走，不再单独占一行；
         下面依次三行描述：识别汇总 / 更正册的识别结果 / 字形落盘，再往下才是拦下的原因与数据兜底说明。
         **这一块只在有识别结果、或刚选完文件夹还没识别时出现**：
           · 点「清空结果」之后整块消失，页面回到初始状态（2026-10-13 用户口径）；
           · 刚选完文件夹时只显示回执与下一步提示 —— 上一批的结论先收起来，
             否则会出现"还没开始识别就给出没有可用的结论"（真机反馈）。
         **「清空结果」不在这一块里** —— 它挪到步骤标题行右侧（见下面的 Teleport），
         与第 1 步「更新预览」同一个位置。 -->
    <div v-if="showResult || pendingPick" class="scan-status" data-role="scan-status">
      <div class="scan-status-head">
        <span class="scan-status-title">扫描识别的状态与结果</span>
        <!-- 来源：刷新前是内存里那份（可去掉 / 放回），刷新后是识别时落盘的那份（只读回显）——灰色提示，不加粗 -->
        <span v-if="dirNote" class="panel-hint" data-role="dir-note">{{ dirNote }}</span>
        <span class="scan-status-actions">
          <button class="text" type="button" data-role="file-list" :disabled="!canOpenFileList" @click="fileListOpen = true">
            看文件清单
          </button>
          <button v-if="showResult && gate.skipped.length" class="text" type="button" data-role="skipped-open" @click="skippedOpen = true">
            看失败的 {{ gate.skipped.length }} 页
          </button>
        </span>
      </div>

      <!-- 刚选完文件夹、还没识别这一批：块里只留标题行（回执 + 按钮），
           上一批的汇总 / 拦下结论 / 卡片都收起来 —— 下面那段"选好文件夹后点「开始识别」…"就是这一步的引导 -->

      <template v-if="showResult">
        <!-- G（2026-10-21 用户口径）：这一块给一个标题，汇总 / 提示 / 卡片都归在它下面 -->
        <p class="scan-result-title" data-role="result-title">识别结果</p>
        <!-- 两行描述：识别汇总（含更正册的识别结果，分号分隔）→ 字形落盘 -->
        <p v-if="runSummary" class="panel-hint" data-role="run-summary">{{ runSummary }}</p>
        <p v-if="savedStats && savedStats.glyphs" class="panel-hint" data-role="glyph-saved">
          字形已落盘：{{ savedStats.pages }} 页 / {{ savedStats.glyphs }} 个字 / {{ (savedStats.bytes / 1024 / 1024).toFixed(1) }} MB
          —— <strong>刷新或关掉浏览器后不用重扫</strong>
        </p>
        <!-- 上一轮识别没跑完（**用户点了「中止」**，或识别中途刷新 / 关掉浏览器）：
             两种情况都提示清楚，并说清接下来能做什么（2026-10-15 用户口径："停下来了要有提示"） -->
        <p v-if="interruptedRun" class="step-note" data-role="scan-interrupted">
          <template v-if="store.scan.stopped">上一次识别是<strong>中途停止</strong>的（已经识别 {{ pages.length }} 页）——</template>
          <template v-else>上一次识别没有跑完就中断了（已经识别 {{ pages.length }} 页）——</template>
          已识别的页与字形都还在，可以点「重新识别」整批重跑，或用「补传扫描件」把没扫到的那些补进来。
        </p>

        <!-- 收批闸门：**拦下的原因与提示常驻在这里**（必须一眼看到，不跟着详情进弹窗）；
             逐页的"跳过：第 N 个文件…"清单收进「看跳过的 N 页」弹窗 —— 它常常几十条、原因还一模一样。
             **识别进行中一律不下结论**（2026-10-15 用户口径）：闸门读的是"当前已识别的那些页"，
             跑到一半时"只有更正册可用"这类话必然出现 —— 那只是"主区那几张还没轮到"，
             摆在界面上就是误导（真机上扫到一半就弹这条）。 -->
        <ul v-if="!running && gate.blockers.length" class="scan-problems">
          <li v-for="(text, i) in gate.blockers" :key="'b' + i" class="error">拦下：{{ text }}</li>
        </ul>
        <ul v-if="!running && gate.notes.length" class="scan-problems">
          <li v-for="(text, i) in visibleNotes" :key="'n' + i" class="info">{{ text }}</li>
        </ul>
        <!-- 提示条数多时默认只留 2 条，其余折叠（G）—— 拦下原因不折叠 -->
        <button
          v-if="!running && hiddenNoteCount"
          class="text"
          type="button"
          data-role="notes-toggle"
          @click="notesExpanded = !notesExpanded"
        >{{ notesExpanded ? '收起' : '展开全部 ' + gate.notes.length + ' 条' }}</button>
        <!-- 同页号多份"内容不同"的更正册（混批）：程序只用第一份，必须说清用哪份、怎么换 -->
        <ul v-if="correctionBookConflicts.length" class="scan-problems">
          <li v-for="(c, i) in correctionBookConflicts" :key="'cc' + i" class="warn">
            第 {{ c.pageNumber }} 页的更正册有 {{ c.others.length + 1 }} 份、内容不同：程序按文件顺序先用
            「{{ c.chosen.fileName }}」，其余 {{ c.others.map((o) => '「' + o.fileName + '」').join('、') }} 不参与配对。
            要改用另一份，就在「看文件清单」里去掉「{{ c.chosen.fileName }}」再识别一次。
          </li>
        </ul>
        <!-- 有红圈、却没有更正册（或册子一个字没写）：红字、常驻（2026-10-21 用户口径） -->
        <p v-if="missingCorrectionBook" class="scan-mismatch" data-role="missing-correction-book">
          主区有 {{ missingCorrectionBook.mainCircled }} 个被红笔圈掉的字，但{{ missingCorrectionBook.hasBookPage ? '更正册上一个字也没写' : '这一批没有更正册' }}：
          这些字会<strong>保留主区原字形（写错的那一版）</strong>，不会用更正册的字形。
          要更正的话，把第 1 步压缩包里的空白更正册按被圈字的顺序写好，和主区放进同一个文件夹再识别一次。
        </p>
        <!-- 更正册与主区被圈字对不上（2026-10-21 用户口径）：红字、常驻、识别完成后才给 -->
        <p v-if="correctionMismatch" class="scan-mismatch" data-role="correction-mismatch">
          更正册与主区对不上：主区被红笔圈了 {{ correctionMismatch.mainCircled }} 个字，更正册写到第
          {{ correctionMismatch.lastUsed }} 格（其中留空 {{ correctionMismatch.blank }} 格、作废
          {{ correctionMismatch.discarded }} 格，合逻辑 {{ correctionMismatch.logical }} 个）——
          两边的数量不一致，更正册无法一一对应。请人工核对下面的「更正核对」，或按被圈字的数量重写更正册。
        </p>
        <!-- 识别进行中不给"可以继续"这类结论（2026-10-13 用户口径：还没结束，别下结论） -->
        <p v-if="gate.canProceed && !running" class="panel-message done">
          这一批可以继续：<span v-if="(store.correction.circled || []).length">被红笔圈掉的字在下面的「更正核对」里可以逐行核对与调整（不改就是程序按识别结果配的那一套，直接用于生成字体）</span><span v-else>主区没有被红笔圈掉的字，可以直接进第 3 步「生成」了</span>
        </p>
        <!-- 2026-10-13 用户口径：原来这里还有一条"识别结果与字形保存在**本机浏览器**里，刷新与关浏览器
             都不丢；清理浏览器数据或换电脑才会没有…扫描件原图程序不留，请自己留一份"——
             与"字形已落盘…刷新或关掉浏览器后不用重扫"说的是同一件事，去掉（这套口径在《使用说明》里）。 -->
      </template>
    </div>
    <!-- 「清空结果」：放在步骤标题行右侧（2026-10-13 用户口径 —— 与第 1 步「更新预览」同一个位置）。
         它作用的是"结果"，所以只要有结果就给入口；识别进行中禁点 -->
    <Teleport to="#step-head-actions">
      <button class="text" type="button" data-role="scan-clear" :disabled="running || !pages.length" @click="clearAll">
        清空结果
      </button>
    </Teleport>
    <!-- 进度（决策 二-18 ④）：在做什么 / 已完几页 / 还剩几步 / 预计还要多久。
         2026-10-13 用户口径两条：① **固定长度的信息在前、不断变化的"当前页动作"放最后** ——
         原来"当前：第 2 / 14 页 · 正在切格（…）"在最前面，括号里的字一直在变长变短，
         把后面的"进度 / 还剩"推来推去（真机上看着在跳）；② 用与"识别结果与字形…"同一种提示条样式 -->
    <p v-if="running" class="step-note" data-role="scan-progress">
      进度 {{ progress.done }} / {{ progress.total }} 页；还剩 {{ progress.total - progress.done }} 页（约 {{ remainingSteps }} 步）<span v-if="etaLabel">，预计还要 {{ etaLabel }}</span>；
      当前：第 {{ progress.currentPage }} / {{ progress.total }} 页 · {{ stage || '准备中' }}<strong v-if="stopping">（已请求中止，当前这一页跑完就停）</strong>
    </p>
    <p v-if="message" class="panel-message" :class="messageType" data-role="scan-message">{{ message }}</p>

    <!-- ④ 结果总览：**一页一张小卡片**（2026-10-12 决策 八-16 ④⑤）——
         卡片只有文件名、状态、一行统计与三个操作；缩略图与 136 格视图收进「看格子」弹窗、点开才加载；
         完整信息（页号来源 / 校验码 / 方向纠正 / 四角误差 / 字序来源 / 写出统计）在 hover 的 title 里 -->
    <div v-if="showResult" class="scan-cards" data-role="scan-cards">
      <div
        v-for="page in orderedPages"
        :key="page.fileIndex"
        class="scan-card"
        :class="[cardClass(page), { active: openIndex === page.fileIndex }]"
        :data-file-index="page.fileIndex"
        :data-page-number="page.pageNumber === null ? '' : page.pageNumber"
        :data-ok="page.ok ? '1' : '0'"
        :data-status="cardStatusLabel(page)"
        :data-role="'scan-card'"
        :title="cardTitle(page)"
        @dragover="onDragOver(page, $event)"
        @drop="onDropPage(page)"
      >
        <div class="scan-card-head">
          <!-- 2026-10-15 用户拍板：**拖动改页序这条操作已去掉**（连同卡片上的手选页序）——
               右侧方块读不出时页号与字序由纸面参考字序列定位定，定不出来就整页失败重扫；
               把准确性交给用户去填数字，本身就是最容易出错的一环（顺序一错整批错字）。 -->
          <span class="scan-card-name" :title="page.fileName">{{ page.fileName }}</span>
          <span class="scan-card-badge">{{ cardStatusLabel(page) }}</span>
        </div>
        <p class="scan-card-stats">
          <!-- 作废的页**优先说"已作废"**（2026-10-15）：它是用户主动清掉的，不能落到下面"没能识别"那个分支上
               —— 真机上它曾被显示成"与某页重复、这一份没能识别"，把用户看糊涂了 -->
          <template v-if="page.voided">
            已作废：这一页的识别结果与字形都清掉了 —— 点「重传」可以重新扫这一页
          </template>
          <template v-else-if="isDuplicateDropped(page)">
            这一页与「{{ adoptedName(page) }}」的页号相同：已自动忽略（结果里用的是那一份 ——
            程序按"认出的红圈数 → 能用的字形数"挑的）；想改用这一份，就在「看文件清单」里去掉那一张再识别
          </template>
          <!-- 整页失败、但右侧方块读出了同一个页号：说清"它其实是同一页的另一份"（2026-10-15 用户口径）——
               真机上的折角页与"去阴影"页就是这种：它们与主件是同一张纸，用户看到两页失败会以为漏了什么 -->
          <template v-else-if="page.failedDuplicateOf !== undefined && page.failedDuplicateOf !== null">
            这一页与「{{ adoptedName(page) }}」的页号相同（那一份已经识别成功）—— 这一份没能识别：{{ page.reason }}
          </template>
          <template v-else-if="page.ok">
            写出 {{ page.counts.written }} 格（可疑 {{ page.counts.suspect }}）· 被圈 {{ page.counts.marked }} 个<span
              v-if="page.counts.uncertain"
            > · 归属待确认 {{ page.counts.uncertain }}</span><span
              v-if="page.barcodeOk === false && page.kind !== 'correction'"
              class="scan-card-degraded"
            > · 无条码</span>
          </template>
          <template v-else>{{ page.reason }}</template>
        </p>
        <div class="scan-card-actions">
          <button class="text" type="button" :disabled="!page.ok" data-role="view-cells" @click="togglePage(page)">
            看格子
          </button>
          <!-- 单页重传（清单 一-8）：只重扫这一页、原地替换它的结果与字形，不必整批重来。
               2026-10-12 按用户口径由实体按钮改成文本按钮「重传」，位置紧跟「看格子」之后 -->
          <!-- 作废这一页（2026-10-15 用户口径）：清掉它的识别结果与字形，卡片留着 ——
               之后点「重传」就能重新扫进来（与"整批重新识别"同一语义，只是只作用于这一页） -->
          <button
            v-if="page.ok"
            class="text"
            type="button"
            data-role="void-page"
            title="把这一页的识别结果与字形一起作废（卡片留着，可以用「重传」重新扫这一页）"
            @click="openVoid(page)"
          >作废</button>
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
        </div>
      </div>
    </div>

    <!-- 单页详情（弹窗）：136 格视图 + 单格放大（手选页序那块已随该功能一起去掉）。
         为什么收进弹窗：60 页时行内展开会把列表撑得很长，而且每页那 136 个格子的覆盖层与格子拼图会常驻 DOM -->
    <div v-if="sheetPage" class="backup-overlay" @click.self="closeSheet()">
      <div class="backup-modal scan-sheet-modal" role="dialog" aria-label="这一页的格子" data-role="scan-sheet">
        <div class="backup-head">
          <h3>{{ sheetPage.fileName }}</h3>
          <button class="text" type="button" data-role="sheet-close" @click="closeSheet()">关闭</button>
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
        <p class="panel-hint" data-role="cell-legend">
          蓝框 = 有笔迹、橙框 = 可疑（偏淡或太小）、红框 = 被红笔圈掉、黄虚线 = 圈压在两格之间（归属待确认）
        </p>
        <p class="panel-hint" data-role="cell-legend-tip">点任意一格看放大与统计</p>

        <div v-if="zoomCell" class="scan-cell-zoom">
          <div class="scan-cell-zoom-img" :style="zoomStyle"></div>
          <div class="scan-cell-zoom-info">
            <strong>第 {{ zoomCell.cell.index + 1 }} 格{{ zoomCell.cell.char ? '「' + zoomCell.cell.char + '」' : '' }}</strong>
            <p class="panel-hint">{{ zoomIsMarkedLabel }}</p>
            <p class="panel-hint" data-role="overflow-hint">{{ zoomOverflowHint }}</p>
            <p class="panel-hint" data-role="zoom-bitmap-note">
              这里显示的是识别时切出的位图（每格 96 像素，放大后有锯齿）；字形轮廓是矢量，要到「生成」那一步才由笔迹追踪出来。
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- 这一步怎么走（初始引导）：没有展示结果、也没在识别时出现 ——
         刚选完文件夹（结果属于上一批）时也显示，正好补上"接下来点开始识别" -->
    <p v-if="!showResult && !running" class="panel-hint">
      选好文件夹后点「开始识别」：程序对每张图片逐页做「预处理 → 切格（方向不对会自动转正）→
      按字序文件对齐（没有文件时认纸面上的参考字）→ 红圈识别 → 字形提取」，
      并把每页的页号来源、写出格数与可疑格报给你；底部条码与右侧方块里的校验码会替你把这一页的字序再验一遍。
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
            这个文件夹里有 {{ orderCandidates.length }} 个字序文件：字序按"固定名优先"挑中了「{{ activeOrderName || '（都不合格式）' }}」——
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

    <!-- 失败的页（详情弹窗）：整批被跳过时往往几十条、原因还一模一样，收在这里看 -->
    <div v-if="skippedOpen" class="backup-overlay" @click.self="skippedOpen = false">
      <div class="backup-modal" role="dialog" aria-label="失败的页" data-role="skipped-modal">
        <div class="backup-head">
          <h3>失败的 {{ gate.skipped.length }} 页</h3>
          <button class="text" type="button" data-role="skipped-close" @click="skippedOpen = false">关闭</button>
        </div>
        <ul class="scan-problems">
          <li v-for="item in gate.skipped" :key="'s' + item.fileIndex" class="warn">
            跳过：第 {{ item.fileIndex + 1 }} 个文件{{ item.fileName ? '（' + item.fileName + '）' : '' }} —— {{ item.reason }}
          </li>
        </ul>
      </div>
    </div>

    <!-- 更正核对（原独立的第 2 步，2026-10-11 并入本页 —— 决策 八-15 ④）：
         它是识别结果的下一步处理，不该另占一步；有识别结果时就挂在这里 -->
    <CorrectionConfirm v-if="showResult && !running" />

    <!-- 作废一页的二次确认（2026-10-15 用户口径）：它是破坏性动作，必须先说清后果 -->
    <div v-if="voidTarget" class="backup-overlay" @click.self="voidTarget = null">
      <div class="backup-modal" role="dialog" aria-label="作废这一页" data-role="void-modal">
        <div class="backup-head">
          <h3>作废这一页？</h3>
          <button class="text" type="button" data-role="void-cancel" @click="voidTarget = null">关闭</button>
        </div>
        <p class="panel-hint">
          会把「{{ voidTarget.fileName }}」的<strong>识别结果与落盘的字形一起清掉</strong>
          （第 3 步已经生成的字体也要重新生成）。
        </p>
        <p class="step-note">
          卡片会留着 —— 想重新扫这一页，作废之后点它上面的「<strong>重传</strong>」即可；
          整批重扫则用上面的「重新识别」。
        </p>
        <div class="panel-actions">
          <button class="text danger" type="button" data-role="void-confirm" @click="confirmVoid">确认作废这一页</button>
          <button class="text" type="button" data-role="void-cancel-btn" @click="voidTarget = null">取消</button>
        </div>
      </div>
    </div>
    <!-- 重新识别前的确认（2026-10-13 用户口径）：第 3 步已经有生成信息时先说一句，
         因为整批重新识别会把那份字体产物与体检清单一起清掉 -->
    <div v-if="restartOpen" class="backup-overlay" @click.self="restartOpen = false">
      <div class="backup-modal" role="dialog" aria-label="重新识别会清掉第 3 步的字体" data-role="restart-modal">
        <div class="backup-head">
          <h3>第 3 步已经生成过字体</h3>
          <button class="text" type="button" data-role="restart-close" @click="restartOpen = false">关闭</button>
        </div>
        <p class="panel-hint">
          重新识别会把第 3 步的<strong>字体产物与字形体检清单一起清掉</strong>（识别结果与字形本来就是这一批的原料，
          会按这次扫描件重算）—— 已经下载的压缩包、以及装进系统的字体不受影响。
        </p>
        <p class="step-note">
          只想换掉某一页的话，用那张结果卡片上的「<strong>重传</strong>」就够了：它不动其它页，也不会清掉字体产物之外的记录。
        </p>
        <div class="panel-actions">
          <button class="primary" type="button" data-role="restart-confirm" @click="confirmRestart">继续识别</button>
          <button class="text" type="button" data-role="restart-cancel" @click="restartOpen = false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>
