// 字形体检（阶段三步骤 3.2 + 步骤 2.4 的单字剔除，清单 一-8；口径见《决策记录》四-7 / 八-8）
// 职责：把"这批字形里哪些该重写、哪些不建议收进字体"算出来 —— **只测量、只提示，绝不改字形**。
// 为什么只能"告警"：决策 四-7 放弃了"逐字按字面框规整"，因为任何统一字面大小的做法都要缩放轮廓、
//   必然按同一倍数改动手写笔画的粗细，用户明确不接受。所以这一档留下的手段就是**如实报出问题、
//   由用户决定重写哪一格**（重写 = 重新扫那一页，或用第 2 步的更正册覆盖）。
//
// 三类数据来源（都由本项目已有模块产出，体检本身零依赖、不加载 fonteditor / potrace）：
//   ① 掩膜（1.6 的产物）：墨迹像素、外框、碎块、灰度 —— 直接数像素即得；
//   ② 书写格映射几何（`glyphGeometry.js`）：越界与占格率按**设计框**口径算，与字体构建同一套换算；
//   ③ 页记录（store.scan.pages）：1.6 已经判过的 `tooSmall` / `lightInk` / `verdict`，直接采信不重算。
//
// 阈值来自 68 格真件实测（2026-10-07，第一页写满 4 行；分位数见《决策记录》四-9）：
//   占格率（映射后外框高 / 书写格）：p10 0.63 / 中位 0.82 / p90 0.98；
//   笔画宽度（p90，占书写格）：中位 5.0% / p90 7.1%；碎块：多数 1 块。
import { classifyChar } from './charset.js'
import { glyphMapping, mapBBoxToDesignBox } from './glyphGeometry.js'
import { connectedComponents, strokeWidthEstimate } from './imageOps.js'

// 阈值一律**显式命名**并集中在这里：改阈值要同步《决策记录》四-9 与 `test/glyph-checkup.mjs` 的断言。
// 全部来自 68 格真件实测（2026-10-07，第一页写满 4 行；分布见《决策记录》四-9 ②）：
//   占格率 p10 0.720 / 中位 0.822 / p90 0.966；笔画宽度中位 2.4~3.4% 格宽；
//   独立块数中位 2 / p90 4；出格墨迹中位 0 像素、p90 50 像素。
export const CHECKUP_DEFAULTS = {
  fillSmall: 0.55, // 占格率低于它 → "写得太小"（真件最小 0.593，这条只在明显偏小时才响）
  fillLarge: 1.02, // 占格率高于它 → "写得过满"（得留出余量：正好顶满书写格时占格率就是 1.00，
  //                  按 `>` 0.995 判会把"刚好写满、没出格"的字也提示一遍；真件最大的两个是 1.02 / 1.03）
  outsidePixels: 30, // 越出书写格的墨迹像素超过它 → 提示"有笔画出格"（真件 p90 为 50）
  debrisArea: 60, // 掩膜里面积小于它的独立块 → 碎块（1.6 已按 12 像素过滤，这里报"偏大的可疑碎块"）
  debrisCount: 4, // 独立块数**超过**它 → 提示可能漏笔画（真件中位 2、p90 4；正常连笔本来就会分成几块）
  thinStrokeRatio: 0.03, // 笔画宽度中位数 / 书写格边长 低于它 → "笔画偏细"（真件中位 3.4%，最细 2.4%）
  darkInkGray: 130, // 笔迹灰度中位数高于它 → "墨色偏淡"（与 1.6 的 lightInkGray 同值）
  // 越界到"要重写"的门槛：收缩系数低于它才算真的缩了一圈（约 2%，肉眼能看出；1 像素越界约 0.8%，
  // 按"只留意"处理）——真件里 34/68 个字越界，绝大多数只差 1~3 像素，全判"要重写"就是噪音（实测踩到）
  clampRewriteBelow: 0.98
}

// 提示的严重程度：rewrite = 建议重写这一格；note = 留意（不一定要动）
const LEVEL = { REWRITE: 'rewrite', NOTE: 'note' }

