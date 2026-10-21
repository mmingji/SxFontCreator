// 红圈识别（阶段一步骤 1.7）
// 职责：从**彩色扫描件**里找出用户圈错字用的红圈，输出「被圈字有序清单」（供 1.8 的更正对应与界面核对），
//   并把红圈做成掩膜，供 1.6 从手写笔迹里剔除 —— 红笔灰度约 76，低于 1.6 的提取阈值 150，
//   不剔除的话圈会被当成笔画写进字形（实测占被圈格掩膜的 17%~26%）；
//   掩膜同时让越界量（overflow）不被圈撑大。
// 数据来源：① 1.4 preprocessFile 保留的**彩色像素**（灰度化后红色信息就没了，决策 二-2）；
//   ② 1.5 analyzePage 的透视矩阵（把红掩膜校正到与切格同一个设计坐标系，按格归属才成立）。
// 算法口径（决策 二-12；2026-10-21 按 二-12 的 D1/E1 修订）：
//   ① **颜色分离 + 红度增强**：红度 = R − max(G, B)，增强后 = min(255, 红度 × redGain) ≥ 阈值判为红笔像素。
//      **为什么加增强（E1）**：扫描 App 的「移除背景」档会把淡红圈洗成断续的碎块（实测：同一张纸
//      「高」9/9 个圈、「关」只有 5/9 —— 缺的 4 圈不是红度不够，而是 40~59 的淡边把连通块切断了）。
//      增强只作用在**红圈这一条链路**：字形提取仍读原始灰度/彩色，成品字形不受任何影响。
//      实测增益 1.5（等效阈值 40）：4 个缺圈全部连成完整块，纸底红度 20~39 放大后仍 < 60，不会误判。
//   ② **透视校正**：把红掩膜校正到设计坐标系（与切格同坐标系），双线性插值产生的中间值再阈值化；
//   ③ **连通域 + 形态过滤**：面积（真圈 500~2500 像素）、外框尺寸、**填充率**上限，以及
//      **环形判据**（D1，2026-10-21）—— 把红块按 24 个角度扇区统计覆盖，要求"绕着中心走一圈"：
//      真圈实测角度覆盖 0.71~1.0、最大连续空扇区 0~7；红线/箭头只有 0.54~0.58、空扇区 10~11。
//      它**不要求闭合、也不要求正圆**（允许约 120° 的开口，随手画能过），只排除"划一道"与红笔杂点。
//   ④ **归属按「参考字区域」而不是字位框/书写格**（D1）：实测用户圈的是**参考字**（更正册上圈的是**序号**，
//      与参考字同一块区域）。判据 = **该格参考字区域的中心落在红块外框内**，取离红块质心最近的格；
//      这样圈旁的数字编号（1、2、3…写在区域外）与底部红字注释都不会被归到任何格。
//      一个圈同时围住两个参考字中心时，第二名距离与最近者接近就标"不确定"交给界面核对（决策 一-7）。
// 不做的事：不要求圈闭合、不做几何圆检测（会把"口""日""圈"这类字误判成圈，决策 二-2）、
//   灰度件（没有颜色信息）的兜底路径见决策 二-4 与清单 三-10。
import { connectedComponents, invert3x3, warpGray } from './imageOps.js'
import { DESIGN, sliceWritingBoxes } from './gridDetector.js'
import { LAYOUT, cellRect } from './layout.js'

// 红圈识别参数。默认值全部来自实测（2026-10-04 / 2026-10-21，详见《提交历史》第 44 / 180 条）
export const MARK_DEFAULTS = {
  redThreshold: 60, // 红度 ≥ 它判为红笔像素（实测真圈增强前 40~233、非红区域全部 < 60）
  redGain: 1.5, // 红度增强倍数（E1）：等效阈值 60 / 1.5 = 40；只用于红掩膜，不碰字形提取
  minCircleArea: 300, // 红块面积下限：真圈 500~2500 像素，更小的是红笔点、数字编号或边缘杂色
  minCircleSize: 40, // 红块外框短边下限（像素）：一道细划痕 / 一个数字不该被当成圈
  maxCircleSize: 400, // 红块外框长边上限（像素）：参考字区域约 60 像素，比它大数倍说明是整片红污 / 跨行线
  maxFill: 0.75, // 填充率上限：真圈 0.08~0.35（只有边框），接近 1 的是实心红块
  angleSectors: 24, // 环形判据的角度扇区数（每个 15°）
  minAngularCover: 0.7, // 红块覆盖的角度比例下限：真圈 0.71~1.0，红线/箭头 0.54~0.58
  maxAngularGap: 8, // 最大连续空扇区：真圈 0~7，红线/箭头 10~11；8 个扇区 = 允许约 120° 的开口
  spanSecondRatio: 1.25, // 一个圈围住两个参考字中心时，第二名距离 / 最近者 ≤ 它 → 标"不确定"
  rectifyThreshold: 128 // 校正后掩膜再二值化的阈值（双线性插值会产出 0~255 的中间值）
}

