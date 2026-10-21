// TrueType 水平度量（hmtx）补全 —— 零依赖纯函数。
//
// 职责：把 TTF 的 hmtx 表补成"每个字形一条完整度量"（hhea.numberOfHMetrics = maxp.numGlyphs）。
//
// 为什么要做（2026-10-21 用户实测）：
//   fonteditor-core 写 TTF 时会**压缩 hmtx**（`hmtx.size()` 从最后一个字形往前数，把 advance 相同的
//   尾部字形合并）—— 生成的文件里 numberOfHMetrics 可能只有 3，而字形有 108 个。按 TTF 规范这是
//   合法的："numberOfHMetrics 之后的字形继承最后一项的 advanceWidth，只额外存 lsb"。
//   但 Word 的排版实现不认这条继承：它把 gid ≥ numberOfHMetrics 的字形的 advanceWidth 当成 0，
//   于是"山不在高"四个字挤成一团（字间距消失）；Photoshop 按规范读，显示正常。
//   实测样本（test/.tmp/font-sample.ttf）：numberOfHMetrics = 3 / numGlyphs = 108，
//   第 3 项之后 advance 全是 1000，Word 里却全挤在一起。
//
// 为什么不改 fonteditor-core：它是 node_modules 里的第三方包、打补丁不可持续；
//   而且在写出后重排一次表数据成本很低（全量 8274 字只多约 16KB）。
//
// 做法：解析表目录 → 读出旧 hmtx（含继承规则的展开）→ 重建"每字 4 字节"的 hmtx →
//   更新 hhea 的 numberOfHMetrics → 按原表顺序重排文件 → 重算每张表的 checksum 与
//   head.checkSumAdjustment。任何结构不符预期（不是 TTF、表缺失、长度对不上）都**原样返回**，
//   宁可让字体保持旧样，也不写坏一份字体。

const SFNT_VERSION_TRUETYPE = 0x00010000
const SFNT_VERSION_TRUE = 0x74727565 // 'true'
const CHECKSUM_MAGIC = 0xb1b0afba

