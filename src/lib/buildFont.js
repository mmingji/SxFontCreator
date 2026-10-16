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
import { buildCheckupSnapshot, inspectGlyphPlan } from './glyphCheckup.js'

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
 * 返回值里带上 `masks`（键 `fileIndex:cellIndex` → 掩膜记录）：体检要用**同一份**原料，
 * 否则刷新过页面时（内存缓存空）体检会以为"一个字的原料都取不到"。
 * @param {Array} items 字形计划 `[{ char, source, fileIndex, cellIndex }]`
 * @returns {Promise<{inputs:Array, missing:Array, masks:Map, fromStore:boolean}>}
 */
export async function collectGlyphInputs(items, { onStage } = {}) {
  const inputs = []
  const missing = []
  const masks = new Map()
  for (const it of items) {
    const cache = getPageCache(it.fileIndex)
    if (!cache || !cache.masks) continue
    for (const m of cache.masks) masks.set(it.fileIndex + ':' + m.index, m)
  }
  let storeMasks = null
  let fromStore = false
  for (const it of items) {
    const key = it.fileIndex + ':' + it.cellIndex
    let found = masks.get(key)
    if (!found) {
      if (!storeMasks) {
        if (onStage) onStage('正在从字形库读回落盘的掩膜…')
        const list = await loadGlyphs()
        storeMasks = new Map(list.map((g) => [g.fileIndex + ':' + g.cellIndex, g]))
        for (const [k, v] of storeMasks) if (!masks.has(k)) masks.set(k, v)
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
  return { inputs, missing, masks, fromStore }
}

/**
 * 构建字体（追踪 + 组装），顺带做一次**字形体检**（阶段三 3.2）。
 * 体检为什么要在这里做：它要的原料与构建完全相同（掩膜 + 书写格几何），而且构建本来就要逐字跑一遍 ——
 *   放在这一步是"一次遍历出两份结果"，不必让用户再等一遍。体检**只提示、不改字形**（决策 四-7）。
 * @param {object} input
 * @param {Array} input.items 字形计划
 * @param {object} input.meta 名称表字段（决策 四-1）
 * @param {Set<string>|string[]} [input.excluded] 已被人工剔除的字（不进字体，但仍在体检清单里显示为"已剔除"）
 * @param {(done:number,total:number)=>void} [input.onProgress] 逐字进度（体检 + 追踪 + 组装都在里面）
 * @param {(text:string)=>void} [input.onStage] 阶段文案
 * @returns {Promise<object>} glyphBuilder 的产物 + `missing`（缺原料的字形）+ `checkup`（体检快照）+ `excluded`
 */
export async function buildFontFromPlan({ items, meta, woff2WasmUrl, excluded, onProgress, onStage }) {
  if (!items || !items.length) {
    const err = new Error('没有可用的字形：先在第 2 步识别扫描件，并在第 2 步确认更正对应')
    err.code = 'NO_GLYPHS'
    throw err
  }
  const excludedSet = excluded instanceof Set ? excluded : new Set(excluded || [])
  const planned = items.filter((it) => !excludedSet.has(it.char))
  const { inputs, missing, masks, fromStore } = await collectGlyphInputs(planned, { onStage })
  if (!inputs.length) {
    const err = new Error('一个字形原料都没取到：请回到第 2 步重新识别一次（落盘的掩膜可能已被清空）')
    err.code = 'NO_INPUTS'
    throw err
  }
  // ① 体检：对**全部**计划里的字跑（含被剔除的，界面要能说明它为什么被剔），原料用上面刚取到的那一份
  if (onStage) onStage('正在检查字形质量…')
  const checkup = inspectGlyphPlan({
    items,
    getCell: (it) => masks.get(it.fileIndex + ':' + it.cellIndex) || null,
    excluded: excludedSet
  })
  if (onStage) onStage(fromStore ? '正在追踪笔迹并组装字体（原料取自落盘掩膜）…' : '正在追踪笔迹并组装字体…')
  const built = await buildGlyphFont(inputs, meta, { onProgress, woff2WasmUrl })
  lastBuild = {
    ...built,
    missing,
    meta,
    fromStore,
    checkup: buildCheckupSnapshot(checkup, excludedSet),
    excludedCount: items.length - planned.length,
    builtAt: new Date().toISOString()
  }
  return lastBuild
}
