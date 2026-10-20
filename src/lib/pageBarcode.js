// 底部横向条码：**载荷格式与编解码的唯一出处**（生成端画、识别端读，两端共用这一份）。
// 为什么单独一份、且零依赖：与 lib/pageCode.js 同一个理由 —— 生成端（templatePdf.js）依赖 pdf-lib 与
//   fontkit（构建后约 1.16MB），识别端（gridDetector / scanFlow）不能为了几行格式逻辑把它拖进首屏。
//
// 版式（模块尺寸、行数、每行模块数）在 lib/layout.js 的 `LAYOUT.barcode` 里，本文件只管**载荷**与**位流**：
//   · 一张纸印 4 行 × 619 模块（起始 8 + 行号 4 + 数据 599 + 结束 8），数据共 2396 位 = **299 字节**；
//   · 这 299 字节 = **数据区（头部 6 + 字序载荷 + CRC 2）+ 里德-所罗门纠错码字**；
//   · 数据区长度写进头部（`dataLen`），所以纠错码字数由它反推 —— 任何一档都用满剩余冗余（用户 2026-10-18 口径）。
//
// 载荷字段的**重要性次序**（用户口径）：整页字序 > 件类型 > 页号 > 档位 > 字数。
//   实测余量（《决策记录》一-18）：预置档的字序是"连续段"只占 4 字节，自定义档升序 delta 约 136 字节，
//   最坏（乱序、回退定长 14 位）238 字节 —— 四种情形都能装下，且仍给纠错留出 55~290 字节。
//
// 字序的三种编码方式（宁可选小的；识别端按头部那 4 位分派）：
//   · `segment`：这一页是某个**内置全序的连续段** → 全序 id + 起始序号 + 个数 = 4 字节（预置三档走这条）；
//   · `delta`：**升序**的字表序号序列 → 首项 2 字节 + 后续差值的 varint（自定义档按字表位置 / 频序排完就是升序）；
//   · `fixed`：定长 14 位/字（乱序时的回退，136 字 = 238 字节）。
//   "字表序号"= 字在 8274 字表里的下标（0 基）；识别端拿它就能从字表还原这一页的字，**不依赖认参考字**。

import { LAYOUT } from './layout.js'

// ── 常量：版本 / 件类型 / 档位字段 / 字序编码方式 / 内置全序 id ────────────────────────────

export const BARCODE_VERSION = 1

/** 件类型（这张纸是干什么用的）—— 与"档位"是两个维度：更正册可以是任何档位印的纸 */
export const KIND = {
  main: 1, // 主区字表页（模板的一页）
  correction: 2, // 更正册（空白册：右侧方块里的页号走 128+ 区间，载荷里没有字序）
  selfCheck: 3, // 打印自检页（1cm 方框 + 10cm 标尺那页，没有字）
  rewrite: 4 // 重写 / 补写页（按重写清单印的少量字的页）
}
export const KIND_LABEL = {
  [KIND.main]: '主区字表页',
  [KIND.correction]: '更正册',
  [KIND.selfCheck]: '打印自检页',
  [KIND.rewrite]: '重写页'
}

/** 档位（这一页来自哪一档选字范围）与排列方式 —— 各 2 位，合成竖带里那 4 位的"档位字段" */
export const SCOPE = { custom: 0, single: 1, common: 2, full: 3 }
export const SCOPE_LABEL = { 0: '自定义选字', 1: '单页试打', 2: '常用 6500 字', 3: '全量 8274 字' }
export const ORDER = { rank: 0, stroke: 1 }
export const ORDER_LABEL = { 0: '按使用频率', 1: '笔画序' }

/** 档位字段 = 高 2 位档位 + 低 2 位排列方式（竖带与条码共用同一个值） */
export function encodeScopeField(scope, orderMode) {
  const s = SCOPE[scope] ?? SCOPE.custom
  const o = ORDER[orderMode] ?? ORDER.rank
  return ((s & 0x3) << 2) | (o & 0x3)
}
export function decodeScopeField(value) {
  const v = value & 0xf
  const scopeCode = (v >> 2) & 0x3
  const orderCode = v & 0x3
  return {
    scopeCode,
    orderCode,
    scopeLabel: SCOPE_LABEL[scopeCode],
    orderLabel: ORDER_LABEL[orderCode]
  }
}

/** 字序编码方式（头部高 4 位里的低 4 位） */
export const ORDER_CODE = { none: 0, segment: 1, delta: 2, fixed: 3 }

