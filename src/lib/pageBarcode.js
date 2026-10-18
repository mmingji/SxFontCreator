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
  correction: 2, // 更正册（空白册：页脚页号走 128+ 区间，载荷里没有字序）
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
export const FULL_ORDER_LABEL = {
  0: '单页试打页序',
  1: '常用 6500 字 · 按使用频率',
  2: '常用 6500 字 · 笔画序',
  3: '全量 8274 字 · 按使用频率',
  4: '全量 8274 字 · 笔画序'
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
 * 解错误值（GF(256) 上的高斯消元）：Σ_k e_k · X_k^j = S_j（j = 0…e−1），X_k = α^(n−1−p_k)。
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
 * 把"这一页的字在字表里的序号"编成载荷。
 * @param {number[]} indexes 升序或乱序的字表序号（0 基）
 * @param {{fullOrderId:number,start:number,count:number}|null} seg 这一页是内置全序的连续段时给出
 */
export function encodeOrderPayload(indexes, seg) {
  const list = (indexes || []).filter((v) => Number.isInteger(v) && v >= 0)
  if (!list.length) return { code: ORDER_CODE.none, bytes: [] }
  if (seg && Number.isInteger(seg.fullOrderId)) {
    const bytes = [seg.fullOrderId & 0xff]
    writeU16(bytes, seg.start | 0)
    bytes.push(seg.count & 0xff)
    return { code: ORDER_CODE.segment, bytes }
  }
  // delta：只在严格升序时可用（首项 2 字节，后续存"差值 − 1"的 varint）
  let ascending = true
  for (let i = 1; i < list.length; i++) if (list[i] <= list[i - 1]) ascending = false
  const deltaBytes = ascending ? (() => {
    const out = []
    writeU16(out, list[0])
    for (let i = 1; i < list.length; i++) encodeVarint(out, list[i] - list[i - 1] - 1)
    return out
  })() : null
  // fixed：每字 14 位（8274 < 2^14），乱序也能装
  const fixedBytes = (() => {
    const bits = []
    for (const v of list) for (let b = 13; b >= 0; b--) bits.push((v >> b) & 1)
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
      indexes.push(v)
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
 * @param {number} input.charCount 这一页的字数（不含空白格）
 * @param {number[]} [input.indexes] 这一页的字在字表里的序号（按格号升序）
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
 * @returns {{bytes:Uint8Array, corrected:number}|null} 图案不对 / 行号不符 / 纠错失败一律 null
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