/**
 * 单格体检。输入用 1.6 的格子记录（`extractHandwriting` 的产物）+ 切片尺寸即可 ——
 * 这些在识别那一轮就已经算好了（页记录里也存了一份轻量字段），所以体检不必重新识别。
 * @param {object} cell 1.6 的格子记录：`mask / boxInSlice / inkPixels / inkPixelsOutside / inkP50 /
 *   bbox / tooSmall / lightInk / verdict / blobsKept`
 * @param {object} [options] CHECKUP_DEFAULTS 的子集
 * @returns {{fill:number, strokeWidth:number|null, mapped:object|null, outside:boolean,
 *   clampScale:number, debris:number, messages:Array<{level:string,text:string}>, needsRewrite:boolean}}
 */
export function inspectGlyphMask(cell, options = {}) {
  const opt = { ...CHECKUP_DEFAULTS, ...options }
  const box = cell.boxInSlice || { x: 0, y: 0, width: 118, height: 118 }
  const width = cell.width || box.x + box.width
  const height = cell.height || box.y + box.height
  // 数字/字母与汉字同一套全角映射（构建端也按全角映射、advance 另按实际宽度给），
  //   但体检对它们**不判"偏小/偏大"**（手写数字本来就窄），所以 `half` 只用于跳过这两条判断。
  const half = classifyChar(cell.char || '') === 'halfwidth'
  const messages = []

  // ① 掩膜口径：面积、外框（按**书写格**口径，越界与否要和纸面规则对得上）、碎块
  let ink = 0
  let outsideInk = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!cell.mask[y * width + x]) continue
      ink++
      const inBox = x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height
      if (!inBox) outsideInk++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (!ink) {
    return {
      fill: 0, strokeWidth: null, mapped: null, outside: false, clampScale: 1, debris: 0,
      messages: [{ level: LEVEL.REWRITE, text: '这一格没有笔迹' }],
      needsRewrite: true
    }
  }

  // 碎块：独立连通块的面积分布（1.6 已按 12 像素过滤过，所以这里看到的最小块也已经"不小"了）。
  // 面积 < debrisArea 的块单独报"碎块"；只有一块时不报（那多半只是笔画断口）
  const maskObj = { data: cell.mask, width, height }
  const comps = connectedComponents(maskObj, { minArea: 1 }).components || []
  const areas = comps.map((b) => b.area).sort((a, b) => a - b)
  const debris = areas.length > 1 ? areas.filter((a) => a < opt.debrisArea).length : 0
  const minArea = areas.length ? areas[0] : 0

  // 笔画宽度（像素 → 占书写格的比例）：距离变换的 median ×2（见 imageOps.strokeWidthEstimate）
  // 为什么体检自己算而不复用页记录：识别阶段没量过它（清单 四-32 的算子是 3.1 试算时补的），
  //   而"笔画偏细"正是这里要报的一项。单格约 0.26ms（146×146），全量约 1.8 秒，可接受。
  const stroke = strokeWidthEstimate(maskObj)
  const strokeRatio = stroke.median ? stroke.median / box.width : null

  // ② 设计框口径：按"书写格 → em 方格"的同一套换算量尺寸（不追踪轮廓，几何完全等价；
  //    轮廓追踪的细微差别在 1/1000 em 量级，远小于这里要判的阈值）。
  //    两条容易踩的口径（都踩过）：
  //    ① **包围盒要用切片坐标**（不是相对书写格）—— `glyphMapping` 的偏移是按切片坐标算的
  //       （它要减 `box.x`），喂相对坐标会白差一个 box.x（实测：写满格被算成越界 118 单位）；
  //    ② **跨度要按"面"算（+1）**—— 墨迹像素是 1×1 的面，`maxX − minX` 只有 117（写满格时），
  //       按点算每个字都会少 1 像素（0.85% 格宽）。
  const mapping = glyphMapping({ boxInSlice: { x: box.x, y: box.y, width: box.width, height: box.height }, half: false })
  const rawBox = { minX, minY, maxX: maxX + 1, maxY: maxY + 1 } // 绝对切片坐标
  const localBox = { minX: minX - box.x, minY: minY - box.y, maxX: maxX + 1 - box.x, maxY: maxY + 1 - box.y }
  const { mapped, outside, clampScale } = mapBBoxToDesignBox(rawBox, mapping, false)
  const boxW = mapping.box.width
  const boxH = mapping.box.height
  const glyphW = mapped.maxX - mapped.minX
  const glyphH = mapped.maxY - mapped.minY
  // 占格率：**长边**占设计框的比例（字面率的口径；只看高会把"一"这类扁字误判成太小 ——
  // 与 1.6 的 tooSmall"宽与高都小于阈值"同一考虑）
  const fill = Math.max(glyphW / mapping.opt.glyphBox, glyphH / mapping.opt.glyphBox)

  // ③ 逐项判定（只产提示，不改字形）
  const sides = []
  if (localBox.minX < 0) sides.push('左')
  if (localBox.maxX > boxW) sides.push('右')
  if (localBox.minY < 0) sides.push('上')
  if (localBox.maxY > boxH) sides.push('下')
  if (outside && clampScale < opt.clampRewriteBelow) {
    messages.push({
      level: LEVEL.REWRITE,
      text: '有笔画越出书写格（' + (sides.join('、') || '边缘') + '侧' + (outsideInk ? '，约 ' + outsideInk + ' 像素' : '') +
        '）：字体里会按"只裁不放大"整体缩小到 ' + Math.round(clampScale * 100) + '%，这个字会比同批的字小一圈'
    })
  } else if (outside || outsideInk >= opt.outsidePixels) {
    messages.push({
      level: LEVEL.NOTE,
      text: '笔画贴到／略微越出书写格（' + (sides.join('、') || '边缘') + '侧' +
        (outsideInk ? '，约 ' + outsideInk + ' 像素' : '') + '）：还没到要缩小的程度，成字后只是略微出框，留意即可'
    })
  }
  if (fill < opt.fillSmall && !half) {
    messages.push({
      level: LEVEL.REWRITE,
      text: '字写得偏小：占格率只有 ' + Math.round(fill * 100) + '%（同批中位约 ' + Math.round(opt.fillSmall * 100) +
        '% 以上算合适）—— 建议重写这一格，否则成字后与别的字大小不匀'
    })
  } else if (fill > opt.fillLarge + 1e-6 && !half) {
    // 用 1e-6 的余量做比较：写满格时 fill 可能正好是 0.9999999999999 / 1.0000000000002（浮点尾差），
    // 按 `>` 直接判会把"刚好写满"也提示成"写得过满"
    messages.push({
      level: LEVEL.NOTE,
      text: '字几乎顶满书写格（占格率 ' + Math.round(fill * 100) + '%）：笔画多的字本该如此，若本来笔画少就要留意写大了'
    })
  }
  if (cell.tooSmall) {
    messages.push({ level: LEVEL.REWRITE, text: '提取阶段判定"写得太小"（宽与高都小于 12 像素）' })
  }
  if (cell.lightInk || (cell.inkP50 !== undefined && cell.inkP50 > opt.darkInkGray)) {
    messages.push({
      level: LEVEL.NOTE,
      text: '墨色偏淡（笔迹灰度中位数 ' + (cell.inkP50 === undefined ? '?' : cell.inkP50) + '，阈值 ' + opt.darkInkGray +
        '）：笔画细的地方可能断裂，建议换笔或重写'
    })
  }
  if (strokeRatio !== null && strokeRatio < opt.thinStrokeRatio) {
    messages.push({
      level: LEVEL.NOTE,
      text: '笔画偏细（中位 ' + (strokeRatio * 100).toFixed(1) + '% 格宽，同批中位约 ' +
        (CHECKUP_DEFAULTS.thinStrokeRatio * 100).toFixed(0) + '% 以上）：成字后这一笔会比别的字轻'
    })
  }
  if (debris > 0) {
    messages.push({
      level: LEVEL.NOTE,
      text: '有 ' + debris + ' 个碎块（最小 ' + minArea + ' 像素）：可能是纸面污点或笔画断口，成字后是个小疙瘩'
    })
  } else if (areas.length > opt.debrisCount) {
    messages.push({
      level: LEVEL.NOTE,
      text: '这个字由 ' + areas.length + ' 个独立块组成（连笔少或笔画断开）：看一看是不是漏写或多写了笔画'
    })
  }

  return {
    fill,
    ink,
    outsideInk,
    strokeWidth: stroke.median || null,
    strokeRatio,
    mapped,
    glyphW,
    glyphH,
    outside,
    clampScale,
    debris,
    blobs: areas.length,
    messages,
    needsRewrite: messages.some((m) => m.level === LEVEL.REWRITE)
  }
}