/** 内置全序的 id（`segment` 编码用）：识别端据此从程序内重建那一份全序再切段 */
export const FULL_ORDER = {
  single: 0, // 单页试打的名句页序（lib/singlePageText.js 的常量）
  commonRank: 1, // 常用 6500 字 · 按使用频率
  commonStroke: 2, // 常用 6500 字 · 笔画序
  fullRank: 3, // 全量 8274 字 · 按使用频率
  fullStroke: 4 // 全量 8274 字 · 笔画序
}

// ── GF(256) 与里德-所罗门（Reed-Solomon）纠错 ────────────────────────────────────────────
// 为什么自己写：项目要求零依赖、离线可用（决策 六-4），而纠错本身只有百来行；
//   本原多项式取 0x11d（QR 码 / AES 用的那一个，α = 2）。

const GF_PRIM = 0x11d
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= GF_PRIM
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
})()

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]])

/**
 * 生成多项式 g(x) = ∏(x − α^i)，i = 1…nsym（系数从最高次开始）。
 * **根从 α^1 起、不是 α^0**：伴随式按 S_j = R(α^j)（j = 1…nsym）算，Berlekamp–Massey 的递推
 *   正好从 S_1 起用（K = i + 1）。两处必须同一个起点 —— 混用会让 BM 的递推整体错位一格、
 *   纠错全部失败（第一版就是根从 α^0 起、伴随式却按 S_1 起喂进去，靠 test/barcode.mjs 抓出来）。
 */
function rsGeneratorPoly(nsym) {
  let g = new Uint8Array([1])
  for (let i = 0; i < nsym; i++) {
    const next = new Uint8Array(g.length + 1)
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j] // × x
      next[j + 1] ^= gfMul(g[j], GF_EXP[i + 1]) // × α^(i+1)
    }
    g = next
  }
  return g
}

/**
 * 算纠错码字（系统码：数据在前、校验在后）。
 * @param {Uint8Array} data 数据区（含头部与 CRC）
 * @param {number} nsym 纠错码字数（可纠正 ⌊nsym/2⌋ 个字节错误）
 * @returns {Uint8Array} nsym 个校验字节
 */
export function rsEncode(data, nsym) {
  if (nsym <= 0) return new Uint8Array(0)
  const gen = rsGeneratorPoly(nsym)
  const buf = new Uint8Array(data.length + nsym)
  buf.set(data)
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i]
    if (coef === 0) continue
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], coef)
  }
  return buf.slice(data.length)
}

// 伴随式 S_j = R(α^j)，j = 0…nsym−1（R 的系数按"高次在前"喂进来，与码字字节序一致）
function rsSyndromes(msg, nsym) {
  const synd = new Uint8Array(nsym)
  for (let j = 0; j < nsym; j++) {
    let v = 0
    for (let i = 0; i < msg.length; i++) v = gfMul(v, GF_EXP[j]) ^ msg[i]
    synd[j] = v
  }
  return synd
}

const gfInv = (a) => (a === 0 ? 0 : GF_EXP[255 - GF_LOG[a]])
const gfPow = (a, n) => (a === 0 ? 0 : GF_EXP[(((GF_LOG[a] * n) % 255) + 255) % 255])

// 多项式工具：错误位置多项式用**低次在前**（p[0] = 常数项，与 Berlekamp–Massey 的递推一致）
const polyScale = (p, s) => p.map((c) => gfMul(c, s))
function polyAdd(a, b) {
  const n = Math.max(a.length, b.length)
  const out = new Array(n).fill(0)
  for (let i = 0; i < a.length; i++) out[i + n - a.length] ^= a[i]
  for (let i = 0; i < b.length; i++) out[i + n - b.length] ^= b[i]
  return out
}
// 多项式求值按**低次在前**（p[0] 是常数项）—— 与 Λ(x) 的表示一致
function polyEvalLow(p, x) {
  let y = 0
  for (let i = p.length - 1; i >= 0; i--) y = gfMul(y, x) ^ p[i]
  return y
}

/**
 * Berlekamp–Massey：求错误位置多项式 Λ(x)（低次在前）。
 * 输入按该算法的标准约定：syndW[0] = 0 占位、syndW[j] = R(α^j)（j ≥ 1）。
 * 错误数超过 ⌊nsym/2⌋（纠不过来）时返回 null。
 */
function rsErrorLocator(syndW, nsym) {
  let errLoc = [1]
  let oldLoc = [1]
  for (let i = 0; i < nsym; i++) {
    const K = i + 1
    let delta = syndW[K]
    for (let j = 1; j < errLoc.length; j++) delta ^= gfMul(errLoc[errLoc.length - 1 - j], syndW[K - j])
    oldLoc = oldLoc.concat([0])
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const next = polyScale(oldLoc, delta)
        oldLoc = polyScale(errLoc, gfInv(delta))
        errLoc = next
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta))
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift()
  const errs = errLoc.length - 1
  if (errs <= 0 || errs * 2 > nsym) return null
  return errLoc
}

