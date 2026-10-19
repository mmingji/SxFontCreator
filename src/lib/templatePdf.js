// 模板与更正册 PDF 生成（阶段一步骤 1.3）
// 职责：把字表按版面参数排成可打印的 PDF —— 主区模板（参考字 + 书写格）与更正册（空白 + 格号）。
// 数据来源：字表来自 src/lib/charset.js（顺序即模板字序）；参考字字体由调用方传入字节 ——
//   界面固定传**内置楷体子集**（2026-10-11 起不再提供"选本机字体"：纸上印的那套参考字必须能被认出来，见决策 五-9）。
// 版式几何（页面 A4 横向、每行 17 格 / 1.6cm、每页 8 行、书写格 1cm、参考字楷体 14pt、线宽与表格居中）
//   实测自做字体网标准模板 V4.0（**历史来源，不是必须对齐的基准**，见《决策记录》一-1~一-4）；
//   其余为自研：四角定位块、底部条码与右侧方块（一-20）、参考字区域 1.02em 与逐字居中、田字格辅助线、
//   色值体系（#A6A6A6 / #D9D9D9 / #2E6E7E）、表格上方那行要点、右侧竖带最底端的可见页码（一-4、一-20）。
// 为什么用 pdf-lib：页面尺寸与每个格子的坐标完全可控，用户按 100% 打印即与设计一致（一-10）。
import { PDFDocument } from 'pdf-lib'
// pdf-lib 嵌入自定义字体（TTF + 子集化）必须先注册 fontkit；@pdf-lib/fontkit 是它配套的 fork。
// 注意是**实例方法**（pdf-lib 1.17 的 PDFDocument 上没有静态 registerFontkit）：每个文档创建后注册一次。
import fontkit from '@pdf-lib/fontkit'
import { getAllChars, charIndexMap } from './charset.js'
// 页级校验码抽在 lib/pageCode.js（零依赖纯函数）：识别端也要用同一个算法，若留在本文件里，
// 识别链路就会为了一个哈希函数把 pdf-lib（2.3MB）拖进首屏。这里 import 后在文件末尾再导出，保持既有引用不变
import { computePageCode, isBlankChar } from './pageCode.js'
import { payloadToRows, packBarcodePayload, KIND, encodeScopeField } from './pageBarcode.js'
import { CM, LAYOUT, cellRect, writingBoxRect, encodeSideBandBits, sideBandBlockRects, correctionPageNumber } from './layout.js'

// 版面常量（LAYOUT、格位换算、右侧方块）已抽到 lib/layout.js（零依赖）：切格模块要用这些常量，
// 但不能为此把 pdf-lib + fontkit（构建后约 1.16MB）拖进首屏 —— 与 computePageCode 抽到 lib/pageCode.js
// 是同一个理由。这里 import 后再导出，保持既有引用（测试、界面、切格模块）不变。
// 注意 `export { x } from './y'` 是再导出、不会在当前模块创建绑定，本文件内部要用就必须先 import（踩过这个坑）。
// computePageCode 一并再导出：它是"生成端印在右侧方块、识别端拿去自证"的同一个算法，调用方从这里取。
export { CM, LAYOUT, cellRect, writingBoxRect, computePageCode }

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

// 画一页的公共部分：四角定位块 + **底部条码** + **右侧方块**（《决策记录》一-20；旧"页脚 20 位横排"已删）
// input.pageCode：**本页校验码**（这一页那些字的 12 位指纹，见 lib/pageCode.js）——
//   主区字表页按这一页实际印的字算；更正册与打印自检页传 0（它们没有"这一页的字"，0 是专用值）
// input.payload：底部条码的整条码字（packBarcodePayload 的 bytes）—— 没有字序的件同样要印
//   （件类型 / 页号 / 档位 / 字数都在里面）
// input.visibleNumber：纸面**给人读**的页码（更正册两边各自从 1 起，与机器读的 128+ 不是一回事）
function drawRegisterMarks(page, input) {
  const { markSize, markOffset, pageWidth, pageHeight, markColor } = LAYOUT
  const corners = [
    { x: markOffset, y: markOffset },
    { x: pageWidth - markOffset - markSize, y: markOffset },
    { x: markOffset, y: pageHeight - markOffset - markSize },
    { x: pageWidth - markOffset - markSize, y: pageHeight - markOffset - markSize }
  ]
  for (const c of corners) {
    page.drawRectangle({ x: c.x, y: c.y, width: markSize, height: markSize, color: markColor })
  }
  if (input.payload) drawBarcode(page, input.payload)
  drawSideBand(page, {
    pageNumber: input.pageNumber,
    visibleNumber: input.visibleNumber,
    scopeField: input.scopeField || 0,
    pageCode: input.pageCode || 0,
    font: input.font || null
  })
}

