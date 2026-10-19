// 扫描件预处理（阶段一步骤 1.4）
// 职责：把"用户交上来的图片"变成"后续步骤能用的三件东西" —— ① 去噪后的灰度图（字形提取用）
//   ② 二值图（切格找定位块、找红圈用）③ 输入质量评估与中文提示（避免用户在错的输入上白跑一遍）。
// 数据来源：图片来自用户上传（平板扫描 / 手机拍摄，决策 二-4 的四档输入）；尺寸、dpi 等元信息由像素推算。
// 与相邻模块的边界：算子全在 imageOps.js；**切格（1.5）、字形提取（1.6）、红圈识别（1.7）都不在这里做** ——
//   本模块只负责"把图弄干净、把问题早说出来"。
// 实测依据（2026-10-03 真实扫描件，3447 × 2419、300dpi 彩色 PNG）：
//   纸面灰度 247~250、Otsu 阈值 174、比纸暗的像素只占 3.4‰（笔迹 + 定位块 + 右侧方块）、
//   四角定位块 58×58 像素（正好 0.5cm@295dpi）、纸面噪点极少、光照 p90−p10 仅约 9。
//   → 结论：**平板扫描件走全局 Otsu 就够**（局部自适应反而会把淡格线一起判成前景），
//     局部自适应留给光照不均的手机拍摄件（决策 二-4 明确要求"用局部自适应，不用全局阈值"）。
// 内存口径：单页 300dpi 彩色解码后约 33MB（RGBA），灰度 8.3MB、二值 8.3MB —— 批量上传时必须
//   **逐页调用、用完即弃**，不要把整批预处理结果留在内存里（清单三-5 实测：全量 61 页约 400MB）。
import {
  adaptiveThreshold, globalThreshold, otsuThreshold, illuminationSpread, laplacianVariance,
  meanGray, medianFilter3, rgbaToGray, foregroundRatio
} from './imageOps.js'

// 预处理默认参数。改这些值等于改"喂给切格与提取的图长什么样"，注释里写明依据
export const PREPROCESS_DEFAULTS = {
  denoise: true, // 3×3 中值去噪：去纸面孤立小黑点，几乎不改变笔画粗细
  thresholdMode: 'auto', // auto = 按光照均匀度自动选 global / adaptive
  adaptiveBlock: 64, // 局部自适应的背景块大小（像素）：64 ≈ 5.4mm@300dpi，够平滑又跟得上光照变化
  adaptiveOffset: 12, // 比局部背景暗多少才算前景：太小会把纸纹判成墨，太大细笔画会断
  unevenThreshold: 60, // 光照 p90−p10 超过它就判定"光照不均"，改走局部自适应
  qualityBlock: 64, // 质量评估的分块大小
  pageAspect: 297 / 210, // A4 横向长宽比：用来判断"这是不是一整页"
  pageLongEdgeMm: 297 // A4 长边毫米数：把像素换算成等效 dpi
}

// 输入质量评估：只看"会不会影响后续步骤"的几件事，不做美观评价
export function assessQuality(gray, options = {}) {
  const opt = { ...PREPROCESS_DEFAULTS, ...options }
  const { width, height } = gray
  const longEdge = Math.max(width, height)
  const shortEdge = Math.min(width, height)
  const aspect = longEdge / shortEdge
  const spread = illuminationSpread(gray, opt.qualityBlock)
  const inkRatio = foregroundRatio(globalThreshold(gray, otsuThreshold(gray)))
  return {
    width,
    height,
    // 等效 dpi：按"这张图就是一整页 A4"折算。用户若裁过图，这个值只会偏大，不会偏小
    dpi: Math.round(longEdge / (opt.pageLongEdgeMm / 25.4)),
    aspect: +aspect.toFixed(3),
    aspectDeviation: +(Math.abs(aspect - opt.pageAspect) / opt.pageAspect).toFixed(3),
    meanGray: +meanGray(gray).toFixed(1),
    illuminationSpread: +spread.toFixed(1),
    sharpness: Math.round(laplacianVariance(gray)),
    inkRatio: +inkRatio.toFixed(5),
    unevenLight: spread > opt.unevenThreshold
  }
}

