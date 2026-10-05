// 从识别结果构建字体（阶段一「界面串联」B3c）
// 职责：把「字形计划」（`scanMeta.buildFinalGlyphPlan` 的产物）翻译成 glyphBuilder 需要的输入 →
//   位图追踪 → 组装 TTF / woff / woff2，并把产物**暂存在内存**里供下载步骤打包。
// 原料从哪来（决策 二-16 的落盘口径）：优先用内存缓存（`scanCache`：刚识别完就在，免解码），
//   刷新过页面就从字形库（`glyphStore`：落盘的 PNG 掩膜）读回 —— 这条正是"关掉浏览器不白写"的兑现。
// 为什么产物不落盘：TTF 完全能由字形重算（全量约 30 秒），再存一份只是把体积翻倍；
//   下载步骤若发现内存里没有产物，会**当场重建**（界面给进度，不是静默重来）。
import { buildGlyphFont } from './glyphBuilder.js'
import { getPageCache } from './scanCache.js'
import { loadGlyphs } from './glyphStore.js'

// 最近一次构建的产物（内存暂存；刷新即失效）
let lastBuild = null
export function getLastBuild() {
  return lastBuild
}
export function clearLastBuild() {
  lastBuild = null
}

/**
 * 取字形原料：按 (fileIndex, cellIndex) 找掩膜。
 * @param {Array} items 字形计划 `[{ char, source, fileIndex, cellIndex }]`
 * @returns {Promise<{inputs:Array, missing:Array, fromStore:boolean}>}
 */
export async function collectGlyphInputs(items, { batchId, onStage } = {}) {
  const inputs = []
  const missing = []
  const cacheMasks = new Map()
  for (const it of items) {
    const cache = getPageCache(it.fileIndex)
    if (!cache || !cache.masks) continue
    for (const m of cache.masks) cacheMasks.set(it.fileIndex + ':' + m.index, m)
  }
  let storeMasks = null
  let fromStore = false
  for (const it of items) {
    const key = it.fileIndex + ':' + it.cellIndex
    let found = cacheMasks.get(key)
    if (!found) {
      if (!storeMasks) {
        if (onStage) onStage('正在从字形库读回落盘的掩膜…')
        const list = await loadGlyphs({ batchId })
        storeMasks = new Map(list.map((g) => [g.fileIndex + ':' + g.cellIndex, g]))
        fromStore = true
      }
      found = storeMasks.get(key)
    }
    if (!found || !found.mask) {
      missing.push(it)
      continue
    }
    inputs.push({
      char: it.char,
      mask: found.mask,
      width: found.width,
      height: found.height,
      boxInSlice: found.boxInSlice,
      source: it.source
    })
  }
  return { inputs, missing, fromStore }
}

/**
 * 构建字体（追踪 + 组装）。
 * @param {object} input
 * @param {Array} input.items 字形计划
 * @param {object} input.meta 名称表字段（决策 四-1）
 * @param {(done:number,total:number)=>void} [input.onProgress] 逐字进度（追踪 + 组装都在里面）
 * @param {(text:string)=>void} [input.onStage] 阶段文案
 * @returns {Promise<object>} glyphBuilder 的产物 + `missing`（缺原料的字形）+ `meta`
 */
export async function buildFontFromPlan({ items, meta, batchId, woff2WasmUrl, onProgress, onStage }) {
  if (!items || !items.length) {
    const err = new Error('没有可用的字形：先在第 3 步识别扫描件，并在第 4 步确认更正对应')
    err.code = 'NO_GLYPHS'
    throw err
  }
  const { inputs, missing, fromStore } = await collectGlyphInputs(items, { batchId, onStage })
  if (!inputs.length) {
    const err = new Error('一个字形原料都没取到：请回到第 3 步重新识别一次（落盘的掩膜可能已被清空）')
    err.code = 'NO_INPUTS'
    throw err
  }
  if (onStage) onStage(fromStore ? '正在追踪笔迹并组装字体（原料取自落盘掩膜）…' : '正在追踪笔迹并组装字体…')
  const built = await buildGlyphFont(inputs, meta, { onProgress, woff2WasmUrl })
  lastBuild = {
    ...built,
    missing,
    meta,
    fromStore,
    builtAt: new Date().toISOString()
  }
  return lastBuild
}
