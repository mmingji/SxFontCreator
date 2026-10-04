// SVG path 解析、包围盒与坐标变换（阶段一步骤 1.9）
// 来源：复用参考项目 sn-font-manager 的 `src/lib/svgNormalize.js`（已跑通多年），按本项目需要裁剪与改造：
//   **保留** parsePathCommands / arcToCubic / pathBBox / commandsToPathData（改造为支持 x、y 独立缩放）/ 从 SVG 提取 path；
//   **不要** normalizeSvgImport 与 normalizeSvgForce —— 它们会把图形"按包围盒铺满 0~1000"，
//   而汉字必须**按书写格线性映射**（决策 四-4：按 bbox 铺满会让"一"和"国"一样大，是明确否掉的做法）；
//   **不要**图标场景的 svg 字符串改写（本项目的产物直接是 path 数据，进字体构建）。
// 职责边界：本文件只做"路径几何"，不碰位图（位图在 traceImage.js）、不碰字体（在 glyphBuilder.js）。

// 各命令的参数个数（用于拆分隐式重复命令）
const ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }

// 解析 path d 字符串为命令数组 [{ type: 大写, raw: 原始字符, args: [...] }]
// 支持相对/绝对、紧凑格式、隐式重复命令（M 后多点 = L；C 后 12 数 = 两个 C）
export function parsePathCommands(d) {
  const re = /([a-zA-Z])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi
  const cmds = []
  let m
  let current = null
  while ((m = re.exec(d)) !== null) {
    if (m[1]) {
      current = { type: m[1].toUpperCase(), raw: m[1], args: [] }
      cmds.push(current)
    } else if (current) {
      current.args.push(parseFloat(m[2]))
    }
  }

  // 拆分隐式重复命令：把过长的 args 按各命令所需参数个数拆成多条
  // 注意：保留原始大小写（raw），相对命令信息不能丢
  const out = []
  for (const c of cmds) {
    const n = ARGS[c.type]
    if (n === 0) {
      out.push(c)
      continue
    }
    const count = Math.floor(c.args.length / n)
    if (count === 0) continue
    for (let i = 0; i < count; i++) {
      // M 之后的隐式点是 L（沿用 M 的大小写性质）
      const isM = c.type === 'M'
      const rawChar = i === 0 ? c.raw : (isM ? (c.raw === 'M' ? 'L' : 'l') : c.raw)
      const typeChar = i === 0 ? c.type : (isM ? 'L' : c.type)
      out.push({ type: typeChar, raw: rawChar, args: c.args.slice(i * n, i * n + n) })
    }
  }
  return out
}

// 将 A/a 椭圆弧转为若干 C 三次贝塞尔曲线（弧在字体与 potrace 输出里都可能出现）
export function arcToCubic(x1, y1, rx, ry, phi, largeArc, sweep, x2, y2) {
  const result = []
  if (rx === 0 || ry === 0) {
    result.push([x1, y1, x2, y2, x2, y2])
    return result
  }
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  const phiRad = (phi * Math.PI) / 180
  const cosphi = Math.cos(phiRad)
  const sinphi = Math.sin(phiRad)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cosphi * dx + sinphi * dy
  const y1p = -sinphi * dx + cosphi * dy
  let rx2 = rx * rx
  let ry2 = ry * ry
  const x1p2 = x1p * x1p
  const y1p2 = y1p * y1p
  const lambda = x1p2 / rx2 + y1p2 / ry2
  if (lambda > 1) {
    const s = Math.sqrt(lambda)
    rx *= s
    ry *= s
    rx2 = rx * rx
    ry2 = ry * ry
  }
  const sign = largeArc === sweep ? -1 : 1
  const num = Math.max(0, rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2)
  const den = rx2 * y1p2 + ry2 * x1p2
  const coef = sign * Math.sqrt(num / den)
  const cxp = (coef * (rx * y1p)) / ry
  const cyp = (coef * -(ry * x1p)) / rx
  const cx = cosphi * cxp - sinphi * cyp + (x1 + x2) / 2
  const cy = sinphi * cxp + cosphi * cyp + (y1 + y2) / 2
  const theta1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx)
  let dtheta = Math.atan2((-(y1p + cyp)) / ry, (-(x1p + cxp)) / rx) - theta1
  if (sweep === 0 && dtheta > 0) dtheta -= 2 * Math.PI
  if (sweep === 1 && dtheta < 0) dtheta += 2 * Math.PI
  const segments = Math.max(1, Math.ceil(Math.abs(dtheta / (Math.PI / 2))))
  const delta = dtheta / segments
  const t = (8 / 3) * Math.sin(delta / 4) * Math.sin(delta / 4) / Math.sin(delta / 2)
  let px = x1
  let py = y1
  for (let i = 0; i < segments; i++) {
    const theta = theta1 + delta * (i + 1)
    const cosT = Math.cos(theta)
    const sinT = Math.sin(theta)
    const x3 = cosphi * (rx * cosT) - sinphi * (ry * sinT) + cx
    const y3 = sinphi * (rx * cosT) + cosphi * (ry * sinT) + cy
    const thetaPrev = theta1 + delta * i
    const cosTp = Math.cos(thetaPrev)
    const sinTp = Math.sin(thetaPrev)
    const x1c = cosphi * (rx * cosTp) - sinphi * (ry * sinTp) + cx
    const y1c = sinphi * (rx * cosTp) + cosphi * (ry * sinTp) + cy
    const dx1 = (px - x1c) * t
    const dy1 = (py - y1c) * t
    const dx2 = (x3 - x1c) * t
    const dy2 = (y3 - y1c) * t
    result.push([px + dx1, py + dy1, x3 - dx2, y3 - dy2, x3, y3])
    px = x3
    py = y3
  }
  return result
}

