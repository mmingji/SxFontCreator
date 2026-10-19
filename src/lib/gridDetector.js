// 自动切格（阶段一步骤 1.5）—— 本项目的核心难点
// 职责：把"一页扫描件"变成"页号 + 本页校验码 + 136 个格子的像素"：
//   ① 在二值图上找四角定位块 → ② 用 4 组对应点解 3×3 透视矩阵 → ③ 把整页校正到设计坐标系
//   → ④ 解码右侧方块（页号 8 + 档位 4 + 指纹 12）与底部条码 → ⑤ 按**已知网格坐标**切格。
// 与相邻模块的边界：算子（连通域 / 单应 / 重采样 / 阈值）全在 imageOps.js，本模块只做业务几何与判定；
//   1.4 的 scanPreprocessor 负责把图弄干净并给中文质量提示（本模块吃它的**灰度图**）；
//   1.6 字形提取吃本模块切出来的格子切片（写进 store 的 glyphs）。
// 四条关键设计（都是为了"切错比不切更糟"这条底线）：
//   ① **标记检测不走 Otsu 二值图**：右侧方块与定位块（中深青 #2E6E7E）灰度约 93，而 2026-10-03 调深后的
//      格线与参考字（#A6A6A6）是 166。Otsu 阈值实测 174（旧色值时期）——格线 166 比它暗，会被判成前景；
//      更麻烦的是 Otsu 会随格线深浅与占比漂移。所以这里用**固定阈值 150**（落在 93 与 166 之间 70 的余量
//      正中），再与局部自适应阈值取交集挡住"手机拍摄的整片暗背景"，与"格线调到多深"彻底解耦。
//   ② **校正到设计坐标系**（A4 横向 @300dpi = 3508 × 2480 像素）：设计坐标就是模板 PDF 的坐标系
//      （LAYOUT 的 pt 尺寸按 300dpi 折算），切格因此退化成"按已知矩形取像素"，不再有任何坐标换算（决策 二-3）。
//   ③ **切片外扩量由版式推导、不写死**（见 CELL_PAD_PT）：上限是中缝 gapMid（书写格顶边 ↔ 参考字区域底边），
//      扣掉实测校正残差（< 6px@300dpi）。这样"外扩后不会碰到参考字区域"这条约束由版式保证：
//      将来改 4 : 2 : 4 的比例或参考字区域大小，外扩量自动跟着变，测试里还有一条断言钉住。
//   ④ **定位块找不到就整页放弃**（决策 二-6）：给中文提示、不做手动标四角；**右侧方块读不出仍照常切格**
//      （页号置 0，由上层按纸面参考字定），不因此判整页失败；
//      拿不准的坐标切出来的是一整批错位字形，比拒绝处理糟得多。
//   ⑤ **方向自动纠正**（2026-10-04 补，决策 二-11）：扫描件整页被转着扫进来是常见操作（实测用户把 A4 横向的
//      纸竖着放进平板扫描仪），而这时**四个定位块依然落在图的四角附近**，找四角照样"成功"、校正也照样"成功"，
//      只有右侧方块解码会失败 —— 也就是说方向错了会静默切出整页错位的格子。所以右侧方块解不出时依次试 0/90/180/270
//      （竖版图先试 90/270），取第一个"右侧方块能解出且校正残差在限内"的方向；四个都不成才明确失败。
import {
  adaptiveThreshold, connectedComponents, globalThreshold, invert3x3, rotateQuarterTurns, solveHomography, warpGray
} from './imageOps.js'
import { LAYOUT, cellRect, writingBoxRect, decodeSideBandBits, sideBandBlockRects, classifyFooterPage } from './layout.js'
import { sampleBarcodeModules, rowsToPayload, unpackBarcodePayload } from './pageBarcode.js'

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// ── 设计坐标系 ────────────────────────────────────────────────────────────
// 为什么是 300dpi 而不是"扫描件自己的尺寸"：设计坐标就是模板 PDF 的坐标系，切格按它取矩形即可；
//   手机拍摄件会被**上采样**到这个尺寸，细节不会凭空变多，但换来的是全套坐标恒定（1.4 已按此实测）。
// PDF 坐标（原点左下、单位 pt）与图像坐标（原点左上、单位 px）差一次 y 翻转，这里只留一个换算口。
export const DESIGN = (() => {
  const dpi = 300
  const ptToPx = dpi / 72
  return {
    dpi,
    ptToPx,
    width: Math.round(LAYOUT.pageWidth * ptToPx), // 3508
    height: Math.round(LAYOUT.pageHeight * ptToPx), // 2480
    // PDF 的 x（pt）→ 图像 x（px）
    x: (ptX) => ptX * ptToPx,
    // PDF 的 y（pt，自底边向上）→ 图像 y（px，自顶边向下）
    y: (ptY) => (LAYOUT.pageHeight - ptY) * ptToPx,
    // PDF 的矩形（x=左、y=底边）→ 图像矩形（x=左、y=上边），四边各自取整，保证相邻格无缝无叠
    rect: (r) => {
      const x0 = Math.round(r.x * ptToPx)
      const x1 = Math.round((r.x + r.width) * ptToPx)
      const y0 = Math.round((LAYOUT.pageHeight - (r.y + r.height)) * ptToPx)
      const y1 = Math.round((LAYOUT.pageHeight - r.y) * ptToPx)
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
    }
  }
})()

// 设计坐标下四个定位块的中心 —— 透视校正的目标点（顺序：左上、右上、右下、左下，图像坐标）
export const CORNER_ORDER = ['tl', 'tr', 'br', 'bl']
export const MARK_CENTERS_PX = (() => {
  const { markOffset, markSize, pageWidth, pageHeight } = LAYOUT
  const cxLeft = DESIGN.x(markOffset + markSize / 2)
  const cxRight = DESIGN.x(pageWidth - markOffset - markSize / 2)
  const cyTop = DESIGN.y(pageHeight - markOffset - markSize / 2)
  const cyBottom = DESIGN.y(markOffset + markSize / 2)
  return {
    tl: { x: cxLeft, y: cyTop },
    tr: { x: cxRight, y: cyTop },
    br: { x: cxRight, y: cyBottom },
    bl: { x: cxLeft, y: cyBottom }
  }
})()

