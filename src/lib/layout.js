// 版面契约（模板生成端与切格识别端共用的唯一真源）
// 职责：把"印在纸上的版面"写成常量与坐标函数 —— 页面尺寸、行列数、字位框 / 书写格 / 参考字区域、
//   四角定位块、页脚编码位宽与排布，以及"页内第 n 格在哪"的换算。
// 为什么单独一份、且**零依赖**：这两端（pdf-lib 生成 PDF、切格解码扫描件）必须逐字对得上
//   （《决策记录》一-9 的页脚编码契约）；而 templatePdf.js 依赖 pdf-lib + fontkit（构建后约 1.16MB），
//   切格模块不能为了几个常量把它拖进首屏 —— 与 computePageCode 抽到 lib/pageCode.js 是同一个理由。
// 注意：下面全是"取值型参数"（颜色、尺寸、行列数、页脚编码位宽）。**改任何一个值，都要全文搜索旧值并同步
//   文档**（本项目规则见《决策记录》六-8），五处参数位置：① 本文件；② 《决策记录》一-3 / 一-4 / 一-9；
//   ③ 《实施计划》步骤 1.3 的"关键参数"与步骤 1.5 的切格参数；④ 《需求与技术方案》5.1 / 5.4；
//   ⑤ 《待办与风险清单》四-6 / 四-8 与《打印实测记录表》表一 / 表二。
//   旧值的**同义说法也要搜**（如把纯黑改中深青后，`#000000`、纯黑、黑色、黑方块都要搜）。
//   为什么写这条：曾发生定位块改色后三份文档仍写"黑方块"，照旧文档实现就会印成黑色。

export const CM = 28.3464567 // 1cm = 28.3465pt
export const TWIP = 1 / 20 // Word 的 twip：1/20 pt

// 与 pdf-lib 的 rgb() 同构的颜色对象（{ type:'RGB', red, green, blue }）。
// 自己写一份的理由同上：这份文件不能 import pdf-lib。传回 pdf-lib 的 drawRectangle 可直接用。
const rgb = (red, green, blue) => ({ type: 'RGB', red, green, blue })