// 红度图 → 红掩膜（彩色原图坐标系）。
// 红度用 R − max(G, B) 而不是 R − G：红墨水的 B 也低，取 max 能同时压住偏紫与偏橙的干扰（决策 二-2）。
// 增强（E1）只乘在**红度差**上、并封顶 255：灰/黑笔迹的红度≈0，放大后仍是 0；纸底偏色的低红度
//   （实测 20~39）放大后 < 60，不会越过阈值 —— 这是"只增强红色通道、不影响其它内容"的落地方式。
export function buildRedMask(rgba, options = {}) {
  const opt = { ...MARK_DEFAULTS, ...options }
  const gain = typeof opt.redGain === 'number' && opt.redGain > 0 ? opt.redGain : 1
  const { width, height } = rgba
  const data = new Uint8Array(width * height)
  let redPixels = 0
  let maxRedness = -255
  let maxRawRedness = -255
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    const raw = rgba.data[p] - Math.max(rgba.data[p + 1], rgba.data[p + 2])
    if (raw > maxRawRedness) maxRawRedness = raw
    const redness = gain === 1 ? raw : Math.min(255, raw * gain)
    if (redness > maxRedness) maxRedness = redness
    if (redness >= opt.redThreshold) {
      data[i] = 1
      redPixels++
    }
  }
  return { data, width, height, redPixels, maxRedness, maxRawRedness }
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

// 设计坐标下的**参考字区域**（主区圈参考字、更正册圈序号，两者是同一块区域 —— 2026-10-21 D1 口径）。
// 几何与 templatePdf 的 drawReferenceChar 同源：字位框内、书写格上方、边长 LAYOUT.referenceAreaSize 的正方形。
export function defaultReferenceRects() {
  const rects = []
  for (let i = 0; i < LAYOUT.perPage; i++) {
    const cell = cellRect(i)
    rects.push(DESIGN.rect({
      x: cell.x + (cell.width - LAYOUT.referenceAreaSize) / 2,
      y: cell.y + LAYOUT.blockBottom + LAYOUT.writingBox + LAYOUT.gapMid,
      width: LAYOUT.referenceAreaSize,
      height: LAYOUT.referenceAreaSize
    }))
  }
  return rects
}

// 红块的"环形"指标（D1）：以质心为中心统计红像素覆盖了多少个角度扇区、最长的连续空扇区有多长。
// 为什么用角度而不是几何圆检测：用户是随手画的（椭圆、方圈、带钩、开口都常见），
//   "绕中心一圈"才是圈的本质；"圆不圆"不是判据（决策 二-12 的 D1 修订）。
function angularCoverage(pixels, width, cx, cy, sectors) {
  const cover = new Uint8Array(sectors)
  for (const p of pixels) {
    const x = p % width
    const y = (p - x) / width
    const ang = Math.atan2(y + 0.5 - cy, x + 0.5 - cx)
    let k = Math.floor((ang + Math.PI) / (2 * Math.PI) * sectors)
    if (k >= sectors) k = sectors - 1
    if (k < 0) k = 0
    cover[k] = 1
  }
  let filled = 0
  for (let k = 0; k < sectors; k++) filled += cover[k]
  // 最大连续空扇区要跨首尾统计（开口可能正好落在角度 0 上）
  let maxGap = 0
  let run = 0
  for (let k = 0; k < sectors * 2; k++) {
    if (cover[k % sectors]) run = 0
    else {
      run++
      if (run > maxGap) maxGap = run
    }
  }
  return { cover: filled / sectors, maxGap: Math.min(maxGap, sectors) }
}