// 设计坐标下**右侧竖带**方块的位置（图像 px）：1 个锚点 + 24 个数据位（页号 8 / 档位 4 / 指纹 12）。
// 几何直接取自 layout.js 的 sideBandBlockRects() —— **生成端 drawSideBand 用的也是它**，
// 两处各写一遍公式早晚会写歪（《决策记录》一-20 的契约）。
export const SIDE_BAND_RECTS_PX = (() => {
  const rects = sideBandBlockRects()
  return { anchor: DESIGN.rect(rects[0]), bits: rects.slice(1).map((r) => DESIGN.rect(r)) }
})()

// ── 参数 ──────────────────────────────────────────────────────────────────

// 1.4 实测：按四角定位块校正后，定位块回到设计位置的误差 < 6 像素（@300dpi）= 1.44pt = 0.508mm。
// 它是"外扩量能贴参考字区域多近"的安全余量，也是"校正是否合格"的参考线。
export const RECTIFY_RESIDUAL_PT = 6 * (72 / DESIGN.dpi)
// 切片外扩的**硬上限**：中缝（书写格顶边 ↔ 参考字区域底边）。超过它就会把参考字切进切片。
export const CELL_PAD_MAX_PT = LAYOUT.gapMid
// 实际外扩量 = 上限 − 校正残差余量 ≈ 3.39pt = 1.20mm ≈ 14px。
// **向下取整到 0.01pt**：外扩量宁可少一点，也绝不能越过"不碰参考字区域"这条硬约束
// （向上取整会让 3.39856 变成 3.40，加上残差就超出中缝 0.0014pt —— 测试里有一条断言专门钉这件事）。
export const CELL_PAD_PT = Math.floor((CELL_PAD_MAX_PT - RECTIFY_RESIDUAL_PT) * 100) / 100

export const DETECT_DEFAULTS = {
  // 标记检测的固定阈值：定位块与右侧方块灰度约 93，调深后的格线与参考字 166 —— 150 在两者之间
  markThreshold: 150,
  // 与局部自适应阈值取交集：手机拍摄时纸面一侧可能整体偏暗（灰度 < 150 会被固定阈值整片判成前景），
  // 局部自适应只保留"比周围背景暗"的像素，正好挡住这类背景，同时不影响定位块（远暗于其局部背景）
  localGuard: true,
  adaptiveBlock: 64, // 局部背景块大小（px）：64 ≈ 5.4mm@300dpi，比定位块（59px）略大
  adaptiveOffset: 12, // 比局部背景暗多少才算前景（沿用 1.4 的预处理默认值）
  // 定位块候选的形状过滤：0.5cm 见方 ≈ 59×59 像素 @300dpi
  minMarkArea: 400, // ≈ 0.5cm @120dpi（24×24）：再小就不是定位块了
  maxMarkArea: 20000, // ≈ 0.5cm @600dpi（118×118）：再大就不是定位块了
  minAspect: 0.75,
  maxAspect: 1.33,
  minFill: 0.72, // 实心方块填充率为 1；笔迹块（口 / 国 这类）远低于它
  cornerZone: 0.25, // 四角搜索区：页宽 / 页高各 25%。纸占画面 ≥ 60% 时定位块仍落在区内（决策 二-4 的拍摄要求）
  markSizeTolerance: 0.35, // 四块等效边长相互之间的最大相对偏差（防止拿噪点凑数）
  maxComponents: 20000, // 整页笔迹可能分成上万个连通块，上限太小会把右下角的定位块截掉
  // 右侧竖带解码（2026-10-18 起取代"页脚 20 位横排"，决策 一-20）
  footInset: 0.3, // 采样区 = 方块中心 60%（每边内缩 30%），躲开抗锯齿边缘
  footOnRatio: 0.5, // 暗像素占比 ≥ 0.5 记为二进制 1
  footUncertainLow: 0.3, // 占比落在这个区间说明"读不准"（既不像空位也不像实心方块）
  footUncertainHigh: 0.7,
  anchorMinFill: 0.8, // 锚点方块必须几乎填满采样区，否则判定右侧方块整排不可用
  anchorSearchPx: 6, // 锚点质心搜索半径：吸收整体对齐残差（实测 < 6px）
  // 底部条码采样（决策 一-20）：内缩比例 / 最小对比度 / 粗定位外扩像素 / 精搜索半径
  barcodeInset: 0.3,
  barcodeMinContrast: 40,
  barcodePadPx: 12,
  barcodeSearchPx: 2,
  // 校正后的自检
  cornerErrorWarn: 6, // 超过它给 warn（实测真实件 < 6px）
  cornerErrorLimit: 15, // 超过它判本页不可用：再切下去大概率整页错位
  verifyRectified: true,
  // 方向自动纠正：右侧方块解不出时依次试其它 90° 方向（决策 二-11）。
  // 关掉它 = 只按送进来的方向处理（测试里用它验证"方向错了会明确失败、不会静默切错"）
  autoOrient: true
}

// ── 找四角定位块 ──────────────────────────────────────────────────────────

