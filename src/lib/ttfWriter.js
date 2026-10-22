// TrueType 字体写盘（零依赖）—— 2026-10-22 排查 Word 挤时新增
//
// 职责：把"字形轮廓 + 名称表字段"直接写成一份 TTF 字节，**不经过 SVG font 中间格式**。
//
// 为什么要自己写盘（清单 一-20 的排查结论）：
//   1016（Word 正常）与交叉生成件（Word 里挤）除 glyf 编码外逐表相同：同一批轮廓经
//   "SVG path → svg2ttfobject"之后，glyf 的点序列会多出一层**显式化的隐含中点**
//   （实测 285 → 306 点）。但 1016 本身也含显式中点（5973 / 12447 个 on-curve 点），
//   所以"中点"不是唯一变量 —— 本轮先用"自己写表"把 fonteditor 这个变量整体拿掉：
//   点序列原样编码（不再多一层转换），其余各表的字段按 1016 的实测值复刻，
//   让产物与"在 Word 里正常的那份"同构，便于把问题收敛到真正的差异上。
//
// 与既有模块的分工：
//   - 轮廓几何（映射、只裁不放大）在 glyphBuilder.js，本文件只接收最终的 path 字符串；
//   - SVG path 的解析复用 svgPath.js（它同时被模板 PDF 与位图追踪使用）；
//   - woff / woff2 仍由 fonteditor 编码（它只是编码器，接受我们写出的 TTF 字节），见 glyphBuilder.js。
//
// 产物契约（《决策记录》四-2 / 四-3 / 四-5 / 四-11，测试 test:fontbuild 逐条钉住）：
//   em 1000、横向 0~1000、纵向 −100~900；汉字全角 1000；数字字母比例宽度；空格半角 500、空轮廓；
//   hmtx **全量**（numberOfHMetrics = numGlyphs，每字 4 字节，lsb = 该字形 xMin）；
//   OS/2 版本 4、usWeightClass 400、fsSelection 0x40、代码页 936、CJK 位；name 表中英并列。
import { arcToCubic, parsePathCommands } from './svgPath.js'

const SFNT_VERSION = 0x00010000
const CHECKSUM_MAGIC = 0xb1b0afba
// 1904-01-01 到 1970-01-01 的秒数：TrueType 的 created / modified 用 1904 纪元（LONGDATETIME）
const EPOCH_1904_TO_1970 = 2082844800

// ── 小工具 ────────────────────────────────────────────────────────────────
function align4(n) {
  return (n + 3) & ~3
}

/** 按 4 字节累加算表 checksum（TTF 规范：不足 4 字节补 0） */
function tableChecksum(bytes, offset, length) {
  let sum = 0
  const end = offset + length
  for (let i = offset; i < end; i += 4) {
    const b0 = bytes[i] || 0
    const b1 = bytes[i + 1] || 0
    const b2 = bytes[i + 2] || 0
    const b3 = bytes[i + 3] || 0
    sum = (sum + b0 * 0x1000000 + (b1 << 16) + (b2 << 8) + b3) >>> 0
  }
  return sum >>> 0
}

/** 动态字节缓冲（表数据都不大，按 1KB 起翻倍） */
class ByteWriter {
  constructor(size = 1024) {
    this.buf = new Uint8Array(size)
    this.len = 0
  }

