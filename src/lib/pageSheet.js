// 页内 136 格的缩略拼图（「看格子」弹窗与更正核对的背景图）。
//
// 为什么单独成一个模块：同一张拼图有**两条来源**，而两条必须画出同一种图 ——
//   ① 识别时当场画（原料是内存里的掩膜，见 lib/scanFlow.js）；
//   ② 刷新 / 关掉浏览器再回来 / 分两次识别之后，内存缓存已经没了，按需**从落盘的字形分片重建**
//      （更正核对的并排表要靠它看"这一格写的到底是什么"）。
// 画法只留这一处，是为了避免"刚识别完看到的"与"刷新后看到的"两张图对不上。
import { LAYOUT } from './layout.js'
import { loadGlyphPage, pngDataUrlToMask } from './glyphStore.js'

// 格与格之间的缝（像素）：不留缝的话相邻两格的笔迹会连成一片，看不出格界
const GAP = 2

/**
 * 把一页的格子画成一张拼图（17 列 × 8 行）。
 * 输入只需要"有内容的格"：空白格不画，底色就是浅灰底。
 * @param {Array} cells `[{ index, mask, width, height, boxInSlice, marked }]`
 *  - `index` 页内格号（0 起）
 *  - `mask` 笔迹掩膜（1 = 笔迹）；不传就画成空格
 *  - `boxInSlice` 书写格在切片内的像素矩形（只画书写格那一块，切片外扩的边不进来）
 *  - `marked` 是否被红笔圈掉（画红框）
 * @param {number} size 每格的像素边长
 * @returns {Promise<Blob>} PNG
 */
export function cellSheet(cells, size) {
  const cols = LAYOUT.cols
  const rows = LAYOUT.rows
  const canvas = new OffscreenCanvas(cols * size, rows * size)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#f4f5f8'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const cellCanvas = new OffscreenCanvas(size, size)
  const cellCtx = cellCanvas.getContext('2d')
  for (const cell of cells) {
    const col = cell.index % cols
    const row = Math.floor(cell.index / cols)
    const ox = col * size
    const oy = row * size
    cellCtx.fillStyle = cell.marked ? '#fff5f5' : '#ffffff'
    cellCtx.fillRect(0, 0, size, size)
    const mask = cell.mask
    if (mask) {
      // 掩膜 → 缩略图：**按区域取墨**，不是最近邻采样。
      //   为什么改（2026-10-22 用户实测）：每格 96 像素、书写格 118 像素，最近邻会跳过约 19% 的源列；
      //   手写的"点"和数字细笔画只有 1~2 像素宽，正好被跳掉 —— 界面上看着像"没识别到"，
      //   其实掩膜与字体里都有（实测 Sx1022 字体里"案/室/3"的 bbox 都到顶）。
      //   现在每个目标像素覆盖的源区域里只要有 1 个墨迹像素就画黑：细笔画不会整条消失，代价是略粗。
      const mw = cell.width
      const mh = cell.height
      const box = cell.boxInSlice
      const img = cellCtx.createImageData(size, size)
      for (let y = 0; y < size; y++) {
        const sy0 = box.y + Math.floor((y / size) * box.height)
        const sy1 = Math.max(sy0 + 1, box.y + Math.ceil(((y + 1) / size) * box.height))
        for (let x = 0; x < size; x++) {
          const sx0 = box.x + Math.floor((x / size) * box.width)
          const sx1 = Math.max(sx0 + 1, box.x + Math.ceil(((x + 1) / size) * box.width))
          let ink = false
          for (let sy = sy0; sy < sy1 && !ink; sy++) {
            if (sy < 0 || sy >= mh) continue
            for (let sx = sx0; sx < sx1; sx++) {
              if (sx >= 0 && sx < mw && mask[sy * mw + sx]) { ink = true; break }
            }
          }
          const v = ink ? 0 : 255
          const o = (y * size + x) * 4
          img.data[o] = img.data[o + 1] = img.data[o + 2] = v
          img.data[o + 3] = 255
        }
      }
      cellCtx.putImageData(img, 0, 0)
    }
    ctx.drawImage(cellCanvas, ox + GAP / 2, oy + GAP / 2, size - GAP, size - GAP)
    // 被红笔圈掉的格画一道红框：与识别时那张图保持同一套记号
    if (cell.marked) {
      ctx.strokeStyle = '#e0483c'
      ctx.lineWidth = 2
      ctx.strokeRect(ox + 1, oy + 1, size - 2, size - 2)
    }
  }
  return canvas.convertToBlob({ type: 'image/png' })
}

/** Blob → dataURL（界面 <img> 与 background-image 直接用；ObjectURL 需要生命周期管理，dataURL 更省心） */
export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('缩略图编码失败'))
    reader.readAsDataURL(blob)
  })
}

/**
 * 从**落盘的字形分片**重建某一页的格子拼图（内存缓存丢失时的兜底，见本文件顶部的两条来源）。
 * 口径：落盘只存"有笔迹"的格，所以重建出来的拼图里空白格就是浅灰底 —— 与识别时那张图观感一致。
 * @param {object} input
 * @param {number} input.fileIndex 第几个文件（分片键）
 * @param {number} [input.cellThumbSize] 每格像素边长，与识别时保持一致（默认 146 = 切片原分辨率，
 *   与 `SCAN_DEFAULTS.cellThumbSize` 同值；这里不 import 它，避免 pageSheet 与 scanFlow 互相依赖）
 * @param {number[]} [input.markedCells] 这一页被红笔圈掉的格号（**落盘的掩膜里没有这个信息**，
 *   由调用方从页记录里取，否则重建的图会丢掉红框）
 * @returns {Promise<{ok:boolean, sheet:string|null, count:number, reason:string}>}
 */
export async function buildPageSheetFromStore({ fileIndex, cellThumbSize = 146, markedCells = [] }) {
  try {
    const page = await loadGlyphPage({ fileIndex })
    if (!page || !(page.glyphs || []).length) {
      return { ok: false, sheet: null, count: 0, reason: '这一页没有落盘的字形（可能已被清空识别结果）' }
    }
    const marked = new Set(Array.isArray(markedCells) ? markedCells : [])
    const cells = []
    for (const g of page.glyphs) {
      cells.push({
        index: g.cellIndex,
        marked: marked.has(g.cellIndex),
        mask: await pngDataUrlToMask(g.png, g.width, g.height),
        width: g.width,
        height: g.height,
        boxInSlice: g.boxInSlice
      })
    }
    const blob = await cellSheet(cells, cellThumbSize)
    return { ok: true, sheet: await blobToDataUrl(blob), count: cells.length, reason: '' }
  } catch (e) {
    return { ok: false, sheet: null, count: 0, reason: e && e.message ? e.message : String(e) }
  }
}