// 标记掩膜 = 固定阈值 ∩ 局部自适应阈值（两个条件的各自作用见 DETECT_DEFAULTS 注释）。
// 为什么不直接用 1.4 的二值图：那是 Otsu 的产物，格线调深到 166 后会被判成前景（见文件头 ①）。
export function buildMarkMask(gray, options = {}) {
  const opt = { ...DETECT_DEFAULTS, ...options }
  const fixed = globalThreshold(gray, opt.markThreshold)
  if (!opt.localGuard) return fixed
  const local = adaptiveThreshold(gray, { blockSize: opt.adaptiveBlock, offset: opt.adaptiveOffset })
  const data = new Uint8Array(fixed.data.length)
  for (let i = 0; i < data.length; i++) data[i] = fixed.data[i] && local.data[i] ? 1 : 0
  return { data, width: fixed.width, height: fixed.height }
}

const CORNER_LABEL = { tl: '左上', tr: '右上', br: '右下', bl: '左下' }

function cornerZones(width, height, zone) {
  const zx = width * zone
  const zy = height * zone
  return {
    tl: { x0: 0, x1: zx, y0: 0, y1: zy },
    tr: { x0: width - zx, x1: width, y0: 0, y1: zy },
    bl: { x0: 0, x1: zx, y0: height - zy, y1: height },
    br: { x0: width - zx, x1: width, y0: height - zy, y1: height }
  }
}

/**
 * 在一页灰度图上找四个角的定位块。
 * @param {{data:Uint8ClampedArray,width:number,height:number}} gray 预处理后的灰度图（已去噪）
 * @param {object} [options] 见 DETECT_DEFAULTS；传 options.mask 可复用已有掩膜
 * @returns {{ok:boolean, marks:object|null, found:string[], missing:string[], candidates:number,
 *   sizes:object, message:string}}
 *   失败时的 message 是给用户看的中文提示（决策 二-6：不静默、不猜、不手动补救）
 */
export function findRegisterMarks(gray, options = {}) {
  const opt = { ...DETECT_DEFAULTS, ...options }
  const { width: W, height: H } = gray
  const mask = opt.mask || buildMarkMask(gray, opt)
  // 面积下限已经滤掉细线与噪点；上限滤掉成片背景与表格边框（它们会连成一大块）
  const { components } = connectedComponents(mask, {
    minArea: opt.minMarkArea,
    maxArea: opt.maxMarkArea,
    maxComponents: opt.maxComponents
  })
  // 定位块是**实心近似正方形**：近似正方形的笔迹块（口 / 日 / 国）填充率远低于实心方块
  const squares = components.filter((c) => {
    const aspect = c.width / c.height
    const fill = c.area / (c.width * c.height)
    return aspect >= opt.minAspect && aspect <= opt.maxAspect && fill >= opt.minFill
  })

  const zones = cornerZones(W, H, opt.cornerZone)
  const marks = {}
  const taken = new Set()
  for (const key of CORNER_ORDER) {
    const z = zones[key]
    let best = null
    for (const c of squares) {
      if (taken.has(c.id)) continue
      if (c.cx < z.x0 || c.cx > z.x1 || c.cy < z.y0 || c.cy > z.y1) continue
      // 同一个角里可能有多个候选（例如写歪的笔画块）：取面积最大的那个 —— 定位块是角落里最大的实心方块
      if (!best || c.area > best.area) best = c
    }
    if (best) {
      taken.add(best.id)
      marks[key] = best
    }
  }

  const found = CORNER_ORDER.filter((k) => marks[k])
  const missing = CORNER_ORDER.filter((k) => !marks[k])
  const sizes = {}
  for (const k of found) sizes[k] = { width: marks[k].width, height: marks[k].height, area: marks[k].area }

  if (found.length === 0) {
    return {
      ok: false, marks: null, found, missing, candidates: squares.length, sizes,
      message: '没找到四角定位块。请确认：打印时选的是实际大小（100%）、纸的四角完整没被裁、纸面平整，然后重扫一次'
    }
  }
  if (missing.length) {
    return {
      ok: false, marks, found, missing, candidates: squares.length, sizes,
      message: '只找到 ' + found.length + ' 个定位块，缺：' +
        missing.map((k) => CORNER_LABEL[k]).join('、') +
        '。请确认纸的四角完整（没被裁掉、没被手指或阴影挡住）、打印时选的是实际大小（100%），然后重扫一次'
    }
  }
  // 四块大小必须接近：一边大一边小通常意味着认错了目标（拿到了某个笔迹块或纸角阴影）
  const sides = CORNER_ORDER.map((k) => Math.sqrt(marks[k].area))
  const ratio = Math.max(...sides) / Math.min(...sides)
  if (ratio > 1 + opt.markSizeTolerance) {
    return {
      ok: false, marks, found, missing, candidates: squares.length, sizes,
      message: '四角定位块的大小差异过大（最大与最小相差 ' + Math.round((ratio - 1) * 100) +
        '%），可能有一角被遮挡、被裁或被认错，请重扫一次'
    }
  }
  return {
    ok: true, marks, found, missing, candidates: squares.length, sizes,
    message: '已找到四角定位块（' + sizes.tl.width + '×' + sizes.tl.height + ' 像素等）'
  }
}

// ── 透视变换与校正 ────────────────────────────────────────────────────────

/**
 * 由四角定位块解出"扫描件坐标 → 设计坐标"的 3×3 透视矩阵。
 * @returns {{ok:boolean, matrix:number[]|null, marks:object|null, message:string}}
 */
export function detectDesignTransform(gray, options = {}) {
  const opt = { ...DETECT_DEFAULTS, ...options }
  const found = opt.marks || findRegisterMarks(gray, opt)
  if (!found.ok) return { ok: false, matrix: null, marks: found, message: found.message }
  const from = CORNER_ORDER.map((k) => ({ x: found.marks[k].cx, y: found.marks[k].cy }))
  const to = CORNER_ORDER.map((k) => MARK_CENTERS_PX[k])
  try {
    const matrix = solveHomography(from, to)
    return { ok: true, matrix, marks: found, message: '已按四角定位块解出透视变换' }
  } catch (e) {
    return {
      ok: false, matrix: null, marks: found,
      message: '四角定位块的连线异常（可能有一角认错或被裁），无法算出透视变换：' + (e && e.message ? e.message : e)
    }
  }
}