// ── 底部条码与右侧方块（《决策记录》一-20；取代原来的"页脚 20 位横排"）────────────────────

/**
 * 画底部横向条码：把载荷按 LAYOUT.barcode 的网格画成模块矩形（深色 = 1）。
 * **连续暗模块合并成一个矩形**：逐个模块画会在相邻矩形之间留出抗锯齿浅缝，合并后既没有缝、也少画很多条。
 * 行 0 = 最上面那一行（与表格底边留约 0.67mm 间隙），与 payloadToRows 的位流顺序一致。
 * @param {object} page pdf-lib 的页面
 * @param {Uint8Array} bytes packBarcodePayload 的 bytes（整条码字，299 字节）
 * @returns {{x:number,y:number,width:number,height:number}[]} 实际画出的矩形（供测试核对几何）
 */
export function drawBarcode(page, bytes) {
  const B = LAYOUT.barcode
  const rows = payloadToRows(bytes, B)
  const rects = []
  for (let r = 0; r < rows.length; r++) {
    const y = B.top - (r + 1) * B.rowHeight
    let i = 0
    while (i < rows[r].length) {
      if (!rows[r][i]) {
        i++
        continue
      }
      let j = i
      while (j < rows[r].length && rows[r][j]) j++
      const rect = { x: B.left + i * B.module, y, width: (j - i) * B.module, height: B.rowHeight }
      rects.push(rect)
      page.drawRectangle({ ...rect, color: LAYOUT.markColor })
      i = j
    }
  }
  return rects
}

/**
 * 画右侧竖带：锚点（8pt 大方块）+ 24 个数据位方块（页号 8 / 档位 4 / 指纹 12）+ 最底端的可见页码。
 * **可见页码在最底端**是用户口径（一-20）：它是给人读的（更正册要按主区页码顺序写），机器读的三组方块
 *   从竖带顶端往下排、与它之间留白。
 * @param {object} page pdf-lib 的页面
 * @param {{pageNumber:number, scopeField:number, pageCode:number, font:object}} input
 * @returns {{anchor:object, bits:{x:number,y:number,size:number}[], bitsValue:number[]}} 供测试核对
 */
export function drawSideBand(page, input) {
  const S = LAYOUT.sideBand
  const bitsValue = encodeSideBandBits(input.pageNumber, input.scopeField || 0, input.pageCode || 0)
  const rects = sideBandBlockRects()
  const anchorRect = rects[0]
  page.drawRectangle({ ...anchorRect, color: LAYOUT.markColor })
  let bitIndex = 0
  const bits = []
  for (const rect of rects.slice(1)) {
    bits.push({ x: rect.x, y: rect.y, size: rect.width })
    if (bitsValue[bitIndex]) {
      page.drawRectangle({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: LAYOUT.markColor })
    }
    bitIndex++
  }
  // 可见页码：竖带最底端、紧贴表格底边之上，**右沿对齐定位块右边缘**（不居中）
  if (input.font) {
    const label = input.visibleNumber === undefined ? input.pageNumber : input.visibleNumber
    const text = String(label)
    const size = S.pageNumberSize
    const width = input.font.widthOfTextAtSize(text, size)
    page.drawText(text, {
      x: S.pageNumberRight - width,
      y: S.pageNumberBaselineY,
      size,
      font: input.font,
      color: LAYOUT.markColor
    })
  }
  return { anchor: anchorRect, bits, bitsValue }
}

