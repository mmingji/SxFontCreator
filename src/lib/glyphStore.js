// 字形落盘（阶段一「界面串联」B3）：把识别出来的笔迹掩膜**分片**存进 IndexedDB，刷新/关浏览器后不丢
// 职责：掩膜 ⇄ PNG 编解码、按页分片读写、统计与清理。字体合成（B3）从这里取原料。
//
// 为什么存掩膜、不存追踪后的轮廓（《决策记录》二-16 ②）：掩膜是二值图，PNG **无损** ——
//   追踪参数不变时追出来的轮廓与"当场追"逐点相同，画质没有区别；但**留着掩膜就能换参数重追**
//   （阶段三 3.1 的逐字字面框规整、3.2 的字形体检都可能要改口径），不必让用户重新手写扫描一遍。
//
// 为什么分片键而不是塞进项目对象（决策 二-16 ①）：全量 8274 字 = 61 页 × 136 格 ≈ 8300 格掩膜、
//   PNG 后约 7~14MB，而 persist 每次改动都会重写整份项目对象 —— 塞进去会让"改一个族名"也写十几 MB。
//   分片后：元信息仍走 `sxfont.project.v1`，字形走 `sxfont.glyphs.v2.<页序>`，
//   重新识别某一页只覆盖那一页的键。
// **2026-10-15（用户拍板彻底删掉"批次"）**：键从 `v1.<批次>.<页序>` 改成 `v2.<页序>` ——
//   识别结果本来就只有"当前这一套"（清空结果时按全量清），批次那层命名空间只是为了区分历史批次，
//   而历史批次既没有入口管理、也不该被复用；去掉之后分片键与页记录一一对应，少一层容易对不上的地方。
//   （旧的 v1 分片不会再被读；清空结果时按前缀全量清，实现见 clearGlyphs。）
import { openProjectDb } from './persist.js'

const PREFIX = 'sxfont.glyphs.v2.'
const LEGACY_PREFIX = 'sxfont.glyphs.v1.' // 旧键只用于"清理时一并删掉"，不再读

function pageKey(pageIndex) {
  return PREFIX + String(pageIndex).padStart(3, '0')
}

// ── 掩膜 ⇄ PNG ────────────────────────────────────────────────────────────
// 掩膜是 1 = 笔迹的 Uint8Array；存成黑白 PNG（1 像素 1 像素，不做缩放，保证往返无损）
export async function maskToPngDataUrl(mask, width, height) {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(width, height)
  for (let i = 0; i < width * height; i++) {
    const v = mask[i] ? 0 : 255
    const o = i * 4
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v
    img.data[o + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('掩膜 PNG 编码失败'))
    reader.readAsDataURL(blob)
  })
}

export async function pngDataUrlToMask(dataUrl, width, height) {
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  // **尺寸必须在 close() 之前取下来**：close() 会把位图的 width/height 清零，
  // 之后再用它算索引会取到 undefined → 整张掩膜读成全 0（踩过：往返测试当场抓住）
  const bw = bitmap.width
  const bh = bitmap.height
  const canvas = new OffscreenCanvas(bw, bh)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0)
  const img = ctx.getImageData(0, 0, bw, bh)
  if (typeof bitmap.close === 'function') bitmap.close()
  const mask = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(bw - 1, x)
      const sy = Math.min(bh - 1, y)
      const o = (sy * bw + sx) * 4
      // 深色判为笔迹（PNG 是黑白两色，阈值取中间足够稳）
      mask[y * width + x] = img.data[o] < 128 ? 1 : 0
    }
  }
  return mask
}

// ── 分片读写 ──────────────────────────────────────────────────────────────
/**
 * 保存一页的字形掩膜（分片键：`v2.<页序>`）。
 * @param {object} input
 * @param {number} input.fileIndex 第几个文件（页序里的位置，也是分片键）
 * @param {number|null} input.pageNumber 页号（可能为 null：页脚读不出且序列定位也没成）
 * @param {Array} input.glyphs `[{ char, cellIndex, mask, width, height, boxInSlice }]`（只传有笔迹的格）
 * @returns {Promise<{ok:boolean, count:number, bytes:number, error?:string}>}
 */