  ensure(n) {
    if (this.len + n <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < this.len + n) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  u8(v) {
    this.ensure(1)
    this.buf[this.len++] = v & 0xff
  }

  u16(v) {
    this.ensure(2)
    this.buf[this.len++] = (v >>> 8) & 0xff
    this.buf[this.len++] = v & 0xff
  }

  i16(v) {
    this.u16(v & 0xffff)
  }

  u32(v) {
    this.ensure(4)
    this.buf[this.len++] = (v >>> 24) & 0xff
    this.buf[this.len++] = (v >>> 16) & 0xff
    this.buf[this.len++] = (v >>> 8) & 0xff
    this.buf[this.len++] = v & 0xff
  }

  bytes(arr) {
    this.ensure(arr.length)
    this.buf.set(arr, this.len)
    this.len += arr.length
  }

  pad4() {
    while (this.len % 4) this.u8(0)
  }

  toUint8() {
    return this.buf.slice(0, this.len)
  }
}

// ── SVG path → TrueType 轮廓点 ────────────────────────────────────────────
// TrueType 的简单字形只认二次贝塞尔：一个轮廓 = 若干点，每点带 onCurve 标记；
//   **两个连续 off-curve 点之间的中点由解释器隐含**（这一点很关键：不要像 fonteditor 那样把它写出来）。
// 输入是本项目自己的 commandsToPathData 输出（M / L / C / Q / Z，绝对坐标、两位小数），
//   这里仍按完整命令集处理（H / V / S / T / A），避免将来换追踪参数时悄悄出错。
function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}

/** 三次贝塞尔拆成两段、每段用一条二次贝塞尔近似（端点重合，控制点取最佳近似） */
function addCubic(cur, p0, p1, p2, p3) {
  const a1 = midpoint(p0, p1)
  const a2 = midpoint(p1, p2)
  const a3 = midpoint(p2, p3)
  const b1 = midpoint(a1, a2)
  const b2 = midpoint(a2, a3)
  const m = midpoint(b1, b2)
  const seg = (q0, c1, c2, q3) => {
    // 二次控制点 Q 使二次曲线在 t=0.5 处与三次曲线重合：Q = (3·C1 + 3·C2 − P0 − P3) / 4
    const qx = (3 * c1[0] + 3 * c2[0] - q0[0] - q3[0]) / 4
    const qy = (3 * c1[1] + 3 * c2[1] - q0[1] - q3[1]) / 4
    cur.off(qx, qy)
    cur.on(q3[0], q3[1])
  }
  seg(p0, a1, b1, m)
  seg(m, b2, a3, p3)
}

/**
 * path 字符串 → 轮廓数组 `[[{x,y,on}...]]`。
 * 闭合轮廓由数组边界表达（TrueType 用 endPtsOfContours），Z 只表示"回到起点"。
 */
export function pathToContours(d) {
  const cmds = parsePathCommands(String(d || ''))
  const contours = []
  let cur = null
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
  const api = {
    on(x, y) {
      if (!cur) {
        cur = []
        contours.push(cur)
      }
      cur.push({ x, y, on: true })
    },
    off(x, y) {
      if (!cur) return
      cur.push({ x, y, on: false })
    }
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
        cur = []
        contours.push(cur)
        cur.push({ x: cx, y: cy, on: true })
        prevIsC = prevIsQ = false
        break
      case 'L':
        cx = A(0)
        cy = B(1)
        api.on(cx, cy)
        prevIsC = prevIsQ = false
        break
      case 'H':
        cx = rel ? cx + args[0] : args[0]
        api.on(cx, cy)
        prevIsC = prevIsQ = false
        break
      case 'V':
        cy = rel ? cy + args[0] : args[0]
        api.on(cx, cy)
        prevIsC = prevIsQ = false
        break
      case 'Q': {
        const qx = A(0)
        const qy = B(1)
        api.off(qx, qy)
        cx = A(2)
        cy = B(3)
        api.on(cx, cy)
        prevQx = qx
        prevQy = qy
        prevIsQ = true
        prevIsC = false
        break
      }
      case 'T': {
        const qx = prevIsQ ? 2 * cx - prevQx : cx
        const qy = prevIsQ ? 2 * cy - prevQy : cy
        api.off(qx, qy)
        cx = A(0)
        cy = B(1)
        api.on(cx, cy)
        prevQx = qx
        prevQy = qy
        prevIsQ = true
        prevIsC = false
        break
      }
      case 'C': {
        const p0 = [cx, cy]
        const p1 = [A(0), B(1)]
        const p2 = [A(2), B(3)]
        const p3 = [A(4), B(5)]
        addCubic(api, p0, p1, p2, p3)
        cx = p3[0]
        cy = p3[1]
        prevC1x = p2[0]
        prevC1y = p2[1]
        prevIsC = true
        prevIsQ = false
        break
      }
      case 'S': {
        const p1 = prevIsC ? [2 * cx - prevC1x, 2 * cy - prevC1y] : [cx, cy]
        const p2 = [A(0), B(1)]
        const p3 = [A(2), B(3)]
        addCubic(api, [cx, cy], p1, p2, p3)
        cx = p3[0]
        cy = p3[1]
        prevC1x = p2[0]
        prevC1y = p2[1]
        prevIsC = true
        prevIsQ = false
        break
      }
      case 'A': {
        const x1 = cx
        const y1 = cy
        const x2 = A(5)
        const y2 = B(6)
        const curves = arcToCubic(x1, y1, args[0], args[1], args[2], args[3], args[4], x2, y2)
        for (const c of curves) addCubic(api, [x1, y1], [c[0], c[1]], [c[2], c[3]], [c[4], c[5]])
        cx = x2
        cy = y2
        prevIsC = prevIsQ = false
        break
      }
      case 'Z':
        cx = sx
        cy = sy
        prevIsC = prevIsQ = false
        break
      default:
        break
    }
  }
  return contours
}