// 把评估结果翻成给用户看的中文提示（界面与上传模块直接用）
// 分三档：error = 必须重来；warn = 能继续但结果可能不好；info = 说明"我替你做了什么"
export function qualityMessages(quality) {
  const out = []
  if (quality.dpi < 150) {
    out.push({ level: 'error', text: '图片分辨率不足（约 ' + quality.dpi + 'dpi），字迹会糊成一团，请用 300dpi 重新扫描' })
  } else if (quality.dpi < 200) {
    out.push({ level: 'warn', text: '分辨率偏低（约 ' + quality.dpi + 'dpi），建议 300dpi 以上；细笔画可能断' })
  }
  if (quality.aspectDeviation > 0.12) {
    out.push({ level: 'warn', text: '这张图的长宽比（' + quality.aspect + '）与 A4 横向（1.414）差得多，可能不是完整一页；若是裁切过，请换整页扫描件' })
  }
  if (quality.inkRatio < 0.0008) {
    out.push({ level: 'error', text: '这一页几乎看不到笔迹，请确认没有扫错面、放反或拿错页' })
  }
  if (quality.meanGray < 180) {
    out.push({ level: 'warn', text: '整页偏暗（平均灰度 ' + quality.meanGray + '），可能是曝光不足或纸面有阴影' })
  }
  if (quality.unevenLight) {
    out.push({ level: 'info', text: '检测到光照不均（明暗差 ' + Math.round(quality.illuminationSpread) + '），已自动改用局部自适应阈值' })
  }
  if (quality.sharpness < 5) {
    out.push({ level: 'warn', text: '画面偏模糊，可能是没对焦或纸没压平；建议重拍或改用平板扫描' })
  }
  return out
}

// 二值化：按光照均匀度在"全局 Otsu"与"局部自适应"之间自动选，也可由调用方强制指定
export function binarize(gray, options = {}) {
  const opt = { ...PREPROCESS_DEFAULTS, ...options }
  const otsu = otsuThreshold(gray)
  const spread = illuminationSpread(gray, opt.qualityBlock)
  const mode = opt.thresholdMode === 'auto'
    ? (spread > opt.unevenThreshold ? 'adaptive' : 'global')
    : opt.thresholdMode

  if (mode === 'adaptive') {
    return {
      mask: adaptiveThreshold(gray, { blockSize: opt.adaptiveBlock, offset: opt.adaptiveOffset }),
      mode,
      threshold: null, // 局部自适应没有单一阈值
      otsu
    }
  }
  // 全局：默认用 Otsu；允许调用方传固定阈值（界面上的"阈值微调"用得上）
  const threshold = typeof opt.threshold === 'number' ? opt.threshold : otsu
  return { mask: globalThreshold(gray, threshold), mode: 'global', threshold, otsu }
}

// 预处理主流程（纯函数，Node 端可直接测）：
//   原始灰度 → 质量评估（评估必须在去噪前做，去噪会改变统计）→ 去噪 → 二值化
export function preprocessGray(gray, options = {}) {
  const opt = { ...PREPROCESS_DEFAULTS, ...options }
  const quality = assessQuality(gray, opt)
  const clean = opt.denoise ? medianFilter3(gray) : gray
  const { mask, mode, threshold, otsu } = binarize(clean, opt)
  return {
    gray: clean, // 去噪后的灰度：字形提取（1.6）用这个，二值化会丢掉"参考字 vs 笔迹"的灰度层次
    mask, // 二值图：切格（1.5）与红圈（1.7）用
    mode,
    threshold,
    otsu,
    quality,
    messages: qualityMessages(quality)
  }
}

// ── 浏览器侧：解码 ────────────────────────────────────────────────────────

// 建一张 2D 画布（优先 OffscreenCanvas：不挂到 DOM 上，批量处理时不留一堆节点）
function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

// 图片文件 → RGBA 像素。
// **EXIF 方向必须处理**（决策 二-4 的产品化要求之一）：手机竖拍的照片在文件里是横躺的，
//   靠 EXIF 里的方向标记才能摆正；不处理会整页躺倒，后面的定位块搜索直接失效。
//   `imageOrientation: 'from-image'` 是让浏览器读 EXIF 并自动摆正的开关（现代规范里是默认值，
//   这里显式写出来，避免将来默认值变化时静默失效）。
export async function decodeImageFile(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const canvas = createCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0)
  const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  if (typeof bitmap.close === 'function') bitmap.close()
  return { data: image.data, width: image.width, height: image.height }
}

// 图片文件 → 预处理结果。除灰度图与二值图外**同时返回彩色像素**：
//   红圈识别（1.7）靠颜色通道差值 R − max(G,B)，灰度化之后红色信息就没了（决策 二-2）。
//   彩色数组最大（约 33MB/页），调用方用完必须及时释放引用。
export async function preprocessFile(file, options = {}) {
  const rgba = await decodeImageFile(file)
  const gray = rgbaToGray(rgba)
  const result = preprocessGray(gray, options)
  return { rgba, ...result }
}
