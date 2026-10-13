// 上传识别流程编排（阶段一「界面串联」B2）
// 职责：一串扫描件 → 逐页「预处理 → 切格（含整页方向自动纠正）→ 红圈识别 → 字形提取（顺带剔除红圈像素）」
//   → 页级 + 格级结果；再按《决策记录》八-9 / 八-10 / 二-7 给出"这一批能不能继续"的判定与中文说明。
// 为什么单独成模块：这是界面与四个识别模块（1.4~1.7）之间**唯一的接缝** —— 界面只管渲染结果，
//   流程顺序、参数、失败处置、页序与批次的判定都在这里，因此可以用真件夹具整条跑通（test/scan-flow.mjs）。
// 内存（决策 二-1、清单 三-5）：**必须串行、逐页释放** —— 单页彩色 8MB、全量 51 页约 400MB，
//   所以每处理完一页就把灰度图 / 彩色像素 / 掩膜丢掉，只留下"能显示、能继续算"的压缩产物：
//   · 页记录（计数、每格判定、被圈格、页号与批次）—— 进 store，落盘
//   · 每页一张**格子缩略图**（136 格拼成一张 PNG）+ 一张**整页缩略图** + 每格的笔迹掩膜 —— 只放内存缓存
//     （掩膜是后续字体合成（B3）的原料；两张图是"识别结果可视化"的原料。都不落盘：
//      落盘会把整份项目对象撑到几 MB，每次改族名都要重写一遍，得不偿失 —— 见清单 四-27）
//     **丢了的代价不一样**：格子缩略图能从落盘的字形掩膜按需重画（lib/pageSheet.js，2026-10-13 起
//     更正核对与「看格子」都走这条兜底）；整页缩略图没有第二份来源，刷新后就是没有了（它只是"看一眼这页长什么样"）。
import { preprocessFile } from './scanPreprocessor.js'
import { analyzePage, summarizeBatch, DESIGN } from './gridDetector.js'
import { attachRedMarks, defaultCellRects } from './markRecognizer.js'
import { extractPage } from './handwritingExtractor.js'
import { rotateQuarterTurns } from './imageOps.js'
import { LAYOUT } from './layout.js'
import { getAllChars } from './charset.js'
import { charAtCell, reorderPages, resolveBatchChars } from './scanMeta.js'
import { readPage as readReferenceChars } from './referenceCharReader.js'
// 格子拼图与 blob→dataURL 的画法在 lib/pageSheet.js 里（刷新后从落盘字形重建时也用它，两处必须同一种画法）
import { blobToDataUrl, cellSheet } from './pageSheet.js'

// 纯逻辑（页内格号 → 字、页序重排、字形统计）在 scanMeta.js 里，这里再导出一次，
// 让调用方只记一个入口（组件里 `import { … } from '../lib/scanFlow.js'` 就够）
export {
  applyCorrectionOverrides,
  buildCorrectionInputs,
  buildFinalGlyphPlan,
  charAtCell,
  collectGlyphStats,
  evaluateRescanAccept,
  evaluateScanGate,
  pairCorrections,
  reorderPages,
  resolveBatchChars,
  usableForGlyphs
} from './scanMeta.js'

// 整批汇总判定（页号重复 / 批次码不符 / 缺页 / 闸门）在 gridDetector.js 里，这里再导出一次：
// 单页重传（清单 一-8）替换完一页后要重算整批，界面不该为此再记一个模块入口
export { summarizeBatch }

export const SCAN_DEFAULTS = {
  autoOrient: true, // 整页方向不对时自动纠正（决策 二-11）
  detectRedMarks: true, // 红圈识别 + 从笔迹里剔除（决策 二-12）
  expectedBatchCode: null, // 所选批次的 12 位校验码（八-10；为 null 时不做批次比对）
  // 参考字候选库（lib/referenceCharReader.js 的 buildLibrary 产物）：**传了它才做"认参考字 + 定字序"**；
  // 不传就退回旧口径（按批次的全局字序取字），供纯逻辑测试与没有字体可用的环境使用。
  library: null,
  // 这一批的字序（**来自目录里的字序文件**，决策 一-18）：给了它就"文件说了算" ——
  //   序列定位只在这个全序里找起点；定位不上但页脚读出了页号时，直接按页号从它里面切一段。
  //   没给（目录里没有字序文件、或文件不合格式）才退回"两份预置全序去猜"，即认参考字那条退路。
  orderChars: '',
  // 这一页上"有参考字的格"占比低于它 → 判定**不是本程序生成的模板**，整页失败
  // （用户 2026-10-11 拍板：只认自家模板产出的纸，外来图片一个字形也不产生）。
  // 实测自家模板在这条上是 0.99~1.00（参考字是印上去的，即使模糊也能取到）。
  minInkRatio: 0.6,
  // 格子缩略图里每格的像素边长：96 够看清"这一格写了没、写得正不正"，又让整页拼图只有 1632×768
  cellThumbSize: 96,
  // 整页缩略图的宽度（高度按比例）：页级行里看一眼"这页长什么样"，300 够用
  pageThumbWidth: 300
}