/**
 * 从设计坐标的红掩膜里找出红圈，并归属到格子。
 * @param {{data:Uint8Array,width:number,height:number}} designRed 设计坐标下的红掩膜
 * @param {Array} [refRects] **参考字区域**（设计坐标像素矩形），默认按 LAYOUT 现算
 * @returns {{circles:Array, markedCells:number[], uncertainCells:number[], dropped:Array}}
 *   markedCells 是**页内格号**（0~135，从左到右、从上到下），天然就是决策 一-7 要的顺序
 */
export function detectCircles(designRed, refRects, options = {}) {
  const opt = { ...MARK_DEFAULTS, ...options }
  const rects = refRects && refRects.length ? refRects : defaultReferenceRects()
  // keepPixels：环形判据要拿像素坐标算角度覆盖（与 imageOps 注释里"找红圈要判环形"同一口径）
  const { components } = connectedComponents(designRed,
    { minArea: opt.minCircleArea, keepPixels: true, maxComponents: 500 })
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
    // 环形：必须绕着质心走一圈（允许约 120° 的开口，不要求闭合、更不要求正圆）
    const ring = angularCoverage(c.pixels, designRed.width, c.cx, c.cy, opt.angleSectors)
    if (ring.cover < opt.minAngularCover || ring.maxGap > opt.maxAngularGap) {
      dropped.push({
        reason: 'notRing', area: c.area, width: w, height: h,
        cover: +ring.cover.toFixed(2), gap: ring.maxGap
      })
      continue
    }

    // 归属（D1）：**该格参考字区域的中心落在红块外框内** = 这个圈围住了这个字；
    //   取离红块质心最近的格。圈旁的数字编号 / 页面底部的红字注释不在参考字区域中心上，
    //   因此不会被归到任何格（实测旧纸：数字编号全部落空、真圈 10/10 命中）。
    const bbox = { x: c.minX, y: c.minY, width: w, height: h }
    const inside = []
    rects.forEach((r, i) => {
      const cx = r.x + r.width / 2
      const cy = r.y + r.height / 2
      if (cx >= c.minX && cx <= c.maxX && cy >= c.minY && cy <= c.maxY) {
        inside.push({ i, dist: Math.hypot(cx - c.cx, cy - c.cy) })
      }
    })
    if (!inside.length) {
      dropped.push({ reason: 'notAround', area: c.area, width: w, height: h })
      continue
    }
    inside.sort((a, b) => a.dist - b.dist)
    const best = inside[0]
    const second = inside[1]
    const uncertain = !!second && second.dist <= best.dist * opt.spanSecondRatio

    circles.push({
      id: circles.length,
      cellIndex: best.i, // 页内格号
      area: c.area,
      fill: +fill.toFixed(3),
      bbox,
      distance: +best.dist.toFixed(1),
      secondDistance: second ? +second.dist.toFixed(1) : null,
      secondCellIndex: second ? second.i : -1,
      uncertain // 一个圈同时围住两个参考字中心 → 交界面确认
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
  // cellRects 是旧名字（字位框），现在语义是**参考字区域**；两者都收，避免调用方漏改时静默用错几何
  const detected = detectCircles(designRed, opt.referenceRects || opt.cellRects, opt)

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
        Object.entries(kinds).map(([k, v]) => ({
          thin: '太细', huge: '过大', solid: '是实心红块', notRing: '没有绕成一圈',
          notAround: '没有围住参考字', duplicate: '同一格重复圈'
        }[k] || k) + ' ' + v).join('，') +
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
    stats: {
      redPixels: red.redPixels,
      maxRedness: red.maxRedness, // 增强后的最大红度（用于提示与测试基线）
      maxRawRedness: red.maxRawRedness, // 原始最大红度（诊断用：区分"红笔本身淡"与"扫描洗掉了"）
      designRedPixels: designRed.pixels
    },
    messages
  }
}

/**
 * 把红圈图层接到切格结果上：右侧方块几何都拿到了，才可能"按格"给出红圈掩膜。
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