/**
 * 右侧竖带最底端的**可见页码**（2026-10-15 用户口径；2026-10-18 挪到竖带最底端）。
 * 为什么要有它：右侧那串方块是给机器读的，人一眼看不出这一页是第几页；而写更正册时要按
 *   "主区页号的先后顺序"写圈出来的字（一-7 / 二-13），没有可见页码就只能靠人自己记 —— 顺序一乱，
 *   整册更正就全错位。所以纸面上必须有一个**人一眼能看懂的页码**。
 * 位置口径（2026-10-18 起，决策 一-20）：**表格右侧竖带的最底端**、紧贴表格底边之上 ——
 *   竖带上面依次是锚点与页号 / 档位 / 指纹三组方块，页码固定占最底下那一段（给人读的东西不跟机器抢位置）。
 *   原来它印在"右侧中间"，改用竖带之后挪到底端，与竖带里的方块拉开距离。
 * 颜色用 markColor（中深青 #2E6E7E）：与定位块同色，红圈识别（红度 R − max(G,B)）不会把它误判，
 *   灰度约 93 也远深于格线，扫描后看得清。
 */
function drawVisiblePageNumber(page, pageNumber, font) {
  const S = LAYOUT.sideBand
  const text = String(pageNumber)
  const size = S.pageNumberSize
  const width = font.widthOfTextAtSize(text, size)
  page.drawText(text, {
    x: S.pageNumberRight - width,
    y: S.pageNumberBaselineY,
    size,
    font,
    color: LAYOUT.markColor
  })
}

// 印在 PDF 上的所有文案集中在这里：**每个字符都必须落在字表 8274 字内**，
// 否则嵌入子集字体没有该字形，会印成方块（旧字表踩过三次：`·`、`%` 与 ASCII 空格 —— 换成官方字表 + 基础字符 169
// 之后这三样都在表内了，但约束本身不变：新文案仍要过测试里那条"逐字符核字表"的断言）。
// 表格上方那一行提示（**每页都印**）：把"打印 + 书写 + 扫描"的关键点压成一行 —— 打印设置（A4 彩打、
// 质量选高、不缩放、不勾无边距）、用笔（0.5mm 黑色中性笔）、写法（居中书写、别出格、不描不改）、纠错（写错用红笔
// 圈参考字）、纸张（防翘边折叠受潮）、扫描设置（照片模式、彩色、300dpi）。原来只在右侧方块左侧印一句打印要求，
// 位置偏、容量只有约 40 字（2026-10-03 按用户要求改到顶部，并删掉右侧方块那句 —— 同一件事不在纸上说两遍）。
// **写法的措辞迭代（每一次都是同一句话被读成了别的意思，或口径本身不够准）**：① "笔画最好顶着田字格"
// （易读成"要写出格"）→ ② "笔画别出田字格"（2026-10-04；装机实测发现字普遍写小、墨迹高度中位只有书写格的
// 81.6%，清单 一-5，而它只剩"别写出去"的意思）→ ③ "居中写满格子(笔画贴到格子边、别出格)"（2026-10-04，
// 一句话同时给出"写满"与"别出格"）→ ④ **"居中书写,别出格"（2026-10-07 用户定稿）**：用户指出"笔画少的字
// 总不能也写满"（如"日""一""小"，硬撑满反而难看、成字后大小不匀；参照做字体网的书写要求 —— 大部分字刚刚
// 触到格线为宜，本身小的字不顶格），所以**纸面只留"居中书写、别出格"这条普适规则**，"笔画多的字撑满格、
// 天生小的字居中写小"这层细则放到界面详细说明里分开讲（决策 一-4 ⑤）。
// **2026-10-07 两行 → 一行**：当天先按"加一句写错怎么标"拆成两行，随后用户给定稿文案并要求
//   **不换行**（纸面上就是一行），分隔符换成半角逗号 / 分号，一行内读起来更紧凑。原实测 8pt 下**宽 569.9pt**（85 字），
//   远小于两个上角定位块内边界之间的 785pt；数组形态保留（`drawHint` 支持多行，将来要拆随时可拆，
//   行距 1.35 倍字号）。字符经断言确认**全在字表内**（`PAGE_HINT` 仍导出 = 各行拼接，供整体判断用）。
// **2026-10-18 在"A4彩打"后面补一句"质量选高"**（用户口径；打印机驱动的质量档位 —— "标准 / 快速"
//   会把灰格线印浅）：现 **90 字、实测宽 604.7pt**（pdf-lib 现算），居中后两端各留 **83.2pt**，
//   仍远小于 785pt。界面上那三句提示与《使用说明》里的同一条已先落地（见 一-16 的 2026-10-18 补注）。
// **2026-10-18 "圈哪儿"反复了一次，最终维持"圈参考字"**（决策 二-12 ⑩）：当天先按"被红圈盖住的参考字
//   100% 认错"（实测见《提交历史》第 158 条）把文案改成"圈这一格"，随后用户改判回**圈参考字**，理由两条：
//   ① **更正册留空 = 保留主区原字形**（一-7 / 二-13），那一格的手写笔迹仍要用 —— 圈在书写格上会盖住
//      笔迹、影响成字效果；圈在参考字上损失的只是"认参考字"这一条**佐证**路径。
//   ② **字序不再依赖认参考字**（底部条码，一-18）：条码直接给出整页字序，被圈参考字认不出来的代价随之
//      消失；但"认参考字"这一步**不删** —— 它作为条码字序的佐证保留（与右侧方块里的指纹互相印证）。
//   所以这一行**一字未动**（与 2026-10-07 定稿一致），改动只落在文档与《使用说明》的解释上。
export const PAGE_HINT_LINES = [
  'A4彩打,质量选高,不缩放,不勾无边距;0.5mm黑色中性笔,居中书写,别出格,不描不改,写错用红笔圈参考字,防止纸张翘边,折叠,受潮;扫描用照片模式,图像类型彩色,300dpi。'
]
export const PAGE_HINT = PAGE_HINT_LINES.join('')