export const LAYOUT = (() => {
  const pageWidth = 29.7 * CM // A4 横向
  const pageHeight = 21 * CM
  const cols = 17
  const rows = 8
  const cellWidth = 907 * TWIP // V4.0 模板实测：字位宽 1.6cm（历史来源，见《决策记录》一-1）
  const writingBox = 567 * TWIP // V4.0 模板实测：书写格 1cm（同上）
  const referenceFontSize = 14 // V4.0 模板实测：参考字楷体 14pt（同上）
  const lineWidth = 4 * TWIP // V4.0 模板实测：边框 0.5pt（同上）
  const tableWidth = cols * cellWidth
  const tableLeft = (pageWidth - tableWidth) / 2 // 表格居中（与 V4.0 的 jc=center 一致）

  // 四角定位块：0.5cm 见方，距纸边 0.5cm（打印机的不可打印区通常 3~5mm，必须留够）
  const markSize = 0.5 * CM
  const markOffset = 0.5 * CM
  const gap = 2 // 定位块与表格之间的间隙
  // 上下边距由定位块决定（V4.0 的 0.8cm 上下边距放不下定位块，这里按需要放大）
  const tableTop = pageHeight - (markOffset + markSize + gap)
  const tableBottom = markOffset + markSize + gap
  const cellHeight = (tableTop - tableBottom) / rows // 8 行铺满可用高度

  // 参考字区域：**边长 = 参考字的最大外形尺寸**，做成一个正方形区域，每个参考字在区域内**居中展示**
  // （逐字按各自的墨迹外框居中，见 templatePdf 的 referenceBaselineY / drawReferenceChar）。2026-10-03 用户规则。
  // 1.02em 来自实测：遍历字表 8105 个汉字（霞鹜文楷子集），最大墨迹宽 0.988em、最高上缘 0.845em、
  //   最低下缘 -0.146em，跨度 1.021em（14pt 下约 5.04mm）。换用外框更大的字体时这个比值要跟着调。
  //   **2026-10-08 换官方字表后复核**：字表由 6919 涨到 8274 字（汉字 8105），最大宽与最高上缘都没变、
  //   下缘由 -0.176em 收到 -0.146em —— 口径不用改，实测数据按新表更新。
  const referenceAreaRatio = 1.02
  const referenceAreaSize = referenceAreaRatio * referenceFontSize
  // 三段留白（外框顶↔参考字区域 / 区域↔书写格 / 书写格↔外框底）按 **4 : 2 : 4** 分配（用户指定）；
  // 注意"上/下"同为 4 份，所以「参考字区域 + 书写格」这个整块在字位内仍然垂直居中。
  const gapTopUnits = 4
  const gapMidUnits = 2
  const gapBottomUnits = 4
  const gapUnits = gapTopUnits + gapMidUnits + gapBottomUnits
  const freeSpace = cellHeight - referenceAreaSize - writingBox
  const gapTop = (freeSpace * gapTopUnits) / gapUnits
  const gapMid = (freeSpace * gapMidUnits) / gapUnits
  const gapBottom = (freeSpace * gapBottomUnits) / gapUnits
  const blockBottom = gapBottom // 书写格底边距字位底
  const referenceAreaBottom = gapBottom + writingBox + gapMid // 参考字区域底边距字位底
  // 典型外框（em）：字体外框解析不出来时的退路（此时所有参考字等价于共用一条基线）
  const referenceTypicalTop = 0.8
  const referenceTypicalBottom = -0.09
  const referenceLineHeight = referenceAreaSize // = 参考字区域高度（供测试与文档引用）
  const blockHeight = referenceLineHeight + writingBox

  // ── 底部横向条码 + 右侧竖带（2026-10-18 用户拍板，决策 一-20）────────────────────────
  // **取代**原来的"页脚 20 位横排"（旧 `pageMark` 与那 20 位的编解码已按用户口径**整块删除**）：
  //   旧格式直接抛弃、识别端不读旧格式，所以代码里没有兼容分支。
  // 版式参数（2026-10-18 定稿，依据都写在《决策记录》一-18 里）：
  //   · 模块 **0.42mm** —— 第 158 条实测的"抗模糊 + 噪声"下限（更小的模块在扫描件上会糊成一片）；
  //   · 行高 = **3 × 模块**（PDF417 一类的惯例）：行太扁会在垂直方向串扰，行太高则排不下；
  //   · **4 行**、**宽 26cm** —— 上边界紧贴表格底边，下边界距纸边 **5.67mm**（比下角定位块的 5mm 更宽裕，
  //     避开打印机 3~5mm 的不可打印区）；宽度两端各留约 8.5mm 静区，不碰左右下角定位块；
  //   · 每行 = 起始图案 8 + 行号 4 + 数据 599 + 结束图案 8 = 619 模块 → 数据位 2396 位 = **299 字节**；
  //   · 载荷与纠错的分法见 lib/pageBarcode.js（头部 4 字节 + 字序载荷 + 里德-所罗门纠错）。
  const barcode = (() => {
    const module = (0.42 * CM) / 10 // 0.42mm
    const rowHeight = module * 3 // 1.26mm
    const rowCount = 4
    const width = 26 * CM
    const startModules = 8 // 每行起始图案：宽窄交替的同步条，解码时用来定模块相位
    const rowIndexModules = 4 // 行号（4 位，够 16 行）—— 行序错了要能发现，不能靠"读到的顺序"
    const stopModules = 8 // 每行结束图案
    const modulesPerRow = Math.floor(width / module) // 619
    const dataModulesPerRow = modulesPerRow - startModules - rowIndexModules - stopModules // 599
    const height = rowCount * rowHeight
    // GF(256) 上的 RS 码字**最长 255 字节**，299 字节一块装不下 —— 必须切成两块（第一版把整条当一个码字解，
    //   纠错全失败）。两块各自"数据 + 纠错"，数据区上限 246 字节（= 123 × 2），不足补 0：
    //   这样**解码端不需要任何外部信息就能分块**（若把"数据长度"当作分块依据，会陷入"长度本身也要保护"的循环）。
    const blocks = [
      { dataBytes: 123, parityBytes: 27 },
      { dataBytes: 123, parityBytes: 26 }
    ]
    return {
      module, rowHeight, rowCount, width, height,
      startModules, rowIndexModules, stopModules, modulesPerRow, dataModulesPerRow,
      dataBits: dataModulesPerRow * rowCount, // 2396 位
      totalBytes: Math.floor((dataModulesPerRow * rowCount) / 8), // 299 字节（整条码字）
      blocks,
      dataBytes: blocks.reduce((sum, b) => sum + b.dataBytes, 0), // 246 字节（数据区上限）
      // **底端与底部定位块的底端对齐**（都距纸边 0.5cm = 用户 2026-10-18 口径）：条码顶端因此自然上移，
      //   与表格那条横线之间留出约 1.9pt 的间隙 —— 既让版面看起来整齐，也让识别端不必担心
      //   "条码上边界紧贴表格线"（原来上边界被表格线污染，粗定位只能走下边界；现在两条边都干净）。
      //   条码高度不变（4 行 × 3 × 0.42mm ≈ 14.3pt），底端 = markOffset、顶端 = markOffset + height。
      bottom: markOffset,
      top: markOffset + height,
      left: (pageWidth - width) / 2,
      right: (pageWidth + width) / 2
    }
  })()

  // 右侧竖带（表格右边 → 纸右边，宽约 12.5mm）：**给人看的可见页码在最底端**，其余位置给机器读的方块。
  //   排列（从表格顶端往下）：**锚点 1 → 页号 8 → 档位 4 → 指纹 12**（共 25 个方块）——
  //   锚点（8pt 大方块）是这一竖排的起点基准，与旧页脚那个锚点同一个作用；
  //   页号 / 档位 / 指纹三组都**沿用原来的位宽与语义**（页号：主区 n、更正册 128+n−1；指纹：本页那些字的
  //   FNV-1a 低 12 位，见 lib/pageCode.js），只是从"底部横排"挪到了"右侧竖排"。
  //   为什么可见页码还在竖带里（而不是挪走）：它是给人读的（更正册要按主区页码顺序写，一-20 ⑦），
  //   机器读的三组方块反而要避开它 —— 所以页码固定占最底端，方块从顶端往下排、中间留白。
  const sideBand = (() => {
    const blockSize = 6
    const gap = 5
    const anchorSize = 8
    const pageBits = 8
    const scopeBits = 4
    const codeBits = 12
    const parts = [
      { key: 'anchor', label: '锚点', count: 1, size: anchorSize },
      { key: 'page', label: '页号', count: pageBits, size: blockSize },
      { key: 'scope', label: '档位', count: scopeBits, size: blockSize },
      { key: 'code', label: '指纹', count: codeBits, size: blockSize }
    ]
    const bandLeft = tableLeft + tableWidth
    const bandWidth = pageWidth - bandLeft
    // **方块的最右侧与右侧定位块的右边缘对齐**（2026-10-18 用户口径）：两者都落在 pageWidth − markOffset。
    //   原来是"方块在空白带里居中"，结果比定位块少半个方块宽、看着参差；右对齐之后一列方块、可见页码、
    //   四角定位块共用同一条竖直基准线。
    const x = pageWidth - markOffset - blockSize
    // 锚点比数据位方块大（8pt vs 6pt），**必须单独算 x**：若沿用同一个左边缘，它的右沿会越过
    //   定位块右边缘 2pt（2026-10-19 用户对着渲染图指出来的）。锚点同样右沿对齐。
    const anchorX = pageWidth - markOffset - anchorSize
    let cursor = tableTop
    const laid = parts.map((p) => {
      const top = cursor
      const height = p.count * p.size + (p.count - 1) * gap
      cursor = top - height - gap // 组与组之间也留一个 gap
      return { ...p, top, height }
    })
    return {
      blockSize, gap, anchorSize, pageBits, scopeBits, codeBits,
      dataBits: pageBits + scopeBits + codeBits,
      blocks: 1 + pageBits + scopeBits + codeBits,
      bandLeft, bandWidth, x, anchorX, parts: laid,
      stackHeight: tableTop - cursor,
      // 可见页码（12pt 数字）：竖带**最底端**、紧贴表格底边之上
      pageNumberSize: 12,
      pageNumberBaselineY: tableBottom + 6,
      // 页码**右对齐**到同一条基准线（= 定位块右边缘）：数字位数变多时向左扩展，
      // 右边沿永远不越过定位块的右边缘（用户口径："页码数字在最宽状态的右侧也不会超出定位块的右边沿"）
      pageNumberRight: pageWidth - markOffset,
    }
  })()

  return {
    pageWidth, pageHeight, cols, rows,
    cellWidth, cellHeight, writingBox, referenceFontSize, lineWidth,
    referenceLineHeight, referenceTypicalTop, referenceTypicalBottom, blockHeight, blockBottom,
    referenceAreaSize, referenceAreaBottom, gapTop, gapMid, gapBottom,
    tableWidth, tableLeft, tableTop, tableBottom,
    markSize, markOffset,
    barcode, sideBand,
    perPage: cols * rows,
    // 书写格内的十字辅助线（田字格）：极淡虚线，只做书写参考；识别时按灰度滤掉（笔迹是黑的，优先级最高）
    crossGuide: true,
    crossLineWidth: 0.4,
    // 颜色
    // #A6A6A6：字位框、书写格、参考字（三者共用）。2026-10-03 打印实测反馈"参考字与格线都偏浅、
    //   照着写略吃力"，由 #BFBFBF 调深一档；扫描件里格线与参考字本就很浅，调深一档后仍远浅于
    //   黑 / 蓝黑笔迹（灰度约 166 对笔迹约 60~90）。**注意**：调深到 166 后它已经比平板件的 Otsu
    //   阈值（实测 174）更暗，会进 Otsu 二值图 —— 所以切格的标记检测改用固定阈值（见 gridDetector.js）。
    gridColor: rgb(0.651, 0.651, 0.651),
    crossColor: rgb(0.851, 0.851, 0.851), // #D9D9D9：十字辅助线，比格线更淡
    // #808080 中灰：表格上方那行书写与打印要求 —— 比格线（166）深、比笔迹（60~90）浅，
    //   纸面上看得见又不抢眼。8pt 是"看得清又不占地方"的折中（需求里的最小字号约束针对界面，纸面另计）
    hintColor: rgb(0.502, 0.502, 0.502),
    hintFontSize: 8,
    // 可见页码（2026-10-15 用户口径，2026-10-18 挪位）：只印数字、12pt、用 markColor（中深青）——
    //   写更正册要按主区页号的先后顺序写，纸面上没有一个人能看懂的页码就会写乱。
    //   位置与字号现在归 `sideBand.pageNumberSize` / `pageNumberBaselineY`（它固定占右侧竖带最底端），
    //   画法在 templatePdf 的 drawSideBand（模板 / 更正册 / 自检页）与 drawVisiblePageNumber（示意页）两处。
    // #2E6E7E 中深青：定位块与页码标记用它，替代原来的纯黑 ——
    // ① 红度 R − max(G,B) = −80（负值），不会被红圈识别误判；② 灰度约 93，灰度扫描下仍远深于格线（166）
    markColor: rgb(0.18, 0.431, 0.494)
  }
})()