// ── glyf 编码 ─────────────────────────────────────────────────────────────
/**
 * 单个字形 → glyf 表里的一段字节（简单字形）。
 * @param {Array} contours pathToContours 的输出
 * @returns {{data:Uint8Array, bbox:object|null, points:number, contours:number}}
 *   bbox 为 null 表示空字形（glyf 长度为 0，loca 原地不动）。
 * 编码规则（TrueType 规范）：
 *   - 坐标取整（1 单位 = 1/1000 em）；
 *   - x/y 增量 0 用 same 位、|增量| < 256 用 short 位（1 字节），否则 int16；
 *   - 连续相同的 flag 用 repeat 位压缩。
 */
export function encodeGlyph(contours) {
  const pts = []
  const endPts = []
  for (const raw of contours) {
    if (!raw || !raw.length) continue
    // 去掉与起点重合的尾点：TrueType 的轮廓是隐式闭合的，重复起点会让轮廓多一个零长度段
    let ring = raw
    if (ring.length > 1) {
      const first = ring[0]
      const last = ring[ring.length - 1]
      if (Math.round(last.x) === Math.round(first.x) && Math.round(last.y) === Math.round(first.y)) {
        ring = ring.slice(0, -1)
      }
    }
    if (!ring.length) continue
    for (const p of ring) pts.push({ x: Math.round(p.x), y: Math.round(p.y), on: p.on !== false })
    endPts.push(pts.length - 1)
  }
  if (!pts.length) return { data: new Uint8Array(0), bbox: null, points: 0, contours: 0 }

  let xMin = Infinity
  let yMin = Infinity
  let xMax = -Infinity
  let yMax = -Infinity
  for (const p of pts) {
    if (p.x < xMin) xMin = p.x
    if (p.x > xMax) xMax = p.x
    if (p.y < yMin) yMin = p.y
    if (p.y > yMax) yMax = p.y
  }

  // ① 先算每点的 flag 与增量
  const flags = []
  const dxs = []
  const dys = []
  let px = 0
  let py = 0
  for (const p of pts) {
    let f = p.on ? 1 : 0
    const dx = p.x - px
    const dy = p.y - py
    if (dx === 0) f |= 0x10
    else if (Math.abs(dx) < 256) {
      f |= 0x02
      if (dx > 0) f |= 0x10
    }
    if (dy === 0) f |= 0x20
    else if (Math.abs(dy) < 256) {
      f |= 0x04
      if (dy > 0) f |= 0x20
    }
    flags.push(f)
    dxs.push(dx)
    dys.push(dy)
    px = p.x
    py = p.y
  }

  // ② flag 压缩（repeat）
  const packedFlags = []
  for (let i = 0; i < flags.length; i++) {
    let j = i
    while (j + 1 < flags.length && flags[j + 1] === flags[i] && j - i < 255) j++
    if (j > i) packedFlags.push(flags[i] | 0x08, j - i)
    else packedFlags.push(flags[i])
    i = j
  }

  // ③ 坐标字节
  const xBytes = []
  const yBytes = []
  for (let i = 0; i < pts.length; i++) {
    const f = flags[i]
    const dx = dxs[i]
    const dy = dys[i]
    if (f & 0x02) xBytes.push(Math.abs(dx))
    else if (!(f & 0x10)) xBytes.push((dx >> 8) & 0xff, dx & 0xff)
    if (f & 0x04) yBytes.push(Math.abs(dy))
    else if (!(f & 0x20)) yBytes.push((dy >> 8) & 0xff, dy & 0xff)
  }

  const w = new ByteWriter(64 + pts.length * 4)
  w.i16(endPts.length)
  w.i16(xMin)
  w.i16(yMin)
  w.i16(xMax)
  w.i16(yMax)
  for (const e of endPts) w.u16(e)
  w.u16(0) // instructionLength：本项目不做 hinting（1016 的指令长度也都是 0）
  for (const f of packedFlags) w.u8(f)
  for (const b of xBytes) w.u8(b)
  for (const b of yBytes) w.u8(b)
  return {
    data: w.toUint8(),
    bbox: { xMin, yMin, xMax, yMax },
    points: pts.length,
    contours: endPts.length
  }
}

