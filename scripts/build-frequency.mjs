// 生成选字用的频次分级数据（决策记录 八-2、八-6）
// 两套标准都做：
//   ① GB2312 —— 一级常用 3755 / 二级次常用 3008：**零外部数据**，用 TextDecoder('gbk') 反向枚举区位码
//      得到"字符 → 一级/二级"，再与字表求交。
//   ② 通用规范汉字表（2013，国务院公布）—— 一级 3500 / 二级 3000 / 三级 1605：需要外部字表，
//      首次运行下载并缓存到 .font-sources/（不入库），产物入库。
// 为什么产物只保留**字表内的字**：选字界面只可能选字表里的 6919 字，别的字印不出来也用不上；
//   过滤后文件更小，且"这一级在字表里有多少字"正是界面要显示的数字。
// 规模任何一项对不上就**中止写出**：宁可报错，也不要静默产出一份错的分级表。
// 运行：npm run frequency
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHARSET } from '../src/data/charset.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src', 'data', 'frequency.js')
const CACHE = join(ROOT, '.font-sources', 'general-standard-chinese-2013.txt')
const SOURCE_URL =
  'https://raw.githubusercontent.com/lqfeng/ChineseCharacters/master/' +
  encodeURIComponent('通用规范汉字表(2013)全部(8105字).txt')
const LINE_SIZE = 100

const chars = Array.from(CHARSET)
const charsetSet = new Set(chars)
const isHan = (c) => {
  const cp = c.codePointAt(0)
  return cp >= 0x4e00 && cp <= 0x9fff
}

// ── ① GB2312：按 GBK 区位枚举 ────────────────────────────────────────
// GB2312 一级汉字在 0xB0A1~0xD7FE、二级在 0xD8A1~0xF7FE；
// GBK 在这些区的空位上补过少量私用区字符（实测 5 个，均不在字表内），过滤字表后不影响计数。
function buildGb2312() {
  const dec = new TextDecoder('gbk')
  const level1 = []
  const level2 = []
  for (let hi = 0xb0; hi <= 0xf7; hi++) {
    for (let lo = 0xa1; lo <= 0xfe; lo++) {
      const ch = dec.decode(new Uint8Array([hi, lo]))
      if (!ch || ch.length !== 1 || ch === '\uFFFD') continue
      if (!charsetSet.has(ch)) continue // 只要字表内的字
      if (hi <= 0xd7) level1.push(ch)
      else level2.push(ch)
    }
  }
  // 顺序统一成"字表顺序"，这样批次字序与全量表位置一致（八-6）
  const order = new Map(chars.map((c, i) => [c, i]))
  const byCharsetOrder = (list) => list.sort((a, b) => order.get(a) - order.get(b)).join('')
  return { level1: byCharsetOrder(level1), level2: byCharsetOrder(level2) }
}

// ── ② 通用规范汉字表（2013）──────────────────────────────────────────
async function loadTongguiText() {
  if (existsSync(CACHE)) {
    console.log('使用本地缓存：' + CACHE)
    return readFileSync(CACHE, 'utf8')
  }
  console.log('本地无缓存，正在下载《通用规范汉字表》…')
  const res = await fetch(SOURCE_URL, { headers: { 'User-Agent': 'sxfont-creator-build' } })
  if (!res.ok) throw new Error('下载失败：HTTP ' + res.status + '（可手动下载后放到 ' + CACHE + '）')
  const text = await res.text()
  mkdirSync(dirname(CACHE), { recursive: true })
  writeFileSync(CACHE, text, 'utf8')
  console.log('已缓存到：' + CACHE + '（该目录不入库）')
  return text
}

// 源文件格式：每行「序号 制表符 字 制表符 拼音」，序号 0001~8105 与表的顺序一致
function parseTonggui(text) {
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => line.split('\t'))
    .filter((cells) => cells.length >= 2 && /^[0-9]{4}$/.test((cells[0] || '').trim()))
  const all = rows.map((cells) => (cells[1] || '').trim())
  return { all, l1: all.slice(0, 3500), l2: all.slice(3500, 6500), l3: all.slice(6500) }
}

function fail(message) {
  console.error('分级数据校验不通过，已中止写出：' + message)
  process.exit(1)
}

const gb = buildGb2312()
if (gb.level1.length !== 3755) fail('GB2312 一级字在字表内应为 3755，实际 ' + gb.level1.length)
if (gb.level2.length !== 3008) fail('GB2312 二级字在字表内应为 3008，实际 ' + gb.level2.length)

