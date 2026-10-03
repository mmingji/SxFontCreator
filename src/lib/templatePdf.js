// 模板与更正册 PDF 生成（阶段一步骤 1.3）
// 职责：把字表按版面参数排成可打印的 PDF —— 主区模板（参考字 + 书写格）与更正册（空白 + 格号）。
// 数据来源：字表来自 src/lib/charset.js（顺序即模板字序）；参考字字体由调用方传入字节（内置子集或用户选的本机字体）。
// 版面依据：全部来自做字体网 V4.0 模板的实测（《决策记录》一-3、一-4）——A4 横向、每行 17 格（1.6cm）、
//   每页 8 行、书写格 1cm 灰色点线、参考字楷体 14pt、字位框灰色实线；另加自研的四角定位块与页脚页码编码标记（一-9）。
// 为什么用 pdf-lib：页面尺寸与每个格子的坐标完全可控，用户按 100% 打印即与设计一致（一-10）。
import { PDFDocument, rgb } from 'pdf-lib'
// pdf-lib 嵌入自定义字体（TTF + 子集化）必须先注册 fontkit；@pdf-lib/fontkit 是它配套的 fork。
// 注意是**实例方法**（pdf-lib 1.17 的 PDFDocument 上没有静态 registerFontkit）：每个文档创建后注册一次。
import fontkit from '@pdf-lib/fontkit'
import { getAllChars } from './charset.js'
// 批次校验码抽在 lib/batchCode.js（零依赖纯函数）：store 给批次记账时也用它，若留在本文件里，
// store 就会为了一个哈希函数把 pdf-lib（2.3MB）拖进首屏。这里 import 后在文件末尾再导出，保持既有引用不变
import { computeBatchCode } from './batchCode.js'

const CM = 28.3464567 // 1cm = 28.3465pt
const TWIP = 1 / 20 // Word 的 twip：1/20 pt

// 版面常量（导出给测试与切格模块共用；改这里就等于改印出来的版面）
// 注意：下面全是"取值型参数"（颜色、尺寸、行列数、页脚编码位宽）。**改任何一个值，都要全文搜索
//   旧值并同步文档**（本项目规则见《决策记录》六-8）：《决策记录》一-3 / 一-4 / 一-9、
//   《实施计划》步骤 1.3 关键参数、《需求与技术方案》5.1 / 5.4、《待办与风险清单》四-6 / 四-8、
//   《打印实测记录表》表一 / 表二。
//   旧值的**同义说法也要搜**（如把纯黑改中深青后，`#000000`、纯黑、黑色、黑方块都要搜）。
//   为什么写这条：曾发生定位块改色后三份文档仍写"黑方块"，照旧文档实现就会印成黑色。
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
  // （逐字按各自的墨迹外框居中，见 referenceBaselineY / drawReferenceChar）。2026-10-03 用户规则。
  // 1.02em 来自实测：遍历字表 6919 字，最大墨迹宽 0.988em、最高上缘 0.845em、最低下缘 -0.176em，
  //   跨度 1.021em（14pt 下约 5.04mm）。换用外框更大的字体时这个比值要跟着调。
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
  //   页号告诉切格端"这是第几页"，校验码告诉切格端"这批扫描件是不是当前选字清单生成的模板"，
  //   不符即整批拦下。总宽 = 8pt 锚点 + 4pt 间隙 + 20×6pt 方块 + 19×5pt 间隔 = 227pt ≈ 8.01cm，
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
    //   黑/蓝黑笔迹（灰度约 166 对笔迹约 60~90），字形提取的分离余量不受影响。
    gridColor: rgb(0.651, 0.651, 0.651),
    crossColor: rgb(0.851, 0.851, 0.851), // #D9D9D9：十字辅助线，比格线更淡
    // #808080 中灰：表格上方那行书写与打印要求 —— 比格线（166）深、比笔迹（60~90）浅，
    //   纸面上看得见又不抢眼。8pt 是"看得清又不占地方"的折中（需求里的最小字号约束针对界面，纸面另计）
    hintColor: rgb(0.502, 0.502, 0.502),
    hintFontSize: 8,
    // #2E6E7E 中深青：定位块与页码标记用它，替代原来的纯黑 ——
    // ① 红度 R − max(G,B) = −80（负值），不会被红圈识别误判；② 灰度约 93，灰度扫描下仍远深于灰格线（166）
    markColor: rgb(0.18, 0.431, 0.494)
  }
})()

