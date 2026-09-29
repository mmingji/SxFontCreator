// 字体格式识别与规整（阶段一步骤 1.3 的补充）
// 职责：把用户选的本机字体文件，统一成"能被 pdf-lib 直接嵌入的单个 sfnt 字体字节"。
// 为什么需要这一层：pdf-lib 只能直接嵌入**单个** TrueType / OpenType 字体；而系统字体目录里常见的
//   .ttc（TrueType Collection）是"一个文件里装多个字体"，直接喂给 pdf-lib 会失败
//   （实测报错 `_this.font.createSubset is not a function`）。
// TTC 的结构恰好允许**零依赖提取**：文件头列出各字体在文件中的偏移，每个偏移指向一个完整的 sfnt
//   表目录（表数据可被多个字体共享），把该目录与它引用的表数据重排成一个独立文件即可 ——
//   不需要解析字形、也不需要理解字体语义，因此不必引入任何新依赖。
// 实测（2026-09-29，本机 C:\Windows\Fonts）：msyh.ttc[0] → MicrosoftYaHei（30209 字形）、
//   simsun.ttc[0] → SimSun（28905 字形）、SitkaI.ttc[0]（6 个字体）提取后均可被 pdf-lib 嵌入。
// 数据来源：用户选择的本地文件，只在本机内存里使用，不上传、不入库。

// ── 格式识别 ───────────────────────────────────────────────────────

// 按文件头魔数判格式。返回 { format, label }；认不出时 format 为 'unknown'
export function detectFontFormat(bytes) {
  const tag = readTag(bytes, 0)
  if (tag === 'ttcf') return { format: 'ttc', label: 'TrueType 字体集合（TTC）' }
  if (tag === 'wOFF') return { format: 'woff', label: 'WOFF 网页字体' }
  if (tag === 'wOF2') return { format: 'woff2', label: 'WOFF2 网页字体' }
  if (tag === 'OTTO') return { format: 'otf', label: 'OpenType 字体（CFF 轮廓）' }
  if (tag === 'true' || tag === 'typ1') return { format: 'ttf', label: 'TrueType 字体' }
  // TrueType 的 sfnt 版本号是 0x00010000，按字符读出来是四个不可打印字节
  if (bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) {
    return { format: 'ttf', label: 'TrueType 字体' }
  }
  return { format: 'unknown', label: '无法识别的格式' }
}

function readTag(bytes, offset) {
  if (bytes.length < offset + 4) return ''
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

function readUint32(bytes, offset) {
  return (bytes[offset] << 24 >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]
}

function readUint16(bytes, offset) {
  return (bytes[offset] << 8) + bytes[offset + 1]
}

// ── TTC 提取 ───────────────────────────────────────────────────────

// 读 TTC 集合信息：含几个字体、各自的 postscript 名
export function readTtcInfo(bytes) {
  if (detectFontFormat(bytes).format !== 'ttc') throw new Error('不是 TTC 字体集合')
  const numFonts = readUint32(bytes, 8)
  const offsets = []
  for (let i = 0; i < numFonts; i++) offsets.push(readUint32(bytes, 12 + i * 4))
  const names = offsets.map((offset) => readFontNames(bytes, offset).postscript || '')
  return { numFonts, names }
}

// 从 TTC 里取出第 index 个字体，返回独立的 sfnt 字节。
// 做法：复制该字体的表目录，并把每张表的数据重排到新文件（表内容原样搬运，因此 checksum 依然成立）
export function extractTtcFont(bytes, index = 0) {
  if (detectFontFormat(bytes).format !== 'ttc') throw new Error('不是 TTC 字体集合')
  const numFonts = readUint32(bytes, 8)
  if (index < 0 || index >= numFonts) {
    throw new Error('字体序号超出范围：该文件含 ' + numFonts + ' 个字体，取不到第 ' + (index + 1) + ' 个')
  }
  const offset = readUint32(bytes, 12 + index * 4)
  const sfntVersion = readUint32(bytes, offset)
  const numTables = readUint16(bytes, offset + 4)

  const tables = []
  for (let i = 0; i < numTables; i++) {
    const record = offset + 12 + i * 16
    tables.push({
      tag: readUint32(bytes, record),
      checksum: readUint32(bytes, record + 4),
      offset: readUint32(bytes, record + 8),
      length: readUint32(bytes, record + 12)
    })
  }

  // sfnt 要求每张表 4 字节对齐
  const align4 = (value) => (value + 3) & ~3
  const dirSize = 12 + numTables * 16
  let total = dirSize
  const placed = tables.map((table) => {
    const newOffset = align4(total)
    total = newOffset + table.length
    return { ...table, newOffset }
  })

  const out = new Uint8Array(align4(total))
  const view = new DataView(out.buffer)
  view.setUint32(0, sfntVersion)
  view.setUint16(4, numTables)
  view.setUint16(6, readUint16(bytes, offset + 6)) // searchRange：照抄原值
  view.setUint16(8, readUint16(bytes, offset + 8)) // entrySelector
  view.setUint16(10, readUint16(bytes, offset + 10)) // rangeShift
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16
    view.setUint32(record, placed[i].tag)
    view.setUint32(record + 4, placed[i].checksum)
    view.setUint32(record + 8, placed[i].newOffset)
    view.setUint32(record + 12, placed[i].length)
    out.set(bytes.subarray(placed[i].offset, placed[i].offset + placed[i].length), placed[i].newOffset)
  }
  return out
}