// ── 右侧竖带的 24 位（不含锚点）：页号 8 + 档位 4 + 指纹 12（《决策记录》一-20）────────────
// **bit0 在最上**（紧挨锚点那个方块），往下依次是 bit1、bit2…… —— 与印在纸上的方块排布顺序一致，
// 也与旧页脚"bit0 在最左"是同一种写法（只是方向从"右"变成"下"）。
// 这是生成端（templatePdf.drawSideBand）与识别端采样之间的契约：改这里必须同步改解码端。
export function encodeSideBandBits(pageNumber, scopeField = 0, pageCode = 0) {
  const { pageBits, scopeBits, codeBits } = LAYOUT.sideBand
  const page = Math.max(0, Math.min((1 << pageBits) - 1, (pageNumber | 0) - 1))
  const scope = scopeField & 0xf
  const code = Math.max(0, Math.min((1 << codeBits) - 1, pageCode | 0))
  const bits = []
  for (let i = 0; i < pageBits; i++) bits.push((page >> i) & 1)
  for (let i = 0; i < scopeBits; i++) bits.push((scope >> i) & 1)
  for (let i = 0; i < codeBits; i++) bits.push((code >> i) & 1)
  return bits
}

// encodeSideBandBits 的逆（识别端采样之后调它；与上面严格对称）
export function decodeSideBandBits(bits) {
  const { pageBits, scopeBits, codeBits } = LAYOUT.sideBand
  let page = 0
  for (let i = 0; i < pageBits; i++) if (bits[i]) page |= 1 << i
  let scope = 0
  for (let i = 0; i < scopeBits; i++) if (bits[pageBits + i]) scope |= 1 << i
  let code = 0
  for (let i = 0; i < codeBits; i++) if (bits[pageBits + scopeBits + i]) code |= 1 << i
  return { pageNumber: page + 1, scopeField: scope, pageCode: code }
}