/**
 * 批量体检：把「字形计划」里的每个字过一遍，汇总成清单（界面按它分类列出）。
 * @param {object} input
 * @param {Array} input.items 字形计划 `[{ char, source, fileIndex, cellIndex }]`
 * @param {(item:object)=>object|null} input.getCell 按 item 取"1.6 的格子记录"（含 mask / boxInSlice）
 * @param {Set<string>|string[]} [input.excluded] 已被用户剔除的字（**仍然量、但状态标成"已剔除"**：
 *   界面上要让用户看得到"这个字是因为什么被剔的"，也要能一键恢复）
 * @param {object} [input.options] CHECKUP_DEFAULTS 的子集
 * @param {(done:number,total:number)=>void} [input.onProgress]
 * @returns {{glyphs:Array, summary:object}}
 */
export function inspectGlyphPlan({ items = [], getCell, excluded, options = {}, onProgress }) {
  const opt = { ...CHECKUP_DEFAULTS, ...options }
  const excludedSet = excluded instanceof Set ? excluded : new Set(excluded || [])
  const glyphs = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const isExcluded = excludedSet.has(item.char)
    const cell = getCell(item)
    if (!cell || !cell.mask) {
      glyphs.push({
        char: item.char, source: item.source, fileIndex: item.fileIndex, cellIndex: item.cellIndex,
        excluded: isExcluded, missing: true, needsRewrite: true,
        messages: [{ level: LEVEL.REWRITE, text: '取不到这个字的笔迹原料（重扫这一页或重新识别一次）' }]
      })
      continue
    }
    const res = inspectGlyphMask({ ...cell, char: item.char }, opt)
    glyphs.push({
      char: item.char,
      source: item.source, // main / correction
      fileIndex: item.fileIndex,
      cellIndex: item.cellIndex,
      pageNumber: item.pageNumber,
      excluded: isExcluded,
      ...res
    })
    if (onProgress) onProgress(i + 1, items.length)
  }
  return { glyphs, summary: summarizeCheckup(glyphs) }
}