// ── 字体名读取（用于告诉用户"取到的是哪个字体"）─────────────────────

// 读 name 表里的家族名与 postscript 名。只读这两项，够用于界面提示。
// 优先 Windows 平台的 UTF-16BE 记录，其次 Mac 平台的单字节记录。
function readFontNames(bytes, fontOffset) {
  const numTables = readUint16(bytes, fontOffset + 4)
  let nameTableOffset = -1
  for (let i = 0; i < numTables; i++) {
    const record = fontOffset + 12 + i * 16
    if (readTag(bytes, record) === 'name') {
      nameTableOffset = readUint32(bytes, record + 8)
      break
    }
  }
  if (nameTableOffset < 0) return { family: '', postscript: '' }

  const count = readUint16(bytes, nameTableOffset + 2)
  const storage = nameTableOffset + readUint16(bytes, nameTableOffset + 4)
  const want = { 1: '', 6: '' } // 1 = 家族名，6 = postscript 名
  let fallback = { 1: '', 6: '' }
  for (let i = 0; i < count; i++) {
    const record = nameTableOffset + 6 + i * 12
    const platformId = readUint16(bytes, record)
    const nameId = readUint16(bytes, record + 6)
    if (!(nameId in want)) continue
    const length = readUint16(bytes, record + 8)
    const offset = storage + readUint16(bytes, record + 10)
    const raw = bytes.subarray(offset, offset + length)
    const text = platformId === 3 ? decodeUtf16Be(raw) : decodeLatin1(raw)
    if (platformId === 3 && !want[nameId]) want[nameId] = text
    if (platformId !== 3 && !fallback[nameId]) fallback[nameId] = text
  }
  return {
    family: want[1] || fallback[1],
    postscript: want[6] || fallback[6]
  }
}

function decodeUtf16Be(raw) {
  let text = ''
  for (let i = 0; i + 1 < raw.length; i += 2) text += String.fromCharCode((raw[i] << 8) + raw[i + 1])
  return text
}

function decodeLatin1(raw) {
  let text = ''
  for (let i = 0; i < raw.length; i++) text += String.fromCharCode(raw[i])
  return text
}

// ── WOFF 解包 ──────────────────────────────────────────────────────