// ── cmap ──────────────────────────────────────────────────────────────────
// 两个子表（Windows 平台）：
//   3/1  format 4  —— BMP 码位，老程序（含 Word 的中文字体槽位）走这张；
//   3/10 format 12 —— 补充平面（字表里有 196 个扩展 B 区汉字），外加全码位兜底。
// glyph id 按码位升序分配（见 buildTrueTypeFont），所以 format 4 的每段内 idDelta 恒定。
function buildFormat4(entries) {
  const bmp = entries.filter((e) => e.code <= 0xffff).sort((a, b) => a.code - b.code)
  const segments = []
  for (const e of bmp) {
    const last = segments[segments.length - 1]
    if (last && e.code === last.end + 1) {
      last.end = e.code
      last.gids.push(e.gid)
    } else {
      segments.push({ start: e.code, end: e.code, gids: [e.gid] })
    }
  }
  // 规范要求最后一段以 0xFFFF 结尾（映射到 .notdef）
  segments.push({ start: 0xffff, end: 0xffff, gids: [0], sentinel: true })
  const segCount = segments.length
  const w = new ByteWriter(16 + segCount * 8)
  w.u16(4) // format
  w.u16(16 + segCount * 8) // length（无 glyphIdArray）
  w.u16(0) // language
  const segX2 = segCount * 2
  let pow = 1
  let log = 0
  while (pow * 2 <= segCount) {
    pow *= 2
    log++
  }
  w.u16(segX2)
  w.u16(pow * 2)
  w.u16(log)
  w.u16(segX2 - pow * 2)
  for (const s of segments) w.u16(s.end)
  w.u16(0) // reservedPad
  for (const s of segments) w.u16(s.start)
  for (const s of segments) {
    // idDelta = gid − code（段内恒定；哨兵段用 +1 把 0xFFFF 映到 gid 0）
    const delta = s.sentinel ? 1 : (s.gids[0] - s.start) & 0xffff
    w.u16(delta)
  }
  for (let i = 0; i < segCount; i++) w.u16(0) // idRangeOffset：全 0（用 idDelta）
  return w.toUint8()
}

function buildFormat12(entries) {
  const sorted = entries.slice().sort((a, b) => a.code - b.code)
  const groups = []
  for (const e of sorted) {
    const last = groups[groups.length - 1]
    if (last && e.code === last.end + 1 && e.gid === last.gid + (e.code - last.start)) {
      last.end = e.code
    } else {
      groups.push({ start: e.code, end: e.code, gid: e.gid })
    }
  }
  const w = new ByteWriter(16 + groups.length * 12)
  w.u16(12) // format
  w.u16(0) // reserved
  w.u32(16 + groups.length * 12) // length
  w.u32(0) // language
  w.u32(groups.length)
  for (const g of groups) {
    w.u32(g.start)
    w.u32(g.end)
    w.u32(g.gid)
  }
  return w.toUint8()
}

