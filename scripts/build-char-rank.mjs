// 生成"按使用频率排列"的字序表（决策记录 八-6 的修订：模板排列方式）
// 数据来源：Jun Da《Modern Chinese Character Frequency List》（现代汉语单字频率列表）
//   —— 综合语料 1.935 亿字符（新闻 / 文学 / 非文学三个子语料），是公开可得的字频表里覆盖最好的一份。
//   首次运行下载并缓存到 .font-sources/（不入库），产物 src/data/charRank.js 入库。
// **许可**：该表版权归作者，**仅研究与教学用途**；对外分发软件本体或商用需另行取得作者书面许可。
//   登记见 THIRD-PARTY-NOTICES.md；将来若对外分发，改用标 MIT 的 hanziDB.csv（同为该表派生）或申请许可。
// 产物形态：**一个按频序排列的 6919 字字符串** —— 与 charset.js 同构，界面直接拿它当 chars 顺序即可，
//   "排列方式"因此不需要任何额外计算；Jun Da 未收录的字（部首、超纲字、107 个符号）按字表顺序排在末尾
//   （符号必须保持字表序：数字字母标点在人眼里有固定次序）。
// 规模任何一项对不上就**中止写出**：宁可报错，也不要静默产出一份错的频序表。
// 运行：npm run charrank
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHARSET } from '../src/data/charset.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src', 'data', 'charRank.js')
const CACHE = join(ROOT, '.font-sources', 'junda-char-frequency.txt')
const SOURCE_URL = 'https://lingua.mtsu.edu/chinese-computing/statistics/char/download.php?Which=MO'
const LINE_SIZE = 100

// 期望值（实测基线，来自 2026-10-04 的调研核对）：任一项对不上就中止，说明源文件变了
const EXPECT = {
  rows: 9933, // 源表数据行数
  covered: 6710, // 字表内、且被源表收录的字数
  missing: 209, // 字表内未被收录（67 个 GB2312 二级部首偏旁 + 34 个超纲字 + 107 个符号 + 1 个通用规范一级字）
  top25: '的一是不了在人有我他这个们中来上大为和国地到以说时'
}

// 源文件编码：**站上这份表是 GBK**（2026-10-04 实测：按 UTF-8 解会得到 14240 个替换字符，
// 表现是"汉字大量重复"）。这里做一次嗅探：UTF-8 解出来的替换字符超过 10 个就改用 GBK，
// 并把转成 UTF-8 的文本写回缓存 —— 下次不必再嗅探（与 charset 脚本用 TextDecoder('gbk') 同一套路）。
function decodeSource(buf) {
  const utf8 = new TextDecoder('utf-8').decode(buf)
  const bad = (utf8.match(/\uFFFD/g) || []).length
  if (bad <= 10) return { text: utf8, encoding: 'utf-8' }
  return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk' }
}

async function loadSource() {
  if (existsSync(CACHE)) {
    const { text, encoding } = decodeSource(readFileSync(CACHE))
    console.log('使用本地缓存：' + CACHE + '（编码 ' + encoding + '）')
    if (encoding !== 'utf-8') {
      writeFileSync(CACHE, text, 'utf8')
      console.log('已把缓存统一转成 UTF-8')
    }
    return text
  }
  console.log('本地无缓存，正在下载 Jun Da 现代汉语单字频率表…')
  const res = await fetch(SOURCE_URL, { headers: { 'User-Agent': 'sxfont-creator-build' } })
  if (!res.ok) throw new Error('下载失败：HTTP ' + res.status + '（可手动下载后放到 ' + CACHE + '）')
  const { text, encoding } = decodeSource(Buffer.from(await res.arrayBuffer()))
  mkdirSync(dirname(CACHE), { recursive: true })
  writeFileSync(CACHE, text, 'utf8')
  console.log('已缓存到：' + CACHE + '（源编码 ' + encoding + '，已转存 UTF-8；该目录不入库）')
  return text
}

// 源文件格式（tab 分隔、前 6 行是 /* 注释）：序列号 / 汉字 / 频率 / 累计频率(%) / 拼音 / 英文
function parse(text) {
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('/*')) continue
    const cells = line.split('\t')
    if (cells.length < 4) continue
    const rank = Number((cells[0] || '').trim())
    const char = (cells[1] || '').trim()
    const count = Number((cells[2] || '').trim())
    const cum = Number((cells[3] || '').trim())
    if (!Number.isFinite(rank) || !char || !Number.isFinite(cum)) continue
    rows.push({ rank, char, count, cum })
  }
  return rows
}

const chars = Array.from(CHARSET)
const charsetSet = new Set(chars)
const rows = parse(await loadSource())
// 语料字符总量 = 各字频次之和（源表头声明为 1.935 亿，这里算出来核对）
const corpusTotal = rows.reduce((s, r) => s + (r.count || 0), 0)