// 按矩阵把灰度图重采样到设计坐标系（3508 × 2480）。图外填纸白（255），不会带进黑边。
export function rectifyGray(gray, matrix) {
  return warpGray(gray, invert3x3(matrix), DESIGN.width, DESIGN.height)
}

/**
 * 校正后自检：在设计坐标图上重新找一次四角，量"离设计位置还差几像素"。
 * 它是"几何对不对"的直接证据，也是切片外扩量留了多少余量的实测依据。
 */
export function measureCornerError(designGray, options = {}) {
  const opt = { ...DETECT_DEFAULTS, ...options }
  const found = findRegisterMarks(designGray, opt)
  const errors = {}
  let max = 0
  for (const k of CORNER_ORDER) {
    const c = found.marks && found.marks[k]
    if (!c) {
      errors[k] = null
      continue
    }
    const target = MARK_CENTERS_PX[k]
    const d = Math.hypot(c.cx - target.x, c.cy - target.y)
    errors[k] = Math.round(d * 10) / 10
    if (d > max) max = d
  }
  return { ok: found.ok, errors, max: Math.round(max * 10) / 10, marks: found.marks }
}

// ── 右侧方块解码（页号 8 + 档位 4 + 指纹 12）────────────────────────────────────────────────────

// 方块中心区域内的暗像素占比。inset 为每边内缩比例（0.3 = 取中心 60%）。
function darkRatio(gray, rect, inset, threshold, dx = 0, dy = 0) {
  const x0 = Math.max(0, Math.round(rect.x + rect.width * inset + dx))
  const x1 = Math.min(gray.width, Math.round(rect.x + rect.width * (1 - inset) + dx))
  const y0 = Math.max(0, Math.round(rect.y + rect.height * inset + dy))
  const y1 = Math.min(gray.height, Math.round(rect.y + rect.height * (1 - inset) + dy))
  let dark = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    const row = y * gray.width
    for (let x = x0; x < x1; x++) {
      if (gray.data[row + x] < threshold) dark++
      n++
    }
  }
  return n ? dark / n : 0
}

// 锚点方块在"预期位置外扩 pad"窗口内的暗像素质心：用来消掉整体对齐残差。
function darkCentroid(gray, rect, pad, threshold) {
  const x0 = Math.max(0, Math.floor(rect.x - pad))
  const x1 = Math.min(gray.width, Math.ceil(rect.x + rect.width + pad))
  const y0 = Math.max(0, Math.floor(rect.y - pad))
  const y1 = Math.min(gray.height, Math.ceil(rect.y + rect.height + pad))
  let sx = 0
  let sy = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    const row = y * gray.width
    for (let x = x0; x < x1; x++) {
      if (gray.data[row + x] < threshold) {
        sx += x
        sy += y
        n++
      }
    }
  }
  if (!n) return null
  return { x: sx / n, y: sy / n, count: n }
}

/**
 * 解码右侧方块（页号 8 + 档位 4 + 指纹 12；锚点只作对齐基准、不带信息）。
 * 判定**宁严勿宽**：读不准的位会让整页页序不可信，而页序错 = 整页字形对错字。
 * @param {{data:Uint8ClampedArray,width:number,height:number}} designGray 校正到设计坐标系的灰度图
 * @returns {{ok:boolean, reason:string|null, pageNumber:number|null, pageCode:number|null,
 *   bits:number[], fills:number[], anchorFill:number, offset:{dx:number,dy:number},
 *   uncertain:number[], message:string}}
 *   pageCode = 本页校验码（这一页那些字的 12 位指纹；0 表示"这一页没有字"）；读不出时两个字段都是 null
 */
export function decodeFooterCode(designGray, options = {}) {
  const opt = { ...DETECT_DEFAULTS, ...options }
  const threshold = opt.markThreshold
  const { anchor: anchorRect, bits: bitRects } = SIDE_BAND_RECTS_PX

  // 锚点：质心偏移作为整排的公共偏移（24 个数据位与锚点是同一张纸上一起印出来的，共享同一个对齐残差）
  const centroid = darkCentroid(designGray, anchorRect, opt.anchorSearchPx, threshold)
  let dx = 0
  let dy = 0
  if (centroid) {
    dx = centroid.x - (anchorRect.x + anchorRect.width / 2)
    dy = centroid.y - (anchorRect.y + anchorRect.height / 2)
    // 质心偏移本身不该超过搜索半径（超过说明窗口里混进了别的东西，例如相邻的 1 位方块）
    const lim = opt.anchorSearchPx
    dx = Math.max(-lim, Math.min(lim, dx))
    dy = Math.max(-lim, Math.min(lim, dy))
  }
  const anchorFill = darkRatio(designGray, anchorRect, opt.footInset, threshold, dx, dy)

  const fills = bitRects.map((r) => darkRatio(designGray, r, opt.footInset, threshold, dx, dy))
  const bits = fills.map((f) => (f >= opt.footOnRatio ? 1 : 0))
  const uncertain = []
  for (let i = 0; i < fills.length; i++) {
    if (fills[i] > opt.footUncertainLow && fills[i] < opt.footUncertainHigh) uncertain.push(i)
  }
  const base = {
    bits, fills, anchorFill: Math.round(anchorFill * 1000) / 1000,
    offset: { dx: Math.round(dx * 10) / 10, dy: Math.round(dy * 10) / 10 },
    uncertain
  }

  if (!centroid || anchorFill < opt.anchorMinFill) {
    return {
      ...base, ok: false, reason: 'anchor', pageNumber: null, pageCode: null,
      message: '右侧方块那排没读到（定位用的锚点方块不在预期位置）：可能是被裁掉、被手指或阴影挡住、或扫描分辨率太低。' +
        '这一页的页号与字序会改由纸面印的参考字定；两样都定不出来时，只能把这一页重扫一次'
    }
  }
  if (uncertain.length) {
    return {
      ...base, ok: false, reason: 'uncertain', pageNumber: null, pageCode: null,
      message: '右侧方块有 ' + uncertain.length + ' 位读不准（第 ' + uncertain.map((i) => i + 1).join('、') +
        ' 位）：可能是扫描分辨率低、纸面有污渍或右侧方块被裁。这一页的页号与字序会改由纸面参考字定'
    }
  }
  const { pageNumber, scopeField, pageCode } = decodeSideBandBits(bits)
  return {
    ...base, ok: true, reason: null, pageNumber, scopeField, pageCode,
    message: '右侧方块解码成功：页号 ' + pageNumber + '，档位字段 ' + scopeField + '，本页校验码 ' + pageCode
  }
}

