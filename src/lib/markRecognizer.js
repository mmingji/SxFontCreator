// 红圈识别（阶段一步骤 1.7）
// 职责：从**彩色扫描件**里找出用户圈错字用的红圈，输出「被圈字有序清单」（供 1.8 的更正对应与界面核对），
//   并把红圈做成掩膜，供 1.6 从手写笔迹里剔除 —— 红笔灰度约 76，低于 1.6 的提取阈值 150，
//   不剔除的话圈会被当成笔画写进字形（实测占被圈格掩膜的 17%~26%）；
//   掩膜同时让越界量（overflow）不被圈撑大。
// 数据来源：① 1.4 preprocessFile 保留的**彩色像素**（灰度化后红色信息就没了，决策 二-2）；
//   ② 1.5 analyzePage 的透视矩阵（把红掩膜校正到与切格同一个设计坐标系，按格归属才成立）。
// 算法口径（决策 二-12）：
//   ① **颜色分离**：红度 = R − max(G, B) ≥ 阈值判为红笔像素（实测红圈 199~233，而纸面、黑笔迹、灰格线全部 < 60）；
//   ② **透视校正**：把红掩膜校正到设计坐标系（与切格同坐标系），双线性插值产生的中间值再阈值化；
//   ③ **连通域 + 三重过滤**：面积（真圈 866~1296 像素）、外框尺寸、**填充率**（真圈 0.11~0.15，
//      红笔涂了一片或一道粗划痕的填充率接近 1，用它挡掉）；
//   ④ **归属按「字位框」而不是书写格**：实测用户习惯把圈画在**参考字**上（书写格上方），
//      按书写格判会归不到任何格；字位框是这个字独占的领地，圈画在参考字上还是手写字上都能归对；
//      一个圈压两格时取重叠面积最大者，第二名达到 70% 就标"不确定"交给界面确认（决策 一-7）。
// 不做的事：不要求圈闭合（手写圈常有开口，强制闭合会漏检）、不做几何圆检测（会把"口""日"误判成圈，决策 二-2）、
//   灰度件（没有颜色信息）的兜底路径见决策 二-4 与清单 三-10。
import { connectedComponents, invert3x3, warpGray } from './imageOps.js'
import { DESIGN, sliceWritingBoxes } from './gridDetector.js'
import { LAYOUT, cellRect } from './layout.js'

// 红圈识别参数。默认值全部来自实测（2026-10-04 真实红圈件，详见《提交历史》第 44 条）
export const MARK_DEFAULTS = {
  redThreshold: 60, // 红度 R − max(G,B) ≥ 它判为红笔像素（实测非红区域全部 < 60、红圈 199~233）
  minCircleArea: 300, // 红块面积下限：真圈 866~1296 像素，更小的是红笔点或边缘杂色
  minCircleSize: 40, // 红块外框短边下限（像素）：一道细划痕不该被当成圈
  maxCircleSize: 400, // 红块外框长边上限（像素）：字位框约 189 像素，比它大一倍以上说明是整片红污
  maxFill: 0.75, // 填充率上限：真圈 0.11~0.15（只有边框），接近 1 的是实心红块
  spanUncertain: 0.7, // 一个圈压两格时，第二名重叠 / 第一名 ≥ 它 → 标"不确定"
  rectifyThreshold: 128 // 校正后掩膜再二值化的阈值（双线性插值会产出 0~255 的中间值）
}

// 红度图 → 红掩膜（彩色原图坐标系）。
// 红度用 R − max(G, B) 而不是 R − G：红墨水的 B 也低，取 max 能同时压住偏紫与偏橙的干扰（决策 二-2）。
export function buildRedMask(rgba, options = {}) {
  const opt = { ...MARK_DEFAULTS, ...options }
  const { width, height } = rgba
  const data = new Uint8Array(width * height)
  let redPixels = 0
  let maxRedness = -255
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    const redness = rgba.data[p] - Math.max(rgba.data[p + 1], rgba.data[p + 2])
    if (redness > maxRedness) maxRedness = redness
    if (redness >= opt.redThreshold) {
      data[i] = 1
      redPixels++
    }
  }
  return { data, width, height, redPixels, maxRedness }
}