// 计算 path 命令的包围盒（支持全部命令、处理相对坐标；控制点计入，比真实墨迹略大，对"是否越界"的判断足够）
export function pathBBox(cmds) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  let prevC1x = 0
  let prevC1y = 0
  let prevQx = 0
  let prevQy = 0
  let prevIsC = false
  let prevIsQ = false
  const collect = (x, y) => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  for (const { type, raw, args } of cmds) {
    const rel = raw !== type
    const A = (i) => (rel ? cx + args[i] : args[i])
    const B = (i) => (rel ? cy + args[i] : args[i])
    switch (type) {
      case 'M':
        cx = A(0)
        cy = B(1)
        sx = cx
        sy = cy
        collect(cx, cy)
        prevIsC = prevIsQ = false
        break
      case 'L':
        cx = A(0)
        cy = B(1)
        collect(cx, cy)
        prevIsC = prevIsQ = false
        break
      case 'H':
        cx = rel ? cx + args[0] : args[0]
        collect(cx, cy)
        prevIsC = prevIsQ = false
        break
      case 'V':
        cy = rel ? cy + args[0] : args[0]
        collect(cx, cy)
        prevIsC = prevIsQ = false
        break
      case 'C':
        collect(A(0), B(1))
        collect(A(2), B(3))
        prevC1x = A(2)
        prevC1y = B(3)
        prevIsC = true
        prevIsQ = false
        cx = A(4)
        cy = B(5)
        collect(cx, cy)
        break
      case 'S':
        {
          let c1x
          let c1y
          if (prevIsC) {
            c1x = 2 * cx - prevC1x
            c1y = 2 * cy - prevC1y
          } else {
            c1x = cx
            c1y = cy
          }
          collect(c1x, c1y)
          collect(A(0), B(1))
          prevC1x = A(0)
          prevC1y = B(1)
          prevIsC = true
          prevIsQ = false
          cx = A(2)
          cy = B(3)
          collect(cx, cy)
        }
        break
      case 'Q':
        collect(A(0), B(1))
        cx = A(2)
        cy = B(3)
        collect(cx, cy)
        prevQx = A(0)
        prevQy = B(1)
        prevIsQ = true
        prevIsC = false
        break
      case 'T':
        {
          let qx
          let qy
          if (prevIsQ) {
            qx = 2 * cx - prevQx
            qy = 2 * cy - prevQy
          } else {
            qx = cx
            qy = cy
          }
          collect(qx, qy)
          cx = A(0)
          cy = B(1)
          collect(cx, cy)
          prevQx = qx
          prevQy = qy
          prevIsQ = true
          prevIsC = false
        }
        break
      case 'A':
        {
          const x1 = cx
          const y1 = cy
          const x2 = A(5)
          const y2 = B(6)
          const curves = arcToCubic(x1, y1, args[0], args[1], args[2], args[3], args[4], x2, y2)
          for (const c of curves) {
            collect(c[0], c[1])
            collect(c[2], c[3])
            collect(c[4], c[5])
          }
          cx = x2
          cy = y2
          prevIsC = prevIsQ = false
        }
        break
      case 'Z':
        cx = sx
        cy = sy
        prevIsC = prevIsQ = false
        break
    }
  }
  return { minX, minY, maxX, maxY }
}