/**
 * 解码**底部横向条码**（决策 一-20）：这一页是哪些字，由它直接给出，不必再认参考字。
 * 判据与竖带一致：**读不出就明确失败**（采样找不到边界 / 纠错纠不过来 / 载荷不自洽），
 *   但**条码读不出不等于整页失败** —— 调用方据此退回"字序文件 → 认参考字"那几条路。
 * @returns {{ok:boolean, reason:string|null, payload:object|null, corrected:number, message:string}}
 */
export function decodeBarcode(designGray, options = {}) {
  const opt = { ...DETECT_DEFAULTS, ...options }
  const rows = sampleBarcodeModules(designGray, DESIGN.x, DESIGN.y, {
    inset: opt.barcodeInset,
    minContrast: opt.barcodeMinContrast,
    pad: opt.barcodePadPx,
    searchPx: opt.barcodeSearchPx
  })
  if (!rows) {
    return {
      ok: false, reason: 'sample', payload: null, corrected: 0,
      message: '底部条码没读出来（找不到条码边界，或对比度不够）：可能是条码被裁掉、被手指或阴影挡住、' +
        '或扫描分辨率太低。这一页的字序会改由字序文件或纸面参考字定'
    }
  }
  const decoded = rowsToPayload(rows)
  if (!decoded) {
    return {
      ok: false, reason: 'decode', payload: null, corrected: 0,
      message: '底部条码读到了，但纠错没能还原（条码有污损或模糊）：这一页的字序会改由字序文件或纸面参考字定'
    }
  }
  const payload = unpackBarcodePayload(decoded.data)
  if (!payload) {
    return {
      ok: false, reason: 'payload', payload: null, corrected: decoded.corrected,
      message: '底部条码的内容不自洽（版本或校验不过）：这一页的字序会改由字序文件或纸面参考字定'
    }
  }
  return {
    ok: true, reason: null, payload, corrected: decoded.corrected,
    message: '底部条码解码成功：' + (payload.kindLabel || '未知件类型') + '，第 ' + payload.pageNumber +
      ' 页，' + payload.charCount + ' 个字（' + (payload.scopeLabel || '') + '·' + (payload.orderLabel || '') + '）'
  }
}

// ── 按已知网格坐标切格 ────────────────────────────────────────────────────

/**
 * 按 LAYOUT 的已知网格坐标切出整页 136 格。
 * 每格切的是**书写格外扩 CELL_PAD_PT** 的范围：纸面提示写的是"笔画贴到格子边、别出格"，但手写总会有越界的起收笔与长撇长捺，
 * 只有包含进来，1.6 的提取与阶段三 3.2 的越界检测才有依据；外扩量由中缝推导，不会碰到参考字区域。
 * @returns {{boxes:Array, padPt:number, sliceSize:object}} boxes 里的 slice 是**拷贝**（调用方持有后
 *   即可释放整页灰度图；批量处理必须逐页释放，清单 三-5）
 * @param {Array} [options.layers] 附加图层 `[{ name, gray }]`（与设计坐标灰度同尺寸），
 *   例如红圈识别（1.7）产出的红掩膜 —— 切格时一并切出来，boxes[i].layers[name] 就是切片尺寸的该图层，
 *   1.6 用它把红圈像素从手写笔迹里剔除。图层可省，省了 boxes[i].layers 为 null
 */