// 把红掩膜透视校正到设计坐标系。
// 掩膜只有 0/1，直接双线性插值会在边缘产出 0~1 之间的"半红"值，所以先摊成灰度再校正、最后按阈值二值化。
// **编码约定：红 = 0（深）、非红 = 255（浅）** —— warpGray 把图外区域填成纸白（255），这样"纸外"不会被
// 判成红；反过来编码（红 = 255）会让整片纸外区域变成一个大红块（实测踩到：校正后红像素从 3212 涨到 283 万）。
export function rectifyMask(mask, matrix, options = {}) {
  const opt = { ...MARK_DEFAULTS, ...options }
  const outW = opt.designWidth || DESIGN.width
  const outH = opt.designHeight || DESIGN.height
  const gray = { data: new Uint8ClampedArray(mask.data.length), width: mask.width, height: mask.height }
  for (let i = 0; i < mask.data.length; i++) gray.data[i] = mask.data[i] ? 0 : 255
  const warped = warpGray(gray, invert3x3(matrix), outW, outH)
  const data = new Uint8Array(outW * outH)
  let pixels = 0
  for (let i = 0; i < data.length; i++) {
    // 双线性插值让红区边缘落在 0~255 之间，取较深的一半算红
    if (warped.data[i] < opt.rectifyThreshold) {
      data[i] = 1
      pixels++
    }
  }
  return { data, width: outW, height: outH, pixels }
}

// 彩色像素的 90° 整数倍旋转（无损、零依赖，与 imageOps.rotateQuarterTurns 同一套方向约定）。
// 为什么要按 turns 转一次：方向纠正（决策 二-11）之后，1.5 给出的 matrix 是"**纠正后**的原图 → 设计坐标"，
//   而调用方手里通常还是**未纠正**的彩色原图 —— 不转过来，红掩膜会整体错位
//   （实测踩到：三个红圈被归到第 45 / 91 格，而不是第 3 / 59 / 135 格）。
export function rotateRgbaQuarterTurns(rgba, turns = 1) {
  const t = ((turns % 4) + 4) % 4
  const { data, width: w, height: h } = rgba
  if (t === 0) return rgba
  const swap = t % 2 === 1
  const outW = swap ? h : w
  const outH = swap ? w : h
  const out = new Uint8ClampedArray(outW * outH * 4)
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let sx
      let sy
      if (t === 1) {
        sx = y
        sy = h - 1 - x
      } else if (t === 2) {
        sx = w - 1 - x
        sy = h - 1 - y
      } else {
        sx = w - 1 - y
        sy = x
      }
      const src = (sy * w + sx) * 4
      const dst = (y * outW + x) * 4
      out[dst] = data[src]
      out[dst + 1] = data[src + 1]
      out[dst + 2] = data[src + 2]
      out[dst + 3] = data[src + 3]
    }
  }
  return { data: out, width: outW, height: outH }
}

// 两个矩形的重叠面积（像素²）
function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

// 设计坐标下的字位框（默认按版面常量算，与切格同一个来源）
export function defaultCellRects() {
  const rects = []
  for (let i = 0; i < LAYOUT.perPage; i++) rects.push(DESIGN.rect(cellRect(i)))
  return rects
}

/**
 * 从设计坐标的红掩膜里找出红圈，并归属到格子。
 * @param {{data:Uint8Array,width:number,height:number}} designRed 设计坐标下的红掩膜
 * @param {Array} [cellRects] 字位框（设计坐标像素矩形），默认按 LAYOUT 现算
 * @returns {{circles:Array, markedCells:number[], uncertainCells:number[], dropped:Array}}
 *   markedCells 是**页内格号**（0~135，从左到右、从上到下），天然就是决策 一-7 要的顺序
 */
