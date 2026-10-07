// 选字分类（决策记录 八-1、八-2；2026-10-07 修订：只留 GB2312 一套，并把基础字符单独成类）
// 职责：算出选字界面左侧分类树要用的数据 —— 每类有哪些字、各多少字。
// 为什么只留 GB2312（2026-10-07 用户拍板）：两套标准在界面上只多一个切换开关，实际能选的字几乎一样
//   （GB2312 与 6919 字表**完全重合** 6763 字；通用规范表覆盖 6677 字，另外 242 字只能落进"其它"），
//   留一套更省心 —— 修订《决策记录》八-2。
// 为什么不需要数据文件：GB2312 的分级是**标准算法**（区位码），用 TextDecoder('gbk') 反向枚举即可算出，
//   存一份 42KB 的派生数据文件属于冗余 —— 2026-10-07 删掉 src/data/frequency.js 与 scripts/build-frequency.mjs，
//   分级改在这里运行时算（与 scripts/build-charset.mjs 那类"读外部源文件"的生成脚本不是一回事）。
// 为什么把基础字符单独成类：数字 / 拉丁字母 / 标点是"最常用、最该先做"的一批（缺了它们，
//   "2026年"这类中英混排没法用），原先混在"其它"里 —— 2026-10-07 用户要求拎出来、单独成一类
//   （数字、字母、标点**合成一类**，不再细分）。
import { getAllChars, classifyChar } from './charset.js'

const ALL = getAllChars()
const ALL_SET = new Set(ALL)
const ORDER = new Map(ALL.map((c, i) => [c, i]))

// GB2312 区位枚举：一级汉字在 0xB0A1~0xD7FE、二级在 0xD8A1~0xF7FE。
// 按 GBK 解码这些区位即可拿到该字的字符（GBK 在空位补过少量私用区字符，实测 5 个、都不在字表内）。
function gb2312Levels() {
  const dec = new TextDecoder('gbk')
  const level1 = []
  const level2 = []
  for (let hi = 0xb0; hi <= 0xf7; hi++) {
    for (let lo = 0xa1; lo <= 0xfe; lo++) {
      const ch = dec.decode(new Uint8Array([hi, lo]))
      if (!ch || ch.length !== 1 || ch === '\uFFFD') continue
      if (!ALL_SET.has(ch)) continue // 选字界面只可能选字表里的 6919 字，别的字印不出来
      if (hi <= 0xd7) level1.push(ch)
      else level2.push(ch)
    }
  }
  return [level1, level2]
}

// 统一排成**字表顺序**：批次字序就是全量表位置顺序，顺序可复现（决策记录 八-6）
const byCharsetOrder = (list) => list.slice().sort((a, b) => ORDER.get(a) - ORDER.get(b)).join('')

const [gb1Raw, gb2Raw] = gb2312Levels()
const GB1 = byCharsetOrder(gb1Raw)
const GB2 = byCharsetOrder(gb2Raw)
const GB_COVERED = new Set([...GB1, ...GB2])

// 不在 GB2312 里的字：按字符类型分成"数字与拉丁字母""标点与符号""其它（超纲字）"
const letters = []
const symbols = []
const extra = []
for (const ch of ALL) {
  if (GB_COVERED.has(ch)) continue
  const cls = classifyChar(ch)
  if (cls === 'halfwidth') letters.push(ch)
  else if (cls === 'symbol') symbols.push(ch)
  else extra.push(ch)
}

// 分类树的数据源（顺序即界面上的显示顺序）
export const SELECTION_LEVELS = [
  {
    key: 'gb1',
    label: '一级常用字',
    note: 'GB2312 一级（按拼音排序），覆盖日常使用频度约 99.9%',
    chars: GB1
  },
  {
    key: 'gb2',
    label: '二级次常用字',
    note: 'GB2312 二级（按部首排序），补上后可用字基本齐全',
    chars: GB2
  },
  {
    key: 'symbols',
    label: '数字、字母与标点',
    note: '半角数字与拉丁字母、中文标点与全角符号 —— 做日常可用的字体，这批要先有（如「2026年」这类混排）',
    chars: [...letters, ...symbols].sort((a, b) => ORDER.get(a) - ORDER.get(b)).join('')
  },
  {
    key: 'extra',
    label: '其它（超纲字）',
    note: '不在 GB2312 内的汉字（囧、喆、赟、玥等）',
    chars: extra.join('')
  }
]

// 统计（界面展示与自检用）
export const SELECTION_META = {
  charsetTotal: ALL.length,
  levels: SELECTION_LEVELS.map((level) => ({ key: level.key, label: level.label, count: level.chars.length }))
}

// 按分类取字（返回字符数组，顺序即字表顺序 = 批次字序）
export function getLevelChars(levelKey) {
  const level = SELECTION_LEVELS.find((item) => item.key === levelKey)
  return level ? Array.from(level.chars) : []
}

// 某个字属于哪一类（找不到返回 null）—— 字网格上给每个字标类型用
export function findLevelOf(char) {
  return SELECTION_LEVELS.find((level) => level.chars.includes(char)) || null
}

// 把任意字符列表过滤成"字表内的字"，并按字表顺序排序 —— 批次字序的统一出口（决策记录 八-6）
export function normalizeSelection(list) {
  const wanted = new Set(Array.from(list || '').filter((ch) => ALL_SET.has(ch)))
  return ALL.filter((ch) => wanted.has(ch))
}

// 检索：在字表范围内按输入顺序找出匹配的字（决策 八-5：支持整段粘贴，按粘贴顺序返回）
export function searchChars(query) {
  const text = String(query || '')
  const hits = []
  const seen = new Set()
  for (const ch of text) {
    if (ALL_SET.has(ch) && !seen.has(ch)) {
      seen.add(ch)
      hits.push(ch)
    }
  }
  return hits
}