export function sliceWritingBoxes(designGray, options = {}) {
  const opt = { ...DETECT_DEFAULTS, ...options }
  if (designGray.width !== DESIGN.width || designGray.height !== DESIGN.height) {
    throw new Error('切格要求设计坐标系（' + DESIGN.width + ' × ' + DESIGN.height +
      '）的灰度图，实际拿到 ' + designGray.width + ' × ' + designGray.height)
  }
  const padPt = typeof opt.cellPadPt === 'number' ? opt.cellPadPt : CELL_PAD_PT
  // 右侧方块读不出时上层传 0：表示"页码未知"，不要在这里退回 1（那等于编造页序）——
  // 页号只由右侧方块或纸面参考字序列定位给出（2026-10-15 起不再有"手选页序"这条界面操作）
  const pageNumber = typeof opt.pageNumber === 'number' ? opt.pageNumber : 1
  // 附加图层：只接受与设计坐标灰度同尺寸的层，尺寸对不上的直接跳过（宁缺勿错位）
  const layers = (opt.layers || []).filter((l) => l && l.gray && l.gray.width === designGray.width &&
    l.gray.height === designGray.height)
  // 切片尺寸**统一按版面常量算**，不用每格的实际像素边界：像素栅格上书写格的边界会因取整在
  // 118 / 119 之间抖动，逐格裁剪会让切片在 146 / 147 之间抖动。位置仍按每格的实际边界（相邻格之间
  // 那 1 像素的差异落在外扩区里，对识别无影响），这样每个切片都是同一尺寸、书写格在切片内的位置也恒定。
  const boxPx = Math.round(LAYOUT.writingBox * DESIGN.ptToPx)
  const padPx = Math.round(padPt * DESIGN.ptToPx)
  const slicePx = boxPx + padPx * 2
  const boxes = []
  let sliceSize = null

  for (let i = 0; i < LAYOUT.perPage; i++) {
    const cell = cellRect(i)
    const box = writingBoxRect(cell)
    const sliceRect = {
      x: box.x - padPt,
      y: box.y - padPt,
      width: box.width + padPt * 2,
      height: box.height + padPt * 2
    }
    const at = DESIGN.rect(box) // 书写格在设计坐标图里的像素位置
    const originX = at.x - padPx
    const originY = at.y - padPx
    // 裁到图内（设计坐标下四个角都在纸内，这里只是防御：改版面参数时不至于读到图外）
    const x0 = Math.max(0, originX)
    const y0 = Math.max(0, originY)
    const x1 = Math.min(designGray.width, originX + slicePx)
    const y1 = Math.min(designGray.height, originY + slicePx)
    const w = x1 - x0
    const h = y1 - y0
    const data = new Uint8ClampedArray(w * h)
    for (let y = 0; y < h; y++) {
      const src = (y0 + y) * designGray.width + x0
      data.set(designGray.data.subarray(src, src + w), y * w)
    }
    // 附加图层走完全相同的裁剪范围，保证与切片逐像素对齐
    let slicedLayers = null
    if (layers.length) {
      slicedLayers = {}
      for (const layer of layers) {
        const ld = new Uint8ClampedArray(w * h)
        for (let y = 0; y < h; y++) {
          const src = (y0 + y) * layer.gray.width + x0
          ld.set(layer.gray.data.subarray(src, src + w), y * w)
        }
        slicedLayers[layer.name] = { data: ld, width: w, height: h }
      }
    }
    sliceSize = { width: w, height: h }
    boxes.push({
      index: i, // 页内格号 0~135（从左到右、从上到下）
      pageNumber, // 页码（1 起，来自右侧方块解码；读不出时为 0）
      charIndex: (pageNumber - 1) * LAYOUT.perPage + i, // 全量字序，直接对应字表位置
      cellRect: cell, // 字位框（设计 pt）
      boxRect: box, // 书写格（设计 pt）
      sliceRect, // 切片矩形（设计 pt，含外扩）
      slicePx: { x: x0, y: y0, width: w, height: h }, // 切片在设计坐标图里的位置
      // 书写格在切片内的像素矩形：1.9 的"按书写格线性映射到 1000×1000 占位"要用它，
      // 这样无论外扩多少、切成多大，映射基准都不变
      boxInSlice: { x: at.x - x0, y: at.y - y0, width: boxPx, height: boxPx },
      slice: { data, width: w, height: h },
      layers: slicedLayers
    })
  }
  return { boxes, padPt, sliceSize }
}

// 方向尝试顺序（决策 二-11）：竖版图（高 > 宽）说明纸很可能是竖着放进去扫的，先试 90 与 270；
// 横版图先按送进来的方向，再试 180（整页上下颠倒时定位块仍在四角，但右侧方块会跑到纸的"上方"）。
function orientationOrder(gray) {
  return gray.height > gray.width ? [1, 3, 0, 2] : [0, 2, 3, 1]
}

// 在**一个方向**上跑完整条链路：找四角 → 透视校正 → 校正自检 → 右侧方块解码。
// 切格不在这里做：方向定下来之后，要切的是**选定方向**校正出来的那张设计坐标图，只切一次。
// 复用调用方给的 opt.mask 只在原方向成立 —— 旋转后坐标全变，必须重算（调用方置空）。
// 返回（失败时同样按这个形状返回，前面几步的产物能给多少给多少）：
//   · ok         —— **这一页被可靠处理了**：右侧方块解得出 且 四角残差在限内（条码读不出不影响它）
//   · stage      —— 走到哪一步停下：marks（没找到四角）/ transform（解不出透视）/ done
//   · marks      —— 四角定位块的查找结果（含中文失败原因）
//   · matrix     —— 原图 → 设计坐标的 3×3 透视矩阵（切格用它）
//   · cornerErrors —— 校正后四角残差（像素）；verifyRectified 关掉时为 null
//   · designGray —— 校正后的灰度图（设计坐标系，切格与采样都在它上面做）
//   · footer     —— 右侧方块（页号 / 档位 / 指纹）的解码结果
//   · barcode    —— 底部条码的解码结果（整页字序；**只在最终方向上解一次**）
//   · timings    —— 各段的耗时（毫秒），排查慢件用
//   · reason     —— 失败时给用户看的中文原因
function analyzeOrientation(gray, opt) {
  const timings = {}
  const tMarks = now()
  const marks = findRegisterMarks(gray, { ...opt, mask: opt.mask })
  timings.marks = Math.round(now() - tMarks)
  if (!marks.ok) {
    return {
      ok: false, stage: 'marks', marks, matrix: null, cornerErrors: null,
      designGray: null, footer: null, timings, reason: marks.message
    }
  }

  const tTransform = now()
  const transform = detectDesignTransform(gray, { ...opt, marks })
  timings.transform = Math.round(now() - tTransform)
  if (!transform.ok) {
    return {
      ok: false, stage: 'transform', marks, matrix: null, cornerErrors: null,
      designGray: null, footer: null, timings, reason: transform.message
    }
  }

  const tRectify = now()
  const designGray = rectifyGray(gray, transform.matrix)
  timings.rectify = Math.round(now() - tRectify)

  let cornerErrors = null
  if (opt.verifyRectified !== false) {
    const tVerify = now()
    cornerErrors = measureCornerError(designGray, opt)
    timings.verify = Math.round(now() - tVerify)
  }

  const tFooter = now()
  const footer = decodeFooterCode(designGray, opt)
  timings.footer = Math.round(now() - tFooter)
  // 底部条码：**只在最终这个方向上解一次** —— 它不参与方向纠正（那是竖带的活，锚点方块比条码模块大 5 倍、
  //   好认得多），放进方向循环只会让坏件慢 4 倍。读不出不影响"这一页被可靠处理"的判定。
  const tBarcode = now()
  const barcode = decodeBarcode(designGray, opt)
  timings.barcode = Math.round(now() - tBarcode)

  const geometryOk = !cornerErrors || cornerErrors.max <= opt.cornerErrorLimit
  return {
    ok: footer.ok && geometryOk, // "这一页被可靠处理了" = 竖带解得出 且 几何在限内
    stage: 'done',
    marks,
    matrix: transform.matrix,
    cornerErrors,
    designGray,
    footer,
    barcode,
    timings,
    reason: footer.ok ? null : footer.message
  }
}