// 竖带里每个方块（锚点 + 24 位）在设计坐标（pt）下的矩形 —— **生成端画、识别端采样共用这一份**。
// 为什么抽出来：两处各写一遍排布公式，迟早会写歪（与 六-8"取值型参数集中"是同一条道理）。
// 顺序 = 印刷顺序 = 采样顺序：锚点 → 页号 8 → 档位 4 → 指纹 12，每组 bit0 在该组最上面。
export function sideBandBlockRects() {
  const S = LAYOUT.sideBand
  const parts = {}
  for (const p of S.parts) parts[p.key] = p
  const out = []
  const a = parts.anchor
  out.push({ key: 'anchor', index: 0, x: S.anchorX, y: a.top - a.size, width: a.size, height: a.size })
  for (const key of ['page', 'scope', 'code']) {
    const group = parts[key]
    for (let i = 0; i < group.count; i++) {
      out.push({
        key,
        index: i,
        x: S.x,
        y: group.top - (i + 1) * group.size - i * S.gap,
        width: group.size,
        height: group.size
      })
    }
  }
  return out
}

// ── 件的类型：靠页号区间区分，不靠校验码的特殊值（《决策记录》一-9 的 2026-10-15 修订，一-20 沿用）──
// 主区字表页的页号是 1~127（实际最多 62 页）；更正册从 128 起编 —— 这样：
//   · 高 12 位的指纹位一位都不用让出来（仍是完整的 12 位，碰撞率 1/4096）；
//   · "校验码 = 0" 这个特殊值腾出来表示**这一页没有字**（打印自检页），语义不再重叠。
export const CORRECTION_PAGE_BASE = 128