/**
 * Chien 搜索：找出错误所在的**码字索引**。
 * 位置 p ↔ 域元素 Z_p = α^(n−1−p)（码字按"高次在前"喂进伴随式，见 rsSyndromes），
 * Berlekamp–Massey 解出的 Λ 以**这些 Z_p 本身**为根（单个错误时实测 Λ = [Z, 1]）。
 * **不玩"互反多项式"那套索引技巧**：直接遍历候选位置、算 Z_p 代进 Λ 看是不是根 —— 根与位置的对应一眼可见
 * （第一版照抄了"求 Λ(Z_p^−1)"的写法，一个根都找不到，靠 test/barcode.mjs 抓出来）。
 */
function rsFindErrorPositions(errLoc, msgLen) {
  const errs = errLoc.length - 1
  const positions = []
  for (let p = 0; p < msgLen; p++) {
    const z = GF_EXP[(msgLen - 1 - p) % 255]
    if (polyEvalLow(errLoc, z) === 0) positions.push(p)
  }
  if (positions.length !== errs) return null
  return positions
}

/**
 * 解错误值（GF(256) 上的高斯消元）：Σ_k e_k · X_k^j = S_{j+1}（j = 0…e−1），X_k = α^(n−1−p_k)。
 * **右端项取 S₁…S_e（不是 S₀ 起）**：与生成多项式的根（α^1…α^nsym）、Berlekamp–Massey 的递推
 *   必须同一个起点 —— 混用会让方程组整体错位一格、解出错误的错误值（见下面 row[e] 那行的注释）。
 * 为什么不用 Forney 公式：解方程写出来**没有索引技巧**，配合末尾的伴随式复核同样可靠；
 * e ≤ ⌊nsym/2⌋（本例最多 27）时只有两万多次域乘，耗时可忽略。
 */
function rsSolveErrorValues(synd, positions, msgLen) {
  const e = positions.length
  const X = positions.map((p) => GF_EXP[(msgLen - 1 - p) % 255])
  const A = []
  for (let j = 0; j < e; j++) {
    const row = new Array(e + 1).fill(0)
    for (let k = 0; k < e; k++) row[k] = gfPow(X[k], j + 1)
    row[e] = synd[j + 1] // 伴随式从 S_1 起（与生成多项式的根、BM 的递推同一个起点）
    A.push(row)
  }
  for (let col = 0; col < e; col++) {
    let piv = -1
    for (let r = col; r < e; r++) if (A[r][col] !== 0) { piv = r; break }
    if (piv < 0) return null
    const tmp = A[col]
    A[col] = A[piv]
    A[piv] = tmp
    const inv = gfInv(A[col][col])
    for (let c = col; c <= e; c++) A[col][c] = gfMul(A[col][c], inv)
    for (let r = 0; r < e; r++) {
      if (r === col || A[r][col] === 0) continue
      const f = A[r][col]
      for (let c = col; c <= e; c++) A[r][c] ^= gfMul(f, A[col][c])
    }
  }
  return A.map((row) => row[e])
}

/**
 * 解码并纠正。
 * **安全性质（与 lib/pageCodeSolve.js 同一条口径）**：要么纠对、要么返回 null —— 绝不返回一个"猜的"结果。
 * @returns {{data:Uint8Array, corrected:number}|null}
 */
export function rsDecode(received, nsym) {
  if (nsym <= 0) return { data: received.slice(), corrected: 0 }
  const msg = received.slice()
  // 伴随式算 **nsym + 1** 个：synd[j] = R(α^j)，j = 0…nsym —— 索引 0 只是占位，
  //   Berlekamp–Massey 的递推从 synd[1] = S_1 起用（与生成多项式的根 α^1…α^nsym 同一个起点）。
  const synd = rsSyndromes(msg, nsym + 1)
  if (synd.slice(1).every((v) => v === 0)) return { data: msg, corrected: 0 }
  const errLoc = rsErrorLocator(synd, nsym)
  if (!errLoc) return null
  const positions = rsFindErrorPositions(errLoc, msg.length)
  if (!positions || !positions.length || positions.length * 2 > nsym) return null
  const values = rsSolveErrorValues(synd, positions, msg.length)
  if (!values) return null
  for (let k = 0; k < positions.length; k++) msg[positions[k]] ^= values[k]
  // 兜底复核：改完之后伴随式必须全 0，否则说明"纠错了" → 宁可返回 null
  if (!rsSyndromes(msg, nsym + 1).slice(1).every((v) => v === 0)) return null
  return { data: msg, corrected: positions.length }
}