// ── 单页总入口 ────────────────────────────────────────────────────────────

/**
 * 处理一页扫描件：方向纠正 → 找四角 → 透视校正 → 右侧方块解码 → 切格。
 * 注意 ok 的含义是"这一页被机器可靠处理了"（含右侧方块解码成功、校正误差在限内）。
 * @param {{data:Uint8ClampedArray,width:number,height:number}} gray 预处理后的灰度图（已去噪）
 * @param {object} [options] DETECT_DEFAULTS + { slice, verifyRectified, keepDesignGray }
 */
export function analyzePage(gray, options = {}) {
  const opt = { ...DETECT_DEFAULTS, ...options }
  const t0 = now()
  const timings = { marks: 0, transform: 0, rectify: 0, verify: 0, footer: 0, barcode: 0 }
  const messages = []

  // ── 方向纠正（决策 二-11）───────────────────────────────────────────────
  // 右侧方块解不出就换方向再试：**方向错了也会"找得到四角、校正得成"**，唯一识破它的是右侧方块，
  //   所以这里以"右侧方块能解出 且 校正残差在限内"为成功的判据，四个方向都不成才明确失败。
  const order = opt.autoOrient ? orientationOrder(gray) : [0]
  const tried = []
  let picked = null
  let pickedTurns = 0
  for (const turns of order) {
    const input = turns === 0 ? gray : rotateQuarterTurns(gray, turns)
    const res = analyzeOrientation(input, turns === 0 ? opt : { ...opt, mask: null })
    for (const k of Object.keys(timings)) timings[k] += res.timings[k] || 0
    tried.push({
      turns,
      markOk: res.marks.ok,
      cornerMax: res.cornerErrors ? res.cornerErrors.max : null,
      footerOk: !!(res.footer && res.footer.ok),
      pageNumber: res.footer && res.footer.ok ? res.footer.pageNumber : null
    })
    if (!picked) {
      picked = res // 全部方向都失败时，保留第一个方向的结果作为返回（照旧切格、页码置 0）
      pickedTurns = turns
    }
    if (res.ok) {
      picked = res
      pickedTurns = turns
      break
    }
  }
  const orientation = {
    turns: pickedTurns, // 实际采用的顺时针旋转（0 = 送进来的方向本身就是正的）
    corrected: pickedTurns !== 0,
    attempts: tried.length,
    tried
  }

  if (picked.stage === 'marks' || picked.stage === 'transform') {
    return {
      ok: false, stage: picked.stage, marks: picked.marks, matrix: null, cornerErrors: null,
      designGray: null, footer: null, boxes: [], orientation,
      messages: [{ level: 'error', text: picked.reason }], timings
    }
  }

  if (orientation.corrected) {
    messages.push({
      level: 'info',
      text: '这张扫描件的方向不对（整页被转了 ' + (pickedTurns * 90) + ' 度），已自动转正后继续处理（共试了 ' +
        tried.length + ' 个方向）'
    })
  } else if (opt.autoOrient && !picked.ok && tried.length > 1) {
    messages.push({
      level: 'error',
      text: '这张扫描件在 ' + tried.length + ' 个方向上都读不出右侧方块：请确认打印时选的是实际大小、纸面平整没有翘边，' +
        '或把纸按横向放正后重扫一次'
    })
  }

  const { marks, matrix, cornerErrors, designGray, footer } = picked

  if (cornerErrors && cornerErrors.max > opt.cornerErrorWarn) {
    messages.push({
      level: cornerErrors.max > opt.cornerErrorLimit ? 'error' : 'warn',
      text: '校正后定位块离设计位置最大偏差 ' + cornerErrors.max + ' 像素' +
        (cornerErrors.max > opt.cornerErrorLimit ? '（超过 ' + opt.cornerErrorLimit + ' 像素，这一页几何不可信）' : '（略大，但仍小于切片外扩量）')
    })
  }

  messages.push({ level: footer.ok ? 'info' : 'error', text: footer.message })
  if (!footer.ok) {
    messages.push({
      level: 'info',
      text: '这一页仍会照常切格：页号与字序改由纸面印的参考字定（序列定位能定出来就照常出字形）；' +
        '参考字也定不出来时这一页只能重扫'
    })
  }

  const tSlice = now()
  const sliced = opt.slice === false ? { boxes: [], padPt: CELL_PAD_PT, sliceSize: null }
    : sliceWritingBoxes(designGray, { ...opt, pageNumber: footer.ok ? footer.pageNumber : 0 })
  timings.slice = Math.round(now() - tSlice)

  const geometryOk = !cornerErrors || cornerErrors.max <= opt.cornerErrorLimit
  timings.total = Math.round(now() - t0)
  return {
    ok: footer.ok && geometryOk,
    stage: 'done',
    marks,
    matrix,
    cornerErrors,
    designGray: opt.keepDesignGray === false ? null : designGray,
    footer,
    boxes: sliced.boxes,
    padPt: sliced.padPt,
    sliceSize: sliced.sliceSize,
    orientation, // 方向纠正的过程留痕：turns / corrected / attempts / tried（界面提示与测试都用它）
    messages,
    timings
  }
}