// 页脚编码 → 20 位数组（bit0 在最左，与印在纸上的方块排布顺序一致）
// 前 8 位是页号（第 n 页编码 n−1，保证第 1 页也有标记，支持 256 页），后 12 位是批次校验码。
// **这是模板生成与切格识别之间的契约**：解码端按同样顺序读位；改这里就必须同步改解码端（决策记录 一-9、八-10）
export function encodePageCode(pageNumber, batchCode = 0) {
  const { pageBits, batchBits } = LAYOUT.pageMark
  const page = Math.max(0, Math.min((1 << pageBits) - 1, (pageNumber | 0) - 1))
  const batch = Math.max(0, Math.min((1 << batchBits) - 1, batchCode | 0))
  const bits = []
  for (let i = 0; i < pageBits; i++) bits.push((page >> i) & 1)
  for (let i = 0; i < batchBits; i++) bits.push((batch >> i) & 1)
  return bits
}

// 批次校验码：实现见 lib/batchCode.js（本文件已 import，这里再导出以便调用方从一个地方取）
export { computeBatchCode }

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

// 参考字的基线：字在**参考字区域内居中** —— 按该字自己的墨迹外框（glyphBox）算，
// 所以不同字的基线会上下浮动（这正是"外形居中"的必然结果，2026-10-03 用户规则）。
// glyphBox 为 null（字体外框解析不出来）时退回典型外框，此时等价于所有字共用一条基线。
export function referenceBaselineY(cell, fontSize = LAYOUT.referenceFontSize, glyphBox = null) {
  const centerY = cell.y + LAYOUT.referenceAreaBottom + LAYOUT.referenceAreaSize / 2
  const mid = glyphBox
    ? (glyphBox.top + glyphBox.bottom) / 2
    : (LAYOUT.referenceTypicalTop + LAYOUT.referenceTypicalBottom) / 2
  return centerY - mid * fontSize
}

// 画一页的公共部分：四角定位块 + 页脚编码标记
// batchCode：该批次的校验码（低 12 位进页脚）；更正册这类还没有清单的产物传 0
function drawRegisterMarks(page, pageNumber, batchCode = 0) {
  const { markSize, markOffset, pageWidth, pageHeight, markColor, pageMark } = LAYOUT
  const corners = [
    { x: markOffset, y: markOffset },
    { x: pageWidth - markOffset - markSize, y: markOffset },
    { x: markOffset, y: pageHeight - markOffset - markSize },
    { x: pageWidth - markOffset - markSize, y: pageHeight - markOffset - markSize }
  ]
  for (const c of corners) {
    page.drawRectangle({ x: c.x, y: c.y, width: markSize, height: markSize, color: markColor })
  }

  // 编码标记：锚点方块（识别时的基准）+ 20 个数据位方块（bit=1 才画）
  const bits = encodePageCode(pageNumber, batchCode)
  const { anchorSize, bitSize, bitGap, anchorGap, y, startX } = pageMark
  page.drawRectangle({ x: startX, y, width: anchorSize, height: anchorSize, color: markColor })
  const bitsStart = startX + anchorSize + anchorGap
  for (let i = 0; i < bits.length; i++) {
    if (!bits[i]) continue
    page.drawRectangle({
      x: bitsStart + i * (bitSize + bitGap),
      y,
      width: bitSize,
      height: bitSize,
      color: markColor
    })
  }
}