/**
 * 体检快照（落盘用）：只留"界面上要显示的那些字段"，几十 KB 级。
 * 为什么不直接存整份报告：报告里每个字都带完整的 `mapped` 包围盒与提示数组，全量 8274 字会有几百 KB，
 *   而它每次构建都能重算（构建本来就要跑一遍）。
 * 为什么"被剔除"的字也要进快照：构建时那些字**不在**字形计划里（被过滤掉了），
 *   不单独带上，界面上就会出现"剔除了但看不到、也没法恢复"的死角。
 */
export function buildCheckupSnapshot(report, excludedInput) {
  const excludedSet = excludedInput instanceof Set ? excludedInput : new Set(excludedInput || [])
  const glyphs = (report.glyphs || []).map((g) => ({
    char: g.char,
    source: g.source || 'main',
    fileIndex: g.fileIndex,
    cellIndex: g.cellIndex,
    pageNumber: g.pageNumber === undefined ? null : g.pageNumber,
    needsRewrite: !!g.needsRewrite,
    excluded: !!g.excluded,
    fill: Math.round((g.fill || 0) * 1000) / 1000,
    clipScale: g.clampScale === undefined ? 1 : Math.round(g.clampScale * 1000) / 1000,
    messages: (g.messages || []).map((m) => m.text)
  }))
  const inReport = new Set(glyphs.map((g) => g.char))
  for (const char of excludedSet) {
    if (inReport.has(char)) continue
    glyphs.push({
      char, source: 'main', fileIndex: null, cellIndex: null, pageNumber: null,
      needsRewrite: false, excluded: true, fill: 0, clipScale: 1,
      messages: ['已剔除：这个字不进入字体']
    })
  }
  return { at: new Date().toISOString(), summary: summarizeCheckup(glyphs), glyphs }
}

