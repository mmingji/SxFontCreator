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

const CM = 28.3464567 // 1cm = 28.3465pt
const TWIP = 1 / 20 // Word 的 twip：1/20 pt

// 版面常量（导出给测试与切格模块共用；改这里就等于改印出来的版面）
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

  // 参考字所在区域的高度：沿用 V4.0 的固定行距 360 twips（18pt），
  // 「参考字区域 + 书写格」作为整体块在字位内垂直居中 —— 这也是 V4.0 的实际排法（一-4）
  const referenceLineHeight = 18
  const blockHeight = referenceLineHeight + writingBox
  const blockBottom = (cellHeight - blockHeight) / 2

  // 页脚页码编码标记：一个锚点方块 + 8 个数据位方块（位置对应二进制位）
  const pageMark = {
    anchorSize: 8,
    bitSize: 6,
    bitGap: 5,
    anchorGap: 4,
    bits: 8,
    y: markOffset + 4 // 距纸边约 0.63cm，落在可打印区内
  }
  pageMark.totalWidth = pageMark.anchorSize + pageMark.anchorGap +
    pageMark.bits * pageMark.bitSize + (pageMark.bits - 1) * pageMark.bitGap
  pageMark.startX = (pageWidth - pageMark.totalWidth) / 2

  return {
    pageWidth, pageHeight, cols, rows,
    cellWidth, cellHeight, writingBox, referenceFontSize, lineWidth,
    referenceLineHeight, blockHeight, blockBottom,
    tableWidth, tableLeft, tableTop, tableBottom,
    markSize, markOffset, pageMark,
    perPage: cols * rows,
    // 书写格内的十字辅助线（田字格）：极淡虚线，只做书写参考；识别时按灰度滤掉（笔迹是黑的，优先级最高）
    crossGuide: true,
    crossLineWidth: 0.4,
    // 颜色
    gridColor: rgb(0.749, 0.749, 0.749), // #BFBFBF：字位框、书写格、参考字
    crossColor: rgb(0.851, 0.851, 0.851), // #D9D9D9：十字辅助线，比格线更淡
    // #2E6E7E 中深青：定位块与页码标记用它，替代原来的纯黑 ——
    // ① 红度 R − max(G,B) = −80（负值），不会被红圈识别误判；② 灰度约 93，灰度扫描下仍远深于灰格线（191）
    markColor: rgb(0.18, 0.431, 0.494)
  }
})()

// 页码编码：第 n 页（从 1 开始）→ 8 位二进制（bit0 在最左），编码 n-1 以保证第 1 页也有标记
export function encodePageCode(pageNumber) {
  const value = Math.max(0, Math.min(255, (pageNumber | 0) - 1))
  const bits = []
  for (let i = 0; i < LAYOUT.pageMark.bits; i++) bits.push((value >> i) & 1)
  return bits
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

// 参考字的基线位置：在书写格上方那一段固定高度的区域里做视觉居中
// （汉字在字体里大致占 em 的 -0.12~0.88，视觉中心约在基线以上 0.38em）
export function referenceBaselineY(cell, fontSize = LAYOUT.referenceFontSize) {
  const box = writingBoxRect(cell)
  const centerY = box.y + box.height + LAYOUT.referenceLineHeight / 2
  return centerY - 0.38 * fontSize
}

// 画一页的公共部分：四角定位块 + 页脚页码编码标记
function drawRegisterMarks(page, pageNumber) {
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

  // 页码标记：锚点方块（识别时的基准）+ 8 个数据位方块（bit=1 才画）
  const bits = encodePageCode(pageNumber)
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

// 页脚左侧印一行极简打印要求：纸面上的提醒比界面提示更容易被看到（清单四-5），
// 位置避开左下定位块，字号 7pt（打印后约 2.5mm 高，可读且不干扰识别 —— 切格只取字位区域）。
// 注意：嵌入的参考字字体是"只含字表 6919 字"的子集，**这句话里的每个字符都必须在这 6919 字内**，
// 否则会印成方块（踩过一次：最初写的 '·' 与 '%' 都不在字表里）。测试里有对应断言兜住。
export const FOOTER_HINT = '彩色喷墨，按实际大小打印'

function drawPrintHint(page, font) {
  page.drawText(FOOTER_HINT, {
    x: LAYOUT.markOffset + LAYOUT.markSize + 10,
    y: LAYOUT.markOffset + 5,
    size: 7,
    font,
    color: LAYOUT.gridColor
  })
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

// 在字位里画参考字（水平居中、淡灰）
function drawReferenceChar(page, cell, char, font) {
  const size = LAYOUT.referenceFontSize
  const width = font.widthOfTextAtSize(char, size)
  page.drawText(char, {
    x: cell.x + (cell.width - width) / 2,
    y: referenceBaselineY(cell, size),
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
 * @param {(done:number,total:number)=>void} [options.onProgress] 进度回调（按页）
 * @returns {Promise<{bytes:Uint8Array, pageCount:number, glyphCount:number, perPage:number}>}
 */
export async function buildTemplatePdf({ chars, fontBytes, onProgress }) {
  const list = chars && chars.length ? chars : getAllChars()
  const perPage = LAYOUT.perPage
  const pageCount = Math.max(1, Math.ceil(list.length / perPage))

  const pdf = await PDFDocument.create()
  pdf.setTitle('SxFontCreator 手写模板')
  pdf.setCreator('SxFontCreator')
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(fontBytes, { subset: true })

  for (let p = 0; p < pageCount; p++) {
    const page = pdf.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight])
    drawGrid(page)
    drawRegisterMarks(page, p + 1)
    drawPrintHint(page, font)
    const slice = list.slice(p * perPage, (p + 1) * perPage)
    for (let i = 0; i < slice.length; i++) {
      drawReferenceChar(page, cellRect(i), slice[i], font)
    }
    if (onProgress) {
      onProgress(p + 1, pageCount)
      // 让出一次主线程：否则生成 51 页时界面完全卡住，进度条也不会刷新
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  const bytes = await pdf.save()
  return { bytes, pageCount, glyphCount: list.length, perPage }
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
    drawRegisterMarks(page, p + 1)
    drawPrintHint(page, font)
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