function buildCmap(entries) {
  const f4 = buildFormat4(entries)
  const f12 = buildFormat12(entries)
  const header = 4 + 8 * 2
  const w = new ByteWriter(header + f4.length + f12.length)
  w.u16(0) // version
  w.u16(2) // numTables
  w.u16(3)
  w.u16(1)
  w.u32(header)
  w.u16(3)
  w.u16(10)
  w.u32(header + f4.length)
  w.bytes(f4)
  w.bytes(f12)
  return w.toUint8()
}

// ── name ──────────────────────────────────────────────────────────────────
// 中英并列的写法沿用 fonteditor 的产物形态（同一条字符串同时写 Mac 与 Windows 两条记录）：
//   Windows 记录用 UTF-16BE（中文正常），Mac 记录只能用 Mac Roman —— 含非 ASCII 的字段**不写 Mac 记录**，
//   免得像旧产物那样写出一串乱码（Mac 记录不参与 Windows / Word 的选字体，跳过是安全的）。
const NAME_IDS = [
  [0, 'copyright'],
  [1, 'fontFamily'],
  [2, 'fontSubFamily'],
  [3, 'uniqueSubFamily'],
  [4, 'fullName'],
  [5, 'version'],
  [6, 'postScriptName'],
  [8, 'manufacturer'],
  [9, 'designer'],
  [10, 'description'],
  [13, 'licence'],
  [14, 'urlOfLicence'],
  [19, 'sampleText']
]

function buildName(fields) {
  const records = []
  for (const [id, key] of NAME_IDS) {
    const text = fields[key]
    if (text === undefined || text === null || text === '') continue
    const str = String(text)
    records.push({ platformID: 3, encodingID: 1, languageID: 0x409, nameID: id, text: str, utf16: true })
    if (/^[\x00-\x7f]*$/.test(str)) {
      records.push({ platformID: 1, encodingID: 0, languageID: 0, nameID: id, text: str, utf16: false })
    }
  }
  records.sort((a, b) =>
    a.platformID - b.platformID || a.encodingID - b.encodingID || a.languageID - b.languageID || a.nameID - b.nameID)
  const strings = new ByteWriter(1024)
  for (const r of records) {
    r.offset = strings.len
    if (r.utf16) {
      for (let i = 0; i < r.text.length; i++) {
        const code = r.text.charCodeAt(i)
        strings.u8((code >> 8) & 0xff)
        strings.u8(code & 0xff)
      }
      r.length = r.text.length * 2
    } else {
      for (let i = 0; i < r.text.length; i++) strings.u8(r.text.charCodeAt(i) & 0x7f)
      r.length = r.text.length
    }
  }
  const w = new ByteWriter(6 + records.length * 12 + strings.len)
  w.u16(0) // format
  w.u16(records.length)
  w.u16(6 + records.length * 12) // stringOffset
  for (const r of records) {
    w.u16(r.platformID)
    w.u16(r.encodingID)
    w.u16(r.languageID)
    w.u16(r.nameID)
    w.u16(r.length)
    w.u16(r.offset)
  }
  w.bytes(strings.toUint8())
  return w.toUint8()
}

// ── head / hhea / maxp / hmtx / post / OS/2 ───────────────────────────────
// 各字段的默认值一律照抄 1016 那份"在 Word 里正常"的字体（实测解析值），
// 把自研写盘与 fonteditor 写盘的差异压缩到"只有 glyf 编码"这一处 —— 否则排查又变成多变量。
function buildHead({ bbox, created, indexToLocFormat = 1 }) {
  const w = new ByteWriter(54)
  w.u32(0x00010000) // version
  w.u32(0x00010000) // fontRevision 1.0
  w.u32(0) // checkSumAdjustment：整文件写完再回填
  w.u32(0x5f0f3cf5) // magicNumber
  w.u16(0x000b) // flags：与 1016 一致
  w.u16(1000) // unitsPerEm
  w.u32(Math.floor(created / 0x100000000) >>> 0)
  w.u32(created % 0x100000000)
  w.u32(Math.floor(created / 0x100000000) >>> 0)
  w.u32(created % 0x100000000)
  w.i16(bbox.xMin)
  w.i16(bbox.yMin)
  w.i16(bbox.xMax)
  w.i16(bbox.yMax)
  w.u16(0) // macStyle
  w.u16(8) // lowestRecPPEM
  w.i16(2) // fontDirectionHint
  w.i16(indexToLocFormat)
  w.i16(0) // glyphDataFormat
  return w.toUint8()
}