// ── CRC16（CCITT）—— RS 之外的最终校验，防"RS 误纠" ───────────────────────────────────
export function crc16(bytes) {
  let crc = 0xffff
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}

// ── 字序载荷的三种编码 ────────────────────────────────────────────────────────────────

const writeU16 = (out, v) => {
  out.push((v >> 8) & 0xff, v & 0xff)
}
const readU16 = (bytes, at) => ((bytes[at] << 8) | bytes[at + 1]) & 0xffff

function encodeVarint(out, value) {
  let v = value
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v & 0x7f)
}
function decodeVarint(bytes, at) {
  let v = 0
  let shift = 0
  let i = at
  while (i < bytes.length) {
    const b = bytes[i++]
    v |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) return { value: v >>> 0, next: i }
    shift += 7
    if (shift > 28) return null
  }
  return null
}

/**
 * 把"这一页每一格的字"编成载荷。
 * @param {number[]} indexes **按格号排列**的字表序号（0 基）；`-1` = 这一格是空白（没印参考字）
 *   —— 格位信息必须留在载荷里：字表里恰好有一个半角空格（基础字符第 1 个，落在常用档第 48 页第 109 格、
 *   全量档第 60 页第 82 格），那一格在纸上是空的；若条码只存"非空格的字"，识别端就不知道空的是第几格，
 *   从那一格之后整页错位（指纹只跳过空格、不含位置，所以它兜不住这件事）。
 * @param {{fullOrderId:number,start:number,count:number}|null} seg 这一页是内置全序的连续段时给出
 */
export function encodeOrderPayload(indexes, seg) {
  const list = (indexes || []).map((v) => (Number.isInteger(v) && v >= 0 ? v : -1))
  if (!list.length) return { code: ORDER_CODE.none, bytes: [] }
  const hasBlank = list.includes(-1)
  if (seg && !hasBlank && Number.isInteger(seg.fullOrderId)) {
    const bytes = [seg.fullOrderId & 0xff]
    writeU16(bytes, seg.start | 0)
    bytes.push(seg.count & 0xff)
    return { code: ORDER_CODE.segment, bytes }
  }
  // delta：只在"全是字、且严格升序"时可用（首项 2 字节，后续存"差值 − 1"的 varint）
  let ascending = !hasBlank
  for (let i = 1; i < list.length && ascending; i++) if (list[i] <= list[i - 1]) ascending = false
  const deltaBytes = ascending ? (() => {
    const out = []
    writeU16(out, list[0])
    for (let i = 1; i < list.length; i++) encodeVarint(out, list[i] - list[i - 1] - 1)
    return out
  })() : null
  // fixed：每格 14 位（8274 < 2^14），乱序与空白格都能装（空白格 = 16383 哨兵）
  const fixedBytes = (() => {
    const bits = []
    for (const v of list) {
      const code = v < 0 ? 0x3fff : v
      for (let b = 13; b >= 0; b--) bits.push((code >> b) & 1)
    }
    const out = []
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0
      for (let b = 0; b < 8; b++) byte = (byte << 1) | (bits[i + b] || 0)
      out.push(byte)
    }
    return out
  })()
  if (deltaBytes && deltaBytes.length < fixedBytes.length) return { code: ORDER_CODE.delta, bytes: deltaBytes }
  return { code: ORDER_CODE.fixed, bytes: fixedBytes }
}

/** encodeOrderPayload 的逆：把载荷解回字表序号数组 */
export function decodeOrderPayload(code, bytes, charCount) {
  const count = charCount | 0
  if (code === ORDER_CODE.none) return { indexes: [] }
  if (code === ORDER_CODE.segment) {
    if (bytes.length < 4) return null
    const fullOrderId = bytes[0]
    const start = readU16(bytes, 1)
    // 以头部的 charCount 为准截断（segment 里的 count 是生成端写的同一件事，两者不一致时宁少勿多）
    const n = count > 0 ? Math.min(bytes[3], count) : bytes[3]
    const indexes = []
    for (let i = 0; i < n; i++) indexes.push(start + i)
    return { fullOrderId, start, count: n, indexes }
  }
  if (code === ORDER_CODE.delta) {
    if (bytes.length < 2) return null
    const indexes = [readU16(bytes, 0)]
    let at = 2
    while (indexes.length < count) {
      const got = decodeVarint(bytes, at)
      if (!got) return null
      indexes.push(indexes[indexes.length - 1] + got.value + 1)
      at = got.next
    }
    return { indexes }
  }
  if (code === ORDER_CODE.fixed) {
    const bits = []
    for (const byte of bytes) for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1)
    const indexes = []
    for (let i = 0; i + 14 <= bits.length && indexes.length < count; i += 14) {
      let v = 0
      for (let b = 0; b < 14; b++) v = (v << 1) | bits[i + b]
      indexes.push(v === 0x3fff ? -1 : v) // 16383 = 空白格哨兵（生成端写的就是它）
    }
    if (indexes.length < count) return null
    return { indexes }
  }
  return null
}

