// 字形提取（阶段一步骤 1.6）
// 职责：从切格产出的**切片**里分离「淡灰参考字 / 灰格线 / 深色手写笔迹」，产出只含手写笔迹的位图（mask），
//   供 1.9 矢量化（potrace）使用；顺带给出越界量、连通块数与"笔迹偏淡"指标，供 2.4 校准界面与 3.2 字形体检复用。
// 数据来源：切片由 gridDetector.analyzePage / sliceWritingBoxes 产出（146 × 146，书写格外扩 3.39pt），
//   **喂进来的是 scanPreprocessor 的去噪灰度图，不是二值图** —— 二值化会把"淡印参考字 vs 深色笔迹"的
//   灰度层次一起抹平，字形提取正是要靠这层差距来分离（决策记录 二-5、二-10）。
// 算法口径（决策记录 二-10）：① 灰度分层（< inkThreshold 判笔迹）② 连通域面积过滤（< minBlobArea 判碎屑）
//   ③ **参考字不做几何剔除** —— 实测它在扫描件上落在 200~219 段（模板里是 166，打印 + 扫描后变浅），
//   阈值 150 天然排除；旧版样本被带进切片顶带的那点残留（27 像素，200~219 段）同样被阈值挡掉。
// 实测依据（2026-10-04 三份真实样本，详见《提交历史》第 42 条）：笔迹 0~119（当前版笔迹在 0~39 段最密）、
//   田字格与格线 220~239、参考字 200~219；空白格书写格内 <180 的像素为 0、最大噪点块 21 像素；
//   写字格连通块平均 2.5~3.9 块、最大 2991 像素 → 面积过滤下限 20 像素既不漏噪点也不伤笔画。
import { closeMask, connectedComponents } from './imageOps.js'

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// 提取参数。默认值全部来自实测，改值要同步《决策记录》二-10 与《实施计划》1.6
export const EXTRACT_DEFAULTS = {
  inkThreshold: 150, // 灰度 < 它判为手写笔迹：实测笔迹 0~119、格线与参考字 ≥ 200，150 落在余量正中
  minBlobArea: 20, // 连通块面积 < 它判为碎屑 / 噪点：实测空间格最大噪点块 21 像素、成形笔画 ≥ 170 像素
  closeRadius: 0, // 闭运算半径（补笔画断口）：实测笔迹连续故默认不做，等出现真实断笔样本再开
  guideThreshold: 220, // 浅灰带上界：用于统计"书写格之外的浅灰像素"（参考字残留的诊断口径）
  minInkPixels: 50, // 掩膜像素数 < 它判为"这一格没写"（与切格测试的判据一致）
  lightInkGray: 130, // 笔迹像素灰度中位数 > 它判为"笔迹偏淡"（只出数字与标志，告警文案留给 2.4 / 3.2）
  minGlyphSize: 12 // 墨迹外框**宽与高都** < 它判为"写得太小"（12 像素约 1mm@300dpi；单边判会误伤"一"这类扁字）
}

