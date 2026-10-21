// 上传识别流程编排（阶段一「界面串联」B2）
// 职责：一串扫描件 → 逐页「预处理 → 切格（含整页方向自动纠正）→ 红圈识别 → 字形提取（顺带剔除红圈像素）」
//   → 页级 + 格级结果；再给出"这一批能不能继续"的判定与中文说明（判据见本文件 ③.5 / ③.6 与 scanMeta.evaluateScanGate）。
// 为什么单独成模块：这是界面与四个识别模块（1.4~1.7）之间**唯一的接缝** —— 界面只管渲染结果，
//   流程顺序、参数、失败处置、页号与件类型的判定都在这里，因此可以用真件夹具整条跑通（test/scan-flow.mjs）。
// 内存（决策 二-1、清单 三-5）：**必须串行、逐页释放** —— 单页彩色 8MB、全量 61 页约 400MB，
//   所以每处理完一页就把灰度图 / 彩色像素 / 掩膜丢掉，只留下"能显示、能继续算"的压缩产物：
//   · 页记录（计数、每格判定、被圈格、页号与本页校验码）—— 进 store，落盘
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
import { LAYOUT, classifyFooterPage, CORRECTION_PAGE_BASE } from './layout.js'
import { computePageCode, matchPageCode } from './pageCode.js'
// 指纹反解（2026-10-18）：字序来自逐格认字时，用每格候选 + 右侧方块里的指纹把认错的格纠正回来
import { solvePageCharsByCode } from './pageCodeSolve.js'
import { getAllChars } from './charset.js'
import { charAtCell, dedupeDuplicatePages, usableForGlyphs } from './scanMeta.js'
import { readPage as readReferenceChars } from './referenceCharReader.js'
// **单页试打那一页的字序是程序里的常量**（决策 八-21）：丢了字序文件时它就是"这一页可能是哪些字"的
//   唯一可信候选 —— 不给它，名句页只能靠逐格认字，认不全就整页失败、写过的字白写（见下面 candidates 的说明）
import { SINGLE_PAGE_TEXT } from './singlePageText.js'
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
  usableForGlyphs
} from './scanMeta.js'

// 整批汇总判定（页号重复 / 缺页 / 闸门）在 gridDetector.js 里，这里再导出一次：
// 单页重传（清单 一-8）替换完一页后要重算整批，界面不该为此再记一个模块入口
export { summarizeBatch }

/**
 * 按页号给重复页打标（**就地**改 pages，返回 `{duplicates, groups}`）。
 *
 * 为什么要单独抽一份：这条判据有两个调用方 —— 整批识别收尾（`recognizeBatch`）与界面侧的
 *   「补传扫描件 / 重传」（补进来的件可能与已有的页同号）。两处必须**同一套判据**，
 *   否则卡片标记 / 统计 / 更正配对 / 字形计划会各说一套。
 *
 * `duplicates` 是给**主线程**用的（`[{fileIndex, duplicateOf}]`）：识别跑在 Worker 里时，逐页那一批
 *   消息早就发走了（结构化克隆发生在那一刻，那时还没有 duplicateOf）—— 结论只能随收尾消息带回，
 *   由 `store.applyScanDuplicates` 补写。不补的话，界面上连「重复页」都不会标（2026-10-14 真机缺陷）。
 * @param {Array} pages 页记录（会被就地修改）
 * @returns {{duplicates:Array<{fileIndex:number, duplicateOf:number}>, groups:Array}}
 */
export function markDuplicatePages(pages) {
  const list = pages || []
  // 先清后打：页号是分组依据，页序一改，"谁与谁同页"就变了，旧的标记必须先作废（否则留下一个与
  // 当前页号无关的「重复页」—— 那一页就再也算不进统计了）
  for (const p of list) {
    if (!p) continue
    if (p.duplicateOf !== undefined) delete p.duplicateOf
    if (p.failedDuplicateOf !== undefined) delete p.failedDuplicateOf
  }
  const dedupe = dedupeDuplicatePages(list)
  const duplicates = []
  for (const p of list) {
    const adopted = dedupe.ignored.get(p.fileIndex)
    if (adopted !== undefined) {
      p.duplicateOf = adopted
      duplicates.push({ fileIndex: p.fileIndex, duplicateOf: adopted })
    }
  }

  // **整页失败、但右侧方块读出了页号**、而这个页号已经有可用页的：也标一句（2026-10-15 用户口径）。
  // 真机上就是这种情况：折角页与"去阴影"页跟主件其实是同一张纸，但它们四角不全 / 定位块缺失、
  // 整页失败 —— 原来连一句"它与某页重复"都没有，用户看到两页失败会以为漏了什么。
  // 判据用**右侧方块原始结果**（`p.footer`）：切格失败时 record.pageNumber 是 null，右侧方块却照常解得出页码。
  // 这类页不参与"采用哪一份"的竞争（它本来就没识别成功），只作为提示。
  const okByPage = new Map()
  for (const p of list) {
    if (p && usableForGlyphs(p) && p.pageNumber) okByPage.set(p.pageNumber, p)
  }
  const failedDuplicates = []
  for (const p of list) {
    // **作废的页不参与**（2026-10-15：作废是用户主动清掉的，不是"这一份没能识别" —— 真机上它被误标成
    //   "与某页重复、这一份没能识别"，把用户看糊涂了）
    if (!p || usableForGlyphs(p) || p.voided) continue
    const footerPage = p.footer && p.footer.ok ? p.footer.pageNumber : null
    const adopted = footerPage ? okByPage.get(footerPage) : null
    if (adopted && adopted.fileIndex !== p.fileIndex) {
      p.failedDuplicateOf = adopted.fileIndex
      failedDuplicates.push({ fileIndex: p.fileIndex, duplicateOf: adopted.fileIndex })
    }
  }
  return { duplicates, failedDuplicates, groups: dedupe.groups }
}