export function detectCircles(designRed, cellRects, options = {}) {
  const opt = { ...MARK_DEFAULTS, ...options }
  const rects = cellRects && cellRects.length ? cellRects : defaultCellRects()
  const { components } = connectedComponents(designRed,
    { minArea: opt.minCircleArea, keepPixels: false, maxComponents: 500 })
  const circles = []
  const dropped = []

  for (const c of components) {
    const w = c.width
    const h = c.height
    const short = Math.min(w, h)
    const long = Math.max(w, h)
    if (short < opt.minCircleSize) {
      dropped.push({ reason: 'thin', area: c.area, width: w, height: h })
      continue
    }
    if (long > opt.maxCircleSize) {
      dropped.push({ reason: 'huge', area: c.area, width: w, height: h })
      continue
    }
    const fill = c.area / (w * h)
    if (fill > opt.maxFill) {
      dropped.push({ reason: 'solid', area: c.area, width: w, height: h, fill: +fill.toFixed(3) })
      continue
    }

    // 归属：与字位框重叠面积最大者；把第二名也记下来，用于判"是不是压在两格之间"
    const bbox = { x: c.minX, y: c.minY, width: w, height: h }
    let best = -1
    let bestArea = 0
    let second = -1
    let secondArea = 0
    rects.forEach((cell, i) => {
      const o = overlapArea(bbox, cell)
      if (o > bestArea) {
        second = best
        secondArea = bestArea
        best = i
        bestArea = o
      } else if (o > secondArea) {
        second = i
        secondArea = o
      }
    })
    if (best < 0 || bestArea === 0) {
      dropped.push({ reason: 'noCell', area: c.area, width: w, height: h })
      continue
    }

    circles.push({
      id: circles.length,
      cellIndex: best, // 页内格号
      area: c.area,
      fill: +fill.toFixed(3),
      bbox,
      overlap: bestArea,
      overlapSecond: secondArea,
      secondCellIndex: secondArea > 0 ? second : -1,
      uncertain: secondArea > 0 && secondArea >= bestArea * opt.spanUncertain // 压在两格之间 → 交界面确认
    })
  }

  // 同一格可能被圈了两次（用户补圈）：保留面积最大的那个，其余记进 dropped 便于排查
  const byCell = new Map()
  for (const c of circles) {
    const prev = byCell.get(c.cellIndex)
    if (!prev) {
      byCell.set(c.cellIndex, c)
    } else {
      const keep = prev.area >= c.area ? prev : c
      const drop = keep === prev ? c : prev
      byCell.set(c.cellIndex, keep)
      dropped.push({ reason: 'duplicate', area: drop.area, cellIndex: drop.cellIndex })
    }
  }
  // 页内格号天然是"从左到右、从上到下"，按它排序即得到决策 一-7 要的有序清单
  const list = [...byCell.values()].sort((a, b) => a.cellIndex - b.cellIndex)
  list.forEach((c, i) => { c.id = i })
  const markedCells = list.map((c) => c.cellIndex)
  const uncertainCells = list.filter((c) => c.uncertain).map((c) => c.cellIndex)
  return { circles: list, markedCells, uncertainCells, dropped }
}

/**
 * 完整流程：彩色像素 + 透视矩阵 → 红圈清单 + 设计坐标红掩膜。
 * @param {{data:Uint8ClampedArray,width:number,height:number}} rgba 彩色像素（**与 matrix 同一个方向**的原图）
 * @param {Array<number>} matrix 1.5 的透视矩阵（原图 → 设计坐标）
 * @param {object} [options] MARK_DEFAULTS + { turns }：turns 是方向纠正用掉的顺时针 90° 数
 *   （取自 `analyzePage().orientation.turns`）；传了它，本函数会先把彩色像素按同一方向转过来
 */