// ── 载荷打包 / 解析（头部 6 字节 + 字序载荷 + CRC 2 字节 + RS 纠错） ──────────────────────────

/**
 * 打包一页的载荷。
 * @param {object} input
 * @param {number} input.kind 件类型（KIND.*）
 * @param {number} input.scopeField 档位字段（encodeScopeField 的结果）
 * @param {number} input.pageNumber 页号（主区 1~127；更正册 128+n−1）
 * @param {number} input.charCount 这一页的**格数**（含空白格；≤ 136）—— 与 indexes 的长度一致
 * @param {number[]} [input.indexes] 这一页**每一格**的字表序号（按格号排列；`-1` = 空白格，见 encodeOrderPayload）
 * @param {object|null} [input.seg] 连续段信息（内置全序）
 * @param {number} [input.totalBytes] 数据位总容量（默认 LAYOUT.barcode.dataBytes）
 * @returns {{bytes:Uint8Array, dataLen:number, nsym:number}}
 */
export function packBarcodePayload(input) {
  const layout = LAYOUT.barcode
  const order = encodeOrderPayload(input.indexes || [], input.seg || null)
  const data = []
  data.push(((BARCODE_VERSION & 0xf) << 4) | (order.code & 0xf))
  data.push(((input.kind & 0xf) << 4) | (input.scopeField & 0xf))
  data.push(input.pageNumber & 0xff)
  data.push((input.charCount || 0) & 0xff)
  writeU16(data, 0) // 占位：dataLen（含 CRC）
  for (const b of order.bytes) data.push(b & 0xff)
  const dataLen = data.length + 2 // 加上 CRC 两个字节
  data[4] = (dataLen >> 8) & 0xff
  data[5] = dataLen & 0xff
  const crc = crc16(Uint8Array.from(data))
  data.push((crc >> 8) & 0xff, crc & 0xff)
  if (dataLen > layout.dataBytes) {
    throw new Error('这一页的载荷装不下：需要 ' + dataLen + ' 字节，条码数据区只有 ' + layout.dataBytes + ' 字节')
  }
  // 补 0 到固定长度的数据区，再按 layout.blocks 分块做纠错（每块 = 数据 + 纠错，依次排进码字）
  const padded = new Uint8Array(layout.dataBytes)
  padded.set(Uint8Array.from(data), 0)
  const bytes = new Uint8Array(layout.totalBytes)
  let dataAt = 0
  let outAt = 0
  for (const blk of layout.blocks) {
    const chunk = padded.slice(dataAt, dataAt + blk.dataBytes)
    bytes.set(chunk, outAt)
    bytes.set(rsEncode(chunk, blk.parityBytes), outAt + blk.dataBytes)
    dataAt += blk.dataBytes
    outAt += blk.dataBytes + blk.parityBytes
  }
  const nsym = layout.blocks.reduce((sum, b) => sum + b.parityBytes, 0)
  return { bytes, data: padded, dataLen, nsym }
}

/**
 * 整条码字 → 数据区（**分块** RS 纠错；任何一块纠不过来就返回 null）。
 * 数据区长度固定（LAYOUT.barcode.dataBytes），所以解码端不需要任何外部信息就能分块。
 * @returns {{data:Uint8Array, corrected:number}|null}
 */
export function codewordToData(bytes, layout = LAYOUT.barcode) {
  if (!bytes || bytes.length !== layout.totalBytes) return null
  const data = new Uint8Array(layout.dataBytes)
  let dataAt = 0
  let inAt = 0
  let corrected = 0
  for (const blk of layout.blocks) {
    const chunk = bytes.slice(inAt, inAt + blk.dataBytes + blk.parityBytes)
    const fixed = rsDecode(chunk, blk.parityBytes)
    if (!fixed) return null
    corrected += fixed.corrected
    data.set(fixed.data.slice(0, blk.dataBytes), dataAt)
    dataAt += blk.dataBytes
    inAt += blk.dataBytes + blk.parityBytes
  }
  return { data, corrected }
}

/**
 * 解析载荷（已经过 RS 纠错）。
 * @returns {object|null} 解析结果；格式不对 / CRC 不过返回 null（宁严勿宽）
 */