/** 读 4 字节 tag */
function readTag(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
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

function align4(n) {
  return (n + 3) & ~3
}

/**
 * 把 hmtx 补成"每字一条"。
 * @param {Uint8Array|Buffer} input TTF 字节
 * @returns {Uint8Array} 修复后的字节；不需要修 / 结构不符时原样返回（Uint8Array 视图）
 */
export function ensureFullHorizontalMetrics(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength < 12) return bytes
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sfnt = dv.getUint32(0)
  if (sfnt !== SFNT_VERSION_TRUETYPE && sfnt !== SFNT_VERSION_TRUE) return bytes
  const numTables = dv.getUint16(4)
  if (numTables <= 0 || 12 + numTables * 16 > bytes.byteLength) return bytes

  const tables = []
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    const tag = readTag(bytes, rec)
    const offset = dv.getUint32(rec + 8)
    const length = dv.getUint32(rec + 12)
    if (offset + length > bytes.byteLength) return bytes
    tables.push({ tag, offset, length, data: bytes.subarray(offset, offset + length) })
  }
  const byTag = new Map(tables.map((t) => [t.tag, t]))
  const maxp = byTag.get('maxp')
  const hhea = byTag.get('hhea')
  const hmtx = byTag.get('hmtx')
  const head = byTag.get('head')
  if (!maxp || !hhea || !hmtx || !head) return bytes
  if (hhea.length < 36 || maxp.length < 6) return bytes

  const maxpDv = new DataView(maxp.data.buffer, maxp.data.byteOffset, maxp.data.byteLength)
  const numGlyphs = maxpDv.getUint16(4)
  const hheaDv = new DataView(hhea.data.buffer, hhea.data.byteOffset, hhea.data.byteLength)
  const origNhm = hheaDv.getUint16(34)
  if (numGlyphs <= 0 || origNhm <= 0 || origNhm > numGlyphs) return bytes
  // 已经是"每字一条"，不需要修
  if (origNhm === numGlyphs) return bytes
  // 旧 hmtx 的期望长度：前 nhm 条 4 字节 + 其余每条 2 字节（只存 lsb）
  const expectLen = origNhm * 4 + (numGlyphs - origNhm) * 2
  if (hmtx.length < expectLen) return bytes

  // 展开继承：numberOfHMetrics 之后的字形沿用最后一条的 advanceWidth
  const hmtxDv = new DataView(hmtx.data.buffer, hmtx.data.byteOffset, hmtx.data.byteLength)
  const advances = new Uint16Array(numGlyphs)
  const lsbs = new Int16Array(numGlyphs)
  for (let i = 0; i < origNhm; i++) {
    advances[i] = hmtxDv.getUint16(i * 4)
    lsbs[i] = hmtxDv.getInt16(i * 4 + 2)
  }
  const lastAdvance = advances[origNhm - 1]
  for (let i = origNhm; i < numGlyphs; i++) {
    advances[i] = lastAdvance
    lsbs[i] = hmtxDv.getInt16(origNhm * 4 + (i - origNhm) * 2)
  }

  // 重建 hmtx：每字 4 字节
  const newHmtx = new Uint8Array(numGlyphs * 4)
  const newHmtxDv = new DataView(newHmtx.buffer)
  for (let i = 0; i < numGlyphs; i++) {
    newHmtxDv.setUint16(i * 4, advances[i])
    newHmtxDv.setInt16(i * 4 + 2, lsbs[i])
  }
  // 重建 hhea：只改 numberOfHMetrics（offset 34）
  const newHhea = new Uint8Array(hhea.data)
  new DataView(newHhea.buffer).setUint16(34, numGlyphs)
  // head 的 checkSumAdjustment 先置 0，最后统一回填
  const newHead = new Uint8Array(head.data)
  new DataView(newHead.buffer).setUint32(8, 0)

  for (const t of tables) {
    if (t.tag === 'hmtx') t.data = newHmtx
    else if (t.tag === 'hhea') t.data = newHhea
    else if (t.tag === 'head') t.data = newHead
  }

  // 重排：头 12 字节 + 表目录 + 表数据（各表 4 字节对齐）
  let cursor = 12 + numTables * 16
  for (const t of tables) {
    cursor = align4(cursor)
    t.newOffset = cursor
    cursor += t.data.length
  }
  const total = align4(cursor)
  const out = new Uint8Array(total)
  out.set(bytes.subarray(0, 12), 0)

  // 表目录（checksum 先写 0 占位，数据写完再回填）
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i]
    const rec = 12 + i * 16
    for (let k = 0; k < 4; k++) out[rec + k] = t.tag.charCodeAt(k)
    const odv = new DataView(out.buffer)
    odv.setUint32(rec + 4, 0)
    odv.setUint32(rec + 8, t.newOffset)
    odv.setUint32(rec + 12, t.data.length)
    out.set(t.data, t.newOffset)
  }
  // 回填 checksum
  const outDv = new DataView(out.buffer)
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i]
    outDv.setUint32(12 + i * 16 + 4, tableChecksum(out, t.newOffset, t.data.length))
  }
  // 整文件 checksum → head.checkSumAdjustment
  const sum = tableChecksum(out, 0, out.length)
  const adjustment = (CHECKSUM_MAGIC - sum) >>> 0
  outDv.setUint32(head.newOffset + 8, adjustment)
  return out
}

/**
 * 解析 hmtx，返回每字 advanceWidth（按继承规则展开）。
 * 测试与诊断用；结构不符返回 null。
 * @param {Uint8Array|Buffer} input
 * @returns {{numGlyphs:number, numberOfHMetrics:number, advances:Uint16Array}|null}
 */
export function readHorizontalMetrics(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength < 12) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const numTables = dv.getUint16(4)
  const byTag = new Map()
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    byTag.set(readTag(bytes, rec), { offset: dv.getUint32(rec + 8), length: dv.getUint32(rec + 12) })
  }
  const maxp = byTag.get('maxp')
  const hhea = byTag.get('hhea')
  const hmtx = byTag.get('hmtx')
  if (!maxp || !hhea || !hmtx) return null
  const numGlyphs = dv.getUint16(maxp.offset + 4)
  const nhm = dv.getUint16(hhea.offset + 34)
  if (numGlyphs <= 0 || nhm <= 0 || nhm > numGlyphs) return null
  if (hmtx.length < nhm * 4 + (numGlyphs - nhm) * 2) return null
  const advances = new Uint16Array(numGlyphs)
  for (let i = 0; i < nhm; i++) advances[i] = dv.getUint16(hmtx.offset + i * 4)
  for (let i = nhm; i < numGlyphs; i++) advances[i] = advances[nhm - 1]
  return { numGlyphs, numberOfHMetrics: nhm, advances }
}