export async function savePageGlyphs({ fileIndex, pageNumber = null, glyphs = [] }) {
  try {
    const { db, store } = await openProjectDb()
    const encoded = []
    for (const g of glyphs) {
      // **只跳过没有掩膜的条目**（2026-10-13 修正）：以前这里还要求 `g.char` 非空，于是更正册里
      // "逐格认字认不出来"的格不落盘 —— 可那些格一旦被配对用上（决策 一-7 的"这个字改用更正册的字形"），
      // 刷新后取原料就取不到，**字体里会少几个字**（冒烟实测：136 个字形只收录了 128 个）。
      // 掩膜才是原料，char 只是附带信息；它代表哪个字由配对（主区那个被圈的字）决定，不靠这一格认出来的字。
      if (!g.mask) continue
      encoded.push({
        char: g.char,
        // 格号字段名兜底：提取模块（1.6）的格子叫 `index`，这里对外叫 `cellIndex` ——
        // 认错字段会让键变成 `0:undefined`、掩膜读不回来（踩过一次），所以两个名字都收
        cellIndex: g.cellIndex === undefined ? g.index : g.cellIndex,
        width: g.width,
        height: g.height,
        boxInSlice: g.boxInSlice,
        png: await maskToPngDataUrl(g.mask, g.width, g.height)
      })
    }
    const record = {
      fileIndex,
      pageNumber,
      savedAt: new Date().toISOString(),
      glyphs: encoded
    }
    const bytes = encoded.reduce((n, g) => n + g.png.length, 0)
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite')
      tx.objectStore(store).put(record, pageKey(fileIndex))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('字形写入失败'))
      tx.onabort = () => reject(tx.error || new Error('字形写入被中止'))
    })
    return { ok: true, count: encoded.length, bytes }
  } catch (e) {
    return { ok: false, count: 0, bytes: 0, error: e && e.message ? e.message : String(e) }
  }
}

// 列出已落盘的字形分片（键、页、字数、体积），供界面提示与"缺哪一页"的判断。
// **旧版本键（v1，带批次那层）只被识别出来用于清理**：`legacy: true` 的那几条不参与统计与取用。
export async function listGlyphPages() {
  try {
    const { db, store } = await openProjectDb()
    const keys = await new Promise((resolve) => {
      const tx = db.transaction(store, 'readonly')
      const req = tx.objectStore(store).getAllKeys()
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => resolve([])
    })
    const glyphKeys = keys.filter((k) => typeof k === 'string' &&
      (k.startsWith(PREFIX) || k.startsWith(LEGACY_PREFIX)))
    const out = []
    for (const key of glyphKeys) {
      const record = await new Promise((resolve) => {
        const tx = db.transaction(store, 'readonly')
        const req = tx.objectStore(store).get(key)
        req.onsuccess = () => resolve(req.result || null)
        req.onerror = () => resolve(null)
      })
      if (!record) continue
      out.push({
        key,
        legacy: !key.startsWith(PREFIX),
        fileIndex: record.fileIndex,
        pageNumber: record.pageNumber,
        count: (record.glyphs || []).length,
        bytes: (record.glyphs || []).reduce((n, g) => n + g.png.length, 0),
        savedAt: record.savedAt
      })
    }
    out.sort((a, b) => a.fileIndex - b.fileIndex)
    return out
  } catch {
    return []
  }
}

/**
 * 只读**某一页**的字形分片（未解码的 PNG dataURL）。
 * 为什么要单独一个按页读的入口：`loadGlyphs()` 会把所有页的掩膜全部解码（全量 8274 格要好几秒），
 *   而"刷新后重建某一页的格子拼图"只需要这一页 —— 见 lib/pageSheet.js。
 * @returns {Promise<{fileIndex:number, pageNumber:number|null, savedAt:string, glyphs:Array}|null>}
 */