function buildHhea({ advances, lsbs, xMaxExtent, minLSB, minRSB, advanceWidthMax }) {
  const w = new ByteWriter(36)
  w.u32(0x00010000)
  w.i16(900) // ascender：设计框顶（四-2 / 四-4）
  w.i16(-100) // descender：设计框底
  w.i16(92) // lineGap：照抄 1016（fonteditor 的默认值）
  w.u16(advanceWidthMax)
  w.i16(minLSB)
  w.i16(minRSB)
  w.i16(xMaxExtent)
  w.i16(1) // caretSlopeRise
  w.i16(0) // caretSlopeRun
  w.i16(0) // caretOffset
  w.i16(0)
  w.i16(0)
  w.i16(0)
  w.i16(0)
  w.i16(0) // metricDataFormat
  w.u16(advances.length) // numberOfHMetrics = numGlyphs（全量）
  return w.toUint8()
}

function buildMaxp({ numGlyphs, maxPoints, maxContours }) {
  const w = new ByteWriter(32)
  w.u32(0x00010000)
  w.u16(numGlyphs)
  w.u16(maxPoints)
  w.u16(maxContours)
  w.u16(0) // maxCompositePoints（本项目没有复合字形）
  w.u16(0) // maxCompositeContours
  w.u16(0) // maxZones（不做 hinting）
  w.u16(0) // maxTwilightPoints
  w.u16(0) // maxStorage
  w.u16(0) // maxFunctionDefs
  w.u16(0) // maxInstructionDefs
  w.u16(0) // maxStackElements
  w.u16(0) // maxSizeOfInstructions
  w.u16(0) // maxComponentElements
  w.u16(0) // maxComponentDepth
  return w.toUint8()
}

function buildHmtx({ advances, lsbs }) {
  const w = new ByteWriter(advances.length * 4)
  for (let i = 0; i < advances.length; i++) {
    w.u16(advances[i])
    w.i16(lsbs[i])
  }
  return w.toUint8()
}

function buildPost() {
  const w = new ByteWriter(32)
  w.u32(0x00030000) // 版本 3：不含字形名（本项目的字形名对 Word / PS 没有作用）
  w.u32(0) // italicAngle
  w.i16(-50) // underlinePosition
  w.i16(50) // underlineThickness
  w.u32(0) // isFixedPitch
  w.u32(0)
  w.u32(0)
  w.u32(0)
  w.u32(0)
  return w.toUint8()
}

