// 图像处理算子层（阶段一步骤 1.4）
// 职责：**只做像素运算**，不碰 DOM、不碰业务、不读文件 —— 切格（1.5）、字形提取（1.6）、红圈识别（1.7）
//   都从这里取算子；将来要换实现（例如真需要 OpenCV 时）只替换这一层（《决策记录》二-3）。
// 为什么自研：本项目要的四件事都是**小图上的简单算子** —— 灰度化、阈值、连通域、按已知坐标重采样，
//   而 OpenCV.js 的代价与收益不成比例（常驻数十 MB、首次使用要等 WebAssembly 编译、内部报错只有错误码）。
// 数据结构约定（三套，互不混用）：
//   RGBA = { data: Uint8ClampedArray(4×w×h), width, height }  与 ImageData 同构，通道交错 R,G,B,A
//   Gray = { data: Uint8ClampedArray(w×h),   width, height }  单通道 0~255，行优先
//   Mask = { data: Uint8Array(w×h),          width, height }  二值图：0 = 背景，1 = 前景
// 内存口径（清单三-5 实测：单页 300dpi 彩色扫描件 8.12MB，解码后 RGBA 约 33MB）：
//   算子一律**原地或等尺寸输出**，不做隐藏的大数组缓存；批量处理时必须逐页调用、逐页释放。

// ── 构造与转换 ────────────────────────────────────────────────────────────

// 建一张单通道灰度图（fill 默认白底 255：纸面是白的，背景即"无墨"）
export function createGray(width, height, fill = 255) {
  const data = new Uint8ClampedArray(width * height)
  if (fill) data.fill(fill) // 省略 / 传 0 时不填：Uint8ClampedArray 的初值本来就是 0
  return { data, width, height }
}

// RGBA → 灰度。权重用 ITU-R BT.601（0.299/0.587/0.114）—— 与《实施计划》步骤 1.4「灰度化」写死的公式一致
export function rgbaToGray(rgba) {
  const { data, width, height } = rgba
  const out = new Uint8ClampedArray(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
  }
  return { data: out, width, height }
}

// 灰度 → RGBA（界面预览用：canvas 只认 RGBA）
export function grayToRgba(gray) {
  const { data, width, height } = gray
  const out = new Uint8ClampedArray(width * height * 4)
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    const v = data[i]
    out[p] = v
    out[p + 1] = v
    out[p + 2] = v
    out[p + 3] = 255
  }
  return { data: out, width, height }
}

// Mask → RGBA：前景涂成指定颜色（默认红），用于把识别结果叠在原图上给人眼核对
export function maskToRgba(mask, { fg = [220, 40, 40], bg = [255, 255, 255] } = {}) {
  const { data, width, height } = mask
  const out = new Uint8ClampedArray(width * height * 4)
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    const c = data[i] ? fg : bg
    out[p] = c[0]
    out[p + 1] = c[1]
    out[p + 2] = c[2]
    out[p + 3] = 255
  }
  return { data: out, width, height }
}

// ── 阈值 ──────────────────────────────────────────────────────────────────

// 灰度直方图（256 桶）。阈值、亮度评估、光照评估都从它出发
export function histogram(gray) {
  const hist = new Uint32Array(256)
  const { data } = gray
  for (let i = 0; i < data.length; i++) hist[data[i]]++
  return hist
}

// Otsu 大津法：在直方图上穷举阈值，取"类间方差"最大者。
// 用途：① 光照均匀的平板扫描件直接用它做全局阈值（比局部自适应更稳，不会把淡格线判成前景）；
//   ② 作为图像质量与对比度的参考（前景 / 背景两类的距离）。
export function otsuThreshold(gray) {
  const hist = histogram(gray)
  const total = gray.width * gray.height
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]

  let sumB = 0
  let wB = 0
  let best = 0
  let bestVariance = -1
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > bestVariance) {
      bestVariance = between
      best = t
    }
  }
  return best
}

// 全局阈值二值化：灰度 < threshold 的像素判为前景（笔迹、定位块、灰线……一切比纸暗的东西）
export function globalThreshold(gray, threshold) {
  const { data, width, height } = gray
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < data.length; i++) mask[i] = data[i] < threshold ? 1 : 0
  return { data: mask, width, height }
}