export function unpackBarcodePayload(bytes) {
  if (!bytes || bytes.length < 8) return null
  const version = (bytes[0] >> 4) & 0xf
  if (version !== BARCODE_VERSION) return null
  const orderCode = bytes[0] & 0xf
  const kind = (bytes[1] >> 4) & 0xf
  const scopeField = bytes[1] & 0xf
  const pageNumber = bytes[2]
  const charCount = bytes[3]
  const dataLen = readU16(bytes, 4)
  if (dataLen < 8 || dataLen > bytes.length) return null
  const crcWant = readU16(bytes, dataLen - 2)
  const crcGot = crc16(bytes.slice(0, dataLen - 2))
  if (crcWant !== crcGot) return null
  const orderBytes = Array.from(bytes.slice(6, dataLen - 2))
  const order = decodeOrderPayload(orderCode, orderBytes, charCount)
  if (!order) return null
  return {
    version,
    kind,
    kindLabel: KIND_LABEL[kind] || '未知件类型',
    scopeField,
    ...decodeScopeField(scopeField),
    pageNumber,
    charCount,
    orderCode,
    order
  }
}

// ── 从"校正到设计坐标系"的灰度图里采样（识别端） ──────────────────────────────────────
// 与现有右侧方块解码同一套路数（gridDetector.decodeFooterCode）：位置全部由设计坐标算出、不做图像识别；
//   每个模块取**中心 40% 区域的灰度平均**（躲开抗锯齿 / 打印扩散的边缘），再用**自适应阈值**判 0/1。
// 为什么用自适应阈值而不是固定阈值：条码与定位块同色（灰度约 93），但打印深浅、纸张、曝光都会让它漂移；
//   取"全部模块灰度的 (min+max)/2"只看这一片区域自己的明暗对比，比钉死一个数字稳。
// **宁严勿宽**：对比度不足（max−min 太小）直接返回 null，让调用方退回"认参考字"那条路，绝不硬猜。

/** 取一个像素矩形（内缩 inset）的平均灰度；矩形退化 / 越界返回 null */
function meanGray(gray, x, y, w, h, inset) {
  const x0 = Math.max(0, Math.round(x + w * inset))
  const x1 = Math.min(gray.width, Math.round(x + w * (1 - inset)))
  const y0 = Math.max(0, Math.round(y + h * inset))
  const y1 = Math.min(gray.height, Math.round(y + h * (1 - inset)))
  if (x1 <= x0 || y1 <= y0) return null
  let sum = 0
  let n = 0
  for (let yy = y0; yy < y1; yy++) {
    const base = yy * gray.width
    for (let xx = x0; xx < x1; xx++) {
      sum += gray.data[base + xx]
      n++
    }
  }
  return n ? sum / n : null
}