/** 从快照里取"要重写的字"（界面与提示共用）：被剔除的不算 */
export function rewriteChars(snapshot) {
  return ((snapshot && snapshot.glyphs) || []).filter((g) => g.needsRewrite && !g.excluded).map((g) => g.char)
}

/**
 * 在快照上**就地**翻转某个字的"已剔除"状态，并重算汇总。
 * 为什么要有这个：快照是"生成字体"那一次的产物，而剔除 / 恢复只是翻一个状态位 ——
 *   不重新跑一遍体检（那要几秒）就能让清单立刻正确。
 * 若这个字不在快照里（理论上不会：快照带上全部计划里的字），就不动它。
 * @returns {object|null} 新的快照（不改原对象，便于响应式更新）
 */
export function toggleSnapshotExcluded(snapshot, char, excluded) {
  if (!snapshot || !Array.isArray(snapshot.glyphs)) return snapshot
  let hit = false
  const glyphs = snapshot.glyphs.map((g) => {
    if (g.char !== char) return g
    hit = true
    return {
      ...g,
      excluded: !!excluded,
      messages: excluded
        ? ['已剔除：这个字不进入字体']
        : (g.messages || []).filter((m) => !/^已剔除/.test(m))
    }
  })
  if (!hit) return snapshot
  return { ...snapshot, glyphs, summary: summarizeCheckup(glyphs) }
}

/** 汇总：按"已剔除 / 要重写 / 只是留意 / 没问题"分类计数，并给出可读的中文结论 */
export function summarizeCheckup(glyphs = []) {
  const byChar = []
  let rewrite = 0
  let note = 0
  let ok = 0
  let missing = 0
  let excluded = 0
  for (const g of glyphs) {
    if (g.excluded) {
      excluded++
      continue // 已剔除的不再计入"待处理"，界面单独列一栏
    }
    if (g.missing) missing++
    if (g.needsRewrite) {
      rewrite++
      byChar.push({ char: g.char, level: LEVEL.REWRITE, messages: (g.messages || []).map((m) => (typeof m === 'string' ? m : m.text)) })
    } else if ((g.messages || []).length) {
      note++
      byChar.push({ char: g.char, level: LEVEL.NOTE, messages: (g.messages || []).map((m) => (typeof m === 'string' ? m : m.text)) })
    } else {
      ok++
    }
  }
  const seconds = []
  if (rewrite) seconds.push(rewrite + ' 个建议重写')
  if (note) seconds.push(note + ' 个只是留意')
  if (missing) seconds.push(missing + ' 个取不到原料')
  if (excluded) seconds.push(excluded + ' 个已剔除')
  // **占格率中位**（2026-10-16 用户口径）：这是"字写得多大"的直接指标 —— 生成的字同字号下看着多大，
  //   基本就是由它决定（程序端是 1:1 映射、不缩放，见 test/font-build.mjs 那条"涂满书写格 = 正好等于
  //   设计框"的断言）。把它显示到摘要上，用户拿我们的字体与系统楷体比、觉得偏小时，一眼就能分清
  //   "是我写小了"还是"程序缩了"。只统计真正进了字体的字（剔除的与取不到原料的不算）。
  const fills = glyphs
    .filter((g) => !g.excluded && !g.missing && typeof g.fill === 'number' && g.fill > 0)
    .map((g) => g.fill)
    .sort((a, b) => a - b)
  const fillMedian = fills.length ? Math.round(fills[Math.floor(fills.length / 2)] * 1000) / 1000 : null
  return {
    total: glyphs.length,
    rewrite,
    note,
    ok,
    missing,
    excluded,
    fillMedian,
    // "干净"= 没有要重写的、也没有取不到原料的（被剔除的是用户的主动选择，不算问题）
    clean: rewrite === 0 && missing === 0,
    message: glyphs.length
      ? '已体检 ' + glyphs.length + ' 个字形：' + (seconds.length ? seconds.join('、') : '全部正常') +
        '（体检只提示、不改字形；建议重写的可以在下面逐个剔除，或重扫那一页）'
      : '还没有可体检的字形',
    byChar
  }
}

/** 值不值得提示"这批整体还行"（界面上一句话总结用） */
export function isClean(report) {
  return !!report && report.summary && report.summary.clean === true
}