// 分块局部背景：把图切成 blockSize 见方的小块，算出每块的平均灰度。
// 为什么用"分块 + 双线性插值"而不是逐像素滑动窗口：滑动窗口要一张与原图等大的积分图
//   （3447×2419 的 Float64 就要 66MB），而光照不均的变化本身是平缓的，分块足够，
//   内存只要 (宽/块) × (高/块) 个浮点数。
export function blockMeans(gray, blockSize = 32) {
  const { data, width, height } = gray
  const bw = Math.max(1, Math.ceil(width / blockSize))
  const bh = Math.max(1, Math.ceil(height / blockSize))
  const means = new Float32Array(bw * bh)
  for (let by = 0; by < bh; by++) {
    const y0 = by * blockSize
    const y1 = Math.min(height, y0 + blockSize)
    for (let bx = 0; bx < bw; bx++) {
      const x0 = bx * blockSize
      const x1 = Math.min(width, x0 + blockSize)
      let sum = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        const row = y * width
        for (let x = x0; x < x1; x++) {
          sum += data[row + x]
          n++
        }
      }
      means[by * bw + bx] = n ? sum / n : 255
    }
  }
  return { means, bw, bh, blockSize }
}

// 取某点的局部背景灰度（块均值双线性插值，避免块与块之间出现台阶）
export function sampleBlockMeans(blocks, x, y) {
  const { means, bw, bh, blockSize } = blocks
  const fx = x / blockSize - 0.5
  const fy = y / blockSize - 0.5
  const x0 = Math.max(0, Math.min(bw - 1, Math.floor(fx)))
  const y0 = Math.max(0, Math.min(bh - 1, Math.floor(fy)))
  const x1 = Math.max(0, Math.min(bw - 1, x0 + 1))
  const y1 = Math.max(0, Math.min(bh - 1, y0 + 1))
  const tx = Math.max(0, Math.min(1, fx - x0))
  const ty = Math.max(0, Math.min(1, fy - y0))
  const a = means[y0 * bw + x0]
  const b = means[y0 * bw + x1]
  const c = means[y1 * bw + x0]
  const d = means[y1 * bw + x1]
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
}

// 局部自适应阈值（Wellner / Bradley 一脉）：像素比自己周围的背景暗 offset 以上才算前景。
// 用途：手机拍摄这类**光照不均**的输入（决策 二-4 明确要求"用局部自适应，不用全局阈值"）。
// offset 是关键参数：太小会把纸纹、淡格线一起判成前景；太大则细笔画会断。
export function adaptiveThreshold(gray, { blockSize = 32, offset = 12 } = {}) {
  const { data, width, height } = gray
  const blocks = blockMeans(gray, blockSize)
  const mask = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const local = sampleBlockMeans(blocks, x, y)
      mask[row + x] = data[row + x] < local - offset ? 1 : 0
    }
  }
  return { data: mask, width, height }
}

// ── 去噪与形态学 ──────────────────────────────────────────────────────────

// 3×3 中值滤波：去掉纸面孤立的小黑点（椒盐噪声），同时**几乎不改变笔画粗细**。
// 为什么不用均值滤波：均值会把细笔画"糊淡"，1cm 格里的细横（实测笔画宽度 p90 中位约 6 像素）经不起。
// 实现：把 9 个邻域值装进定长数组做插入排序 —— 邻域数据通常高度重复，插入排序在这种输入上
//   接近线性；**必须是完整排序**（曾写成"只排前一半就取中位"，取到的是前缀最大值，不是中位数，
//   被 test/image-ops.mjs 的直边断言抓住）。
// 固有行为：实心块的直角会被削圆（角点的 3×3 邻域里背景占多数）—— 手写笔画是圆头曲线，正好。
export function medianFilter3(gray) {
  const { data, width, height } = gray
  const out = new Uint8ClampedArray(data.length)
  const v = new Array(9)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let n = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        const row = yy * width
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          v[n++] = data[row + xx]
        }
      }
      for (let i = 1; i < n; i++) {
        const key = v[i]
        let j = i - 1
        while (j >= 0 && v[j] > key) {
          v[j + 1] = v[j]
          j--
        }
        v[j + 1] = key
      }
      // 奇数个取正中；图像边界上只有 4 / 6 个邻居时取偏小的那个（宁可多留墨，也不误抹细笔画）
      out[y * width + x] = v[(n - 1) >> 1]
    }
  }
  return { data: out, width, height }
}