// ── 多页汇总（整批判定）──────────────────────────────────────────────────

/**
 * 把多页的处理结果汇总成"这一批能不能收"的判定。
 * 规则（《决策记录》一-9 的 2026-10-15 修订，替代原"批次校验码不符即整批拦下"那套）：
 *   - 右侧方块读不出的页 → 只提示（页号与字序改由纸面参考字定；定不出来时那一页整页失败）
 *   - 页号重复 → error；非字表页（指纹 0 的打印自检页）→ info，不参与字形识别
 *   - 字表页有缺 → warn（不拦下：用户可以先识别已有的那几页）
 * @param {Array} pages analyzePage 的结果数组
 * @param {{sheetPages:number}} [options]
 */
export function summarizeBatch(pages, options = {}) {
  const { sheetPages } = options
  const problems = []
  const duplicates = []
  const seen = new Map() // `${件类型}:${pageNumber}` → 第几个文件（1 起）
  const rows = pages.map((p, i) => {
    const file = i + 1
    const footer = p && p.footer
    const footerOk = !!(footer && footer.ok)
    const rawPageNumber = footerOk ? footer.pageNumber : null
    const pageCode = footerOk ? footer.pageCode : null
    // 件类型与页号：**优先用识别时已经解释好的那一份**（`footer.kind` / `footer.pageNumber`，
    // 由 scanFlow 的 footerShape 经 layout.classifyFooterPage 得出，并且包含"旧纸宽容"那条口径）——
    // 两处各判一次必然会走样：实测踩到过旧口径印的更正册在这里被判成"非字表页"、于是既不算更正册、
    // 又被算进"可用页"。只有拿不到 footer.kind 时（手工构造的页记录 / 老数据）才自己判一次。
    const cls = footerOk
      ? (footer.kind
          ? { kind: footer.kind, pageNumber: footer.pageNumber }
          : classifyFooterPage(rawPageNumber, pageCode))
      : { kind: 'unknown', pageNumber: null }
    const row = {
      file,
      ok: !!(p && p.ok),
      pageNumber: cls.pageNumber, // 人读页号（更正册还原成它自己的第 n 页）
      rawPageNumber,
      pageCode,
      footerOk,
      kind: cls.kind,
      isCorrection: cls.kind === 'correction',
      isSheetPage: null
    }
    if (row.pageNumber !== null) {
      const dupKey = row.kind + ':' + row.pageNumber
      if (seen.has(dupKey)) {
        duplicates.push(row.pageNumber)
        problems.push({
          level: 'error',
          text: '第 ' + seen.get(dupKey) + ' 个文件与第 ' + file + ' 个文件的右侧方块都写着' +
            (row.kind === 'correction' ? '更正册第 ' : '第 ') + row.pageNumber + ' 页，请确认有没有重复上传同一页'
        })
      } else {
        seen.set(dupKey, file)
      }
      // 非字表页判定只对主区有意义：更正册的页号是它自己的（1 起），与字表页数无关
      if (row.kind === 'main') row.isSheetPage = typeof sheetPages !== 'number' || row.pageNumber <= sheetPages
    }
    if (footer && !footer.ok) {
      // 右侧方块读不出**只提示**（2026-10-15 口径）：页号与字序由纸面参考字序列定位定，定不出来时
      //   那一页自己会整页失败（扫描件那一层）。原来这里推 error，于是"被参考字救回来、照常可用的页"
      //   与"这一批被拦下"会同时出现在一屏上（两处结论打架，子代理实测指出）。
      problems.push({ level: 'warn', text: '第 ' + file + ' 个文件：' + footer.message })
    }
    return row
  })

  // 右侧方块读不出：只提示 —— 页号与字序会改由纸面参考字定（决策 五-9 的新模型），
  //   不再要求"手选页序 + 显式确认批次"（那条界面操作已去掉）
  const noFooter = rows.filter((r) => r.kind === 'unknown')
  if (noFooter.length) {
    problems.push({
      level: 'warn',
      text: '有 ' + noFooter.length + ' 页的右侧方块读不出（第 ' + noFooter.map((r) => r.file).join('、') +
        ' 个文件）：这些页的页号与字序会由纸面参考字定；定不出来的页会整页失败，只能重扫'
    })
  }

  // 更正册的件数（下面的汇总文案要用）
  const correctionRows = rows.filter((r) => r.kind === 'correction')

  if (typeof sheetPages === 'number') {
    const extra = rows.filter((r) => r.kind === 'notSheet')
    if (extra.length) {
      problems.push({
        level: 'info',
        text: '第 ' + extra.map((r) => r.file).join('、') + ' 个文件是打印自检页（没有字表内容），不参与字形识别'
      })
    }
    const missing = []
    for (let p = 1; p <= sheetPages; p++) if (!seen.has('main:' + p)) missing.push(p)
    if (missing.length) {
      problems.push({ level: 'warn', text: '字表页里还缺第 ' + missing.join('、') + ' 页' })
    }
  }

  const ok = !problems.some((m) => m.level === 'error')
  return {
    ok,
    pageCount: rows.length,
    pages: rows,
    duplicates,
    problems,
    correctionPages: correctionRows.length,
    message: ok
      ? '这一批可以继续识别（' + rows.length + ' 页' +
        (correctionRows.length ? '，其中更正册 ' + correctionRows.length + ' 页' : '') + '）'
      : '这一批被拦下：' + problems.filter((m) => m.level === 'error').map((m) => m.text).join('；')
  }
}