// 更正册顶部那一行（**只更正册印，模板不印**）：更正册是空白册，用户要自己按顺序写，
// 所以顶部必须把配对规则讲清楚 —— 三条压成一行：顺序重写 / 坏格红圈后补写 / 留空即不更正。
// 规则口径见《决策记录》一-6、一-7 与二-13（2026-10-04 拍板）：更正册主段第 k 格对应第 k 个被圈字，
// 留空的格表示"这个字保留主区原字形"，写坏的格用红笔圈掉后该字进补写队列、在册子后面按顺序补写。
// 注意：文案只能用字表内的字符（旧口径下半角空格、% 、/ 都不在表里、会印成方块，清单四-7 踩过三次；
//   换成官方字表 + 基础字符 169 之后它们都在表内了 —— 但断言保留，防止将来又写进表外的字）
export const CORRECTION_HINT = '按主区页码的顺序、每页按格子先后，把红笔圈出的字从第1格起每格写一个字；写坏的格用红笔圈掉，在后面按顺序补写；留空的格表示这个字不更正。'
export const SELF_CHECK_TEXTS = {
  title: '打印自检',
  boxLabel: '此处方框应为1cm',
  rulerLabel: '此处标尺应为10cm',
  lines: [
    '请用尺子量上面的方框与标尺',
    '尺寸不对，就检查打印设置：选实际大小，不要选适合页面，也不要勾无边距',
    '本页是自检页，不用于书写；正式书写页从第1页开始'
  ]
}