// 印在 PDF 上的所有文案集中在这里：**每个字符都必须落在字表 6919 字内**，
// 否则嵌入子集字体没有该字形，会印成方块（踩过两次：`·`、`%`，以及 ASCII 空格都不在字表里）。
// 中文与数字之间也不要加空格 —— 空格同样不在字表内。测试里有断言兜住。
// 表格上方那一行提示（**每页都印**）：把"扫描之前"的关键点压成一行 —— 打印设置、用笔、顶满格、
// 不描不改、压平纸。原来只在页脚左侧印一句打印要求，位置偏、容量只有约 40 字（2026-10-03 按用户要求
// 改为顶部一行、并删掉页脚那句，避免同一件事在纸上说两遍）。
export const PAGE_HINT = '按实际大小彩色打印、不勾无边框；建议用0.5mm黑色中性笔，居中书写，笔画最好顶着田字格、不描不改，防止纸张变形(翘边、折叠、受潮)'
export const SELF_CHECK_TEXTS = {
  title: '打印自检',
  boxLabel: '此处方框应为1cm',
  rulerLabel: '此处标尺应为10cm',
  lines: [
    '请用尺子量上面的方框与标尺',
    '尺寸不对，就检查打印设置：选实际大小，不要选适合页面，也不要勾无边框',
    '本页是自检页，不用于书写；正式书写页从第1页开始'
  ]
}

// 表格上方居中印一行书写与打印要求：纸面上的提醒比界面提示更容易被看到（清单四-5）。
// 位置：与上排两个定位块同一水平带（定位块在左右两侧、这行居中，水平方向不会重叠），
//   基线取表格顶边上方 6pt，避免贴住表格；切格只取字位区域，不会干扰识别。
function drawPageHint(page, font) {
  const width = font.widthOfTextAtSize(PAGE_HINT, LAYOUT.hintFontSize)
  page.drawText(PAGE_HINT, {
    x: (LAYOUT.pageWidth - width) / 2,
    y: LAYOUT.tableTop + 6,
    size: LAYOUT.hintFontSize,
    font,
    color: LAYOUT.hintColor
  })
}

// 自检页的尺寸常量（导出给测试断言 —— 这两个值就是用户拿尺子量的目标）
export const SELF_CHECK_LAYOUT = {
  boxSize: 1 * CM,
  rulerWidth: 10 * CM
}

// 画一行居中文本（自检页用；模板页的参考字有自己的定位逻辑）
function drawCenteredText(page, text, centerX, y, size, font, color) {
  const width = font.widthOfTextAtSize(text, size)
  page.drawText(text, { x: centerX - width / 2, y, size, font, color })
}

// 打印自检页：放在文末，用户拿尺子量方框与标尺即可自证"打印缩放 = 100%"，
// 黑白激光或按"适合页面"打印这类错误，能在浪费 51 页纸之前发现（决策记录 一-12）
function drawSelfCheckPage(page, pageNumber, font, batchCode = 0) {
  const { pageWidth, pageHeight, markColor, gridColor } = LAYOUT
  const centerX = pageWidth / 2
  drawRegisterMarks(page, pageNumber, batchCode)
  drawCenteredText(page, SELF_CHECK_TEXTS.title, centerX, pageHeight - 70, 18, font, markColor)

  // 1cm 标准方框
  const boxSize = SELF_CHECK_LAYOUT.boxSize
  const boxY = pageHeight - 240
  page.drawRectangle({
    x: centerX - boxSize / 2,
    y: boxY,
    width: boxSize,
    height: boxSize,
    borderColor: markColor,
    borderWidth: 0.8
  })
  drawCenteredText(page, SELF_CHECK_TEXTS.boxLabel, centerX, boxY - 24, 10, font, markColor)

  // 10cm 标尺：量更长的距离更准（1cm 方框只有 2.8pt 的容差，10cm 能放大误差）
  const rulerWidth = SELF_CHECK_LAYOUT.rulerWidth
  const rulerY = boxY - 110
  const left = centerX - rulerWidth / 2
  const right = centerX + rulerWidth / 2
  page.drawLine({ start: { x: left, y: rulerY }, end: { x: right, y: rulerY }, thickness: 0.8, color: markColor })
  page.drawLine({ start: { x: left, y: rulerY - 7 }, end: { x: left, y: rulerY + 7 }, thickness: 0.8, color: markColor })
  page.drawLine({ start: { x: right, y: rulerY - 7 }, end: { x: right, y: rulerY + 7 }, thickness: 0.8, color: markColor })
  drawCenteredText(page, SELF_CHECK_TEXTS.rulerLabel, centerX, rulerY - 24, 10, font, markColor)

  // 说明文字
  let y = rulerY - 80
  for (const line of SELF_CHECK_TEXTS.lines) {
    drawCenteredText(page, line, centerX, y, 10, font, gridColor)
    y -= 20
  }
}