const tgText = await loadTongguiText()
const tg = parseTonggui(tgText)
if (tg.all.length !== 8105) fail('通用规范汉字表总数应为 8105，实际 ' + tg.all.length)
if (tg.l1.length !== 3500 || tg.l2.length !== 3000 || tg.l3.length !== 1605) {
  fail('通用规范汉字表分级应为 3500 / 3000 / 1605，实际 ' + tg.l1.length + ' / ' + tg.l2.length + ' / ' + tg.l3.length)
}
if (new Set(tg.all).size !== 8105) fail('通用规范汉字表存在重复字')

// 只保留字表内的字，并统一按字表顺序排列
const order = new Map(chars.map((c, i) => [c, i]))
const inCharsetOrder = (list) =>
  list
    .filter((c) => charsetSet.has(c))
    .sort((a, b) => order.get(a) - order.get(b))
    .join('')
const tg1 = inCharsetOrder(tg.l1)
const tg2 = inCharsetOrder(tg.l2)
const tg3 = inCharsetOrder(tg.l3)

const hanCount = chars.filter(isHan).length
const gbCovered = new Set([...gb.level1, ...gb.level2]).size
const tgCovered = new Set([...tg1, ...tg2, ...tg3]).size

// 折行成字符串数组并用 join('') 拼回 —— 只为便于阅读与 diff（与 charset.js 同一做法）
const wrap = (text) => {
  const lines = []
  for (let i = 0; i < text.length; i += LINE_SIZE) lines.push(text.slice(i, i + LINE_SIZE))
  return '[\n' + lines.map((line) => '      ' + JSON.stringify(line)).join(',\n') + '\n    ].join(\'\')'
}

const body = `// 本文件由 scripts/build-frequency.mjs 生成，请勿手改（要改分级就改脚本后重跑 npm run frequency）。
// 数据来源：① GB2312 分级由区位码本地推算（TextDecoder('gbk') 反向枚举，无外部数据）；
//           ② 通用规范汉字表（2013，国务院公布）取自公开字表文件，缓存于 .font-sources/（不入库）。
// 内容：只保留**字表内的字**（选字界面只可能选这 ${chars.length} 字），各段均按**字表顺序**排列 ——
//       批次字序即全量表位置顺序，保证顺序可复现（决策记录 八-6）。
// 未列入任何一级的字（如符号、超纲字）不在这里存，由 src/lib/frequency.js 用全集相减得出。
// 用法：见 src/lib/frequency.js。

export const FREQUENCY_META = {
  charsetTotal: ${chars.length},
  charsetHan: ${hanCount},
  gb2312Covered: ${gbCovered},
  tongguiCovered: ${tgCovered}
}

// ① GB2312：一级常用 ${gb.level1.length} 字 / 二级次常用 ${gb.level2.length} 字（字表内的数量）
export const GB2312_LEVELS = [
  {
    key: 'gb1',
    label: '一级常用字',
    note: 'GB2312 一级（按拼音排序），覆盖日常使用频度约 99.9%',
    chars:
${wrap(gb.level1)}
  },
  {
    key: 'gb2',
    label: '二级次常用字',
    note: 'GB2312 二级（按部首排序），补上后可用字基本齐全',
    chars:
${wrap(gb.level2)}
  }
]

// ② 通用规范汉字表（2013）：一级 3500 / 二级 3000 / 三级 1605（国家公布口径），
//    这里同样只列字表内的字
export const TONGGUI_LEVELS = [
  {
    key: 'tg1',
    label: '一级字表',
    note: '常用字集，满足基础教育与文化普及的基本用字需要',
    chars:
${wrap(tg1)}
  },
  {
    key: 'tg2',
    label: '二级字表',
    note: '使用度仅次于一级字，与一级合计覆盖出版印刷等一般用字需要',
    chars:
${wrap(tg2)}
  },
  {
    key: 'tg3',
    label: '三级字表',
    note: '姓氏人名、地名、科技术语等领域的专门用字',
    chars:
${wrap(tg3)}
  }
]
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, body, 'utf8')
console.log('已生成分级数据：' + OUT)
console.log('  字表内 GB2312 覆盖 ' + gbCovered + ' 字（一级 ' + gb.level1.length + ' / 二级 ' + gb.level2.length + '）')
console.log('  字表内通用规范汉字表覆盖 ' + tgCovered + ' 字（一级 ' + tg1.length + ' / 二级 ' + tg2.length + ' / 三级 ' + tg3.length + '）')
console.log('  两套都没覆盖的字（符号与超纲字）：' + (chars.length - gbCovered) + ' / ' + (chars.length - tgCovered))
