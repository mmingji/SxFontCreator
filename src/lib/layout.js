// 版面契约（模板生成端与切格识别端共用的唯一真源）
// 职责：把"印在纸上的版面"写成常量与坐标函数 —— 页面尺寸、行列数、字位框 / 书写格 / 参考字区域、
//   四角定位块、页脚编码位宽与排布，以及"页内第 n 格在哪"的换算。
// 为什么单独一份、且**零依赖**：这两端（pdf-lib 生成 PDF、切格解码扫描件）必须逐字对得上
//   （《决策记录》一-9 的页脚编码契约）；而 templatePdf.js 依赖 pdf-lib + fontkit（构建后约 1.16MB），
//   切格模块不能为了几个常量把它拖进首屏 —— 与 computeBatchCode 抽到 lib/batchCode.js 是同一个理由。
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
  const cellWidth = 907 * TWIP // V4.0 实测：字位宽 1.6cm
  const writingBox = 567 * TWIP // V4.0 实测：书写格 1cm
  const referenceFontSize = 14 // V4.0 实测：参考字楷体 14pt
  const lineWidth = 4 * TWIP // V4.0 实测：边框 0.5pt
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

  // 页脚编码标记：一个锚点方块 + 20 个数据位方块（位置对应二进制位）
  // 20 位 = 低 8 位页号 + 高 12 位批次校验码（《决策记录》八-10 把一-9 原来的 8 位扩成了 20 位）：
  //   页号告诉识别端"这是第几页"；校验码**2026-10-11 起降为自校验**（决策 五-9 ⑥ / 六-14）——
  //   原来它当闸门（不符即整批拦下），现在批次是内部容器、字序由纸面参考字定位决定，
  //   识别出的字序算出的码与纸面码对不上**只提示复核**，不再拦批。位宽与排布不变。
  //   总宽 = 8pt 锚点 + 4pt 间隙 + 20×6pt 方块 + 19×5pt 间隔 = 227pt ≈ 8.01cm，
  //   A4 横向（可用宽 27.2cm）放得下，也不碰左右下角的定位块。
  const pageBits = 8
  const batchBits = 12
  const pageMark = {
    anchorSize: 8,
    bitSize: 6,
    bitGap: 5,
    anchorGap: 4,
    pageBits, // 低 8 位：页号
    batchBits, // 高 12 位：批次校验码
    bits: pageBits + batchBits,
    y: markOffset + 4 // 距纸边约 0.63cm，落在可打印区内
  }
  pageMark.totalWidth = pageMark.anchorSize + pageMark.anchorGap +
    pageMark.bits * pageMark.bitSize + (pageMark.bits - 1) * pageMark.bitGap
  pageMark.startX = (pageWidth - pageMark.totalWidth) / 2

  return {
    pageWidth, pageHeight, cols, rows,
    cellWidth, cellHeight, writingBox, referenceFontSize, lineWidth,
    referenceLineHeight, referenceTypicalTop, referenceTypicalBottom, blockHeight, blockBottom,
    referenceAreaSize, referenceAreaBottom, gapTop, gapMid, gapBottom,
    tableWidth, tableLeft, tableTop, tableBottom,
    markSize, markOffset, pageMark,
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
    // #2E6E7E 中深青：定位块与页码标记用它，替代原来的纯黑 ——
    // ① 红度 R − max(G,B) = −80（负值），不会被红圈识别误判；② 灰度约 93，灰度扫描下仍远深于格线（166）
    markColor: rgb(0.18, 0.431, 0.494)
  }
})()

// 页脚编码 → 20 位数组（bit0 在最左，与印在纸上的方块排布顺序一致）
// 前 8 位是页号（第 n 页编码 n−1，保证第 1 页也有标记，支持 256 页），后 12 位是批次校验码。
// **这是模板生成与切格识别之间的契约**：解码端（gridDetector.decodeFooterCode）按同样顺序读位；
// 改这里就必须同步改解码端（《决策记录》一-9、八-10）。
export function encodePageCode(pageNumber, batchCode = 0) {
  const { pageBits, batchBits } = LAYOUT.pageMark
  const page = Math.max(0, Math.min((1 << pageBits) - 1, (pageNumber | 0) - 1))
  const batch = Math.max(0, Math.min((1 << batchBits) - 1, batchCode | 0))
  const bits = []
  for (let i = 0; i < pageBits; i++) bits.push((page >> i) & 1)
  for (let i = 0; i < batchBits; i++) bits.push((batch >> i) & 1)
  return bits
}

// encodePageCode 的逆：把 20 位读回页号与批次校验码（切格解码端用，与上面严格对称）
export function decodePageBits(bits) {
  const { pageBits, batchBits } = LAYOUT.pageMark
  let page = 0
  for (let i = 0; i < pageBits; i++) if (bits[i]) page |= 1 << i
  let batch = 0
  for (let i = 0; i < batchBits; i++) if (bits[pageBits + i]) batch |= 1 << i
  return { pageNumber: page + 1, batchCode: batch }
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