// 膨胀（半径 radius 的方形结构元）：前景"长胖"，用于连通被切断的笔画
export function dilateMask(mask, radius = 1) {
  const { data, width, height } = mask
  const out = new Uint8Array(data.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hit = 0
      for (let dy = -radius; dy <= radius && !hit; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        const row = yy * width
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          if (data[row + xx]) { hit = 1; break }
        }
      }
      out[y * width + x] = hit
    }
  }
  return { data: out, width, height }
}

// 腐蚀（半径 radius 的方形结构元）：前景"变瘦"，用于去掉细小的噪点
export function erodeMask(mask, radius = 1) {
  const { data, width, height } = mask
  const out = new Uint8Array(data.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let keep = 1
      for (let dy = -radius; dy <= radius && keep; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= height) { keep = 0; break }
        const row = yy * width
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= width) { keep = 0; break }
          if (!data[row + xx]) { keep = 0; break }
        }
      }
      out[y * width + x] = keep
    }
  }
  return { data: out, width, height }
}

// 开运算 = 先腐蚀后膨胀：**去掉小噪点、保留主体形状**（本项目的默认去噪手段）
export function openMask(mask, radius = 1) {
  return dilateMask(erodeMask(mask, radius), radius)
}

// 闭运算 = 先膨胀后腐蚀：填补笔画内部的小孔与断口
export function closeMask(mask, radius = 1) {
  return erodeMask(dilateMask(mask, radius), radius)
}

// 距离变换（chamfer 5-7-11 两遍扫描）：每个前景像素到**最近背景像素**的距离 × 5。
// 为什么需要它：判"笔画有多粗"只能从掩膜量（字形本身没有笔画宽度字段），而逐像素数
//   到边界的距离正是笔画半宽 —— 离背景最远的那些像素就在笔画中轴上（阶段三 3.2 的字形体检
//   用它量笔画宽度；早先那条"逐字按字面框规整"2026-10-07 已放弃，见决策 四-7）。
// 为什么用 chamfer 近似而不是精确欧氏距离：两遍扫描、整数运算、O(wh)，误差 < 2%
//   （5-7-11 权重是对欧氏距离 ×5 的拟合），而精确算法要么带开方、要么要更复杂的下包络扫描。
// 注意：图外的像素按**背景**处理不到（没有外圈），贴边的笔画会被低估半宽 —— 本项目里
//   切片外扩 14 像素（决策 二-8），正常笔画离切片边界还有余量，影响可忽略。
// 返回：{ data: Uint16Array(wh), width, height, scale }，真实距离（像素）= data[i] / scale
export function distanceTransform(mask) {
  const { data, width, height } = mask
  const INF = 0xffff
  const D1 = 5 // 正交邻步
  const D2 = 7 // 对角邻步
  const D3 = 11 // 马步（|dx|,|dy| = 1,2）
  const d = new Uint16Array(width * height)
  for (let i = 0; i < d.length; i++) d[i] = data[i] ? INF : 0
  // 前向：左上 → 右下，用已确定的左上半邻域更新
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (d[i] === 0) continue
      let v = d[i]
      if (y > 0) {
        if (x > 0) v = Math.min(v, d[i - width - 1] + D2)
        v = Math.min(v, d[i - width] + D1)
        if (x < width - 1) v = Math.min(v, d[i - width + 1] + D2)
      }
      if (x > 0) v = Math.min(v, d[i - 1] + D1)
      if (y > 1) {
        if (x > 0) v = Math.min(v, d[i - 2 * width - 1] + D3)
        if (x < width - 1) v = Math.min(v, d[i - 2 * width + 1] + D3)
      }
      if (x > 1) {
        if (y > 0) v = Math.min(v, d[i - width - 2] + D3)
        if (y < height - 1) v = Math.min(v, d[i + width - 2] + D3)
      }
      d[i] = v
    }
  }
  // 后向：右下 → 左上，用右下半邻域补齐
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x
      if (d[i] === 0) continue
      let v = d[i]
      if (y < height - 1) {
        if (x < width - 1) v = Math.min(v, d[i + width + 1] + D2)
        v = Math.min(v, d[i + width] + D1)
        if (x > 0) v = Math.min(v, d[i + width - 1] + D2)
      }
      if (x < width - 1) v = Math.min(v, d[i + 1] + D1)
      if (y < height - 2) {
        if (x < width - 1) v = Math.min(v, d[i + 2 * width + 1] + D3)
        if (x > 0) v = Math.min(v, d[i + 2 * width - 1] + D3)
      }
      if (x < width - 2) {
        if (y < height - 1) v = Math.min(v, d[i + width + 2] + D3)
        if (y > 0) v = Math.min(v, d[i - width + 2] + D3)
      }
      d[i] = v
    }
  }
  return { data: d, width, height, scale: D1 }
}