// 表格上方居中印一行提示：纸面上的提醒比界面提示更容易被看到（清单四-5）。
// 位置：与上排两个定位块同一水平带（定位块在左右两侧、这行居中，水平方向不会重叠），
//   基线取表格顶边上方 6pt，避免贴住表格；切格只取字位区域，不会干扰识别。
// 模板印书写与打印要点（PAGE_HINT）、更正册印它自己的配对规则（CORRECTION_HINT）——
//   两件事互不相干，所以按调用方传入的文案画，而不是写死一句话。
function drawHint(page, font, text) {
  // 支持多行（模板顶部当前是**一行**；2026-10-07 当天曾拆成两行、随后按用户定稿改回一行）：数组第一行画在最上面，行距 1.35 倍字号；
  // **最后一行仍落在表格顶边上方 6pt** —— 与原来单行时的位置一致，渲染断言的采样线不用改。
  const lines = Array.isArray(text) ? text : [text]
  const lineGap = LAYOUT.hintFontSize * 1.35
  lines.forEach((line, i) => {
    const width = font.widthOfTextAtSize(line, LAYOUT.hintFontSize)
    page.drawText(line, {
      x: (LAYOUT.pageWidth - width) / 2,
      y: LAYOUT.tableTop + 6 + (lines.length - 1 - i) * lineGap,
      size: LAYOUT.hintFontSize,
      font,
      color: LAYOUT.hintColor
    })
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

/**
 * 打印自检页（文末那一页）：1cm 标准方框 + 10cm 标尺 + 说明文字 —— 用户先打这页、拿尺子量，
 *   即可自证"打印缩放 = 100%"，在黑白银光 / 按"适合页面"打印这类错误浪费整套纸（全量 61 页）
 *   之前发现（决策记录 一-12）。
 * 它照样带四角定位块、底部条码与右侧方块（件类型 = 自检页），识别端因此不会把它当成字表页；
 *   **指纹固定传 0**：这一页没有字，0 是"没有字"的专用值（一-19）；条码载荷里 charCount = 0、无字序。
 */
function drawSelfCheckPage(page, pageNumber, font) {
  const { pageWidth, pageHeight, markColor, gridColor } = LAYOUT
  const centerX = pageWidth / 2
  drawRegisterMarks(page, {
    pageNumber,
    scopeField: 0,
    pageCode: 0, // 自检页没有"这一页的字"，指纹是专用值 0（决策 一-19）
    font,
    payload: packBarcodePayload({
      kind: KIND.selfCheck, scopeField: 0, pageNumber, charCount: 0, indexes: [], seg: null
    }).bytes
  })
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
// 字体解析不了（字节异常等）时返回 null，调用方退回典型外框（等价于共用一条基线）。
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
 * @param {string[]} [options.chars] 要排入模板的字符（默认全量 8274 字，按官方笔画序分页）
 * @param {ArrayBuffer|Uint8Array} options.fontBytes 参考字字体字节（TTF）
 * @param {boolean} [options.includeSelfCheck] 是否在文末附一页打印自检页（默认附）
 * @param {number} [options.startPage] 起始页号（默认 1）。**重写模板 / 补写模板**用它把页号接在现有纸之后 ——
 *   右侧方块编的是"第几页"，接着编才不会与已经写过的纸撞号（撞号会被当成同一页覆盖掉）
 * @param {number} [options.onlyPage] **只生成这一页**（绝对页号，1 起，`sheetPages+1` = 自检页）——
 *   第 1 步预览按需生成用；不传 = 整份。页码与右侧方块里的指纹照整份算，所以与下载件里的同一页逐格一致
 * @param {(done:number,total:number)=>void} [options.onProgress] 进度回调（按字表页）
 * @returns {Promise<{bytes:Uint8Array, pageCount:number, sheetPages:number, selfCheck:boolean, glyphCount:number, perPage:number, pageCodes:number[], onlyPage:number}>}
 *   onlyPage = 0 表示整份，否则是这次生成的那一页；单页时 pageCodes 只含那一页（自检页为 [0]）
 *   pageCodes 是**每一页各自的 12 位校验码**（这一页那些字的指纹，印在右侧方块里的 12 位）：
 *   识别端拿"猜出来的这一页的字"再算一遍比对，一致就说明页号与字序来源都对（决策 一-9 的 2026-10-15 修订）
 */
export async function buildTemplatePdf({
  chars, fontBytes, includeSelfCheck = true, startPage = 1, onlyPage, onProgress,
  scope = 'custom', orderMode = 'rank', seg = null
}) {
  const list = chars && chars.length ? chars : getAllChars()
  const perPage = LAYOUT.perPage
  const sheetPages = Math.max(1, Math.ceil(list.length / perPage))
  const selfCheck = includeSelfCheck !== false
  const pageCount = sheetPages + (selfCheck ? 1 : 0)
  // 条码要用的两件东西（决策 一-20）：**档位字段**（这一批纸来自哪一档、按什么序排）与**字表序号映射**
  //   （把"这一页是哪些字"写成 0~8273 的序号 —— 识别端凭它就能还原字序，不必认参考字）。
  const scopeField = encodeScopeField(scope, orderMode)
  const indexMap = charIndexMap()
  // **只生成一页**（2026-10-16 新增，第 1 步预览用；不传 = 整份，下载路径与既有测试的行为一个字不变）：
  //   传的是**绝对页号**（1 起，含自检页）。为什么要有它：预览一次只看一页，而整份生成在全量档要
  //   1.5 秒（书写示意还要 2.9 秒）—— 按需生成把"切档位等几秒"变成"等几十毫秒"。
  //   **页码与右侧方块里的指纹照整份算**（页号由 p 推、指纹由这一页的字算，都不依赖"这一份里画了几页"），
  //   所以预览里看到的那一页与下载件里的同一页逐格一致（test:template 比对同一页的指纹）。
  const only = Number.isFinite(onlyPage) ? Math.min(Math.max(1, Math.trunc(onlyPage)), pageCount) : 0

  const pdf = await PDFDocument.create()
  pdf.setTitle('SxFontCreator 手写模板')
  pdf.setCreator('SxFontCreator')
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(fontBytes, { subset: true })
  // 参考字外框表：让每个字在"参考字区域"里按自己的墨迹外形居中（解析失败时为 null，退回典型外框）
  const glyphBoxes = buildGlyphBoxTable(fontBytes)

  // 画一页字表页（第 p 页，0 起），返回这一页的右侧方块里的指纹
  const drawSheetPage = (p) => {
    const page = pdf.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight])
    // 这一页的字：**先切出来、再算指纹、再用它印参考字** —— 三处必须用同一份，
    // 否则"印在纸上的字"与"右侧方块里的指纹描述的字"就会不是一回事（识别端永远对不上）
    const slice = list.slice(p * perPage, (p + 1) * perPage)
    // **空白字符要当作"这一格没有字"**（2026-10-16 修）：字表里恰好有一个半角空格（基础字符 169 的第 1 个），
    //   它落在常用档第 48 页第 109 格、全量档第 60 页第 82 格。参考字字体给空格的是空字形 → 纸上没墨迹 →
    //   识别端判 empty 跳过；生成端若照算指纹，两端就对不上（实测 836 vs 1132）→ 那一页必然整页失败。
    //   **格位保留**（后面的字不前移）：页号 + 格号 → 字的映射与字序文件仍一一对应。
    const pageChars = slice.map((ch) => (isBlankChar(ch) ? null : ch))
    const printed = pageChars.filter((ch) => ch !== null)
    const pageCode = computePageCode(printed)
    // 底部条码：**整页字序**（这一页的字在字表里的序号）+ 件类型 / 页号 / 档位 / 字数（决策 一-20）。
    //   预置档位走"连续段"编码（只要 4 字节：全序 id + 起始 + 个数）；自定义档走升序 delta；
    //   兜底是定长 14 位 —— 三种都装得下（最坏 246 字节，数据区就是 246）。
    // **按格号排列、空白格写 -1**（条码里必须留下"哪几格是空的"：字表里那个半角空格落在两页的中间格，
    //   只存非空格的字会让识别端从那一格之后整页错位）
    const indexes = pageChars.map((ch) => (ch === null ? -1 : (indexMap.get(ch) ?? -1)))
    const packed = packBarcodePayload({
      kind: KIND.main,
      scopeField,
      pageNumber: startPage + p,
      charCount: indexes.length,
      indexes,
      seg: seg ? { fullOrderId: seg.fullOrderId, start: (seg.startIndex || 0) + p * perPage, count: indexes.length } : null
    })
    drawGrid(page)
    drawRegisterMarks(page, {
      pageNumber: startPage + p,
      scopeField,
      pageCode,
      font,
      payload: packed.bytes
    })
    drawHint(page, font, PAGE_HINT_LINES)
    for (let i = 0; i < pageChars.length; i++) {
      if (pageChars[i] === null) continue // 空白格：印出来什么都没有，跳过（指纹也把它排除了）
      drawReferenceChar(page, cellRect(i), pageChars[i], font, glyphBoxes)
    }
    return pageCode
  }

  const pageCodes = []
  if (only) {
    // 单页模式：只画请求的那一页（自检页 = sheetPages + 1，它的指纹是专用值 0）
    if (only > sheetPages) {
      if (selfCheck) drawSelfCheckPage(pdf.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]), sheetPages + 1, font)
      pageCodes.push(0)
    } else {
      pageCodes.push(drawSheetPage(only - 1))
    }
    if (onProgress) onProgress(1, 1)
  } else {
    for (let p = 0; p < sheetPages; p++) {
      pageCodes.push(drawSheetPage(p))
      if (onProgress) {
        onProgress(p + 1, sheetPages)
        // 让出一次主线程：否则生成整套纸（全量 61 页）时界面完全卡住，进度条也不会刷新
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
    // 自检页放文末：不打乱字表页的编号（第 n 页编码 n−1 保持成立）。
    // 它带上"页号 = 字表页数 + 1、指纹 = 0"这组标记，识别端据此判定"这不是字表页"（0 是专用值）
    if (selfCheck) drawSelfCheckPage(pdf.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]), sheetPages + 1, font)
  }

  const bytes = await pdf.save()
  return { bytes, pageCount, sheetPages, selfCheck, glyphCount: list.length, perPage, pageCodes, onlyPage: only }
}