// 命令序列 → 规范 path 字符串（大写绝对命令）。
// **改造点**：支持 x、y 各自缩放与平移（scaleY 省略时与 scaleX 相同）——
//   汉字从图像坐标（y 向下）映射到字体坐标（y 向上）必须把 y 取负，只支持统一 scale 做不到。
// 参数顺序：`(cmds, scaleX, scaleY = scaleX, offsetX = 0, offsetY = 0)`
export function commandsToPathData(cmds, scaleX = 1, scaleY = scaleX, offsetX = 0, offsetY = 0) {
  let out = ''
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  let prevC1x = 0
  let prevC1y = 0
  let prevIsC = false
  let prevQx = 0
  let prevQy = 0
  let prevIsQ = false
  const X = (v) => +((v * scaleX) + offsetX).toFixed(2)
  const Y = (v) => +((v * scaleY) + offsetY).toFixed(2)

  for (const { type, raw, args } of cmds) {
    const rel = raw !== type
    const A = (i) => (rel ? cx + args[i] : args[i])
    const B = (i) => (rel ? cy + args[i] : args[i])
    switch (type) {
      case 'M':
        cx = A(0)
        cy = B(1)
        sx = cx
        sy = cy
        out += `M${X(cx)} ${Y(cy)}`
        prevIsC = prevIsQ = false
        break
      case 'L':
        cx = A(0)
        cy = B(1)
        out += `L${X(cx)} ${Y(cy)}`
        prevIsC = prevIsQ = false
        break
      case 'H':
        cx = rel ? cx + args[0] : args[0]
        out += `L${X(cx)} ${Y(cy)}`
        prevIsC = prevIsQ = false
        break
      case 'V':
        cy = rel ? cy + args[0] : args[0]
        out += `L${X(cx)} ${Y(cy)}`
        prevIsC = prevIsQ = false
        break
      case 'C':
        out += `C${X(A(0))} ${Y(B(1))} ${X(A(2))} ${Y(B(3))} ${X(A(4))} ${Y(B(5))}`
        // 先记录本段第二个控制点（供后续 S 镜像），再更新当前点 —— 顺序颠倒会用终点坐标算镜像，S 会变形
        prevC1x = A(2)
        prevC1y = B(3)
        prevIsC = true
        prevIsQ = false
        cx = A(4)
        cy = B(5)
        break
      case 'S':
        {
          let c1x
          let c1y
          if (prevIsC) {
            c1x = 2 * cx - prevC1x
            c1y = 2 * cy - prevC1y
          } else {
            c1x = cx
            c1y = cy
          }
          out += `C${X(c1x)} ${Y(c1y)} ${X(A(0))} ${Y(B(1))} ${X(A(2))} ${Y(B(3))}`
          prevC1x = A(0)
          prevC1y = B(1)
          prevIsC = true
          prevIsQ = false
          cx = A(2)
          cy = B(3)
        }
        break
      case 'Q':
        out += `Q${X(A(0))} ${Y(B(1))} ${X(A(2))} ${Y(B(3))}`
        cx = A(2)
        cy = B(3)
        prevQx = A(0)
        prevQy = B(1)
        prevIsQ = true
        prevIsC = false
        break
      case 'T':
        {
          let qx
          let qy
          if (prevIsQ) {
            qx = 2 * cx - prevQx
            qy = 2 * cy - prevQy
          } else {
            qx = cx
            qy = cy
          }
          out += `Q${X(qx)} ${Y(qy)} ${X(A(0))} ${Y(B(1))}`
          cx = A(0)
          cy = B(1)
          prevQx = qx
          prevQy = qy
          prevIsQ = true
          prevIsC = false
        }
        break
      case 'A':
        {
          const x1 = cx
          const y1 = cy
          const x2 = A(5)
          const y2 = B(6)
          const curves = arcToCubic(x1, y1, args[0], args[1], args[2], args[3], args[4], x2, y2)
          for (const c of curves) {
            out += `C${X(c[0])} ${Y(c[1])} ${X(c[2])} ${Y(c[3])} ${X(c[4])} ${Y(c[5])}`
          }
          cx = x2
          cy = y2
          prevIsC = prevIsQ = false
        }
        break
      case 'Z':
        out += 'Z'
        cx = sx
        cy = sy
        prevIsC = prevIsQ = false
        break
    }
  }
  return out
}

