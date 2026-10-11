// 参考字识别 —— 把印在纸上的参考字**读回来**（决策 五-9 的"纸还在、库没了"）
//
// 为什么能做：纸上的参考字是**本程序自己用内置楷体、按 14pt、按每个字自己的墨迹外框在参考字区域内居中**
//   渲染出来的（见 lib/templatePdf.js 的 drawReferenceChar）。所以这不是通用 OCR，而是
//   **封闭候选集（字表 8274 字）+ 同字体同字号**的模板匹配 —— 相当于拿标准答案去比对。
//   2026-10-11 原型实测（真实样本）：无笔迹干扰的空白件 top-1 99.3%、写满的手机拍摄件 92.6%。
//
// 两条产出，互为补充：
//   ① **逐格识别**：每格给 top-1 与候选列表 + 置信度（margin）—— 完全自定义、没有连续序列时，
//      这条就是唯一的路（认不准的格在界面上列出来让人确认）；被红圈盖住的格在这里必然失败。
//   ② **序列定位**：模板把某个全序的一段按顺序印进 136 格，所以预置档位（单页试打 / 常用 6500 字 /
//      全量）的纸，页内 136 字必是"笔画序"或"使用频率序"里的**连续一段**。用十几格高置信度锚点投票
//      定出起点，整页字序随之完全确定 —— **认错的格（含被红圈盖住的）由序列补上**。
//      实测：主件 10 格认错仍准确收敛到起点 0（一致 126/136），算出的校验码与纸面完全一致。
//      **注意边界**：自定义选字的纸是"某个全序的子序列"而非连续段，连续段假设不成立 →
//      此时 located 为 null，走 ① 的复核路径（不要把 located 的结果硬套上去）。
//
// 与识别链路的关系：本模块只"读字"，不碰笔迹；它读出的字序用来**建批次**，之后仍走原有的
//   上传识别 / 更正配对 / 落盘分片流程（决策 五-9 的第二步口径）。
import { LAYOUT, cellRect } from './layout.js'
import { getAllChars } from './charset.js'
import { getRankOrder } from './charRank.js'
import { computeBatchCode } from './batchCode.js'

// 设计坐标系（与 gridDetector.DESIGN 同一套：300dpi、PDF 的 pt 原点在左下）
const DPI = 300
const PT_TO_PX = DPI / 72
const PAGE_HEIGHT_PT = LAYOUT.pageHeight

export const REFCHAR_DEFAULTS = {
  glyphCell: 64, // 候选字渲染时的格位边长（像素）
  glyphPerRow: 32, // 一次渲染 32×32 个候选（一张画布一批，避免逐字 getImageData）
  batch: 1024,
  featSize: 32, // 精比特征尺寸（32×32 灰度）
  sigSize: 16, // 粗筛签名尺寸（16×16 二值 → 8 个 uint32）
  coarseTop: 120, // 粗筛保留的候选数
  pad: 6, // 参考字窗口相对"参考字区域"的外扩（像素）
  minInkPixels: 30, // 窗口内墨迹像素少于它 → 这格没有参考字
  minBoxSide: 8, // 墨迹包围盒**最长边**小于它 → 判为噪点（不是字）
  minBoxThin: 3, // 包围盒**最短边**小于它 → 同上。**不能要求两边都 ≥ 8**：「一」「二」这类
  //   极扁的字包围盒只有 3×59 像素，按"两边都够大"判会把它们误杀（实测 136 格里丢 1 格）
  // 判"这一格认准了"的 margin 下限：(第二名分数 − 第一名分数) / 第一名分数
  minMargin: 0.15,
  // 序列定位：锚点取多少格、至少要有多少格与定位结果吻合才认
  anchorCount: 12,
  minAgree: 0.6
}

// ── 坐标 ────────────────────────────────────────────────────────────────────

// 第 index 格的"参考字区域"（PDF 坐标，pt）—— 与 templatePdf 的绘制口径一一对应：
// 水平居中于字位框，底边距字位底 referenceAreaBottom，边长 referenceAreaSize
export function referenceAreaRect(index) {
  const cell = cellRect(index)
  if (!cell) return null
  return {
    x: cell.x + (cell.width - LAYOUT.referenceAreaSize) / 2,
    y: cell.y + LAYOUT.referenceAreaBottom,
    width: LAYOUT.referenceAreaSize,
    height: LAYOUT.referenceAreaSize
  }
}