export function recognizeMarks(rgba, matrix, options = {}) {
  const opt = { ...MARK_DEFAULTS, ...options }
  if (!rgba || !rgba.data) throw new Error('红圈识别需要彩色像素（{ data, width, height }）')
  if (!matrix) throw new Error('红圈识别需要 1.5 的透视矩阵（把红掩膜校正到设计坐标系）')
  // 方向必须与 matrix 对齐：matrix 描述的是"纠正后的原图 → 设计坐标"
  const turns = typeof opt.turns === 'number' ? opt.turns : 0
  const source = turns ? rotateRgbaQuarterTurns(rgba, turns) : rgba
  const red = buildRedMask(source, opt)
  const designRed = rectifyMask(red, matrix, opt)
  const detected = detectCircles(designRed, opt.cellRects, opt)

  const messages = []
  if (red.redPixels === 0) {
    messages.push({
      level: 'warn',
      text: '这一页一个红色像素都没有：如果确实用红笔圈了字，请确认扫描时选的是彩色（照片）模式，而不是黑白或灰度'
    })
  } else if (!detected.circles.length) {
    messages.push({
      level: 'warn',
      text: '这一页有红色像素，但没有检出成形的红圈（可能圈得太小、太细，或只是红笔的杂点）：' +
        '被圈的字请在界面上手工标记'
    })
  }
  if (detected.dropped.length) {
    const kinds = {}
    for (const d of detected.dropped) kinds[d.reason] = (kinds[d.reason] || 0) + 1
    messages.push({
      level: 'info',
      text: '另有 ' + detected.dropped.length + ' 处红色未被当作圈（' +
        Object.entries(kinds).map(([k, v]) => ({ thin: '太细', huge: '过大', solid: '是实心红块', noCell: '不在任何格内', duplicate: '同一格重复圈' }[k] || k) + ' ' + v).join('，') +
        '），不计入被圈字清单'
    })
  }
  if (detected.uncertainCells.length) {
    messages.push({
      level: 'warn',
      text: '有 ' + detected.uncertainCells.length + ' 个圈压在两个格子之间（第 ' + detected.uncertainCells.join('、') +
        ' 格附近），归属可能不准，请在核对界面上优先确认'
    })
  }

  return {
    ok: true, // 识别本身不判"这一页能不能收"：没圈到字是合法结果（用户可能一个错字都没写）
    circles: detected.circles,
    markedCells: detected.markedCells,
    uncertainCells: detected.uncertainCells,
    dropped: detected.dropped,
    designRed, // 设计坐标红掩膜：切格时作为附加图层切出来，1.6 用它把红圈像素从笔迹里剔除
    stats: { redPixels: red.redPixels, maxRedness: red.maxRedness, designRedPixels: designRed.pixels },
    messages
  }
}

/**
 * 把红圈图层接到切格结果上：页脚几何都拿到了，才可能"按格"给出红圈掩膜。
 * 为什么要重新切一次：红掩膜要先用 1.5 的矩阵校正到设计坐标（matrix 是 1.5 的产物），
 *   而切格发生在 analyzePage 内部 —— 与其让 gridDetector 反向依赖本模块，不如拿到 matrix 后再切一遍
 *   （实测切 136 格约 6ms，可忽略）。
 * @param {object} page analyzePage 的结果（需要 keepDesignGray 为真，默认就是）
 * @param {{data:Uint8ClampedArray,width:number,height:number}} rgba 彩色像素
 * @returns {{marks:object, boxes:Array}|null} 切格结果里每格多一个 layers.red（切片尺寸的红掩膜）
 */
export function attachRedMarks(page, rgba, options = {}) {
  if (!page || !page.ok || !page.matrix || !page.designGray || !rgba) return null
  // 方向纠正用掉的角度要从 page 里带过来，否则红掩膜与设计坐标对不上
  const turns = options.turns !== undefined
    ? options.turns
    : (page.orientation ? page.orientation.turns : 0)
  const marks = recognizeMarks(rgba, page.matrix, { ...options, turns })
  const sliced = sliceWritingBoxes(page.designGray, {
    ...options,
    pageNumber: page.footer && page.footer.ok ? page.footer.pageNumber : 0,
    layers: [{ name: 'red', gray: marks.designRed }]
  })
  return { marks, boxes: sliced.boxes }
}