/** 区域内的自适应阈值（灰度 min/max 的中点）；对比度不足返回 null */
function regionThreshold(gray, x0, y0, x1, y1, minContrast) {
  let min = 255
  let max = 0
  for (let y = Math.max(0, y0); y < Math.min(gray.height, y1); y++) {
    const base = y * gray.width
    for (let x = Math.max(0, x0); x < Math.min(gray.width, x1); x++) {
      const v = gray.data[base + x]
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (max - min < minContrast) return null
  return (min + max) / 2
}

/**
 * 采样条码的每个模块（0/1）。
 * **为什么必须自校准**：模块只有 0.42mm（@300dpi 约 5 像素），而四角校正后仍有实测 < 6 像素的整体残差 ——
 *   直接按设计坐标采样会串到相邻模块甚至相邻行（这是第一版实测踩到的：不加校准连整体平移 3px 都读不出来）。
 *   所以分两步：
 *   ① **粗定位**：在条码区域做列投影与行投影，找出条码的**左边界**与**下边界** —— 这两处外侧都是空白纸，
 *      不受干扰；**上边界不能用**（它紧贴表格那条横线），改用"下边界 + 设计高度"；
 *   ② **精搜索**：以亚像素步长在 ±2px 内搜 (dx, dy)，用**同步图案**（每行的起始 8 + 行号 4 + 结束 8，
 *      共 80 个采样点）的灰度匹配分挑最佳 —— 这些图案是已知的，等于条码自带的一把对齐标尺。
 *      搜索范围远小于图案周期（2 模块 ≈ 10px），不会出现相位歧义。
 * 判不出来一律返回 null（对比度不足 / 边界找不到 / 采样越界），让调用方退回"认参考字"那条路。
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} gray 校正到设计坐标系的灰度图
 * @param {(pt:number)=>number} xPt 设计坐标 x（pt）→ 图像 x（px）
 * @param {(pt:number)=>number} yPt 设计坐标 y（pt）→ 图像 y（px）—— PDF 的 y 朝上、图像的 y 朝下
 * @param {{inset?:number, minContrast?:number, pad?:number, searchPx?:number, step?:number}} [options]
 * @returns {number[][]|null} 每行 modulesPerRow 个 0/1
 */
export function sampleBarcodeModules(gray, xPt, yPt, options = {}, layout = LAYOUT.barcode) {
  const inset = options.inset === undefined ? 0.3 : options.inset
  const minContrast = options.minContrast === undefined ? 40 : options.minContrast
  const pad = options.pad === undefined ? 12 : options.pad
  const searchPx = options.searchPx === undefined ? 2 : options.searchPx
  const step = options.step === undefined ? 0.5 : options.step
  const moduleW = xPt(layout.module) - xPt(0)
  const moduleH = Math.abs(yPt(layout.rowHeight) - yPt(0))
  if (!(moduleW > 0.5) || !(moduleH > 0.5)) return null

  const leftPx = xPt(layout.left)
  const rightPx = xPt(layout.right)
  const topPx = yPt(layout.top)
  const bottomPx = yPt(layout.bottom)
  const x0 = Math.max(0, Math.floor(leftPx - pad))
  const x1 = Math.min(gray.width, Math.ceil(rightPx + pad))
  const y0 = Math.max(0, Math.floor(topPx - pad))
  const y1 = Math.min(gray.height, Math.ceil(bottomPx + pad))
  if (x1 <= x0 || y1 <= y0) return null

  const threshold = regionThreshold(gray, x0, y0, x1, y1, minContrast)
  if (threshold === null) return null

  // ① 粗定位：左边界（列投影；纵向范围跳过紧贴条码顶边的表格线）与下边界（行投影，下方是空白纸）
  const projTop = Math.min(gray.height - 1, Math.max(0, Math.floor(topPx) + 1))
  const projBottom = Math.min(gray.height - 1, Math.ceil(bottomPx + pad))
  let coarseDx = 0
  {
    const minRun = Math.max(2, Math.round((projBottom - projTop + 1) * 0.3))
    for (let x = x0; x < x1; x++) {
      let dark = 0
      for (let y = projTop; y <= projBottom; y++) if (gray.data[y * gray.width + x] < threshold) dark++
      if (dark >= minRun) {
        coarseDx = x - leftPx
        break
      }
    }
  }
  let coarseDy = 0
  {
    // **下边界不能要求"这一行有 30% 宽度的暗像素"**（2026-10-20 重锚新纸时实测踩出来的）：
    //   单页试打 106 字 / 更正册 8 字节这类**稀疏载荷**，最底一行可能只有同步图案
    //   （每行起始 4 + 结束 4 个暗模块 ≈ 40px，只占行宽 1.3%）—— 按 30% 行宽（约 920px）去找，
    //   会跳过最底行、把窗口抬到上面某一行（实测条码整体偏一行，RS 全部失败）；
    //   而 test:barcode 用的样本恰好是 136 个乱序字的密集载荷，底行暗像素足够，所以一直没暴露。
    //   判据改成"连续 3 行都有暗像素（每行 ≥ 20 个）"，取最底那一段：
    //   条码下方是 5mm 空白纸，纸面噪点通常只有个位像素、且不会连续 3 行。
    const minDark = 20
    const minRows = 3
    let run = 0
    for (let y = projBottom; y >= projTop; y--) {
      const base = y * gray.width
      let dark = 0
      for (let x = x0; x < x1; x++) if (gray.data[base + x] < threshold) dark++
      if (dark >= minDark) {
        run++
        if (run >= minRows) {
          // 从下往上扫：最底一行是 y + run − 1（y 递减），它约等于条码 row3 的底边
          coarseDy = (y + run - 1) - bottomPx
          break
        }
      } else {
        run = 0
      }
    }
  }

  const sampleModule = (dx, dy, r, i) => meanGray(gray,
    xPt(layout.left + (i + 0.5) * layout.module - layout.module / 2) + dx,
    yPt(layout.top - (r + 0.5) * layout.rowHeight + layout.rowHeight / 2) + dy,
    moduleW, moduleH, inset)

  // ② 精搜索：同步图案（起始 8 + 行号 4 + 结束 8）的匹配分，越大越像
  const refs = []
  const stopStart = layout.startModules + layout.rowIndexModules + layout.dataModulesPerRow
  for (let r = 0; r < layout.rowCount; r++) {
    const startBits = START_PATTERN.slice(0, layout.startModules)
    for (let b = layout.rowIndexModules - 1; b >= 0; b--) startBits.push((r >> b) & 1)
    refs.push({ row: r, startBits, stopBits: STOP_PATTERN.slice(0, layout.stopModules), stopStart })
  }
  const scoreAt = (dx, dy) => {
    let score = 0
    for (const ref of refs) {
      for (let i = 0; i < ref.startBits.length; i++) {
        const v = sampleModule(dx, dy, ref.row, i)
        if (v === null) return null
        score += ref.startBits[i] ? threshold - v : v - threshold
      }
      for (let i = 0; i < ref.stopBits.length; i++) {
        const v = sampleModule(dx, dy, ref.row, ref.stopStart + i)
        if (v === null) return null
        score += ref.stopBits[i] ? threshold - v : v - threshold
      }
    }
    return score
  }
  let bestDx = coarseDx
  let bestDy = coarseDy
  let bestScore = -Infinity
  for (let sx = -searchPx; sx <= searchPx + 1e-9; sx += step) {
    for (let sy = -searchPx; sy <= searchPx + 1e-9; sy += step) {
      const s = scoreAt(coarseDx + sx, coarseDy + sy)
      if (s === null) continue
      if (s > bestScore) {
        bestScore = s
        bestDx = coarseDx + sx
        bestDy = coarseDy + sy
      }
    }
  }
  if (bestScore === -Infinity) return null

  // ③ 按最佳偏移全量采样 + 自适应阈值判 0/1
  const rows = []
  const values = []
  for (let r = 0; r < layout.rowCount; r++) {
    const vals = []
    for (let i = 0; i < layout.modulesPerRow; i++) {
      const v = sampleModule(bestDx, bestDy, r, i)
      if (v === null) return null
      vals.push(v)
    }
    rows.push(vals)
    for (const v of vals) values.push(v)
  }
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!(max - min >= minContrast)) return null
  const cut = (min + max) / 2
  return rows.map((vals) => vals.map((v) => (v < cut ? 1 : 0)))
}

// ── 位流 ↔ 行图案（生成端画、识别端读） ────────────────────────────────────────────────

/** 每行的起始 / 结束同步图案（宽窄交替，给解码端核对模块相位用） */
export const START_PATTERN = [1, 0, 1, 0, 1, 0, 1, 0]
export const STOP_PATTERN = [0, 1, 0, 1, 0, 1, 0, 1]

/**
 * 载荷 → 每一行的模块数组（含起始图案、行号、结束图案；行内数据不足补 0）。
 * @returns {number[][]} 每行 modulesPerRow 个 0/1
 */
export function payloadToRows(bytes, layout = LAYOUT.barcode) {
  const bits = []
  for (const byte of bytes) for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1)
  const rows = []
  for (let r = 0; r < layout.rowCount; r++) {
    const row = []
    row.push(...START_PATTERN.slice(0, layout.startModules))
    for (let b = layout.rowIndexModules - 1; b >= 0; b--) row.push((r >> b) & 1)
    const start = r * layout.dataModulesPerRow
    for (let i = 0; i < layout.dataModulesPerRow; i++) row.push(bits[start + i] || 0)
    row.push(...STOP_PATTERN.slice(0, layout.stopModules))
    rows.push(row)
  }
  return rows
}