// 在最终掩膜上统计：笔迹像素数、格内 / 格外分布、墨迹外框、笔迹灰度中位数。
// 抽成独立函数是因为掩膜可能经过闭运算，统计必须在**最终**掩膜上做，否则越界量与体检数字对不上。
function measureMask(mask, slice, box) {
  const { width, height } = slice
  const hist = new Int32Array(256)
  let inkPixels = 0
  let inkPixelsOutside = 0
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    const row = y * width
    const insideRow = y >= box.y && y < box.y + box.height
    for (let x = 0; x < width; x++) {
      if (!mask[row + x]) continue
      inkPixels++
      hist[slice.data[row + x]]++
      if (!insideRow || x < box.x || x >= box.x + box.width) inkPixelsOutside++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  // 笔迹像素的灰度中位数：判断"笔迹偏淡"的依据（淡笔迹在固定阈值下会被削细，矢量化后容易断笔）
  let inkP50 = 255
  if (inkPixels) {
    let acc = 0
    const target = inkPixels / 2
    for (let g = 0; g < 256; g++) {
      acc += hist[g]
      if (acc >= target) {
        inkP50 = g
        break
      }
    }
  }
  return {
    inkPixels,
    inkPixelsOutside,
    inkP50,
    bbox: maxX >= 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null
  }
}

/**
 * 提取单格的手写笔迹。
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} slice 切格产出的切片（去噪灰度）
 * @param {{x:number,y:number,width:number,height:number}} boxInSlice 书写格在切片内的像素矩形（切格给的坐标）
 * @param {object} [options] 见 EXTRACT_DEFAULTS
 * @returns {{mask:Uint8Array,bbox:object|null,overflow:object,hasInk:boolean,verdict:string}} mask 为 1 = 笔迹；
 *   bbox 用切片坐标；overflow 是四向越界量（像素，正数表示超出书写格多少）；verdict 为 empty / suspect / ok
 */
export function extractHandwriting(slice, boxInSlice, options = {}) {
  if (!slice || !slice.data) throw new Error('字形提取需要切格产出的切片（{ data, width, height }）')
  const opt = { ...EXTRACT_DEFAULTS, ...options }
  const { width, height } = slice
  // boxInSlice 缺省时退化成"整张切片都算书写格"：手工调用（测试、将来的单图调试）不必先算版面坐标
  const box = boxInSlice && boxInSlice.width
    ? boxInSlice
    : { x: 0, y: 0, width, height }

  // ① 灰度分层：手写候选进 raw；同时统计全切片最暗值，以及"书写格之外的浅灰像素"（参考字残留的诊断口径）
  const raw = new Uint8Array(width * height)
  let darkest = 255
  let guidePixels = 0
  for (let y = 0; y < height; y++) {
    const row = y * width
    const insideRow = y >= box.y && y < box.y + box.height
    for (let x = 0; x < width; x++) {
      const g = slice.data[row + x]
      if (g < darkest) darkest = g
      if (g < opt.inkThreshold) {
        raw[row + x] = 1
      } else if (g < opt.guideThreshold && (!insideRow || x < box.x || x >= box.x + box.width)) {
        guidePixels++
      }
    }
  }

  // ② 连通域 + 面积过滤：面积过小的块是墨点碎屑或纸面噪点，送进 potrace 只会得到一堆无意义的轮廓
  const { components } = connectedComponents({ data: raw, width, height },
    { minArea: 1, keepPixels: true, maxComponents: 5000 })
  const filtered = new Uint8Array(width * height)
  let blobsKeptRaw = 0 // 面积过滤后保留的块数；若开了闭运算，下面会按**最终**掩膜重算
  let blobsRemoved = 0
  let removedPixels = 0
  for (const c of components) {
    if (c.area < opt.minBlobArea) {
      blobsRemoved++
      removedPixels += c.area
      continue
    }
    blobsKeptRaw++
    for (const p of c.pixels) filtered[p] = 1
  }

  // ③ 可选闭运算：补 1~2 像素的笔画断口（默认不做，实测笔迹连续）。
  // 注意闭运算会改变连通关系，所以块数要在**最终**掩膜上重算，否则体检数字与实际送进 potrace 的图对不上。
  let mask = filtered
  let blobsKept = blobsKeptRaw
  if (opt.closeRadius > 0) {
    mask = closeMask({ data: filtered, width, height }, opt.closeRadius).data
    blobsKept = connectedComponents({ data: mask, width, height },
      { minArea: 1, keepPixels: false, maxComponents: 5000 }).components.length
  }

  const m = measureMask(mask, slice, box)
  const hasInk = m.inkPixels >= opt.minInkPixels
  // "写得太小"要求宽与高**都**小于阈值：像"一"这样天生扁的字只有 6 像素高，按单边判会被误判成写小了
  const tooSmall = !!m.bbox && m.bbox.width < opt.minGlyphSize && m.bbox.height < opt.minGlyphSize
  const lightInk = hasInk && m.inkP50 > opt.lightInkGray
  // 三态与决策 八-8 的书写状态对应：empty = 未写；suspect = 写了但值得人工看一眼（偏淡 / 太小）
  const verdict = !hasInk ? 'empty' : (lightInk || tooSmall ? 'suspect' : 'ok')
  const overflow = m.bbox
    ? {
        top: Math.max(0, box.y - m.bbox.y),
        left: Math.max(0, box.x - m.bbox.x),
        bottom: Math.max(0, m.bbox.y + m.bbox.height - (box.y + box.height)),
        right: Math.max(0, m.bbox.x + m.bbox.width - (box.x + box.width))
      }
    : { top: 0, left: 0, bottom: 0, right: 0 }

  return {
    width,
    height,
    mask, // 1 = 手写笔迹（已去噪），交给 1.9 的位图 → 矢量
    boxInSlice: { x: box.x, y: box.y, width: box.width, height: box.height },
    inkPixels: m.inkPixels,
    inkPixelsOutside: m.inkPixelsOutside, // 越界笔迹像素数（"笔画别出田字格"的量化指标）
    bbox: m.bbox,
    overflow,
    hasInk,
    verdict,
    lightInk,
    tooSmall,
    inkP50: m.inkP50,
    darkest,
    guidePixels, // 书写格之外的浅灰像素（参考字残留 / 格线边缘），量大说明参考字被带进了切片
    blobsKept,
    blobsRemoved,
    removedPixels,
    inkThreshold: opt.inkThreshold,
    minBlobArea: opt.minBlobArea
  }
}

/**
 * 整页提取：对切格产出的 boxes 逐格调用 extractHandwriting。
 * @param {Array} boxes gridDetector.analyzePage 的 boxes（每格带 slice 与 boxInSlice）
 * @param {object} [options] 见 EXTRACT_DEFAULTS
 * @returns {{cells:Array, summary:object}} cells 保留 index / pageNumber / charIndex，上层据此映射回字表
 */
export function extractPage(boxes, options = {}) {
  const t0 = now()
  const cells = boxes.map((b) => ({
    index: b.index,
    pageNumber: b.pageNumber,
    charIndex: b.charIndex,
    ...extractHandwriting(b.slice, b.boxInSlice, options)
  }))
  const summary = { count: cells.length, written: 0, empty: 0, suspect: 0, inkPixels: 0, ms: Math.round(now() - t0) }
  for (const c of cells) {
    if (c.verdict === 'empty') summary.empty++
    else {
      summary.written++
      if (c.verdict === 'suspect') summary.suspect++
    }
    summary.inkPixels += c.inkPixels
  }
  return { cells, summary }
}