export async function loadGlyphPage({ fileIndex = 0 } = {}) {
  try {
    const { db, store } = await openProjectDb()
    const record = await new Promise((resolve) => {
      const tx = db.transaction(store, 'readonly')
      const req = tx.objectStore(store).get(pageKey(fileIndex))
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => resolve(null)
    })
    if (!record) return null
    return {
      fileIndex: record.fileIndex,
      pageNumber: record.pageNumber,
      savedAt: record.savedAt,
      glyphs: record.glyphs || []
    }
  } catch {
    return null
  }
}

/**
 * 读回字形（掩膜已解码成 Uint8Array）。**只读当前版本（v2）的分片**。
 * @returns {Promise<Array<{char, cellIndex, pageNumber, fileIndex, mask, width, height, boxInSlice}>>}
 */
export async function loadGlyphs() {
  const pages = await listGlyphPages()
  const wanted = pages.filter((p) => !p.legacy)
  const out = []
  const { db, store } = await openProjectDb()
  for (const info of wanted) {
    const record = await new Promise((resolve) => {
      const tx = db.transaction(store, 'readonly')
      const req = tx.objectStore(store).get(info.key)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => resolve(null)
    })
    if (!record) continue
    for (const g of record.glyphs || []) {
      const mask = await pngDataUrlToMask(g.png, g.width, g.height)
      out.push({
        char: g.char,
        cellIndex: g.cellIndex,
        pageNumber: record.pageNumber,
        fileIndex: record.fileIndex,
        mask,
        width: g.width,
        height: g.height,
        boxInSlice: g.boxInSlice
      })
    }
  }
  return out
}

// 2026-10-13：原来这里还有一对按原键读写单条分片的函数（`readGlyphShard` / `writeGlyphShard`，
// 为「项目包导入 / 导出」服务）—— 项目包功能已随决策 五-10 作废，这两个导出**全库零引用**，一并删除。
// 需要时从 git 历史取回（那一版里还留着一条实测教训：写入前必须先 JSON 往返一次，
// 否则结构化克隆碰到 Vue 的响应式代理会报 "could not be cloned"）。

// 统计（界面提示用）：多少页、多少字、占多少字节。**只数当前版本的分片**（旧版本键另有 legacyPages）
export async function glyphStoreStats() {
  const pages = await listGlyphPages()
  const current = pages.filter((p) => !p.legacy)
  return {
    pages: current.length,
    glyphs: current.reduce((n, p) => n + p.count, 0),
    bytes: current.reduce((n, p) => n + p.bytes, 0),
    legacyPages: pages.length - current.length
  }
}

/** 清掉字形：**按全量清**（识别结果本来就只有当前这一套；旧版本的键也一并清掉） */
export async function clearGlyphs() {
  try {
    const pages = await listGlyphPages()
    if (!pages.length) return { ok: true, removed: 0 }
    const { db, store } = await openProjectDb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite')
      for (const info of pages) tx.objectStore(store).delete(info.key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('字形清理失败'))
    })
    return { ok: true, removed: pages.length }
  } catch (e) {
    return { ok: false, removed: 0, error: e && e.message ? e.message : String(e) }
  }
}

/**
 * 清掉**某一页**的字形分片（2026-10-15 用户口径：卡片上的「作废」）。
 * 为什么必须按页删：作废一页之后这一页的掩膜就不该再留着 —— 不删的话，下次生成字体或
 *   重建缩略图还会把它当成"这一页的字形"，作废就只是界面上的假象。
 * @returns {{ok:boolean, removed:number, error?:string}} 这一页本来就没有分片时 `removed: 0`（不算失败）
 */
export async function deleteGlyphPage({ fileIndex = 0 } = {}) {
  try {
    const pages = await listGlyphPages()
    const wanted = pages.filter((p) => p.fileIndex === fileIndex)
    if (!wanted.length) return { ok: true, removed: 0 }
    const { db, store } = await openProjectDb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite')
      for (const info of wanted) tx.objectStore(store).delete(info.key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('字形清理失败'))
    })
    return { ok: true, removed: wanted.length }
  } catch (e) {
    return { ok: false, removed: 0, error: e && e.message ? e.message : String(e) }
  }
}