// 画字位网格（灰色实线）+ 书写格（灰色点线）
function drawGrid(page) {
  const { gridColor, lineWidth } = LAYOUT
  for (let i = 0; i < LAYOUT.perPage; i++) {
    const cell = cellRect(i)
    page.drawRectangle({
      x: cell.x,
      y: cell.y,
      width: cell.width,
      height: cell.height,
      borderColor: gridColor,
      borderWidth: lineWidth
    })
    const box = writingBoxRect(cell)
    page.drawRectangle({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      borderColor: gridColor,
      borderWidth: lineWidth,
      borderDashArray: [1, 2] // 点线：与 V4.0 的 dotted 边框对应
    })
    // 十字辅助线（田字格）：帮用户把字写正、写满、大小一致；极淡虚线，扫描时按灰度滤掉
    if (LAYOUT.crossGuide) {
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      page.drawLine({
        start: { x: box.x, y: cy },
        end: { x: box.x + box.width, y: cy },
        thickness: LAYOUT.crossLineWidth,
        color: LAYOUT.crossColor,
        dashArray: [1, 2]
      })
      page.drawLine({
        start: { x: cx, y: box.y },
        end: { x: cx, y: box.y + box.height },
        thickness: LAYOUT.crossLineWidth,
        color: LAYOUT.crossColor,
        dashArray: [1, 2]
      })
    }
  }
}

// 参考字外框表：字符 → 墨迹四边（em 单位），供"把参考字放进参考字区域并居中"使用。
// 为什么需要：每个字的墨迹在 em 框里占的位置不同（"一"很扁、"囊"很满、拉丁字母还往下伸），
//   要做到"每个字都在同一块方形区域里视觉居中"，只能按各自的外框定位（2026-10-03 用户规则）。
// 字体解析不了（本机字体格式异常等）时返回 null，调用方退回典型外框（等价于共用一条基线）。
export function buildGlyphBoxTable(fontBytes) {
  try {
    const f = fontkit.create(fontBytes)
    const em = f.unitsPerEm || 1000
    const cache = new Map()
    return {
      get(ch) {
        let box = cache.get(ch)
        if (!box) {
          const g = f.glyphForCodePoint(ch.codePointAt(0))
          const b = g && g.bbox
          box = b && (b.maxX > b.minX || b.maxY > b.minY)
            ? { left: b.minX / em, right: b.maxX / em, top: b.maxY / em, bottom: b.minY / em }
            : { left: 0, right: 1, top: LAYOUT.referenceTypicalTop, bottom: LAYOUT.referenceTypicalBottom }
          cache.set(ch, box)
        }
        return box
      }
    }
  } catch {
    return null
  }
}

// 在字位里画参考字：放进"参考字区域"，按**墨迹外框**居中（水平也按外框，不是按 advance 宽度），
// 这样"一"与"囊"看起来都端坐在同一块方形区域的正中。
function drawReferenceChar(page, cell, char, font, glyphBoxes) {
  const size = LAYOUT.referenceFontSize
  const box = glyphBoxes ? glyphBoxes.get(char) : null
  const centerX = cell.x + cell.width / 2
  const x = box
    ? centerX - ((box.left + box.right) / 2) * size
    : centerX - font.widthOfTextAtSize(char, size) / 2
  page.drawText(char, {
    x,
    y: referenceBaselineY(cell, size, box),
    size,
    font,
    color: LAYOUT.gridColor
  })
}

/**
 * 生成主区模板 PDF
 * @param {object} options
 * @param {string[]} [options.chars] 要排入模板的字符（默认全量 6919 字，按字表顺序分页）
 * @param {ArrayBuffer|Uint8Array} options.fontBytes 参考字字体字节（TTF）
 * @param {boolean} [options.includeSelfCheck] 是否在文末附一页打印自检页（默认附）
 * @param {(done:number,total:number)=>void} [options.onProgress] 进度回调（按字表页）
 * @returns {Promise<{bytes:Uint8Array, pageCount:number, sheetPages:number, selfCheck:boolean, glyphCount:number, perPage:number, batchCode:number}>}
 *   batchCode 是这一批选字清单的 12 位校验码：它同时印在页脚，识别时用来发现"扫描件与所选批次不匹配"（决策记录 八-10）
 */