function buildOs2({ numGlyphs, avgWidth, firstChar, lastChar }) {
  const w = new ByteWriter(96)
  w.u16(4) // version
  w.i16(avgWidth) // xAvgCharWidth
  w.u16(400) // usWeightClass：常规体
  w.u16(5) // usWidthClass：Medium
  w.u16(0) // fsType：可自由嵌入
  w.i16(665) // ySubscriptXSize
  w.i16(716) // ySubscriptYSize
  w.i16(0)
  w.i16(143)
  w.i16(665) // ySuperscriptXSize
  w.i16(716)
  w.i16(0)
  w.i16(491)
  w.i16(51) // yStrikeoutSize
  w.i16(265) // yStrikeoutPosition
  w.i16(0) // sFamilyClass
  for (let i = 0; i < 10; i++) w.u8(0) // panose
  w.u32(0x80000001) // ulUnicodeRange1：第 31 位常用标点
  w.u32(0x08010000) // ulUnicodeRange2：第 48 位 CJK 标点 + 第 59 位 CJK 统一表意文字
  w.u32(0x00000010) // ulUnicodeRange3：第 68 位半角及全角形式
  w.u32(0) // ulUnicodeRange4
  w.bytes([0x50, 0x66, 0x45, 0x64]) // achVendID "PfEd"（与 1016 一致）
  w.u16(0x40) // fsSelection：只留 REGULAR
  w.u16(firstChar)
  w.u16(lastChar)
  w.i16(812) // sTypoAscender
  w.i16(-212) // sTypoDescender
  w.i16(92) // sTypoLineGap
  w.u16(812) // usWinAscent
  w.u16(212) // usWinDescent
  w.u32(0x00040001) // ulCodePageRange1：Latin-1 + 936 简体中文
  w.u32(0) // ulCodePageRange2
  w.i16(792) // sxHeight
  w.i16(0) // sCapHeight
  w.u16(0) // usDefaultChar
  w.u16(32) // usBreakChar：空格
  w.u16(1) // usMaxContext
  return w.toUint8()
}

// ── 组装 ──────────────────────────────────────────────────────────────────
/**
 * 字形清单 → TTF 字节。
 * @param {{glyphs:Array<{code:number, advanceWidth:number, d:string}>, meta:object}} input
 *   glyphs：**必须已含 .notdef 之外的全部字形**（空格由调用方加进来，d 为空串即空轮廓）；
 *   gid 由本函数分配：0 = .notdef，其余按码位升序 —— format 4 的 idDelta 段因此成立。
 *   meta：名称表字段（familyName / version / designer / copyright / licence ...）
 * @returns {Uint8Array} TTF 字节
 */
