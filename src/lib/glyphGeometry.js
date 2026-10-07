// 字形几何（零依赖）：书写格 → em 方格的映射常量与"按已知框定位"的换算。
// 为什么单独成一个模块：这两件事**构建期与体检都要用**，但体检（`glyphCheckup.js`）绝不能为此把
//   `glyphBuilder.js` 拖进来 —— 后者 import 了 `fonteditor-core`（浏览器里必须经打包器才能加载，
//   0.5MB 级），而体检本身只是"量尺寸"。所以版面常量与换算放这里，构建与体检都从它导入。
// 数据来源：`boxInSlice` 是切格（1.5）给的"书写格在切片内的像素矩形"（恒为 14 / 14 / 118 / 118，
//   决策 二-8 ④），它是"按书写格线性映射"的基准（决策 四-2 / 四-4）。

// 取色型/尺寸型参数：改这里要同步《决策记录》四-2 / 四-3 与《实施计划》1.9
export const FONT_DEFAULTS = {
  unitsPerEm: 1000, // em 方格
  glyphBox: 1000, // 书写格映射到的边长 = 1em（字面率 100%）
  glyphLeft: 0, // 占位框左边距：书写格左边落在 x = 0、右边落在 x = 1000
  glyphTop: 900, // 书写格顶边映射到 y = 900
  glyphBottom: -100, // 书写格底边映射到 y = -100（基线在格底上方 0.1em）
  fullWidth: 1000, // 汉字与中文标点的 advanceWidth
  halfWidth: 500, // 数字与拉丁字母的 advanceWidth
  turdsize: 2, // 透传给 potrace 的去噪点
  alphamax: 1
}

// 越界判定的容差（设计框单位）：半个单位，用来吸收取整误差
export const OUT_TOLERANCE = 0.5

/**
 * 书写格 → em 方格的换算参数（水平 / 垂直各一个缩放与偏移）。
 * @param {object} input
 * @param {object} input.boxInSlice 书写格在切片内的像素矩形 `{x,y,width,height}`
 * @param {boolean} input.half 是否半角字形（数字 / 拉丁字母，水平压一半收进 500 宽的格子，决策 四-3）
 * @param {object} [input.traceTransform] potrace 的 transform（像素坐标要合并它，见 traceImage 的说明）
 * @param {object} [options] FONT_DEFAULTS 的子集
 */
export function glyphMapping({ boxInSlice, half, traceTransform }, options = {}) {
  const opt = { ...FONT_DEFAULTS, ...options }
  const box = boxInSlice || { x: 0, y: 0, width: opt.glyphBox, height: opt.glyphBox }
  const tr = traceTransform || { a: 0, b: 0, c: 1, d: 1 }
  const sx = opt.glyphBox / box.width
  const sy = -opt.glyphBox / box.height // y 轴翻转：图像向下 → 字体向上
  const oxFull = (tr.a - box.x) * sx + opt.glyphLeft
  const oy = (tr.b - box.y) * sy + opt.glyphTop
  return {
    opt,
    box,
    // 半角：整个书写格 [0,1000] 压成 [0,500]（在各向同性的前提下等于 x·sx·0.5 + oxFull·0.5）
    scaleX: (half ? 0.5 : 1) * tr.c * sx,
    offsetX: half ? oxFull * 0.5 : oxFull,
    scaleY: tr.d * sy,
    offsetY: oy
  }
}

/**
 * 把某个包围盒按给定的映射参数换算到设计框，并顺带给出"越界多少"与"只裁不放大"的收缩系数。
 * `scaleY` 为负（y 轴翻转），所以返回的 min/max 已按数值大小归一，直接可与设计框比较。
 *
 * **越界量用"超出多少单位"而不是"布尔比较"**（2026-10-07 修）：写满整格时映射结果正好是
 * 0 / 1000 / 900 / −100，浮点尾差会让 `maxX > 1000 + 0.5` 之类的比较时真时假（实测出现过
 * `clampScale = 0.9999999999999999`，等于把"写满格"判成要缩小）。改成先算超出量、再用
 * `OUT_TOLERANCE` 判，比较只在确定的数量级上做。
 * @param {object} bb 像素坐标包围盒 `{minX,minY,maxX,maxY}`
 * @param {object} mapping `glyphMapping()` 的返回值
 * @param {boolean} half 是否半角
 * @returns {{mapped:object, box:object, outside:boolean, overflow:number, clampScale:number}}
 */
export function mapBBoxToDesignBox(bb, mapping, half) {
  const { opt, scaleX, offsetX, scaleY, offsetY } = mapping
  const x1 = bb.minX * scaleX + offsetX
  const x2 = bb.maxX * scaleX + offsetX
  const y1 = bb.minY * scaleY + offsetY
  const y2 = bb.maxY * scaleY + offsetY
  const mapped = {
    minX: Math.min(x1, x2),
    minY: Math.min(y1, y2),
    maxX: Math.max(x1, x2),
    maxY: Math.max(y1, y2)
  }
  const box = {
    left: half ? 0 : opt.glyphLeft,
    right: half ? opt.halfWidth : opt.glyphLeft + opt.glyphBox,
    bottom: opt.glyphBottom,
    top: opt.glyphTop
  }
  // 超出量（单位）：四向取最大；没超出时为 0（负数一律归零，便于调用方直接比较）
  const overflow = Math.max(
    0,
    box.left - mapped.minX,
    mapped.maxX - box.right,
    box.bottom - mapped.minY,
    mapped.maxY - box.top
  )
  const outside = overflow > OUT_TOLERANCE
  // 没越界时收缩系数恒为 1（**不要**无条件算比值：字比设计框小时那个比值会大于 1，
  // 而"只裁不放大"的含义是"最多 1"，写进 metrics 会被误读成放大过）
  let clampScale = 1
  if (outside) {
    const w = mapped.maxX - mapped.minX
    const h = mapped.maxY - mapped.minY
    const boxW = box.right - box.left
    const boxH = box.top - box.bottom
    clampScale = Math.min(1, boxW / Math.max(w, boxW), boxH / Math.max(h, boxH))
  }
  return { mapped, box, outside, overflow, clampScale }
}