/**
 * 生成更正册 PDF（空白册：只有书写格与格号，用于按顺序重写写错的字）
 * 格号跨页连续，便于人工核对"更正册第 k 格 → 主区哪个字"（决策记录 一-6、清单四-4）
 * 右侧方块里的页号用**更正册专用区间**（第 n 页编 128+n−1，见 layout.js 的 CORRECTION_PAGE_BASE），
 *   件类型因此靠页号区分、不再靠"校验码 0"；指纹一律 0（这一册没有"这一页的字"）。
 * **可见页码从 1 起、独立编号**（2026-10-15 用户确认）：更正册是另一本册子，页码接着主区编会让人
 *   以为"第 63 页"是模板的第 63 页；它自己的第 1 页就印 1。
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
    // 更正册：件类型 = correction、指纹 0（这一册没有"这一页的字"）+ 条码只带件类型 / 页号 / 档位；
    //   **可见页码从 1 起**（visibleNumber），与机器读的 128+ 是两套值（决策 一-20 / 八-20 ⑦）
    drawRegisterMarks(page, {
      pageNumber: correctionPageNumber(p + 1),
      visibleNumber: p + 1,
      scopeField: 0,
      pageCode: 0,
      font,
      payload: packBarcodePayload({
        kind: KIND.correction,
        scopeField: 0,
        pageNumber: correctionPageNumber(p + 1),
        charCount: 0,
        indexes: [],
        seg: null
      }).bytes
    })
    drawHint(page, font, CORRECTION_HINT)
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

// 书写示意页的绘制参数（导出给测试断言）。
// 这一页**不进正式模板 PDF**：只由界面在第 1 步与模板预览并排显示，让用户一眼看到"这个格子里应该写成什么样"
// （用户 2026-10-07 的要求：和模板一样的一页，只是每个书写格里已经用工整的手写体写好了那个字；
//   2026-10-08 由"填写示意"改名为"书写示意"，并改成跟着范围逐页生成）
export const SAMPLE_PAGE = {
  // 示范字的字号 = 书写格边长 × 1.0（即 1em = 格边长）。依据（2026-10-08 换官方字表后按 8105 个汉字复核，
  // 数值与旧表几乎一致 —— 新增的字里没有更大的）：墨迹外框中位高 0.888em / 宽 0.879em、p90 0.924 / 0.917、
  // 最大 0.977 / 0.972 —— 取 1em = 格边长时
  // **最大的字也不会出格**，而大部分字落在"刚刚触到格子线"附近，正是决策 一-13 的口径（笔画少的字自然不满格）。
  fontScale: 1,
  // 示范笔迹色：接近黑色中性笔。比参考字的 #A6A6A6 深得多，一眼分得清"印上去的参考字"与"写上去的示范字"
  inkColor: { type: 'RGB', red: 0.13, green: 0.13, blue: 0.13 }
}

// 在书写格里画一个示范手写字：字号统一（见 SAMPLE_PAGE.fontScale），位置按**该字自己的墨迹外框**居中 ——
// 与参考字的居中口径一致（决策 一-4 ①），这样"一"与"囊"都端坐在格心，笔画多的字自然贴近格边。
function drawSampleChar(page, cell, char, font, glyphBoxes) {
  const box = writingBoxRect(cell)
  const size = LAYOUT.writingBox * SAMPLE_PAGE.fontScale
  const centerX = box.x + box.width / 2
  const centerY = box.y + box.height / 2
  const gb = glyphBoxes ? glyphBoxes.get(char) : null
  const midY = gb
    ? (gb.top + gb.bottom) / 2
    : (LAYOUT.referenceTypicalTop + LAYOUT.referenceTypicalBottom) / 2
  const x = gb
    ? centerX - ((gb.left + gb.right) / 2) * size
    : centerX - font.widthOfTextAtSize(char, size) / 2
  page.drawText(char, {
    x,
    y: centerY - midY * size,
    size,
    font,
    color: SAMPLE_PAGE.inkColor
  })
}

/**
 * 生成"书写示意"PDF（仅界面预览用，**不进正式模板**）
 * 与模板**同版式**（同样的 17 × 8 字位、参考字、书写格与田字格），差别只有两处：
 *   ① 每个书写格里已经用工整手写体写好了那一格的字（示范"怎么写"）；
 *   ② **不画四角定位块与右侧方块标记** —— 它是给人看的，不是给机器认的，也避免被误当成可打印的模板。
 * @param {object} options
 * @param {string[]} [options.chars] 要排的字（按当前范围**逐页**生成，页数与模板一致）
 * @param {ArrayBuffer|Uint8Array} options.fontBytes 参考字字体字节（与模板同一字体）
 * @param {ArrayBuffer|Uint8Array} options.sampleFontBytes 示范手写体字节（内置悠哉字体子集）
 * @returns {Promise<{bytes:Uint8Array, pageCount:number, glyphCount:number, fontScale:number}>}
 */