export function buildTrueTypeFont({ glyphs, meta = {} }) {
  // ① 分配 gid：0 = .notdef（空轮廓），其余按码位升序
  const items = glyphs.slice().sort((a, b) => a.code - b.code)
  const all = [{ code: -1, advanceWidth: 1000, d: '' }].concat(items)
  const encoded = all.map((g) => {
    // 两种输入：生产路径给 `d`（path 字符串）；测试 / 诊断可以直接给点序列（`contours`），
    //   后者用于"把既有字体的轮廓原样重新编码"这类交叉验证（不经过 SVG path 的往返转换）。
    const contours = g.contours || (g.d ? pathToContours(g.d) : [])
    const enc = encodeGlyph(contours)
    return { ...g, ...enc }
  })

  // ② glyf + loca（long 格式；每个字形按 4 字节对齐）
  const glyfW = new ByteWriter(64 * 1024)
  const loca = []
  for (const g of encoded) {
    loca.push(glyfW.len)
    if (g.data.length) {
      glyfW.bytes(g.data)
      glyfW.pad4()
    }
  }
  loca.push(glyfW.len)
  const glyf = glyfW.toUint8()
  const locaW = new ByteWriter((loca.length) * 4)
  for (const off of loca) locaW.u32(off)
  const locaTable = locaW.toUint8()

  // ③ 度量（hmtx 全量；lsb = 字形 xMin）
  const advances = []
  const lsbs = []
  let advanceWidthMax = 0
  let minLSB = 0
  let minRSB = 0
  let xMaxExtent = 0
  let bbox = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 }
  let firstBox = true
  let maxPoints = 0
  let maxContours = 0
  let avgSum = 0
  for (const g of encoded) {
    const adv = Math.max(0, Math.min(0xffff, Math.round(g.advanceWidth || 0)))
    advances.push(adv)
    avgSum += adv
    const lsb = g.bbox ? g.bbox.xMin : 0
    lsbs.push(lsb)
    const width = g.bbox ? g.bbox.xMax - g.bbox.xMin : 0
    const rsb = g.bbox ? adv - lsb - width : adv
    advanceWidthMax = Math.max(advanceWidthMax, adv)
    minLSB = Math.min(minLSB, lsb)
    minRSB = Math.min(minRSB, rsb)
    xMaxExtent = Math.max(xMaxExtent, lsb + width)
    if (g.bbox) {
      if (firstBox) {
        bbox = { ...g.bbox }
        firstBox = false
      } else {
        bbox.xMin = Math.min(bbox.xMin, g.bbox.xMin)
        bbox.yMin = Math.min(bbox.yMin, g.bbox.yMin)
        bbox.xMax = Math.max(bbox.xMax, g.bbox.xMax)
        bbox.yMax = Math.max(bbox.yMax, g.bbox.yMax)
      }
    }
    if (g.points > maxPoints) maxPoints = g.points
    if (g.contours > maxContours) maxContours = g.contours
  }
  if (firstBox) bbox = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 }

  // ④ 其余表
  const codes = items.map((g) => g.code).filter((c) => c >= 0)
  const bmpCodes = codes.filter((c) => c <= 0xffff)
  const firstChar = bmpCodes.length ? Math.min(...bmpCodes) : 0xffff
  const lastChar = bmpCodes.length ? Math.max(...bmpCodes) : 0xffff
  const now = Math.floor(Date.now() / 1000) + EPOCH_1904_TO_1970
  const tables = {
    'OS/2': buildOs2({
      numGlyphs: encoded.length,
      avgWidth: Math.round(avgSum / Math.max(1, encoded.length)),
      firstChar,
      lastChar
    }),
    cmap: buildCmap(encoded.filter((g) => g.code >= 0).map((g, i) => ({ code: g.code, gid: i + 1 }))),
    glyf,
    head: buildHead({ bbox, created: now }),
    hhea: buildHhea({ advances, lsbs, xMaxExtent, minLSB, minRSB, advanceWidthMax }),
    hmtx: buildHmtx({ advances, lsbs }),
    loca: locaTable,
    maxp: buildMaxp({ numGlyphs: encoded.length, maxPoints, maxContours }),
    name: buildName({
      fontFamily: meta.familyName,
      fontSubFamily: meta.fontSubFamily || 'Regular',
      uniqueSubFamily: meta.uniqueSubFamily,
      fullName: meta.fullName,
      version: meta.version,
      postScriptName: meta.postScriptName,
      copyright: meta.copyright,
      manufacturer: meta.manufacturer,
      designer: meta.designer,
      description: meta.description,
      licence: meta.licence,
      urlOfLicence: meta.urlOfLicence,
      sampleText: meta.sampleText
    }),
    post: buildPost()
  }

  // ⑤ 表目录 + 数据（按 tag 字母序，与 1016 的产物顺序一致）
  const tags = Object.keys(tables).sort()
  const numTables = tags.length
  let cursor = 12 + numTables * 16
  const records = []
  for (const tag of tags) {
    cursor = align4(cursor)
    records.push({ tag, offset: cursor, data: tables[tag] })
    cursor += tables[tag].length
  }
  const total = align4(cursor)
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, SFNT_VERSION)
  dv.setUint16(4, numTables)
  let pow = 1
  let log = 0
  while (pow * 2 <= numTables) {
    pow *= 2
    log++
  }
  dv.setUint16(6, pow * 16)
  dv.setUint16(8, log)
  dv.setUint16(10, numTables * 16 - pow * 16)
  for (let i = 0; i < records.length; i++) {
    const r = 12 + i * 16
    const rec = records[i]
    for (let k = 0; k < 4; k++) out[r + k] = rec.tag.charCodeAt(k)
    dv.setUint32(r + 8, rec.offset)
    dv.setUint32(r + 12, rec.data.length)
    out.set(rec.data, rec.offset)
  }
  // 表 checksum
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    dv.setUint32(12 + i * 16 + 4, tableChecksum(out, rec.offset, rec.data.length))
  }
  // 整文件 checksum → head.checkSumAdjustment（head 表内该字段此时为 0）
  const sum = tableChecksum(out, 0, out.length)
  const adjustment = (CHECKSUM_MAGIC - sum) >>> 0
  const headRec = records.find((r) => r.tag === 'head')
  dv.setUint32(headRec.offset + 8, adjustment)
  return out
}