// WOFF 是"sfnt + 逐表 zlib 压缩"的包装格式，解包即还原成 sfnt（ttf / otf）。
// 用浏览器原生的 DecompressionStream，不引依赖。WOFF2 用 Brotli 且带表变换，浏览器不能原生解，明确不支持。
async function inflateWoff(bytes) {
  const numTables = readUint16(bytes, 12)
  const flavor = readUint32(bytes, 4)
  const entries = []
  for (let i = 0; i < numTables; i++) {
    const record = 44 + i * 20
    entries.push({
      tag: readUint32(bytes, record),
      offset: readUint32(bytes, record + 4),
      compLength: readUint32(bytes, record + 8),
      origLength: readUint32(bytes, record + 12),
      origChecksum: readUint32(bytes, record + 16)
    })
  }

  const align4 = (value) => (value + 3) & ~3
  const powersOfTwo = Math.floor(Math.log2(numTables))
  const searchRange = 16 * Math.pow(2, powersOfTwo)
  const dirSize = 12 + numTables * 16
  let total = dirSize
  const decoded = []
  for (const entry of entries) {
    const raw = bytes.subarray(entry.offset, entry.offset + entry.compLength)
    // compLength < origLength 表示这张表是压缩的；相等就是原样存储
    const data = entry.compLength < entry.origLength ? await inflateZlib(raw) : raw
    const newOffset = align4(total)
    total = newOffset + entry.origLength
    decoded.push({ ...entry, data, newOffset })
  }

  const out = new Uint8Array(align4(total))
  const view = new DataView(out.buffer)
  view.setUint32(0, flavor)
  view.setUint16(4, numTables)
  view.setUint16(6, searchRange)
  view.setUint16(8, powersOfTwo)
  view.setUint16(10, numTables * 16 - searchRange)
  for (let i = 0; i < decoded.length; i++) {
    const record = 12 + i * 16
    view.setUint32(record, decoded[i].tag)
    view.setUint32(record + 4, decoded[i].origChecksum)
    view.setUint32(record + 8, decoded[i].newOffset)
    view.setUint32(record + 12, decoded[i].origLength)
    out.set(decoded[i].data.subarray(0, decoded[i].origLength), decoded[i].newOffset)
  }
  return out
}

async function inflateZlib(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'))
  const buffer = await new Response(stream).arrayBuffer()
  return new Uint8Array(buffer)
}

// ── 统一入口 ───────────────────────────────────────────────────────

/**
 * 把用户选的字体文件规整成可嵌入的单个 sfnt 字体
 * @param {Uint8Array} bytes 文件内容
 * @returns {Promise<{bytes: Uint8Array, format: string, label: string, note: string}>}
 *   bytes 为规整后的字体字节；note 是给用户看的一句中文说明（如"已从字体集合中取用第 1 个"）
 * @throws {Error} 中文错误信息（含原因与建议）
 */
export async function normalizeFontBytes(bytes) {
  if (!bytes || !bytes.length) throw new Error('字体文件为空')
  const { format, label } = detectFontFormat(bytes)

  if (format === 'ttf' || format === 'otf') {
    return { bytes, format, label, note: '' }
  }

  if (format === 'ttc') {
    const { numFonts, names } = readTtcInfo(bytes)
    const font = extractTtcFont(bytes, 0)
    // 集合里通常第 1 个就是常规体；这里固定取第 1 个，并把取到的是哪个字体告诉用户
    const name = names[0] ? '（' + names[0] + '）' : ''
    const note = numFonts > 1
      ? '这个文件是字体集合，含 ' + numFonts + ' 个字体，已取用第 1 个' + name
      : '已从字体集合中取用唯一的一个字体' + name
    return { bytes: font, format: 'ttf', label, note }
  }

  if (format === 'woff') {
    const font = await inflateWoff(bytes)
    const inner = detectFontFormat(font)
    return { bytes: font, format: inner.format, label: 'WOFF（已解包为 ' + inner.label + '）', note: '已把 WOFF 网页字体解包为可嵌入的字体' }
  }

  if (format === 'woff2') {
    throw new Error('暂不支持 WOFF2 字体：它用 Brotli 压缩并带表变换，浏览器不能原生解包。请改用 ttf / otf / ttc，或先用字体工具把 woff2 转成 ttf')
  }

  throw new Error('无法识别的字体格式（文件头不是 ttf / otf / ttc / woff）：请改用 ttf、otf 或 ttc 字体文件')
}