export async function buildTemplatePdf({ chars, fontBytes, includeSelfCheck = true, onProgress }) {
  const list = chars && chars.length ? chars : getAllChars()
  const perPage = LAYOUT.perPage
  const sheetPages = Math.max(1, Math.ceil(list.length / perPage))
  const selfCheck = includeSelfCheck !== false
  const pageCount = sheetPages + (selfCheck ? 1 : 0)
  // 校验码由"这一批要写的字"决定：改了选字清单，码就变，旧模板印出来的扫描件会被识别端拦下（八-9、八-10）
  const batchCode = computeBatchCode(list)

  const pdf = await PDFDocument.create()
  pdf.setTitle('SxFontCreator 手写模板')
  pdf.setCreator('SxFontCreator')
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(fontBytes, { subset: true })
  // 参考字外框表：让每个字在"参考字区域"里按自己的墨迹外形居中（解析失败时为 null，退回典型外框）
  const glyphBoxes = buildGlyphBoxTable(fontBytes)

  for (let p = 0; p < sheetPages; p++) {
    const page = pdf.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight])
    drawGrid(page)
    drawRegisterMarks(page, p + 1, batchCode)
    drawPageHint(page, font)
    const slice = list.slice(p * perPage, (p + 1) * perPage)
    for (let i = 0; i < slice.length; i++) {
      drawReferenceChar(page, cellRect(i), slice[i], font, glyphBoxes)
    }
    if (onProgress) {
      onProgress(p + 1, sheetPages)
      // 让出一次主线程：否则生成 51 页时界面完全卡住，进度条也不会刷新
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  // 自检页放文末：不打乱字表页的编号（第 n 页编码 n−1 保持成立，切格模块只需忽略超出字表页数的页）
  // 它属于同一份模板 PDF，所以带上同一批次校验码；页号超出字表页数，识别端据此判定"这不是字表页"
  if (selfCheck) drawSelfCheckPage(pdf.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]), sheetPages + 1, font, batchCode)

  const bytes = await pdf.save()
  return { bytes, pageCount, sheetPages, selfCheck, glyphCount: list.length, perPage, batchCode }
}

/**
 * 生成更正册 PDF（空白册：只有书写格与格号，用于按顺序重写写错的字）
 * 格号跨页连续，便于人工核对"更正册第 k 格 → 主区哪个字"（决策记录 一-6、清单四-4）
 * @param {object} options
 * @param {number} [options.pageCount] 页数（默认 5 页，够写 680 个错字）
 * @param {number} [options.startIndex] 起始格号（默认 1）
 * @param {ArrayBuffer|Uint8Array} options.fontBytes 字体字节（画格号用，与模板同一字体）
 * @param {(done:number,total:number)=>void} [options.onProgress]
 */
export async function buildCorrectionBookPdf({ pageCount = 5, startIndex = 1, fontBytes, onProgress }) {
  const pdf = await PDFDocument.create()
  pdf.setTitle('SxFontCreator 更正册')
  pdf.setCreator('SxFontCreator')
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(fontBytes, { subset: true })
  const numberSize = 8

  for (let p = 0; p < pageCount; p++) {
    const page = pdf.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight])
    drawGrid(page)
    // 更正册暂不带批次校验码（0）：它的字序要等红圈识别给出"被圈字清单"才确定，
    // 到那时才能算出属于它的校验码并在界面上与主区并排核对（决策记录 一-6、一-7）
    drawRegisterMarks(page, p + 1)
    drawPageHint(page, font)
    for (let i = 0; i < LAYOUT.perPage; i++) {
      const label = String(startIndex + p * LAYOUT.perPage + i)
      const cell = cellRect(i)
      const width = font.widthOfTextAtSize(label, numberSize)
      // 格号印在书写格上方的参考字位置（字位内），不压到书写区
      page.drawText(label, {
        x: cell.x + (cell.width - width) / 2,
        y: referenceBaselineY(cell, numberSize),
        size: numberSize,
        font,
        color: LAYOUT.gridColor
      })
    }
    if (onProgress) onProgress(p + 1, pageCount)
  }

  const bytes = await pdf.save()
  return { bytes, pageCount }
}