// 笔画宽度统计（像素）：对前景像素取距离变换值的分位数 ×2（距离是半宽，宽度要乘 2）。
// 为什么给三个分位数而不是一个"笔画宽度"：手写笔画粗细不匀（起笔顿、收笔尖）——
//   median 代表"典型笔画"、p90 接近"最粗的那一笔"、max 是单点最粗（容易被顿笔拉高）。
//   **口径已定：调用方只用 median**（"笔画偏细" = median < 3% 格宽，决策 四-9 ⑥）——
//   p90 与 max 保留作诊断参考（校准阈值时看得到最粗的那一笔）。
// 返回：{ pixels, median, p90, max }（单位像素；pixels = 前景像素数）
export function strokeWidthEstimate(mask) {
  const dt = distanceTransform(mask)
  const vals = []
  for (let i = 0; i < dt.data.length; i++) {
    if (mask.data[i]) vals.push(dt.data[i] / dt.scale)
  }
  if (!vals.length) return { pixels: 0, median: 0, p90: 0, max: 0 }
  vals.sort((a, b) => a - b)
  const at = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))]
  return {
    pixels: vals.length,
    median: 2 * at(0.5),
    p90: 2 * at(0.9),
    max: 2 * vals[vals.length - 1]
  }
}

// ── 连通域 ────────────────────────────────────────────────────────────────

// 连通域标记（8 邻域）＋按面积过滤，返回每个连通块的外接矩形、面积与质心。
// 用途：1.5 找四角定位块（按面积与长宽比过滤）、1.6 剔除参考字残留的小笔画、1.7 找红圈。
// 实现用**显式栈**而不是递归：整页前景可能有上万像素一块，递归会爆调用栈。
// keepPixels = true 时同时返回该块的像素坐标（找红圈要判"环形"）；默认不返回坐标数组 —— 整页前景可达上万像素，逐块存下来很占内存。
export function connectedComponents(mask, { minArea = 1, maxArea = Infinity, keepPixels = false, maxComponents = 5000 } = {}) {
  const { data, width, height } = mask
  const labels = new Int32Array(width * height).fill(-1)
  const out = []
  const stack = new Int32Array(width * height)
  for (let start = 0; start < data.length; start++) {
    if (!data[start] || labels[start] >= 0) continue
    const id = out.length
    if (id >= maxComponents) break
    let sp = 0
    stack[sp++] = start
    labels[start] = id
    let area = 0
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1
    let sumX = 0
    let sumY = 0
    const pixels = keepPixels ? [] : null
    while (sp > 0) {
      const p = stack[--sp]
      const x = p % width
      const y = (p - x) / width
      area++
      sumX += x
      sumY += y
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (pixels) pixels.push(p)
      // 8 邻域
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        const row = yy * width
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          const q = row + xx
          if (data[q] && labels[q] < 0) {
            labels[q] = id
            stack[sp++] = q
          }
        }
      }
    }
    if (area < minArea || area > maxArea) continue
    out.push({
      id,
      area,
      minX, minY, maxX, maxY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      cx: sumX / area,
      cy: sumY / area,
      pixels
    })
  }
  return { components: out, labels, width, height }
}

// ── 几何：单应矩阵与重采样 ────────────────────────────────────────────────

// 解 3×3 单应矩阵（透视变换）：求把 from 四点映射到 to 四点的矩阵。
// 为什么要它：切格的核心就是"四角定位块 → 透视矩阵 → 按已知网格坐标切格"（《决策记录》二-3、需求 6.1），
//   模板本身就是按 A4 横向设计的，扫描件的轻微旋转 / 缩放 / 梯形变形都由这一个矩阵还原。
// 解法：把 8 个未知数排成 8×8 线性方程组，做**带部分主元的高斯消元**（零依赖、数值稳定够用）。
export function solveHomography(from, to) {
  if (from.length !== 4 || to.length !== 4) throw new Error('单应矩阵需要 4 组对应点')
  const a = []
  const b = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]
    const { x: u, y: v } = to[i]
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    b.push(u)
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    b.push(v)
  }
  // 高斯消元（列主元）
  for (let col = 0; col < 8; col++) {
    let pivot = col
    for (let r = col + 1; r < 8; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r
    }
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error('四点共线或重合，无法解出透视变换')
    if (pivot !== col) {
      const t = a[pivot]; a[pivot] = a[col]; a[col] = t
      const tb = b[pivot]; b[pivot] = b[col]; b[col] = tb
    }
    const p = a[col][col]
    for (let r = col + 1; r < 8; r++) {
      const f = a[r][col] / p
      if (!f) continue
      for (let c = col; c < 8; c++) a[r][c] -= f * a[col][c]
      b[r] -= f * b[col]
    }
  }
  const h = new Array(8)
  for (let r = 7; r >= 0; r--) {
    let s = b[r]
    for (let c = r + 1; c < 8; c++) s -= a[r][c] * h[c]
    h[r] = s / a[r][r]
  }
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]
}

