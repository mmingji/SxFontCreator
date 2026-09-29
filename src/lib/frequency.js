// 选字用的频次分级（决策记录 八-1、八-2）
// 职责：把两套频次标准包装成界面可直接用的分类树数据 —— 每级有哪些字、各多少字、"其它"兜底是什么。
// 数据来源：src/data/frequency.js（由 scripts/build-frequency.mjs 生成，只含字表内的字、按字表顺序）。
// 为什么两套都提供：GB2312 分级零外部数据、与字表天然重合；通用规范汉字表是国家公布口径（2013），
//   两者覆盖略有差异（实测字表内 GB2312 覆盖 6763 字、通用规范表覆盖 6677 字），界面上可切换。
// 为什么有「其它」：符号（107 个）与超纲字不属于任何一级，它们同样是字表的一部分、也要能选，
//   所以每套标准都补一个兜底分类。兜底内容用全集相减实时算出，不写进数据文件（省体积、也不会不一致）。
import { getAllChars } from './charset.js'
import { GB2312_LEVELS, TONGGUI_LEVELS, FREQUENCY_META } from '../data/frequency.js'

const ALL = getAllChars()
const ALL_SET = new Set(ALL)

// 全集减去已分级的字 = 「其它」。顺序仍按字表顺序
function buildOther(levels) {
  const covered = new Set()
  for (const level of levels) for (const ch of level.chars) covered.add(ch)
  return ALL.filter((ch) => !covered.has(ch)).join('')
}

function withOther(setKey, setLabel, setNote, levels) {
  const otherChars = buildOther(levels)
  return {
    key: setKey,
    label: setLabel,
    note: setNote,
    levels: [
      ...levels.map((level) => ({ ...level, count: level.chars.length, setKey })),
      {
        key: 'other',
        setKey,
        label: '其它（符号与超纲字）',
        note: '不属于本标准的任何一级：107 个数字/字母/标点，以及不在该标准内的汉字',
        chars: otherChars,
        count: otherChars.length
      }
    ]
  }
}

// 两套标准（界面上的分类树就用这个结构渲染）
export const FREQUENCY_SETS = [
  withOther(
    'gb2312',
    'GB2312 分级',
    '由区位码本地推算，与字表天然重合；一级字覆盖日常使用频度约 99.9%',
    GB2312_LEVELS
  ),
  withOther(
    'tonggui',
    '通用规范汉字表（2013）',
    '国务院公布的国家标准字表：一级 3500 / 二级 3000 / 三级 1605（这里只列字表内的字）',
    TONGGUI_LEVELS
  )
]

export { FREQUENCY_META }

export function getFrequencySet(setKey) {
  return FREQUENCY_SETS.find((set) => set.key === setKey) || FREQUENCY_SETS[0]
}

// 按分类取字（返回字符数组，顺序即字表顺序 = 批次字序）
export function getLevelChars(setKey, levelKey) {
  const set = getFrequencySet(setKey)
  const level = set.levels.find((item) => item.key === levelKey)
  return level ? Array.from(level.chars) : []
}

// 某个字在某套标准里属于哪一级（找不到返回 null）—— 字网格上给每个字标级别用
export function findLevelOf(char, setKey) {
  const set = getFrequencySet(setKey)
  for (const level of set.levels) {
    if (level.chars.includes(char)) return level
  }
  return null
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