/** 更正册第 index 页（1 起）在页脚里编的页号 */
export function correctionPageNumber(index) {
  return CORRECTION_PAGE_BASE + Math.max(1, index | 0) - 1
}

/** 页脚读出的页号是不是更正册 */
export function isCorrectionPage(pageNumber) {
  return typeof pageNumber === 'number' && pageNumber >= CORRECTION_PAGE_BASE
}

/** 更正册页号 → 它是更正册的第几页（1 起；非更正册页号返回 0） */
export function correctionIndexOf(pageNumber) {
  return isCorrectionPage(pageNumber) ? pageNumber - CORRECTION_PAGE_BASE + 1 : 0
}

/**
 * 把"页脚原样读到的页号 + 本页校验码"解释成件的类型与人读页号。
 * **识别端只有这一处判定口径**（scanFlow 与 summarizeBatch 共用），避免两处各写一套：
 *   · 页号 ≥ 128 → 更正册第 (页号−127) 页；
 *   · 指纹 = 0  → 不是字表页（打印自检页 —— 它没有"这一页的字"，所以指纹是专用值 0）；
 *   · 其余      → 主区第 n 页。
 * @returns {{kind:'main'|'correction'|'notSheet'|'unknown', pageNumber:number|null}}
 */
export function classifyFooterPage(rawPageNumber, pageCode) {
  if (typeof rawPageNumber !== 'number') return { kind: 'unknown', pageNumber: null }
  if (isCorrectionPage(rawPageNumber)) return { kind: 'correction', pageNumber: correctionIndexOf(rawPageNumber) }
  if (!pageCode) return { kind: 'notSheet', pageNumber: rawPageNumber }
  return { kind: 'main', pageNumber: rawPageNumber }
}

// 某一页上第 index 个格子（从左到右、从上到下）的坐标；越界返回 null
export function cellRect(index) {
  if (index < 0 || index >= LAYOUT.perPage) return null
  const col = index % LAYOUT.cols
  const row = Math.floor(index / LAYOUT.cols)
  return {
    x: LAYOUT.tableLeft + col * LAYOUT.cellWidth,
    y: LAYOUT.tableTop - (row + 1) * LAYOUT.cellHeight,
    width: LAYOUT.cellWidth,
    height: LAYOUT.cellHeight
  }
}

// 字位内的书写格位置：水平居中；垂直方向上，「参考字区域 + 书写格」整体在字位内居中
// （V4.0 的实际排法是参考字紧贴书写格上方、整体居中，见《决策记录》一-4）
export function writingBoxRect(cell) {
  return {
    x: cell.x + (cell.width - LAYOUT.writingBox) / 2,
    y: cell.y + LAYOUT.blockBottom,
    width: LAYOUT.writingBox,
    height: LAYOUT.writingBox
  }
}