// 3×3 矩阵求逆（warp 时要用"目标 → 源"的逆映射，才不会在目标图里留下空洞）
export function invert3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) throw new Error('矩阵不可逆（三点共线）')
  const D = -(b * i - c * h)
  const E = a * i - c * g
  const F = -(a * h - b * g)
  const G = b * f - c * e
  const H = -(a * f - c * d)
  const I = a * e - b * d
  return [A / det, D / det, G / det, B / det, E / det, H / det, C / det, F / det, I / det]
}

// 用 3×3 矩阵变换一个点（齐次坐标，返回值已除以 w）
export function applyMatrix(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8]
  return {
    x: (m[0] * x + m[1] * y + m[2]) / w,
    y: (m[3] * x + m[4] * y + m[5]) / w
  }
}

// 按矩阵把灰度图重采样成 outW × outH（双线性插值）。
// 约定：matrixToSource 是**目标坐标 → 源坐标**的映射（即源→目标矩阵的逆）——
//   对目标图逐像素反查源图，就不会出现"正向投影留下空洞"的问题。
// 落在源图之外的像素填 255（纸白），避免出现黑边影响后续阈值统计。
export function warpGray(gray, matrixToSource, outW, outH) {
  const { data, width, height } = gray
  const out = new Uint8ClampedArray(outW * outH).fill(255)
  const m = matrixToSource
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const w = m[6] * x + m[7] * y + m[8]
      const sx = (m[0] * x + m[1] * y + m[2]) / w
      const sy = (m[3] * x + m[4] * y + m[5]) / w
      if (sx < 0 || sy < 0 || sx > width - 1 || sy > height - 1) continue
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const x1 = Math.min(width - 1, x0 + 1)
      const y1 = Math.min(height - 1, y0 + 1)
      const tx = sx - x0
      const ty = sy - y0
      const p00 = data[y0 * width + x0]
      const p10 = data[y0 * width + x1]
      const p01 = data[y1 * width + x0]
      const p11 = data[y1 * width + x1]
      const top = p00 * (1 - tx) + p10 * tx
      const bottom = p01 * (1 - tx) + p11 * tx
      out[y * outW + x] = top * (1 - ty) + bottom * ty
    }
  }
  return { data: out, width: outW, height: outH }
}

// 小角度旋转（弧度）：以图心为轴，输出尺寸不变，四角留白按纸白处理。
// 方向：**正角度 = 图像内容顺时针转**（屏幕坐标 y 轴向下，与数学习惯相反；测试里有断言钉住）。
// 用途：平板扫描件的轻微倾斜（实测常见 0~1 度）；手机拍摄的梯形变形走 solveHomography + warpGray。
export function rotateGray(gray, radians) {
  const { width, height } = gray
  const cx = width / 2
  const cy = height / 2
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  // 目标 → 源：反向旋转
  const m = [cos, sin, cx - cos * cx - sin * cy, -sin, cos, cy + sin * cx - cos * cy, 0, 0, 1]
  return warpGray(gray, m, width, height)
}