/**
 * 每一行的模块数组 → 载荷字节（生成端的逆；识别端在采样之后调它）。
 * @returns {{data:Uint8Array, dataLen:number, corrected:number}|null} 图案不对 / 行号不符 / 纠错失败一律 null
 */
export function rowsToPayload(rows, layout = LAYOUT.barcode) {
  if (!Array.isArray(rows) || rows.length !== layout.rowCount) return null
  const bits = []
  for (let r = 0; r < layout.rowCount; r++) {
    const row = rows[r]
    if (!row || row.length !== layout.modulesPerRow) return null
    for (let i = 0; i < layout.startModules; i++) {
      if (row[i] !== START_PATTERN[i]) return null
    }
    let rowIndex = 0
    for (let i = 0; i < layout.rowIndexModules; i++) rowIndex = (rowIndex << 1) | (row[layout.startModules + i] ? 1 : 0)
    if (rowIndex !== r) return null
    const stopAt = layout.startModules + layout.rowIndexModules + layout.dataModulesPerRow
    for (let i = 0; i < layout.stopModules; i++) {
      if (row[stopAt + i] !== STOP_PATTERN[i]) return null
    }
    for (let i = 0; i < layout.dataModulesPerRow; i++) bits.push(row[layout.startModules + layout.rowIndexModules + i])
  }
  const total = Math.floor(bits.length / 8)
  const bytes = new Uint8Array(total)
  for (let i = 0; i < total; i++) {
    let byte = 0
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b]
    bytes[i] = byte
  }
  const decoded = codewordToData(bytes, layout)
  if (!decoded) return null
  const dataLen = readU16(decoded.data, 4)
  if (dataLen < 8 || dataLen > layout.dataBytes) return null
  return { data: decoded.data, dataLen, corrected: decoded.corrected }
}