export async function buildSamplePdf({ chars, fontBytes, sampleFontBytes, onlyPage, startPage = 1 }) {
  if (!sampleFontBytes) throw new Error('生成书写示意失败：没有手写示范字体')
  const list = chars && chars.length ? Array.from(chars) : getAllChars()
  // 按当前范围**逐页**生成（2026-10-07 用户拍板：与模板同页数、可翻页看）
  const pageCount = Math.max(1, Math.ceil(list.length / LAYOUT.perPage))
  // **只生成一页**（2026-10-16 新增，与 buildTemplatePdf 的 onlyPage 同一口径）：第 1 步预览按需生成用；
  //   不传 = 整份（原来的行为一个字不变）。示意页每格要画两次字（参考字 + 示范字），全量 61 页约 2.9 秒 ——
  //   预览一次只看一页，按需生成把这块也压到几十~几百毫秒。
  const only = Number.isFinite(onlyPage) ? Math.min(Math.max(1, Math.trunc(onlyPage)), pageCount) : 0

  const pdf = await PDFDocument.create()
  pdf.setTitle('SxFontCreator 书写示意')
  pdf.setCreator('SxFontCreator')
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(fontBytes, { subset: true })
  const sampleFont = await pdf.embedFont(sampleFontBytes, { subset: true })
  const glyphBoxes = buildGlyphBoxTable(fontBytes)
  const sampleBoxes = buildGlyphBoxTable(sampleFontBytes)

  const from0 = only ? only - 1 : 0
  const to0 = only ? only : pageCount
  for (let p = from0; p < Math.min(to0, pageCount); p++) {
    const page = pdf.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight])
    drawGrid(page)
    // **可见页码**（2026-10-16 用户要求）：与模板**同一画法、同一位置**（表格右侧竖带最底端、右沿对齐定位块右边缘、12pt、中深青），
    //   页号也是同一个（示意第 p 页 ↔ 模板第 p 页）—— 这样把示意页打印出来当字帖时能一页页对上模板。
    //   它与"右侧方块"是两回事：示意页**仍然不画定位块、不印右侧方块**，不参与识别（决策 一-14）。
    drawVisiblePageNumber(page, startPage + p, font)
    const from = p * LAYOUT.perPage
    const slice = list.slice(from, from + LAYOUT.perPage)
    for (let i = 0; i < slice.length; i++) {
      const cell = cellRect(i)
      drawReferenceChar(page, cell, slice[i], font, glyphBoxes)
      drawSampleChar(page, cell, slice[i], sampleFont, sampleBoxes)
    }
  }

  const bytes = await pdf.save()
  return { bytes, pageCount, glyphCount: list.length, fontScale: SAMPLE_PAGE.fontScale, onlyPage: only }
}

// 兼容旧名（调用方与测试都用 `buildSamplePagePdf`）：现在它生成的是**多页**示意，名字保留不再改，
// 免得同时改一堆引用；新代码用 `buildSamplePdf` 更贴切。
export const buildSamplePagePdf = buildSamplePdf