// 90° 整数倍旋转（无损：整数像素搬移，不做插值）。
// 方向约定与 rotateGray 一致：**正数 = 图像内容顺时针转**（turns = 1 → 顺时针 90°）。
// 用途：扫描件整页被转着扫进来（实测用户把 A4 横向的纸竖着放到平板扫描仪上，得到 2400 × 3428 的竖版件），
//   切格需要先把图转正 —— 这种情形必须用无损旋转，用角度旋转插值会白白糊掉细笔画。
// 返回值：turns 为奇数时宽高互换。
export function rotateQuarterTurns(gray, turns = 1) {
  const t = ((turns % 4) + 4) % 4
  const { data, width: w, height: h } = gray
  if (t === 0) return { data: data.slice(), width: w, height: h }
  const swap = t % 2 === 1
  const outW = swap ? h : w
  const outH = swap ? w : h
  const out = new Uint8ClampedArray(outW * outH)
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let sx
      let sy
      if (t === 1) {
        sx = y
        sy = h - 1 - x // 顺时针 90°：源图左上角转到目标右上角
      } else if (t === 2) {
        sx = w - 1 - x
        sy = h - 1 - y // 180°：中心对称
      } else {
        sx = w - 1 - y
        sy = x // 顺时针 270°（= 逆时针 90°）：源图左上角转到目标左下角
      }
      out[y * outW + x] = data[sy * w + sx]
    }
  }
  return { data: out, width: outW, height: outH }
}

// ── 质量评估用的统计量 ────────────────────────────────────────────────────

// 拉普拉斯方差：清晰度的常用代理指标 —— 越模糊，边缘越少，方差越小。
// 阈值因设备而异，这里只作为**相对参考**（同一台设备的历史值比较），不单独判"糊没糊"。
export function laplacianVariance(gray) {
  const { data, width, height } = gray
  let sum = 0
  let sum2 = 0
  let n = 0
  for (let y = 1; y < height - 1; y++) {
    const row = y * width
    for (let x = 1; x < width - 1; x++) {
      const lap = 4 * data[row + x] - data[row + x - 1] - data[row + x + 1] - data[row - width + x] - data[row + width + x]
      sum += lap
      sum2 += lap * lap
      n++
    }
  }
  if (!n) return 0
  const mean = sum / n
  return sum2 / n - mean * mean
}

// 光照不均程度：**只看"像纸的亮块"**，取块均值的 p90 − p10。
// 为什么不取全体块的极差：暗块往往是成片笔迹、定位块或（手机拍摄时）画面外的桌面，
//   它们不代表光照；实测一份均匀的平板扫描件用极差法会算出 80，用亮块分位法只有约 9。
// 用途：决定二值化走全局阈值还是局部自适应 —— 平板扫描件通常 < 30，手机拍摄常 > 60。
export function illuminationSpread(gray, blockSize = 64) {
  const { means } = blockMeans(gray, blockSize)
  const bright = []
  for (let i = 0; i < means.length; i++) {
    if (means[i] > 150) bright.push(means[i])
  }
  if (bright.length < 4) return 0
  bright.sort((a, b) => a - b)
  const pick = (q) => bright[Math.min(bright.length - 1, Math.floor(q * bright.length))]
  return pick(0.9) - pick(0.1)
}

// 整图平均灰度（判断过曝 / 过暗）
export function meanGray(gray) {
  const { data } = gray
  let sum = 0
  for (let i = 0; i < data.length; i++) sum += data[i]
  return data.length ? sum / data.length : 0
}

// 前景占比（0~1）：阈值化后有多少像素被判成"有墨"。唯一的生产调用点是 `scanPreprocessor`
//   （光照均匀度评估 + 空白件自检）；**逐格"这一格有没有写字"不走这里** —— 那是
//   `handwritingExtractor` 按 inkPixels 判的（决策 二-10 / 八-8 的四态）。
export function foregroundRatio(mask) {
  const { data } = mask
  let n = 0
  for (let i = 0; i < data.length; i++) if (data[i]) n++
  return data.length ? n / data.length : 0
}

// 按整数因子缩小灰度图（面积平均）：整页评估、缩略图预览用，避免在大图上反复做全量统计
export function downsampleGray(gray, factor = 4) {
  if (factor <= 1) return gray
  const { data, width, height } = gray
  const outW = Math.max(1, Math.floor(width / factor))
  const outH = Math.max(1, Math.floor(height / factor))
  const out = new Uint8ClampedArray(outW * outH)
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let sum = 0
      let n = 0
      for (let dy = 0; dy < factor; dy++) {
        const yy = y * factor + dy
        if (yy >= height) break
        const row = yy * width
        for (let dx = 0; dx < factor; dx++) {
          const xx = x * factor + dx
          if (xx >= width) break
          sum += data[row + xx]
          n++
        }
      }
      out[y * outW + x] = n ? sum / n : 255
    }
  }
  return { data: out, width: outW, height: outH }
}