// ── 缩略图（**离屏画布**：主线程与 Worker 里都能跑；只在这些函数里碰画布，别的都是纯计算）──────
// 识别链路现在主跑在 Web Worker 里（决策 六-15），所以这里一律用 OffscreenCanvas —— Worker 里没有 document。
// 注意**格子拼图**不在这里（它要能从落盘的字形重建，画法在 lib/pageSheet.js），这里只留页级缩略图。
// 把设计坐标灰度图降采样成一张小图（页级缩略图）
function grayThumb(gray, targetWidth) {
  const factor = Math.max(1, Math.round(gray.width / targetWidth))
  const w = Math.max(1, Math.floor(gray.width / factor))
  const h = Math.max(1, Math.floor(gray.height / factor))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(w, h)
  const src = gray.data
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = src[(y * factor) * gray.width + x * factor]
      const o = (y * w + x) * 4
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v
      img.data[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}

/**
 * 页脚四个方向都解不出时的**第二轮回退**（2026-10-13 用户拍板）。
 *
 * 为什么需要它：方向纠正的判据一直是"页脚能不能解出"（决策 二-11），可**页脚被裁掉 / 污损的纸本来还能用** ——
 *   四角定位块与纸面参考字都好好的。真件实测（把页脚编码带涂白）：四个方向页脚全败 → 方向判错 →
 *   按错方向切格 → 参考字覆盖率不达标 → 整页失败，用户除了重拍没有别的路。
 * 判据换成**纸面参考字能不能认出来**（与"这是不是自家模板"同源，决策 五-9 ④）：
 *   四个方向各跑一次「找四角 → 透视校正 → 按已知网格切格 → 认参考字」，取**序列定位命中优先、
 *   认得出的格数其次**的那个方向；达标线 = 定位命中，或认得出的格数 ≥ 136 × 0.6（与 `readPage` 的 ready 同口径）。
 *   **不能拿 `inkRatio` 当判据**：它只统计"格子里有没有模板的参考字"，把整页转 90°/180° 照样接近 1.0
 *   （参考字仍在格内、只是倒着）—— 实测踩到过一次：转错 90° 的方向拿了满分，于是选中错方向、整页白跑。
 * 代价：这一段约等于把切格 + 认字跑四遍（单页切格实测约 0.6 秒），但**只在页脚全败时才跑** ——
 *   页脚读得出的件一次都不会走到这里（`tried` 里任何一个方向解出页脚就直接返回 null）。
 * 口径不变的地方：页脚仍然没读出来（`footerOk` 依旧 false）→ 页序该确认的照旧确认（决策 二-7）。
 * @returns {object|null} 救回来时返回"按选定方向重新跑过"的页结果（orientation 已覆盖成真实方向），否则 null
 */
function rescueOrientationByReference(gray, failedPage, options) {
  const tried = (failedPage && failedPage.orientation && failedPage.orientation.tried) || []
  if (!options.library) return null // 没有参考字候选库（纯几何的测试路径）就没法评分
  if (failedPage.stage === 'marks' || failedPage.stage === 'transform') return null // 连四角都没找到
  if (tried.length < 2 || tried.some((t) => t.footerOk)) return null // 没试过多个方向，或本来就有方向解出了页脚

  let best = null
  for (const t of tried) {
    const input = t.turns === 0 ? gray : rotateQuarterTurns(gray, t.turns)
    // 这一轮**不再让它自己转方向**（我们正在逐方向评分），四角 / 校正 / 切格照旧
    const page = analyzePage(input, {
      autoOrient: false,
      keepDesignGray: true,
      expectedBatchCode: options.expectedBatchCode
    })
    if (!page.designGray || !page.boxes || !page.boxes.length) continue
    const read = readReferenceChars(page.designGray, options.library, {})
    // 评分 = **序列定位有没有命中** > **认得出的格数** —— 这两个对方向敏感。
    // 为什么不用 inkRatio（"参考字覆盖率"）：它只统计"格子里有没有模板的参考字"，
    //   把整页转 90°/180° 它照样接近 1.0（参考字仍在格内，只是倒着）—— 实测踩到过：
    //   转错 90° 的那个方向拿了满分，于是选中了错方向、整页白跑。
    const score = (read.located ? 1000 : 0) + (read.sureCount || 0)
    if (!best || score > best.score) best = { turns: t.turns, page, score, read }
  }
  if (!best) return null
  // 达标判据与 readPage 的 `ready` 同一口径：序列定位命中，或认得出的格数过半
  const okByReference = !!best.read.located || best.read.sureCount >= Math.round(LAYOUT.perPage * 0.6)
  if (!okByReference) return null

  // 选定方向的这一份结果直接采用，但 **orientation 必须换成真实值**：内部那一轮没转方向、它报的 turns 是 0，
  // 而下游（红圈识别按 turns 把彩色像素转过来、界面显示"已自动转正/按参考字定方向"）都读这个字段
  const page = best.page
  // **整页可以继续**：方向已由纸面参考字定下来，四角 / 校正 / 切格都成功 —— 页脚读不出只是
  //   "少了一个自校验来源"（决策 五-9 ⑥ 早就把页脚降为兜底与自校验），不该再按"整页失败"处理。
  //   不置这一位的话，回退白做：下游一句 `if (!page.ok)` 就把整页丢掉了（实测踩到）。
  page.ok = true
  page.orientation = {
    turns: best.turns,
    corrected: best.turns !== 0,
    attempts: tried.length,
    tried,
    rescuedByReference: true, // 方向是"按参考字"救回来的（界面据此换一句提示）
    rescueSure: best.read.sureCount || 0,
    rescueLocated: !!best.read.located,
    rescueRatio: Math.round((best.read.inkRatio || 0) * 1000) / 1000
  }
  page.messages = [
    ...(page.messages || []),
    {
      level: 'warn',
      text: '这一页的页脚编码读不出来（可能被裁掉或污损）：已改按纸面参考字定方向（试了 ' +
        tried.length + ' 个方向，认得出 ' + (best.read.sureCount || 0) + ' 格' +
        (best.read.located ? '、整页字序也定位上了' : '') + '）—— 请核对这一页的页序对不对'
    }
  ]
  return page
}

/**
 * 识别一页扫描件。
 * @param {File} file 图片文件
 * @param {object} options
 * @param {string} options.chars 这一批要写的字（按字序；见 resolveBatchChars）
 * @param {number} [options.expectedBatchCode] 所选批次的校验码（用于页面级比对提示）
 * @param {number} [options.fileIndex] 第几个文件（0 起，仅用于展示与缓存键）
 * @param {number} [options.pageNumberOverride] 页脚读不出时由用户指定的页号（决策 二-7）
 * @returns {Promise<{record:object, cache:object}>} record 是可落盘的轻量记录，cache 是只放内存的图与掩膜
 */
export async function recognizePage(file, options = {}) {
  const opt = { ...SCAN_DEFAULTS, ...options }
  const chars = opt.chars || getAllChars().join('')
  const fileIndex = opt.fileIndex || 0
  const messages = []
  // 阶段文案回调（界面用它显示"现在到底在做什么"）：每个动作开始前报一次，文案是给人看的中文动作名
  const stage = (text) => { if (typeof opt.onStage === 'function') opt.onStage(text) }

  // ① 预处理（1.4）：灰度（去噪）+ 二值图 + 彩色原图；彩色最大，用完立刻释放引用
  stage('正在预处理（去噪、二值化）')
  const prepared = await preprocessFile(file)
  const gray = prepared.gray
  let rgba = prepared.rgba

  // ② 切格（1.5）：方向纠正 → 找四角 → 透视校正 → 页脚解码 → 按已知网格切 136 格
  stage('正在切格（找四角、透视校正、读页脚）')
  let page = analyzePage(gray, {
    autoOrient: opt.autoOrient,
    keepDesignGray: true,
    expectedBatchCode: typeof opt.expectedBatchCode === 'number' ? opt.expectedBatchCode : null
  })
  // 页脚四个方向都解不出 → 再按"参考字覆盖率"试一遍四个方向（2026-10-13 用户拍板，见上面那个函数的注释）。
  // 页脚读得出的件一次都不会走到这里；只有"页脚被裁掉 / 污损"的纸才会真跑这四遍
  if (!page.ok) {
    stage('页脚读不出：正在按参考字试其它方向')
    const rescued = rescueOrientationByReference(gray, page, {
      library: opt.library,
      minInkRatio: opt.minInkRatio,
      expectedBatchCode: typeof opt.expectedBatchCode === 'number' ? opt.expectedBatchCode : null
    })
    if (rescued) page = rescued
  }
  const record = {
    fileIndex,
    fileName: file.name,
    ok: false,
    reason: '',
    pageNumber: null,
    footerOk: false,
    batchCode: null,
    batchMatch: null,
    isSheetPage: null,
    // **页脚的原始结果要一起带上**：summarizeBatch（整批判定）读的是 `p.footer.ok / pageNumber / batchCode`，
    // 只给 footerOk 这些扁平字段的话，每页都会被当成"页脚读不出"（踩过：汇总里全是"页脚没读出"的警告，
    // 而页面记录明明读出了第 1 页与校验码 3362 —— 因为那种情形只产生 warn、ok 仍为 true，测试也没抓住）
    footer: null,
    orientation: page.orientation ? {
      corrected: !!page.orientation.corrected,
      turns: page.orientation.turns,
      tried: page.orientation.tried,
      // 2026-10-13：方向是"按纸面参考字"救回来的（页脚读不出时）—— 界面据此换一句提示
      rescuedByReference: !!page.orientation.rescuedByReference,
      rescueSure: page.orientation.rescueSure || 0,
      rescueLocated: !!page.orientation.rescueLocated
    } : null,
    cornerMaxError: page.cornerErrors ? Math.round(page.cornerErrors.max * 10) / 10 : null,
    counts: { written: 0, empty: 0, suspect: 0, marked: 0, uncertain: 0, inkPixels: 0 },
    // 参考字识别与定字序（2026-10-11 新模型）：
    //   pageChars 是**这一页 136 格各自的字**（认不出为 null）—— 定位成功时由序列给出（整页确定），
    //   定位不上时是逐格识别结果（认不准的格记进 unsureCells，交界面复核）
    read: null,
    located: null,
    // 页脚自校验（决策 五-9 ⑥：页脚码降为自校验）：{ footerCode, readCode, agree } —— 对不上只提示复核，不拦
    footerSelfCheck: null,
    pageChars: null,
    pageNumberSource: null, // sequence（序列定位反推）| footer（页脚读出）| user（手选）| unknown
    // 这一页的字是**从哪儿来的**：file 目录里的字序文件 / sequence 纸面参考字序列定位 / cells 逐格认字。
    // 界面要把它显示出来 —— "字序是文件给死的"与"是猜出来的"对用户的信任度完全不同（决策 一-18 ⑤）
    orderSource: null,
    unsureCells: [],
    // 复核用的候选（每格最多 5 个）：认不准的格在界面上让用户从候选里挑，或直接手输
    charCandidates: null,
    needReview: false,
    cells: [],
    messages: [],
    timings: page.timings ? { ...page.timings } : null
  }
  // 页脚摘要（喂给 summarizeBatch 的最小形状）：读不出时给 ok:false 与原因，好让整批判定说得清是哪一页的问题
  const footerShape = (footer) => (footer
    ? { ok: !!footer.ok, pageNumber: footer.ok ? footer.pageNumber : null, batchCode: footer.ok ? footer.batchCode : null, message: footer.message || '' }
    : { ok: false, pageNumber: null, batchCode: null, message: '这一页没有页脚结果（切格没走到页脚解码）' })
  record.footer = footerShape(page.footer)

  if (!page.ok || !page.boxes || !page.boxes.length) {
    // 整页失败：按决策 二-6 明确失败 + 中文提示（不静默拿错坐标切格）
    record.reason = page.reason || (page.messages && page.messages.find((m) => m.level === 'error') || {}).text || '这一页没能定位到四角定位块'
    record.messages = (page.messages || []).map((m) => ({ level: m.level, text: m.text }))
    if (record.messages.length === 0) record.messages = [{ level: 'error', text: record.reason }]
    return { record, cache: { thumb: null, sheet: null, masks: null } }
  }

  record.footerOk = !!(page.footer && page.footer.ok)
  record.pageNumber = page.footer && page.footer.ok ? page.footer.pageNumber : null
  record.batchCode = page.footer && page.footer.ok ? page.footer.batchCode : null
  // 件类型（决策 一-9、二-13）：更正册的页脚校验码为 0、主区是批次校验码、读不出时未知 ——
  // 与 summarizeBatch 同一口径（那边按 row.kind 分拣重复页与批次比对）。
  // **必须排在 batchMatch 之前**：下面要用它决定"这一页参不参与批次比对"。顺序写反过一次 ——
  //   kind 此刻还是 undefined，于是更正册页的 batchMatch 被算成"码 0 vs 所选批次"的 false；
  //   界面与收批闸门都按 kind 先分拣，用户看不到，所以这条只影响页记录本身（测试已钉住）。
  record.kind = record.footerOk ? (record.batchCode === 0 ? 'correction' : 'main') : 'unknown'
  record.batchMatch = record.kind === 'correction' ? null : (page.batch ? page.batch.match : null)
  record.footer = footerShape(page.footer)
  if (record.pageNumber === null && typeof opt.pageNumberOverride === 'number') {
    record.pageNumber = opt.pageNumberOverride
    record.orderFromUser = true // 页序是用户手选的（决策 二-7），界面要显式标出来
  }

  // ③ 红圈（1.7）：颜色分离 + 形态过滤 → 被圈格清单 + 红掩膜；再把红掩膜作为附加图层切到每格
  let extractionBoxes = page.boxes
  let designRedMask = null
  if (opt.detectRedMarks && rgba) {
    stage('正在识别红笔圈')
    // attachRedMarks 在这些前提不满足时返回 null（页面不可用 / 没有矩阵 / 没开 keepDesignGray / 没彩色像素）：
    // 那就退回"不剔红圈"的切格结果，绝不因为拿不到红掩膜就整页失败
    const attached = attachRedMarks(page, rgba, {
      cellRects: defaultCellRects(),
      turns: page.orientation ? page.orientation.turns : 0
    })
    if (attached) {
      extractionBoxes = attached.boxes
      // 红掩膜留着给"认参考字"用：红圈在灰度图上是深色，不抹掉会把参考字的阈值带偏
      designRedMask = attached.marks && attached.marks.designRed ? attached.marks.designRed.data : null
      record.redStats = attached.marks ? { ...attached.marks.stats } : null
      record.markedCells = (attached.marks && attached.marks.markedCells) || []
      record.uncertainCells = (attached.marks && attached.marks.uncertainCells) || []
      for (const m of (attached.marks && attached.marks.messages) || []) messages.push({ level: m.level, text: m.text })
    } else {
      messages.push({ level: 'info', text: '这一页没有做红圈识别（缺少切格矩阵或彩色像素），被圈的字请在核对界面手工标记' })
    }
  }
  rgba = null // 彩色像素到此用完（红掩膜已经切成分片），显式释放

  // ③.5 认参考字 + 定字序（2026-10-11 新模型：生成范围由扫描件决定 —— 决策 五-9）
  // 为什么排在这里：① 认字只要设计灰度图 + 红掩膜，两者此刻都在手上；② 下面的字形提取要按
  //   "格号 → 字"给每格标字，字序必须先定下来。
  // 处置口径（用户 2026-10-11 拍板）：
  //   · 纸上没有本程序的参考字版式 → **整页失败**（只认自家模板，外来图片一个字形也不产生）
  //   · 有参考字：优先**序列定位** —— 预置档位的纸连页脚都不用读，页号与整页 136 字一起确定；
  //     定位不上（自定义选字的纸不是任何全序的连续段）→ 退到"逐格识别的字 + 页脚页号"，
  //     认不准的格记进 unsureCells 交界面复核
  const orderChars = typeof opt.orderChars === 'string' && opt.orderChars.length ? opt.orderChars : ''
  if (opt.library && record.kind !== 'correction' && page.designGray) {
    stage('正在认参考字、定字序')
    // 有字序文件时**只试它那一个序列**：文件说了算，不能再拿两份预置全序去猜 ——
    //   猜中的那一个可能是另一套字序（纸上的字确实按那个顺序排过），于是整页的字被换成另一套，
    //   而且"看起来还挺对"（这正是 一-18 要把字序显式落成文件的原因）。
    const sequences = orderChars
      ? [{ key: 'file', label: '字序文件', chars: Array.from(orderChars) }]
      : undefined
    const read = readReferenceChars(page.designGray, opt.library, { redMask: designRedMask, sequences })
    record.read = {
      emptyCount: read.emptyCount,
      sureCount: read.sureCount,
      unsureCount: read.unsureCount,
      inkRatio: Math.round(read.inkRatio * 1000) / 1000,
      located: read.located ? { seqKey: read.located.seqKey, start: read.located.start, agree: read.located.agree } : null
    }
    if (read.inkRatio < opt.minInkRatio) {
      record.reason = '这不是本程序生成的模板：这一页 ' + LAYOUT.perPage + ' 格里有 ' + read.emptyCount +
        ' 格取不到模板的参考字。请确认用的是第 1 步「生成模板 PDF」下载的那份文件、按实际大小（100%）打印的纸。'
      record.messages = [{ level: 'error', text: record.reason }]
      return { record, cache: { thumb: null, sheet: null, masks: null } }
    }
    record.unsureCells = read.unsureCells
    record.charCandidates = read.cells.map((c) => (c.candidates || []).map((x) => x.char))
    if (read.located) {
      // 序列定位命中：整页 136 个字全部确定（含那几个认不出的格），页号由起点反推
      record.located = record.read.located
      record.pageNumber = Math.floor(read.located.start / LAYOUT.perPage) + 1
      record.pageNumberSource = 'sequence'
      // 序列定位用的候选序列就是字序文件时，这一页的字等于"文件给死的那一段"（不是猜出来的）
      record.orderSource = orderChars ? 'file' : 'sequence'
      record.pageChars = read.located.chars.slice()
      record.batchCode = read.batchCode
      // 整页已由序列确定 → **没有"需要人工确认"的格**（认不出的那几格的字同样已确定）
      record.unsureCells = []
      // 自校验（用户拍板：页脚码留作自校验 / 可信度提示，不当闸门）：识别出的字序算出的码 vs 纸面码。
      // 实测两者一致（206 = 206）；对不上说明这一页多半不是按本程序模板写的，提示复核。
      if (page.footer && page.footer.ok && typeof page.footer.batchCode === 'number') {
        record.footerSelfCheck = {
          footerCode: page.footer.batchCode,
          readCode: read.batchCode,
          agree: page.footer.batchCode === read.batchCode
        }
        if (!record.footerSelfCheck.agree) {
          messages.push({
            level: 'warn',
            text: '这一页识别出的字序与纸面页脚对不上（纸面校验码 ' + page.footer.batchCode + '、识别出 ' +
              read.batchCode + '）：请核对这一页是不是本程序模板印的纸，或在界面上逐格确认后再用'
          })
        }
      }
    } else if (orderChars && record.pageNumber !== null) {
      // 字序文件在、页脚也读出了页号：直接按页号从文件字序里切一段。
      // 为什么这条路比"逐格认字"硬：文件给死的是**完整字序**，页号一确定，这一页 136 个字就全确定，
      //   一个也不用猜、也不必人工复核（逐格认字的错会静默进成品，这里没有可猜的余地）。
      const list = Array.from(orderChars)
      const start = (record.pageNumber - 1) * LAYOUT.perPage
      record.pageChars = list.slice(start, start + LAYOUT.perPage)
      record.pageNumberSource = 'footer'
      record.orderSource = 'file'
      record.needReview = false
      messages.push({
        level: 'info',
        text: '这一页的字序取自目录里的字序文件：第 ' + record.pageNumber + ' 页 = 字序里的第 ' +
          (start + 1) + ' ~ ' + (start + record.pageChars.length) + ' 个字'
      })
    } else {
      record.pageChars = read.cells.map((c) => (c.empty ? null : c.char))
      record.pageNumberSource = record.pageNumber !== null ? 'footer' : (record.orderFromUser ? 'user' : 'unknown')
      record.orderSource = 'cells'
      record.needReview = read.unsureCount > 0 || read.emptyCount > 0
      messages.push({
        level: record.needReview ? 'warn' : 'info',
        text: '这一页认不出是哪一段字序（多半是自定义选字的模板）：已按逐格识别取字' +
          (record.needReview ? '，其中 ' + (read.unsureCount + read.emptyCount) + ' 格需要你在界面上确认' : '，且全部格都认准了')
      })
    }
  }

  // ④ 字形提取（1.6）：灰度分层 + 面积过滤，红圈像素按附加图层跳过
  stage('正在提取笔迹')
  const extracted = extractPage(extractionBoxes)
  const markedSet = new Set(record.markedCells || [])
  const uncertainSet = new Set(record.uncertainCells || [])
  const items = []
  for (const cell of extracted.cells) {
    // 更正册的格不按批次的字序映射：它是"第 k 个更正格"，字由更正核对（1.8）配对时决定（决策 二-13）
    // 字序来源：**优先用这一页自己认出来的字**（新模型：范围由扫描件决定）；没有认字结果时才退回
    // 批次的全局字序（旧口径，供没有候选库的环境使用）
    const char = record.kind === 'correction'
      ? null
      : ((record.pageChars && record.pageChars[cell.index]) || charAtCell(chars, record.pageNumber, cell.index))
    const item = {
      index: cell.index,
      char,
      verdict: cell.verdict,
      inkPixels: cell.inkPixels,
      inkPixelsOutside: cell.inkPixelsOutside,
      overflow: cell.overflow,
      marked: markedSet.has(cell.index),
      uncertain: uncertainSet.has(cell.index),
      // 被红圈掩膜挡掉的深色像素数：界面用它证明"红圈确实被剔除了"（诊断口径，见 四-18）
      redPixelsRemoved: cell.redPixelsRemoved || 0,
      // 掩膜与尺寸留在 cache 里（内存），record 只带统计
      mask: cell.mask,
      width: cell.width,
      height: cell.height,
      boxInSlice: cell.boxInSlice
    }
    items.push(item)
    record.counts.written += cell.verdict === 'empty' ? 0 : 1
    record.counts.empty += cell.verdict === 'empty' ? 1 : 0
    record.counts.suspect += cell.verdict === 'suspect' ? 1 : 0
    record.counts.inkPixels += cell.inkPixels || 0
  }
  record.counts.marked = (record.markedCells || []).length
  record.counts.uncertain = (record.uncertainCells || []).length

  // ⑤ 结果可视化：格子拼图 + 整页缩略图（各一次 PNG 编码）
  let thumb = null
  let sheet = null
  try {
    const [thumbBlob, sheetBlob] = await Promise.all([
      page.designGray ? grayThumb(page.designGray, opt.pageThumbWidth) : Promise.resolve(null),
      cellSheet(items, opt.cellThumbSize)
    ])
    thumb = thumbBlob ? await blobToDataUrl(thumbBlob) : null
    sheet = sheetBlob ? await blobToDataUrl(sheetBlob) : null
  } catch (e) {
    messages.push({ level: 'warn', text: '识别结果缩略图生成失败（不影响字形数据）：' + (e && e.message ? e.message : e) })
  }

  // ⑥ 组装轻量记录：cells 去掉掩膜（掩膜进 cache）
  record.cells = items.map((it) => ({
    index: it.index,
    char: it.char,
    verdict: it.verdict,
    inkPixels: it.inkPixels,
    inkPixelsOutside: it.inkPixelsOutside,
    overflow: it.overflow,
    marked: it.marked,
    uncertain: it.uncertain,
    redPixelsRemoved: it.redPixelsRemoved
  }))
  record.messages = [...(page.messages || []).map((m) => ({ level: m.level, text: m.text })), ...messages]
  record.ok = true
  record.reason = ''
  return {
    record,
    cache: {
      thumb,
      sheet,
      // 只留"有笔迹"的掩膜（空白格不需要参与字体合成），并把 boxInSlice 一起带上（B3 映射要用）；
      // redPixelsRemoved 一并留着，供界面/测试核对"红圈确实被剔除了"
      masks: items
        .filter((it) => it.verdict !== 'empty')
        .map((it) => ({
          index: it.index,
          char: it.char,
          mask: it.mask,
          width: it.width,
          height: it.height,
          boxInSlice: it.boxInSlice,
          redPixelsRemoved: it.redPixelsRemoved
        })),
      designSize: page.designGray ? { width: page.designGray.width, height: page.designGray.height } : DESIGN
    }
  }
}

/**
 * 批量识别（**主线程跑法**）：串行逐页处理（决策 二-1），每页处理完立刻回调（界面可以边跑边显示），
 * 全部结束后按 summarizeBatch 给出"这一批能不能继续"的判定。
 * **两种跑法的关系**（决策 六-15 ⑨）：界面上跑的是 Worker 那条路（`lib/scanWorkerClient`），
 *   它内部在 Worker 里也串行逐页调同一个 `recognizePage`；本函数是**主线程那条跑法**，
 *   由 `test:scanflow` 直接调用 —— 它存在的意义就是证明"纯计算部分两种方式都能跑"。
 *   两处的逐页循环结构一致，改动其中一处时**另一处要跟着看**（真正的计算只有 recognizePage 一份）。
 * @param {File[]} files
 * @param {object} options 见 recognizePage，另加：
 * @param {Function} [options.onPage] (record, index, total, cache) => void —— 每页处理完回调
 * @param {Function} [options.onPageStart] (pageNo, total) => void —— 开始处理某一页
 * @param {Function} [options.shouldStop] () => boolean —— 返回 true 就在这一页处理完后停下（已处理的页保留）
 * @param {object} [options.batch] 批次（内部容器）：只用来取**字序兜底**与**页数口径**；
 *   校验码不再由它决定 —— 要么走 `expectedBatchCode` 显式传，要么在 recognizePage 里做页脚自校验
 */
export async function recognizeBatch(files, options = {}) {
  const opt = { ...SCAN_DEFAULTS, ...options }
  const batch = opt.batch || null
  // 这一批的字序：**字序文件优先**（决策 一-18）—— 它给死的就是"这批纸的字序"；
  // 没有文件时才用批次的全局字序兜底（认参考字那条退路里，"逐格认字 + 页脚页号"要用到它）
  const chars = opt.orderChars || resolveBatchChars(batch)
  // 新模型（决策 五-9）：**批次校验码不再当闸门** —— 字序由纸面参考字定位决定，而批次是自动建的容器
  // （`store.ensureScanBatch()`），两者的码本来就可能不同，拿它拦批会误伤。页脚码改用**自校验**：
  // recognizePage 把"识别出的字序算出的码"与"纸面读出的码"对一下（footerSelfCheck），对不上只提示复核。
  // 这里把调用方显式给的 expectedBatchCode **原样转下去**（用于页面级比对提示），没有就不传。
  const expectedBatchCode = typeof opt.expectedBatchCode === 'number' ? opt.expectedBatchCode : null
  const pages = []
  const caches = new Map()
  let stopped = false
  for (let i = 0; i < files.length; i++) {
    // 可中止：长任务（全量 61 页约 100 秒）要能让用户停下来；中止后已处理完的页仍然保留（界面照常显示）
    if (opt.shouldStop && opt.shouldStop()) {
      stopped = true
      break
    }
    // onPageStart 报"开始处理第几页"，页内的细阶段由 recognizePage 的 onStage 报（同一个回调透传下去）：
    // 界面据此显示"第 3 / 12 页 · 正在认参考字"这样的当前动作（决策 二-18 ④）
    if (opt.onPageStart) opt.onPageStart(i + 1, files.length)
    const { record, cache } = await recognizePage(files[i], {
      ...opt,
      chars,
      expectedBatchCode,
      fileIndex: i
    })
    pages.push(record)
    caches.set(i, cache)
    // onPage 带上该页的内存缓存（缩略图 / 格子拼图 / 掩膜）：界面要**边跑边显示**，
    // 不能等整批结束才拿到（全量 61 页要等约 100 秒，期间什么都看不到）。
    // **要 await**：回调里要落盘字形（一页一次写），不等它就没有确定的完成顺序
    if (opt.onPage) await opt.onPage(record, i, files.length, cache)
  }
  const summary = summarizeBatch(pages, {
    expectedBatchCode,
    // 页数口径：有字序文件时以**文件声明的页数**为准（自检页的判据就靠它：页号超出字表页数即自检页）
    sheetPages: typeof opt.orderPages === 'number' ? opt.orderPages : (batch ? batch.pageCount : undefined)
  })
  return { pages, caches, summary, chars, stopped }
}

/**
 * 用户手选页序后重新算"每格是哪个字"，并按新页序重新做批次汇总（决策 二-7）。
 * 只重算字与页号，**不重新识别** —— 掩膜与页序无关（scanMeta.reorderPages 是纯的那一半）。
 * @param {Array} pages record 数组
 * @param {object} overrides `{ [fileIndex]: pageNumber }`
 * @param {string} chars 这一批的字序
 * @returns {{pages:Array, summary:object}}
 */
export function applyPageOrder(pages, overrides, chars, options = {}) {
  const next = reorderPages(pages, overrides, chars).map((p) => ({
    ...p,
    isSheetPage: typeof options.sheetPages === 'number' && p.pageNumber
      ? p.pageNumber <= options.sheetPages
      : p.isSheetPage
  }))
  const summary = summarizeBatch(next, {
    expectedBatchCode: typeof options.expectedBatchCode === 'number' ? options.expectedBatchCode : null,
    sheetPages: options.sheetPages
  })
  return { pages: next, summary }
}