export const SCAN_DEFAULTS = {
  autoOrient: true, // 整页方向不对时自动纠正（决策 二-11）
  detectRedMarks: true, // 红圈识别 + 从笔迹里剔除（决策 二-12）
  // 参考字候选库（lib/referenceCharReader.js 的 buildLibrary 产物）：**传了它才做"认参考字 + 定字序"**；
  // 不传就退回旧口径（按字序切段取字），供纯逻辑测试与没有字体可用的环境使用。
  library: null,
  // 这一批的字序（**来自目录里的字序文件**，决策 一-18）：给了它就"文件说了算" ——
  //   序列定位只在这个全序里找起点；定位不上但右侧方块读出了页号时，直接按页号从它里面切一段。
  //   没给（目录里没有字序文件、或文件不合格式）才退回"两份预置全序去猜"，即认参考字那条退路。
  orderChars: '',
  // **补写页的候选字序**（重写清单 / 未收录字清单，见决策 八-8 与八-19 ⑮⑲）：
  //   这些字既不在字序文件里、也不是任何预置全序的连续段，所以单独作为"候选全序"传进来 ——
  //   补写页的页号与字序校验（页级指纹）都在这几条候选里找。
  extraSequences: null,
  // 这一页上"有参考字的格"占比低于它 → 判定**不是本程序生成的模板**，整页失败
  // （用户 2026-10-11 拍板：只认自家模板产出的纸，外来图片一个字形也不产生）。
  // 实测满页模板在这条上是 0.99~1.00（参考字是印上去的，即使模糊也能取到）。
  // **2026-10-21 起降级为兜底**：底部条码解出、且与右侧方块指纹互证通过时直接放行（自定义档只选几十个字
  //   时覆盖率天然低于它；被红圈盖住的参考字又必然让逐格认字算错指纹，这一档正是条码要兜的场景，一-20）。
  //   覆盖率只在"条码读不出"时起作用；**补写页例外**（重写清单 / 未收录字模板）见 minRewriteChars。
  minInkRatio: 0.6,
  // 补写页的闸门：一页只印几个字也照收，判据改成"认出的字 ≥ 1 且指纹一致"
  minRewriteChars: 1,
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
 * 右侧方块四个方向都解不出时的**第二轮回退**（2026-10-13 用户拍板）。
 *
 * 为什么需要它：方向纠正的判据一直是"右侧方块能不能解出"（决策 二-11），可**右侧方块被裁掉 / 污损的纸本来还能用** ——
 *   四角定位块与纸面参考字都好好的。真件实测（把右侧方块带涂白）：四个方向右侧方块全败 → 方向判错 →
 *   按错方向切格 → 参考字覆盖率不达标 → 整页失败，用户除了重拍没有别的路。
 * 判据换成**纸面参考字能不能认出来**（与"这是不是自家模板"同源，决策 五-9 ④）：
 *   四个方向各跑一次「找四角 → 透视校正 → 按已知网格切格 → 认参考字」，取**序列定位命中优先、
 *   认得出的格数其次**的那个方向；达标线 = 定位命中，或认得出的格数 ≥ 136 × 0.6（与 `readPage` 的 ready 同口径）。
 *   **不能拿 `inkRatio` 当判据**：它只统计"格子里有没有模板的参考字"，把整页转 90°/180° 照样接近 1.0
 *   （参考字仍在格内、只是倒着）—— 实测踩到过一次：转错 90° 的方向拿了满分，于是选中错方向、整页白跑。
 * 代价：这一段约等于把切格 + 认字跑四遍（单页切格实测约 0.6 秒），但**只在右侧方块全败时才跑** ——
 *   右侧方块读得出的件一次都不会走到这里（`tried` 里任何一个方向解出右侧方块就直接返回 null）。
 * 口径不变的地方：右侧方块仍然没读出来（`footerOk` 依旧 false）→ 页号只能靠序列定位反推；
 *   参考字也定不出来时，这一页整页失败（"手选页序"这条界面兜底已按用户拍板去掉）。
 * @returns {object|null} 救回来时返回"按选定方向重新跑过"的页结果（orientation 已覆盖成真实方向），否则 null
 */
function rescueOrientationByReference(gray, failedPage, options) {
  const tried = (failedPage && failedPage.orientation && failedPage.orientation.tried) || []
  if (!options.library) return null // 没有参考字候选库（纯几何的测试路径）就没法评分
  if (failedPage.stage === 'marks' || failedPage.stage === 'transform') return null // 连四角都没找到
  if (tried.length < 2 || tried.some((t) => t.footerOk)) return null // 没试过多个方向，或本来就有方向解出了右侧方块

  let best = null
  for (const t of tried) {
    const input = t.turns === 0 ? gray : rotateQuarterTurns(gray, t.turns)
    // 这一轮**不再让它自己转方向**（我们正在逐方向评分），四角 / 校正 / 切格照旧
    const page = analyzePage(input, { autoOrient: false, keepDesignGray: true })
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
  // **整页可以继续**：方向已由纸面参考字定下来，四角 / 校正 / 切格都成功 —— 右侧方块读不出只是
  //   "少了一个自校验来源"（决策 五-9 ⑥ 早就把右侧方块降为兜底与自校验），不该再按"整页失败"处理。
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
      text: '这一页的底部条码与右侧方块都读不出来（可能被裁掉或污损）：已改按纸面参考字定方向（试了 ' +
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
 * @param {string} [options.chars] 这一轮的字序（**来自目录里的字序文件**；没有文件时为空串）
 * @param {number} [options.fileIndex] 第几个文件（0 起，仅用于展示与缓存键）
 * @param {number} [options.pageNumberOverride] 页号兜底（重传时沿用原页的页号；右侧方块读不出时才用）
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

  // ② 切格（1.5）：方向纠正 → 找四角 → 透视校正 → 右侧方块解码 → 按已知网格切 136 格
  stage('正在切格（找四角、透视校正、读底部条码与右侧方块）')
  let page = analyzePage(gray, { autoOrient: opt.autoOrient, keepDesignGray: true })
  // 右侧方块四个方向都解不出 → 再按"参考字覆盖率"试一遍四个方向（2026-10-13 用户拍板，见上面那个函数的注释）。
  // 右侧方块读得出的件一次都不会走到这里；只有"右侧方块被裁掉 / 污损"的纸才会真跑这四遍
  if (!page.ok) {
    stage('底部条码与右侧方块都读不出：正在按参考字试其它方向')
    const rescued = rescueOrientationByReference(gray, page, {
      library: opt.library,
      minInkRatio: opt.minInkRatio
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
    // 纸面右侧方块上的**本页校验码**（这一页那些字的 12 位指纹；0 表示"这一页没有字"）
    pageCode: null,
    // 这一页是不是**旧版本印的纸**（指纹 0 且页号落在主区范围）：旧更正册会被宽容地按更正册收下，
    // 界面据此说明"这一页没有本页校验码"
    legacyPaper: false,
    // 页级校验的结论（见 ③.6）：{ code, agree, from, correctedPageNumber }
    pageCheck: null,
    isSheetPage: null,
    // **右侧方块的原始结果要一起带上**：summarizeBatch（整批汇总）读的是 `p.footer.ok / pageNumber / pageCode`，
    // 只给 footerOk 这些扁平字段的话，每页都会被当成"右侧方块读不出"（踩过：汇总里全是"右侧方块没读出"的警告，
    // 而页面记录明明读出了第 1 页与校验码 3362 —— 因为那种情形只产生 warn、ok 仍为 true，测试也没抓住）
    footer: null,
    orientation: page.orientation ? {
      corrected: !!page.orientation.corrected,
      turns: page.orientation.turns,
      tried: page.orientation.tried,
      // 2026-10-13：方向是"按纸面参考字"救回来的（右侧方块读不出时）—— 界面据此换一句提示
      rescuedByReference: !!page.orientation.rescuedByReference,
      rescueSure: page.orientation.rescueSure || 0,
      rescueLocated: !!page.orientation.rescueLocated
    } : null,
    cornerMaxError: page.cornerErrors ? Math.round(page.cornerErrors.max * 10) / 10 : null,
    counts: { written: 0, empty: 0, suspect: 0, marked: 0, uncertain: 0, inkPixels: 0 },
    // 参考字识别与定字序（2026-10-11 新模型）：
    //   pageChars 是**这一页 136 格各自的字**（认不出为 null）—— 定位成功时由序列给出（整页确定），
    //   定位不上时是逐格识别结果（2026-10-15 起不再往界面上送"哪几格认不准"：逐格确认已去掉，
    //   页级校验码负责证明整页字序对不对）
    read: null,
    located: null,
    pageChars: null,
    pageNumberSource: null, // sequence（序列定位反推）| footer（右侧方块读出）| barcode（底部条码）| override（重传沿用原页页号）| code（指纹反推）| unknown
    // 这一页的字是**从哪儿来的**：file 目录里的字序文件 / barcode 底部条码 / sequence 纸面参考字序列定位 /
    //   cells 逐格认字 / rewrite 补写清单 / code 指纹反解（决策 一-20 把 barcode 插在 file 之后）
    // rewrite 补写清单。界面要把它显示出来 —— "字序是文件给死的"与"是猜出来的"对用户的信任度完全不同（一-18 ⑤）
    orderSource: null,
    cells: [],
    messages: [],
    timings: page.timings ? { ...page.timings } : null
  }
  // 右侧方块摘要（喂给 summarizeBatch 的最小形状）：读不出时给 ok:false 与原因，好让整批判定说得清是哪一页的问题。
  // **页号与件类型在这里就解释好**（layout.classifyFooterPage 是唯一口径）：更正册的页号要还原成
  //   "更正册第 n 页"（右侧方块里编的是 128+n−1 的区间值），否则它会被当成主区的第 128 页。
  const footerShape = (footer) => {
    if (!footer) {
      return { ok: false, pageNumber: null, pageCode: null, kind: 'unknown', message: '这一页没有右侧方块结果（切格没走到解码那一步）' }
    }
    if (!footer.ok) {
      return { ok: false, pageNumber: null, pageCode: null, kind: 'unknown', message: footer.message || '' }
    }
    const cls = classifyFooterPage(footer.pageNumber, footer.pageCode)
    // **旧纸的宽容（2026-10-15，有意为之）**：指纹 0 且页号落在主区范围 —— 这是**旧版本右侧方块**的形态
    //   （那时高 12 位放的是"整批共用的校验码"，而更正册固定印 0）。这一档判成**更正册**比判成
    //   "非字表页"对用户友好得多：更正册是空白册，收下它的唯一用途是给被圈的字当替代格子来源，
    //   没有指纹不会造成任何错配（它没笔迹就配不到任何字）。而**"整批不止一页"的旧纸会失败**：
    //   旧码是"整批算一个值、每页都印同一个"，与新指纹对不上，那部分作废是用户明确接受的
    //   （见《决策记录》一-19 的"代价"）。**边界（2026-10-16 核实；用户提出疑问后改写）**：
    //   **单页试打那一档的旧纸照旧可用**。道理是"**右侧方块里的校验码是纸的属性**"：识别端永远按**从这张纸上认出来的字**
    //   重算（就是下面那句 computePageCode(read.printedChars)），与"当前模板印的是哪些字"无关 ——
    //   旧纸（频序前 136 字）与新纸（现在是名句页，106 格）**各算各的、互不影响**。旧纸能过，是因为
    //   **那张纸当年那一批只有一页**："整批码"与"本页指纹"对同一张纸而言是同一串字、算法也同一个。
    //   打印自检页也会落进这一档（无害：它同样没有笔迹，卡片上会说明它可能是自检页）。
    const isBlankFingerprint = cls.kind === 'notSheet' && footer.pageNumber < CORRECTION_PAGE_BASE
    // 有字序文件时能认出**打印自检页**（它的页号是"字表页数 + 1"，必然超出声明页数）—— 那一档照旧不收；
    // 没有字序文件时无从区分，就按上面说的宽容处理（自检页被当更正册也无害）。
    const selfCheckPage = isBlankFingerprint && typeof opt.orderPages === 'number' && footer.pageNumber > opt.orderPages
    const legacyPaper = isBlankFingerprint && !selfCheckPage
    return {
      ok: true,
      pageNumber: legacyPaper ? footer.pageNumber : cls.pageNumber,
      rawPageNumber: footer.pageNumber,
      pageCode: footer.pageCode,
      kind: legacyPaper ? 'correction' : cls.kind,
      legacyPaper,
      message: footer.message || ''
    }
  }
  record.footer = footerShape(page.footer)

  if (!page.ok || !page.boxes || !page.boxes.length) {
    // 整页失败：按决策 二-6 明确失败 + 中文提示（不静默拿错坐标切格）
    record.reason = page.reason || (page.messages && page.messages.find((m) => m.level === 'error') || {}).text || '这一页没能定位到四角定位块'
    record.messages = (page.messages || []).map((m) => ({ level: m.level, text: m.text }))
    if (record.messages.length === 0) record.messages = [{ level: 'error', text: record.reason }]
    return { record, cache: { thumb: null, sheet: null, masks: null } }
  }

  record.footerOk = record.footer.ok
  // 件类型与页号：更正册靠页号区间（≥128）、非字表页靠指纹 0 —— 判定口径只在 classifyFooterPage 一处
  record.kind = record.footer.kind
  record.legacyPaper = !!record.footer.legacyPaper
  record.pageNumber = record.footer.pageNumber
  record.rawPageNumber = record.footer.rawPageNumber || null
  record.pageCode = record.footer.pageCode
  if (record.pageNumber === null && typeof opt.pageNumberOverride === 'number') {
    record.pageNumber = opt.pageNumberOverride
    record.pageNumberSource = 'override'
    record.orderFromUser = true // 页号沿用原页（重传），界面要显式标出来
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
  //   · 有参考字：优先**序列定位** —— 预置档位的纸连右侧方块都不用读，页号与整页 136 字一起确定；
  //     定位不上（自定义选字的纸不是任何全序的连续段）→ 退到"逐格识别的字 + 右侧方块里的页号"，
  //     没认准的格只**计数**（`unsureCount`，进页记录与提示），不再逐格往界面上送 ——
  //     那条「逐格复核」的操作 2026-10-15 已按用户拍板去掉，`unsureCells` 字段 2026-10-16 一并删除
  const orderChars = typeof opt.orderChars === 'string' && opt.orderChars.length ? opt.orderChars : ''
  // **底部条码给出的字序**（决策 一-20）：这一页每一格是哪个字，条码里直接写着（字表序号，-1 = 空白格）。
  //   它比"认参考字 + 序列定位"硬得多 —— 实测逐格认字 top-1 只有 91%，错几格整页就废；
  //   而条码给的是**纸面自己写的答案**，还带 CRC + 纠错。
  //   优先级（用户口径）：**字序文件 > 条码 > 序列定位 / 逐格认字** —— 文件是"这一批纸的真相"，
  //   有文件就以文件为准；没有文件时条码就是最可靠的那条路。
  const barcodeChars = (() => {
    if (orderChars) return null
    const bc = page.barcode
    if (!bc || !bc.ok || !bc.payload || !bc.payload.order) return null
    const idx = bc.payload.order.indexes
    if (!Array.isArray(idx) || !idx.length) return null
    const table = getAllChars()
    const chars = idx.map((i) => (i >= 0 && table[i] ? table[i] : null))
    return chars.some((c) => c !== null) ? chars : null
  })()
  // 条码字序的页级指纹：与右侧方块里的那 12 位互证（一-20）。条码自己带 CRC16 + RS 纠错，
  //   所以"条码解出 + 指纹一致"是**两条独立印刷通道**共同证明"这一页是哪些字"——比参考字覆盖率硬得多。
  //   2026-10-21 真实自定义档纸（72 字 / 136 格 = 52.9%）就是被覆盖率闸门误判的：红圈盖住的 5 个参考字
  //   让逐格认字算出的指纹对不上，页还没走到条码就被判成"不是本程序生成的模板"。
  const barcodeCode = barcodeChars ? computePageCode(barcodeChars) : null
  // 条码里的页号比右侧方块读出来的更可信（条码整块带纠错，竖带只有 24 个小方块）：有就用它
  if (barcodeChars && page.barcode.payload.pageNumber) {
    record.pageNumber = page.barcode.payload.pageNumber
    record.pageNumberSource = 'barcode'
  }
  // 候选全序（页级校验的反推要在它们里面逐页找指纹）：
  //   · file    = 目录里的字序文件（决策 一-18）
  //   · rewrite = 补写清单（重写模板 / 未收录字模板，决策 八-8、八-19 ⑮⑲）
  //   · 一个都没有时，referenceCharReader 会拿两份预置全序（笔画序 / 频序）去定位
  const candidates = []
  if (orderChars) candidates.push({ key: 'file', label: '字序文件', chars: Array.from(orderChars) })
  // 条码候选排在文件之后：文件说了算；没有文件时它就是最可靠的那一条（一-20）
  if (barcodeChars) candidates.push({ key: 'barcode', label: '底部条码', chars: barcodeChars })
  for (const extra of (opt.extraSequences || [])) {
    if (extra && extra.chars && extra.chars.length) {
      candidates.push({ key: extra.key || 'rewrite', label: extra.label || '补写清单', chars: Array.from(extra.chars) })
    }
  }
  // **内置候选：单页试打那一页的字序**（2026-10-18 用户实测发现后才加的）。
  // 为什么要有（真机踩到的）：那一页印的是 9 句名句连排（106 格、没有标点分隔），**不是任何预置全序的
  //   连续段** —— 丢了 `字序.sxorder` 时只能逐格认字，而 106 个字里认错一个，右侧方块里的指纹（整页哈希）
  //   就对不上 → 整页失败、写过的字只能重写。可这一页的内容是**程序里的常量**（lib/singlePageText.js），
  //   "这一页可能是哪些字"其实已知 → 把它当候选送进"认参考字 + 序列定位"，丢文件也能救回来。
  // 只在**没有字序文件**时加：文件是这一批纸的真相，有它就不该再拿别的序列去猜（一-18 的口径）。
  if (!orderChars) {
    candidates.push({ key: 'single', label: '单页试打的字序（内置）', chars: Array.from(SINGLE_PAGE_TEXT) })
  }
  // 指纹为 0 的件：可能是打印自检页，也可能是**旧版本模板 / 旧更正册**印的纸
  // （2026-10-15 起右侧方块里的 12 位改成"本页指纹"，旧纸那一格里是整批共用的码或 0）。
  // 走到这里说明它超出了字序文件声明的页数 —— 按打印自检页处理；两种可能都说清，
  // 只说"这是自检页"对着一本旧更正册完全说不通。
  if (record.kind === 'notSheet') {
    record.reason = '这一页的右侧方块里没有本页校验码（指纹 0）、页号又超出字序文件声明的页数：' +
      '它多半是模板文末的打印自检页（没有字表内容）；也可能是**旧版本模板**印的纸（右侧方块的口径换过两次：2026-10-15 改语义、2026-10-18 改排布）。' +
      '请确认这一页是写了字的字表页；是的话请用最新下载的模板重新打印、重写这一页。'
    record.messages = [{ level: 'error', text: record.reason }]
    return { record, cache: { thumb: null, sheet: null, masks: null } }
  }
  if (opt.library && record.kind !== 'correction' && page.designGray) {
    stage('正在认参考字、定字序')
    // 有候选字序（字序文件 / 补写清单）时**只试这几个序列**：文件说了算，不能再拿两份预置全序去猜 ——
    //   猜中的那一个可能是另一套字序（纸上的字确实按那个顺序排过），于是整页的字被换成另一套，
    //   而且"看起来还挺对"（这正是 一-18 要把字序显式落成文件的原因）。
    const sequences = candidates.length ? candidates : undefined
    const read = readReferenceChars(page.designGray, opt.library, { redMask: designRedMask, sequences })
    record.read = {
      emptyCount: read.emptyCount,
      sureCount: read.sureCount,
      unsureCount: read.unsureCount,
      inkRatio: Math.round(read.inkRatio * 1000) / 1000,
      located: read.located ? { seqKey: read.located.seqKey, start: read.located.start, agree: read.located.agree } : null
    }
    // 页级校验码的自证：把"这一页实际印了参考字的那些字"算一遍，与纸面右侧方块上的那 12 位比。
    // 这是 2026-10-15 新口径的核心 —— 一致就说明"这一页是第几页、上面是哪些字"确定无疑。
    const selfCode = computePageCode(read.printedChars)
    const selfAgree = !!record.pageCode && selfCode === record.pageCode
    // **条码自证**（2026-10-21）：条码解出 = 这一页的字序由纸面自己给出；右侧方块能读时两者必须一致。
    //   `!record.pageCode` 也收：竖带被裁 / 污损时，条码的 CRC + RS 本身就是足够强的"自家纸"证据。
    const barcodeCertified = !!barcodeChars && (!record.pageCode || barcodeCode === record.pageCode)
    const sparse = read.inkRatio < opt.minInkRatio
    // 闸门分档（2026-10-15 用户拍板）：主区字表页要求"有参考字的格 ≥ 60%"（整版纸 136 格基本都印着字）；
    //   补写页（重写清单 / 未收录字模板，一页只印几个字）改成"认出的字 ≥ 1 且右侧方块里的指纹对得上"。
    //   **2026-10-21 起再加一条**：条码与右侧方块互证通过时直接放行 —— 自定义档只选几十个字时覆盖率天然
    //   低于 60%，而被红圈盖住的参考字又必然让逐格认字算错指纹（这一档正是条码要兜的场景，一-20 / 二-12 ⑩）。
    //   覆盖率只在"条码读不出"时兜底（此时"认出的字 ≥ 1 且指纹一致"仍可用）。
    if (sparse && !barcodeCertified && !(read.printedChars.length >= opt.minRewriteChars && selfAgree)) {
      record.reason = '这不是本程序生成的模板：这一页 ' + LAYOUT.perPage + ' 格里有 ' + read.emptyCount +
        ' 格取不到模板的参考字。请确认用的是第 1 步「下载模板」得到的那份文件、按实际大小（100%）打印的纸。'
      record.messages = [{ level: 'error', text: record.reason }]
      return { record, cache: { thumb: null, sheet: null, masks: null } }
    }
    if (read.located) {
      // 序列定位命中：整页 136 个字全部确定（含那几个认不出的格），页号由起点反推
      record.located = record.read.located
      record.pageNumber = Math.floor(read.located.start / LAYOUT.perPage) + 1
      record.pageNumberSource = 'sequence'
      // 序列定位用的候选序列就是字序文件 / 条码时，这一页的字等于"它给死的那一段"（不是猜出来的）
      record.orderSource = orderChars ? 'file' : (read.located.seqKey === 'barcode' ? 'barcode' : 'sequence')
      record.pageChars = read.located.chars.slice()
    } else if (orderChars && record.pageNumber !== null) {
      // 字序文件在、右侧方块也读出了页号：直接按页号从文件字序里切一段。
      // 为什么这条路比"逐格认字"硬：文件给死的是**完整字序**，页号一确定，这一页 136 个字就全确定，
      //   一个也不用猜（逐格认字的错会静默进成品，这里没有可猜的余地）。
      const list = Array.from(orderChars)
      const start = (record.pageNumber - 1) * LAYOUT.perPage
      record.pageChars = list.slice(start, start + LAYOUT.perPage)
      record.pageNumberSource = 'footer'
      record.orderSource = 'file'
      messages.push({
        level: 'info',
        text: '这一页的字序取自目录里的字序文件：第 ' + record.pageNumber + ' 页 = 字序里的第 ' +
          (start + 1) + ' ~ ' + (start + record.pageChars.length) + ' 个字'
      })
    } else if (barcodeChars && barcodeChars.length) {
      // 条码给出了这一页的字序，但序列定位没命中（认参考字质量太差）：**仍然用条码的** ——
      //   它比逐格认字硬得多；后面 ③.6 的页级校验会拿指纹把关，对不上就整页失败，不会静默用错字序。
      record.pageChars = barcodeChars.slice()
      record.pageNumberSource = 'barcode'
      record.orderSource = 'barcode'
      messages.push({
        level: 'info',
        text: '这一页的字序取自底部条码（' + barcodeChars.length + ' 格，含空白格位）'
      })
    } else {
      record.pageChars = read.cells.map((c) => (c.empty ? null : c.char))
      record.pageNumberSource = record.pageNumber !== null ? 'footer' : (record.orderFromUser ? 'override' : 'unknown')
      record.orderSource = 'cells'
      messages.push({
        level: 'info',
        text: '这一页的字按纸面逐个认出来（不依赖字序文件）：认出 ' + read.printedChars.length + ' 格' +
          (read.unsureCount + read.emptyCount > 0 ? '，另有 ' + (read.unsureCount + read.emptyCount) + ' 格没认准' : '') +
          '；与右侧方块里的校验码一致才采用'
      })
    }
    // 补写页（一页只印了几个字的那种）：字来自逐格认字时，界面要能说明这一页的来路是"补写清单"。
    // **只在字序确实来自逐格认字时才这么标**（2026-10-16 修）：原来是无条件 `if (sparse)` 覆盖，
    //   而"稀疏"不止补写页一种 —— 自定义档只选了几个字打的纸、未收录字模板都算稀疏；
    //   **2026-10-18 起单页试打不在其列**：那一页改成名句集锦后是 106/136 = 78%，过得了 60% 那道闸
    //   （旧版那篇短文页 77/136 = 57% 曾是这条判据的活样本）。
    if (sparse && record.orderSource === 'cells') record.orderSource = 'rewrite'

    // ③.6 页级校验（每页自证，2026-10-15 新口径）：纸面右侧方块里那 12 位 = "这一页应当是哪些字"的指纹。
    //   一致 → 这一页的字序确定无疑；不一致 → **先用指纹反推页号**（在候选字序里逐页试，
    //   全量 61 页只要 61 次哈希），反推命中就纠正页号与字序；仍然对不上 → 整页失败。
    //   为什么宁严勿宽：按错字序识别出来的是一整页"看着挺好、其实全是别的字"的字形（与二-6 同一条底线）。
    if (record.pageCode) {
      // 指纹来源：条码自证时用**条码字序**算出的指纹（前面已与右侧方块比对过），否则用纸面逐格认字算出的指纹。
      // 为什么（2026-10-21）：条码解出时"这一页是哪些字"由纸面自己给出，被红圈盖住的参考字不该再把校验
      //   判成"对不上"，更不该触发"已按校验码反推"这种误导文案 —— 这一页的页号本来就来自条码。
      const check = {
        code: barcodeCertified ? barcodeCode : selfCode,
        agree: barcodeCertified || selfAgree,
        from: barcodeCertified ? 'barcode' : 'self'
      }
      if (!check.agree) {
        // **先试"指纹反解"**（2026-10-18 新增；用户实测问"字序文件丢了写的字就报废吗"之后做的）：
        //   字序来自**逐格认字**时（没有候选字序），每格的 top-2 候选其实已经算好了 —— 在"最可疑的
        //   十几格"里穷举，找出使右侧方块里的指纹与纸面一致、且候选分数最像的那一组，就把认错的格纠正回来了。
        //   它**不需要任何候选字序**（候选来自纸面自己），所以自定义档丢了字序文件也能救回来。
        //   判据与边界全在 lib/pageCodeSolve.js（12 位指纹只有 4096 种值，组合空间大时会撞上"假匹配"，
        //   所以那边会按候选分数择优、并要求明显优于次优 —— 分不开就返回 null，这里照旧往下走反推 / 失败）。
        let solvedOk = false
        if ((record.orderSource === 'cells' || record.orderSource === 'rewrite') && read && read.cells) {
          const solved = solvePageCharsByCode(read.cells, record.pageCode)
          if (solved) {
            record.pageChars = solved.chars.slice()
            record.orderSource = 'code'
            record.pageCheck = { code: solved.code, agree: true, from: 'solve', fixed: solved.fixed }
            solvedOk = true
            messages.push({
              level: 'info',
              text: '这一页的参考字有几格没认准（红圈 / 手写序号盖住了？），已用右侧方块里的校验码纠正 ' +
                solved.fixed + ' 格，整页字序与纸面指纹一致'
            })
          }
        }
        if (solvedOk) {
          // 已经用反解通过校验：跳过"反推页号"与失败分支
        } else {
          let hit = null
          let hitSeq = null
          for (const cand of candidates) {
            const m = matchPageCode(record.pageCode, cand.chars, LAYOUT.perPage)
            if (m) { hit = m; hitSeq = cand; break }
          }
          if (hit) {
            record.pageNumber = hit.pageNumber
            record.pageNumberSource = 'code'
            record.pageChars = hit.chars.slice()
            record.orderSource = hitSeq.key
            record.located = { seqKey: hitSeq.key, start: (hit.pageNumber - 1) * LAYOUT.perPage, agree: 0 }
            check.agree = true // 已经通过校验（只是走的是"反推页号"这条路）
            check.from = 'reverse'
            check.correctedPageNumber = hit.pageNumber
            check.seqKey = hitSeq.key
            messages.push({
              level: 'info',
              text: '纸面右侧方块上的校验码与识别出的字序对不上，已按校验码反推：这一页是第 ' + hit.pageNumber +
                ' 页（字序取自' + hitSeq.label + '）'
            })
          } else {
            check.agree = false
            record.pageCheck = check
            // 失败原因分两种（2026-10-18 用户实测踩到的）：字序是**逐格认出来**的（目录里没有字序文件）
            //   时，多半是个别字没认准 → 提示他把字序文件放进来，而不是让他怀疑纸印错了；
            //   字序来自字序文件 / 序列定位时，才真的是"纸与这套字序不匹配"（旧纸或别的批）。
            const byCells = record.orderSource === 'cells' || record.orderSource === 'rewrite'
            record.reason = '这一页右侧方块里的校验码与识别出的字序对不上（纸面 ' + record.pageCode + '、识别出 ' + selfCode + '）：' +
              (byCells
                ? '这一页的字序是按纸面逐格认出来的（目录里没有字序文件），个别字没认准就会对不上 —— ' +
                  '把第 1 步压缩包里的「字序.sxorder」和图片一起放进这个文件夹，再识别一次通常就好。'
                : '这张纸可能不是用最新模板印的（旧模板印的纸要重印），或者这一页的参考字没认对。') +
              '若这一页本来就只印了很少几个字（重写模板 / 补写模板），请从第 3 步那一处重新下载模板再打一份。'
            record.messages = [{ level: 'error', text: record.reason }]
            return { record, cache: { thumb: null, sheet: null, masks: null } }
          }
        }
      }
      record.pageCheck = check
    }
  }

  // ④ 字形提取（1.6）：灰度分层 + 面积过滤，红圈像素按附加图层跳过
  stage('正在提取笔迹')
  const extracted = extractPage(extractionBoxes)
  const markedSet = new Set(record.markedCells || [])
  const uncertainSet = new Set(record.uncertainCells || [])
  const items = []
  for (const cell of extracted.cells) {
    // 更正册的格没有"字"：它是"第 k 个更正格"，字由更正核对（1.8）配对时决定（决策 二-13）
    // 字序来源：**优先用这一页自己认出来的字**（新模型：范围由扫描件决定）；没有认字结果时才退回
    // 按页号在字序文件里切段（`charAtCell`）—— 那条只有在"字序文件 + 右侧方块里的页号"都在时才有意义
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
 */
export async function recognizeBatch(files, options = {}) {
  const opt = { ...SCAN_DEFAULTS, ...options }
  // 这一批的字序：**字序文件优先**（决策 一-18）—— 它给死的就是"这批纸的字序"；
  // 没有文件时字序完全由纸面参考字定（序列定位），再不行就逐格认字 + 右侧方块里的校验码自证
  const chars = opt.orderChars || ''
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
    const { record, cache } = await recognizePage(files[i], { ...opt, chars, fileIndex: i })
    pages.push(record)
    caches.set(i, cache)
    // onPage 带上该页的内存缓存（缩略图 / 格子拼图 / 掩膜）：界面要**边跑边显示**，
    // 不能等整批结束才拿到（全量 61 页要等约 100 秒，期间什么都看不到）。
    // **要 await**：回调里要落盘字形（一页一次写），不等它就没有确定的完成顺序
    if (opt.onPage) await opt.onPage(record, i, files.length, cache)
  }
  // 重复页去重（2026-10-14 用户拍板）：同一页号有多份时**自动采用效果最好的一份**，其余打上 duplicateOf。
  // 为什么放在 summarizeBatch **之前**：汇总与闸门都要按"去重后的页"来数（可用页数、写出格数、被圈数、
  //   更正配对的候选），否则统计会翻倍错乱（用户真机实测：12 份同一张纸 → "被红笔圈 29 个"、
  //   配对表里同一个字出现四行、下面一大片"没有对应格"）。判据与字段口径见 scanMeta.dedupeDuplicatePages。
  // **2026-10-14 修**：结论要一起回传主线程（见下面 duplicates 的注释）。
  const { duplicates, failedDuplicates } = markDuplicatePages(pages)
  const summary = summarizeBatch(pages, {
    // 页数口径：有字序文件时以**文件声明的页数**为准（缺页统计与"非字表页"的提示都读它）
    sheetPages: typeof opt.orderPages === 'number' ? opt.orderPages : undefined
  })
  return { pages, caches, summary, chars, stopped, duplicates, failedDuplicates }
}

// 2026-10-15 用户拍板：「手选页序」这条界面操作已去掉，因此这里的 applyPageOrder（以及它依赖的
//   scanMeta.reorderPages）一并删除。右侧方块读不出时页号与字序由纸面参考字序列定位定；定不出来就整页失败
//   （页级校验码也帮不上 —— 它要求先猜出"这一页是哪些字"）。需要时从 git 历史取回。
