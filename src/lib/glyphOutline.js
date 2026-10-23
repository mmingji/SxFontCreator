// 单个手写字形 → 设计框坐标的矢量轮廓（从 glyphBuilder.js 抽出，2026-10-23）。
//
// 为什么单独成一个模块：第 2 步「看格子」的放大格也要"掩膜 → 字形"（用户 2026-10-23 口径：
//   点开一格看字形效果，而不是像素化的掩膜）。而 `glyphBuilder.js` 顶部静态 import 了
//   `fonteditor-core`（只为 woff / woff2 编码与 @font-face），把它拉进第 2 步会让"识别"这一步
//   白白加载字体编码库。这里只依赖追踪与几何四个零依赖 / 轻量模块，浏览器与生成端可以共用。
//
// 口径与 `glyphBuilder.buildGlyphFont` 完全一致（同一处实现，不是"预览一套、成字另一套"）：
//   书写格 118 像素 → 设计框 1000×1000（横向 0~1000、纵向 −100~900），y 轴翻转；
//   越界按"只裁不放大"等比收缩；数字 / 拉丁字母按实际墨迹宽度给 advance（规则字体）。
import { maskToPathData } from './traceImage.js'
import { commandsToPathData, parsePathCommands, pathBBox } from './svgPath.js'
import { classifyChar } from './charset.js'
import { FONT_DEFAULTS, glyphMapping, mapBBoxToDesignBox } from './glyphGeometry.js'

/**
 * 单个字形：掩膜 → em 方格坐标的 path。
 * @param {{mask:Uint8Array,width:number,height:number,boxInSlice:object,char:string}} glyph
 *   mask 来自 1.6（1 = 手写笔迹），boxInSlice 是书写格在切片内的像素矩形（切格给的基准）
 * @param {object} [options] FONT_DEFAULTS 的子集（`alphamax` 由「轮廓」档位透传）
 * @returns {{empty:boolean,d:string,advanceWidth:number,clamped:boolean,bbox:object}}
 */
export async function buildGlyphPath({ mask, width, height, boxInSlice, char }, options = {}) {
  const opt = { ...FONT_DEFAULTS, ...options }
  // 数字 / 拉丁字母：**按字形实际宽度给 advance（比例字体）**，对照系统里的手写体：
  //   方正小楷数字 287~430、悠哉 539~718、飞波 376~766；固定全角 1000 太宽、固定半角 500
  //   又不能反映"写得宽 / 窄"。这里按墨迹宽度 + 左右各 0.05em，夹在 0.3~0.8em。
  //   汉字与中文标点仍是全角 1000。
  const isHalf = classifyChar(char) === 'halfwidth'
  let advanceWidth = opt.fullWidth
  const traced = await maskToPathData(mask, {
    width, height, turdsize: opt.turdsize, alphamax: opt.alphamax
  })
  if (traced.empty) return { empty: true, d: '', advanceWidth, clamped: false, bbox: null }

  // ① 按书写格线性映射：书写格（118 像素见方）→ **设计框**（横向 0~1000、竖向 −100~900；决策 四-2 / 四-4），
  //    y 轴同时翻转（图像向下 → 字体向上）。**不是**映射到 0~1000 的正方形 —— 越界判据、缩放与平移
  //    都按设计框算（见 glyphGeometry.mapBBoxToDesignBox 与本文件下面的收缩逻辑）。
  //    注意要**合并 potrace 自己的 transform**：它的 path 坐标是"像素 × 10"且 y 反向（见 traceImage 的说明），
  //    所以像素坐标 = (c·x + a, d·y + b)。漏掉这一步会让坐标差 10 倍、上下颠倒（实测踩到）。
  //    数字/字母也用全角映射（书写格 0~1000），字形保持用户写的位置，再按实际宽度定 advance。
  const bb = pathBBox(traced.cmds)
  const box = boxInSlice || { x: 0, y: 0, width, height } // 缺省退化成"整张切片都算书写格"（与 1.6 同口径）
  const tr = traced.transform || { a: 0, b: 0, c: 1, d: 1 }
  const mapping = glyphMapping({ boxInSlice: box, half: false, traceTransform: tr }, opt)
  const { scaleX, offsetX, scaleY, offsetY } = mapping
  const { mapped, box: designBox, outside, clampScale } = mapBBoxToDesignBox(bb, mapping, false)

  // ② 越界处理：**以"书写格映射出来的设计框"为界**（决策 四-2 ④、四-4），越出设计框的笔画按
  //    "只裁不放大"等比收缩并平移回框内。为什么界要用设计框、不用"0~1000 的 em 方格"：
  //    书写格底边落在基线下方 0.1em（glyphBottom = −100），按 0~1000 判会把**格内**那一段合法笔迹
  //    当成越界、把整个字上移 0.1em —— 破坏基线一致性（2026-10-04 实测：60/79 个字形被"处理"过，
  //    其中多数只是被平移、并非真的越界）。
  let k = 1
  let dx = 0
  let dy = 0
  if (outside) {
    k = clampScale
    const x0 = mapped.minX * k
    const x1 = mapped.maxX * k
    const yy0 = mapped.minY * k
    const yy1 = mapped.maxY * k
    if (x0 < designBox.left) dx = designBox.left - x0
    if (x1 + dx > designBox.right) dx = designBox.right - x1
    if (yy0 < designBox.bottom) dy = designBox.bottom - yy0
    if (yy1 + dy > designBox.top) dy = designBox.top - yy1
  }
  const baseD = commandsToPathData(traced.cmds, scaleX * k, scaleY * k, offsetX * k + dx, offsetY * k + dy)
  // 数字/字母：按墨迹宽度定 advance，并把字形左移到 0.05em 边距处
  let shift = 0
  if (isHalf) {
    const pre = pathBBox(parsePathCommands(baseD))
    const inkWidth = pre.maxX - pre.minX
    const pad = 50
    advanceWidth = Math.max(300, Math.min(800, Math.round(inkWidth + pad * 2)))
    shift = pad - pre.minX
  }
  const d = shift
    ? commandsToPathData(traced.cmds, scaleX * k, scaleY * k, offsetX * k + dx + shift, offsetY * k + dy)
    : baseD
  // 最终包围盒：解析回命令再算（供体检与测试断言；d 是自己生成的规范格式，解析成本可忽略）
  const bbox = pathBBox(parsePathCommands(d))
  return {
    empty: false,
    d,
    advanceWidth,
    clamped: outside,
    bbox,
    // 度量信息：原始包围盒与最终映射参数 —— 3.2 字形体检（越界 / 偏大偏小）要用，排查也靠它
    metrics: {
      rawBBox: bb,
      mappedBBox: mapped,
      scaleX, scaleY, offsetX, offsetY, clampScale: k, clampDx: dx, clampDy: dy,
      traceTransform: tr
    }
  }
}