// 从 SVG 字符串里收集 **字形前景** 的 path 命令。
// 两个必须处理的现实（都是实测踩到的）：
//   ① potrace（esm-potrace-wasm）会输出**两组 `<g>`**：一组 `fill="#000000"` 的**前景轮廓**、
//      一组 `fill="#FFFFFF"` 的**背景轮廓**（覆盖整幅图）。两组合并的话包围盒就是整幅图 ——
//      表现为所有字形都被判成越界、统统裁成整框，字体里是一个个黑方块。所以这里按 fill 过滤，只取非白的那组。
//   ② path 的坐标不是像素值，而是"像素 × 10"且 y 反向，缩放/翻转藏在 `<g transform>` 里 ——
//      本函数只取命令，transform 由 `parseTraceTransform`（traceImage.js）交给调用方合并。
// 用正则而不是 DOMParser：浏览器与 Node 行为一致，potrace 的输出格式固定。
export function collectPathCommands(svg) {
  const src = String(svg || '')
  const collectFrom = (chunk) => {
    const out = []
    const pathRe = /<path\b[^>]*?\bd\s*=\s*["']([^"']*)["']/gi
    let pm
    while ((pm = pathRe.exec(chunk)) !== null) {
      const d = pm[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      for (const c of parsePathCommands(d)) out.push(c)
    }
    return out
  }
  const groups = src.split(/<g\b/i).slice(1)
  if (!groups.length) return collectFrom(src) // 没有分组时（某些版本直接给 <path>）按整份文档收
  const all = []
  for (const g of groups) {
    const fill = ((/fill\s*=\s*["']([^"']*)["']/i.exec(g) || [])[1] || '').trim()
    // 跳过白色背景组（#FFF / #FFFFFF / white）；其它颜色（含未声明）都当字形
    if (/^#?(f{3}|f{6})$/i.test(fill) || /^white$/i.test(fill)) continue
    for (const c of collectFrom(g)) all.push(c)
  }
  return all
}

// 把"已映射到 em 方格坐标的命令"裁进 0~1000（**只裁不放大**，决策 四-2、四-4）。
// 用途：越界笔画（长撇长捺伸出书写格）映射到字体坐标后会超出 0~1000，TTF 里坐标越界会让字形异常；
//   参考项目的实战结论是"裁入 0~1000 框内（只收缩平移，绝不放大）"。
// 返回 { changed, scaleX, scaleY, offsetX, offsetY, bbox }：调用方把这四个参数**叠加**到自己那次变换上
//   （本函数不改动 cmds，省掉一次字符串往返；等比收缩时 scaleX === scaleY === k）。
export function clampToBox(cmds, { min = 0, max = 1000, tolerance = 0.5 } = {}) {
  const bb = pathBBox(cmds)
  const identity = { changed: false, scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, bbox: bb }
  if (!isFinite(bb.minX) || !isFinite(bb.minY)) return identity
  if (bb.minX >= min - tolerance && bb.minY >= min - tolerance &&
      bb.maxX <= max + tolerance && bb.maxY <= max + tolerance) {
    return identity
  }
  const w = bb.maxX - bb.minX
  const h = bb.maxY - bb.minY
  if (!(w > 0) || !(h > 0)) return identity
  const box = max - min
  // k ≤ 1：图比框大时才收缩，绝不放大；再平移回框内（先左/上贴边，越界则整体推回来）
  const k = Math.min(1, box / Math.max(w, box), box / Math.max(h, box))
  const x0 = bb.minX * k
  const x1 = bb.maxX * k
  const y0 = bb.minY * k
  const y1 = bb.maxY * k
  let ox = 0
  let oy = 0
  if (x0 < min) ox = min - x0
  if (x1 + ox > max) ox = max - x1
  if (y0 < min) oy = min - y0
  if (y1 + oy > max) oy = max - y1
  return { changed: true, scaleX: k, scaleY: k, offsetX: ox, offsetY: oy, bbox: bb }
}