// PDF 矩形（y = 底边）→ 图像矩形（y = 上边），与 gridDetector.DESIGN.rect 同一算法
function toImageRect(r) {
  const x0 = Math.round(r.x * PT_TO_PX)
  const x1 = Math.round((r.x + r.width) * PT_TO_PX)
  const y0 = Math.round((PAGE_HEIGHT_PT - (r.y + r.height)) * PT_TO_PX)
  const y1 = Math.round((PAGE_HEIGHT_PT - r.y) * PT_TO_PX)
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

// 第 index 格的参考字窗口（图像坐标，含外扩）
export function referenceWindowRect(index, pad = REFCHAR_DEFAULTS.pad) {
  const r = toImageRect(referenceAreaRect(index))
  return { x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: r.height + 2 * pad }
}

// ── 特征 ────────────────────────────────────────────────────────────────────

// 把一个窗口裁到墨迹包围盒、重采样成 featSize×featSize 灰度（归一化到 0..1）+ sigSize 二值签名。
// 为什么按包围盒归一化：打印 + 扫描会让字的位置与大小有零点几毫米的漂移，按外框归一化后
//   这些漂移全部消掉，剩下的差异才是"字形差异"。
export function featureFrom(gray, width, height, x0, y0, cw, ch, threshold, options = {}) {
  const opt = { ...REFCHAR_DEFAULTS, ...options }
  const F = opt.featSize
  const S = opt.sigSize
  let minX = 1e9
  let minY = 1e9
  let maxX = -1
  let maxY = -1
  let ink = 0
  for (let y = 0; y < ch; y++) {
    const yy = y0 + y
    if (yy < 0 || yy >= height) continue
    for (let x = 0; x < cw; x++) {
      const xx = x0 + x
      if (xx < 0 || xx >= width) continue
      if (gray[yy * width + xx] < threshold) {
        ink++
        if (xx < minX) minX = xx
        if (xx > maxX) maxX = xx
        if (yy < minY) minY = yy
        if (yy > maxY) maxY = yy
      }
    }
  }
  if (maxX < 0) return null
  const bw = maxX - minX + 1
  const bh = maxY - minY + 1
  if (bw < opt.minBoxThin || bh < opt.minBoxThin) return null
  if (Math.max(bw, bh) < opt.minBoxSide) return null
  const v32 = new Float32Array(F * F)
  let lo = 255
  let hi = 0
  for (let gy = 0; gy < F; gy++) {
    for (let gx = 0; gx < F; gx++) {
      const sx = minX + Math.min(bw - 1, Math.floor((gx + 0.5) * bw / F))
      const sy = minY + Math.min(bh - 1, Math.floor((gy + 0.5) * bh / F))
      const v = gray[sy * width + sx]
      v32[gy * F + gx] = v
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  const span = Math.max(1, hi - lo)
  for (let i = 0; i < v32.length; i++) v32[i] = (v32[i] - lo) / span
  const bits = new Uint32Array(S * S / 32)
  for (let gy = 0; gy < S; gy++) {
    for (let gx = 0; gx < S; gx++) {
      const sx = Math.floor((gx + 0.5) * F / S)
      const sy = Math.floor((gy + 0.5) * F / S)
      if (v32[sy * F + sx] < 0.5) {
        const k = gy * S + gx
        bits[k >> 5] |= 1 << (k & 31)
      }
    }
  }
  return { v32, bits, ink, box: { w: bw, h: bh } }
}

const popcount = (x) => {
  x = x - ((x >> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333)
  x = (x + (x >> 4)) & 0x0f0f0f0f
  return (Math.imul(x, 0x01010101) >> 24) & 0xff
}

// ── ① 候选库：把字表每个字渲染成位图（浏览器侧；需要 canvas + 已注册的参考字字体）──

/**
 * 建候选库。一次性成本实测约 2.3 秒（8274 字）—— 恢复是低频动作，配进度提示即可，
 * 不需要移入 Web Worker（与决策 四-10 的口径一致）。
 * @param {{fontFamily:string, chars?:string[], onProgress?:(done:number,total:number)=>void}} options
 * @returns {Promise<{chars:string[], count:number, v32:Float32Array, sig:Uint32Array, ok:Uint8Array,
 *                    featSize:number, sigSize:number, ms:number}>}
 */
export async function buildLibrary(options = {}) {
  const opt = { ...REFCHAR_DEFAULTS, ...options }
  const chars = options.chars || getAllChars()
  const family = options.fontFamily || 'sxfont-refchar'
  const F = opt.featSize
  const S = opt.sigSize
  const CELL = opt.glyphCell
  const perRow = opt.glyphPerRow
  const batch = opt.batch
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now()

  const v32 = new Float32Array(chars.length * F * F)
  const sig = new Uint32Array(chars.length * (S * S / 32))
  const ok = new Uint8Array(chars.length)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const fontPx = LAYOUT.referenceFontSize * PT_TO_PX // 14pt @300dpi ≈ 58.3px

  for (let b = 0; b < Math.ceil(chars.length / batch); b++) {
    const slice = chars.slice(b * batch, Math.min(chars.length, (b + 1) * batch))
    const rows = Math.ceil(slice.length / perRow)
    canvas.width = perRow * CELL
    canvas.height = rows * CELL
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#000000'
    ctx.font = fontPx + 'px ' + family
    ctx.textBaseline = 'alphabetic'
    for (let k = 0; k < slice.length; k++) {
      const m = ctx.measureText(slice[k])
      const left = m.actualBoundingBoxLeft || 0
      const right = m.actualBoundingBoxRight || 0
      const asc = m.actualBoundingBoxAscent || 0
      const desc = m.actualBoundingBoxDescent || 0
      // 与生成端同口径：**墨迹外框**的中心对齐到格位中心（不是按 advance 宽度）
      const cx = (k % perRow) * CELL + CELL / 2
      const cy = ((k / perRow) | 0) * CELL + CELL / 2
      ctx.fillText(slice[k], cx - (right - left) / 2, cy + (asc - desc) / 2)
    }
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    // ImageData.data 是 RGBA 四通道 —— 必须先转单通道灰度再喂给特征函数（踩过：直接按单通道读
    // 会读到错位字节，整个候选库变成噪声，匹配全错且各候选分数无差别）
    const glyphGray = new Uint8ClampedArray(canvas.width * canvas.height)
    for (let i = 0; i < glyphGray.length; i++) glyphGray[i] = img.data[i * 4]
    for (let k = 0; k < slice.length; k++) {
      const fx = featureFrom(glyphGray, canvas.width, canvas.height,
        (k % perRow) * CELL, ((k / perRow) | 0) * CELL, CELL, CELL, 128, opt)
      if (!fx) continue
      const idx = b * batch + k
      v32.set(fx.v32, idx * F * F)
      sig.set(fx.bits, idx * (S * S / 32))
      ok[idx] = 1
    }
    if (typeof options.onProgress === 'function') options.onProgress(Math.min(chars.length, (b + 1) * batch), chars.length)
  }
  const ms = Math.round(((typeof performance !== 'undefined' ? performance : Date).now()) - t0)
  return { chars, count: chars.length, v32, sig, ok, featSize: F, sigSize: S, ms }
}

// ── ② 取样 + 匹配（纯逻辑，可在 Node 侧用合成数据断言）──────────────────────

/**
 * 从设计灰度图上取一格的参考字特征。
 * @param {{data:Uint8ClampedArray,width:number,height:number}} designGray 校正后的灰度图
 * @param {number} index 页内格号
 * @param {{redMask?:Uint8Array}} [options] redMask 是设计坐标的红掩膜（红圈像素要先抹成纸色，
 *   否则深红的圈会把阈值带偏、把参考字切掉）
 * @returns {{empty:boolean, reason?:string, feature?:object, threshold?:number, ink?:number}}
 */
export function sampleCell(designGray, index, options = {}) {
  const opt = { ...REFCHAR_DEFAULTS, ...options }
  const r = referenceWindowRect(index, opt.pad)
  const cw = r.width
  const ch = r.height
  const win = new Uint8ClampedArray(cw * ch)
  const hist = new Int32Array(256)
  let n = 0
  for (let y = 0; y < ch; y++) {
    const yy = r.y + y
    for (let x = 0; x < cw; x++) {
      const xx = r.x + x
      let v = 255
      if (xx >= 0 && xx < designGray.width && yy >= 0 && yy < designGray.height) {
        const p = yy * designGray.width + xx
        v = options.redMask && options.redMask[p] ? 255 : designGray.data[p]
      }
      win[y * cw + x] = v
      hist[v]++
      n++
    }
  }
  // 纸面灰度取 p90（比 max 稳、比中位数贴近纸面）；墨迹判据用"低于纸面 25 灰阶的像素数"——
  // **不能只看对比度**：笔画极少的字（「一」「二」）墨迹只占窗口 3.5%，p05 会落在纸面上，
  // 按 (p05+p95)/2 判会把它误判成"没有参考字"（原型阶段实测踩到，136 格里丢了 1 格）。
  const quantile = (p) => {
    let acc = 0
    for (let v = 0; v < 256; v++) {
      acc += hist[v]
      if (acc >= n * p) return v
    }
    return 255
  }
  const paper = quantile(0.9)
  const below = Math.max(0, paper - 25)
  let inkPixels = 0
  for (let v = 0; v < below; v++) inkPixels += hist[v]
  if (inkPixels < opt.minInkPixels) return { empty: true, reason: 'no-ink', ink: inkPixels, paper }
  const threshold = Math.round((quantile(0.02) + paper) / 2)
  const fx = featureFrom(win, cw, ch, 0, 0, cw, ch, threshold, opt)
  if (!fx) return { empty: true, reason: 'no-box', ink: inkPixels, paper }
  return { empty: false, feature: { ...fx, bits: fx.bits }, threshold, ink: inkPixels, paper }
}

/**
 * 一格特征 → top-K 候选（两级：16×16 二值签名汉明距离粗筛，32×32 灰度 L2 精比）
 * @returns {Array<{index:number, char:string, score:number}>} 按分数升序（越小越像）
 */
export function matchFeature(library, feature, options = {}) {
  const opt = { ...REFCHAR_DEFAULTS, ...options }
  const F = library.featSize
  const S = library.sigSize
  const sigWords = S * S / 32
  const total = library.chars.length
  const topK = opt.topK || 5
  const coarse = opt.coarseTop
  const cIdx = new Int32Array(coarse).fill(-1)
  const cD = new Int32Array(coarse).fill(1 << 30)
  for (let i = 0; i < total; i++) {
    if (!library.ok[i]) continue
    const o = i * sigWords
    let d = 0
    for (let k = 0; k < sigWords; k++) d += popcount(feature.bits[k] ^ library.sig[o + k])
    if (d < cD[coarse - 1]) {
      let j = coarse - 1
      while (j > 0 && cD[j - 1] > d) {
        cD[j] = cD[j - 1]
        cIdx[j] = cIdx[j - 1]
        j--
      }
      cD[j] = d
      cIdx[j] = i
    }
  }
  const scored = []
  for (let c = 0; c < coarse; c++) {
    const i = cIdx[c]
    if (i < 0) continue
    const o = i * F * F
    let s = 0
    for (let k = 0; k < F * F; k++) {
      const d = feature.v32[k] - library.v32[o + k]
      s += d * d
    }
    scored.push({ index: i, char: library.chars[i], score: s })
  }
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, topK)
}

// ── ③ 一页：逐格识别 ────────────────────────────────────────────────────────

/**
 * 逐格读参考字。
 * @param {object} designGray analyzePage 的 designGray（校正后的设计灰度图）
 * @param {object} library buildLibrary 的产物
 * @param {{redMask?:Uint8Array, onProgress?:Function}} [options]
 * @returns {{cells:Array, emptyCount:number, unsureCount:number, sureCount:number}}
 *   cells[i] = { index, empty, char, score, margin, candidates }
 *   **empty 的格不是"认错"，是"这格没有参考字"**（更正册每格只有格号、或压根不是模板页）
 */
export function readPageCells(designGray, library, options = {}) {
  const opt = { ...REFCHAR_DEFAULTS, ...options }
  const cells = []
  let emptyCount = 0
  let unsureCount = 0
  let sureCount = 0
  for (let i = 0; i < LAYOUT.perPage; i++) {
    const sample = sampleCell(designGray, i, { ...opt, redMask: options.redMask })
    if (sample.empty) {
      emptyCount++
      cells.push({ index: i, empty: true, reason: sample.reason, char: null, score: null, margin: null, candidates: [] })
    } else {
      const top = matchFeature(library, sample.feature, opt)
      const best = top[0]
      const second = top[1]
      const margin = second && second.score > 0 ? (second.score - best.score) / second.score : 1
      const sure = margin >= opt.minMargin
      if (sure) sureCount++
      else unsureCount++
      cells.push({
        index: i,
        empty: false,
        char: best.char,
        score: best.score,
        margin,
        sure,
        candidates: top.map((t) => ({ char: t.char, score: t.score }))
      })
    }
    if (typeof options.onProgress === 'function' && (i % 16 === 0)) options.onProgress(i + 1, LAYOUT.perPage)
  }
  return { cells, emptyCount, unsureCount, sureCount }
}

// ── ④ 序列定位（预置档位有效；自定义选字不成立，返回 null）─────────────────

/**
 * 在一条全序里找"这一页是它的哪一段"。
 * 做法：取 margin 最大的若干格当锚点 → 每个锚点反推候选起点（该字在序列里的每个位置 − 格号）→
 *   投票 → 对得票最高的少数起点，数"整页 136 格与识别结果吻合多少格" → 取最优。
 * @param {Array} cells readPageCells 的 cells
 * @param {string[]} seq 全序（笔画序或使用频率序）
 * @returns {{start:number, agree:number, chars:string[]}|null}
 */
export function locateInSequence(cells, seq, options = {}) {
  const opt = { ...REFCHAR_DEFAULTS, ...options }
  const anchors = cells
    .filter((c) => !c.empty && c.margin !== null)
    .slice()
    .sort((a, b) => b.margin - a.margin)
    .slice(0, opt.anchorCount)
  if (!anchors.length) return null
  const posOf = new Map()
  for (let p = 0; p < seq.length; p++) {
    const ch = seq[p]
    if (!posOf.has(ch)) posOf.set(ch, [])
    posOf.get(ch).push(p)
  }
  const votes = new Map()
  for (const a of anchors) {
    const positions = posOf.get(a.char) || []
    for (const p of positions) {
      const s = p - a.index
      if (s < 0) continue
      votes.set(s, (votes.get(s) || 0) + 1)
    }
  }
  if (!votes.size) return null
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  let best = null
  for (const [s] of ranked) {
    let agree = 0
    for (const c of cells) {
      if (c.empty) continue
      const j = s + c.index
      if (j >= 0 && j < seq.length && seq[j] === c.char) agree++
    }
    if (!best || agree > best.agree) best = { start: s, agree }
  }
  if (!best) return null
  const need = Math.round(LAYOUT.perPage * opt.minAgree)
  if (best.agree < need) return null
  const chars = seq.slice(best.start, best.start + LAYOUT.perPage)
  return { start: best.start, agree: best.agree, chars }
}

/**
 * 一页的完整读取：逐格识别 + 两份全序各试一次定位。
 * @returns {{cells:object, located:object|null, chars:string|null, batchCode:number|null,
 *            sureCount:number, unsureCells:number[], emptyCells:number[], source:string}}
 *   located 命中时 `chars` 就是**整页字序**（认错的格与没有参考字的格都由它补上）；
 *   没命中（自定义选字 / 不是模板页）时 `chars` 为 null，请走逐格复核。
 */
export function readPage(designGray, library, options = {}) {
  const opt = { ...REFCHAR_DEFAULTS, ...options }
  const read = readPageCells(designGray, library, opt)
  const seqs = options.sequences || [
    { key: 'rank', label: '使用频率序', chars: getRankOrder() },
    { key: 'charset', label: '笔画序', chars: getAllChars() }
  ]
  let located = null
  for (const s of seqs) {
    const hit = locateInSequence(read.cells, s.chars, opt)
    if (!hit) continue
    const cand = { seqKey: s.key, seqLabel: s.label, ...hit }
    if (!located || cand.agree > located.agree) located = cand
  }
  const unsureCells = read.cells.filter((c) => !c.empty && !c.sure).map((c) => c.index)
  const emptyCells = read.cells.filter((c) => c.empty).map((c) => c.index)
  let chars = null
  let batchCode = null
  if (located) {
    chars = located.chars.join('')
    batchCode = computeBatchCode(located.chars)
  }
  return {
    cells: read.cells, // 136 项：{ index, empty, char, score, margin, sure, candidates }
    emptyCount: read.emptyCount,
    sureCount: read.sureCount,
    unsureCount: read.unsureCount,
    unsureCells,
    emptyCells,
    // 有参考字的格占多少 —— 这是"这张纸是不是本程序模板"的判据（外来件取不到参考字）
    inkRatio: 1 - read.emptyCount / LAYOUT.perPage,
    located,
    chars,
    batchCode,
    // ready 的口径：定位成功（字序完全确定），或"认准的格足够多、剩下靠人过一眼"
    ready: !!located || read.sureCount >= Math.round(LAYOUT.perPage * 0.6)
  }
}