function fail(message) {
  console.error('频序数据校验不通过，已中止写出：' + message)
  process.exit(1)
}

if (rows.length !== EXPECT.rows) fail('源表数据行数应为 ' + EXPECT.rows + '，实际 ' + rows.length)
if (new Set(rows.map((r) => r.char)).size !== rows.length) fail('源表存在重复字')

// 字表内、按频序排列的字（源表里也可能出现同一个字两次的情况，去重保序）
const covered = []
const seen = new Set()
for (const row of rows) {
  if (!charsetSet.has(row.char) || seen.has(row.char)) continue
  seen.add(row.char)
  covered.push(row.char)
}
// 未被收录的字：保持**字表顺序**（符号、部首、超纲字），排在频序字的后面
const missing = chars.filter((c) => !seen.has(c))
const order = covered.concat(missing)

if (covered.length !== EXPECT.covered) fail('字表内被收录的字数应为 ' + EXPECT.covered + '，实际 ' + covered.length)
if (missing.length !== EXPECT.missing) fail('未收录的字数应为 ' + EXPECT.missing + '，实际 ' + missing.length)
if (order.length !== chars.length) fail('合并后的字数应为 ' + chars.length + '，实际 ' + order.length)
if (new Set(order).size !== chars.length) fail('合并后存在重复字')
if (order.slice(0, 25).join('') !== EXPECT.top25) {
  fail('频序前 25 字与实测基线不符：' + order.slice(0, 25).join(''))
}

const cum2000 = rows.find((r) => r.rank === 2000)
const cum3755 = rows.find((r) => r.rank === 3755)
if (!cum2000 || !cum3755) fail('源表里找不到第 2000 / 3755 条，无法记录累计覆盖率')

// 折行成字符串数组再用 join('') 拼回 —— 与 charset.js / frequency.js 同一做法，便于 diff
const wrap = (text) => {
  const lines = []
  for (let i = 0; i < text.length; i += LINE_SIZE) lines.push(text.slice(i, i + LINE_SIZE))
  return '[\n' + lines.map((line) => '      ' + JSON.stringify(line)).join(',\n') + '\n    ].join(\'\')'
}

const body = `// 本文件由 scripts/build-char-rank.mjs 生成，请勿手改（要换数据源或更新版本就改脚本后重跑 npm run charrank）。
// 数据来源：Jun Da《Modern Chinese Character Frequency List》（现代汉语单字频率列表），
//   综合语料 ${corpusTotal} 字符；原始文件缓存于 .font-sources/（不入库）。
// **许可**：版权归作者，仅研究与教学用途；对外分发或商用需另行取得作者许可 —— 见 THIRD-PARTY-NOTICES.md。
// 内容：字表内**按使用频率从高到低**排列的 ${chars.length} 字；源表未收录的 ${missing.length} 字
//   （67 个 GB2312 二级部首偏旁 + 34 个超纲字 + 107 个符号，另有 1 个通用规范一级字）按**字表顺序**排在末尾。
// 用法：见 src/lib/charRank.js（界面上的"排列方式：使用频率"直接拿它当模板字序）。

export const CHAR_RANK_META = {
  sourceName: 'Modern Chinese Character Frequency List（Jun Da）',
  sourceUrl: 'https://lingua.mtsu.edu/chinese-computing/statistics/',
  sourceRows: ${rows.length},
  corpusChars: ${corpusTotal},
  covered: ${covered.length},
  missing: ${missing.length},
  charsetTotal: ${chars.length},
  // 源表口径的累计覆盖率：前 2000 条 / 前 3755 条覆盖了多少语料
  cumAt2000: ${cum2000.cum.toFixed(2)},
  cumAt3755: ${cum3755.cum.toFixed(2)},
  license: '版权归作者，仅研究与教学用途；对外分发或商用需另行取得作者许可（见 THIRD-PARTY-NOTICES.md）'
}

// 按使用频率从高到低排列的 ${chars.length} 字（每行 ${LINE_SIZE} 字便于 diff）
export const RANK_ORDER =
    ${wrap(order.join(''))}
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, body, 'utf8')
console.log('已生成频序数据：' + OUT)
console.log('  源表 ' + rows.length + ' 条 / 语料 ' + corpusTotal + ' 字符')
console.log('  字表内被收录 ' + covered.length + ' 字，未收录 ' + missing.length + ' 字（已按字表顺序排在末尾）')
console.log('  累计覆盖：前 2000 条 ' + cum2000.cum.toFixed(2) + '%，前 3755 条 ' + cum3755.cum.toFixed(2) + '%')
console.log('  频序前 25 字：' + order.slice(0, 25).join(''))
