// 选字分类（决策记录 八-1、八-2；2026-10-08 换成官方口径）
// 职责：算出选字界面左侧分类树要用的数据 —— 每类有哪些字、各多少字。
//
// 分类维度 = 《通用规范汉字表》的**规范三级 + 基础字符**（四类）：
//   一级 3500 / 二级 3000 / 三级 1605 / 基础字符 169 = 8274（全量）。
// 为什么不需要数据文件：分级就是**字表位置的切片** —— 官方字表序号 1~3500 一级、3501~6500 二级、
//   6501~8105 三级（《通用规范汉字表》说明第二条），基础字符是字表末尾那 169 个；
//   全部由字表本身推得，存一份派生数据属于冗余。
// 与旧口径的差（2026-10-08 用户拍板换源）：原来的 GB2312 区位码分级（一级 3755 / 二级 3008）
//   与"超纲字"两类概念**全部删除** —— GB2312（1980）是编码字符集，它的分级既不是用字规范、
//   也漏掉 119 个规范一级字（调研与实测见 docs/字表标准与收字口径.md）。
import { getAllChars, getCharsetMeta } from './charset.js'

const ALL = getAllChars()
const ALL_SET = new Set(ALL)
const META = getCharsetMeta()
const { l1, l2, l3 } = META.levels

// 分类树的数据源（顺序即界面上的显示顺序）：四类互不重叠、并集 = 全集。
// **chars 用数组而不是字符串**：字表里有 273 个非基本区汉字（其中 196 个是扩展 B 区的代理对），
//   字符串的 `.length` 按 UTF-16 码元算、会把这 196 个字各多算一个 —— 分级计数、界面上的"已选 / 总数"
//   都会跟着虚高（实测：二级显示成 3003、三级显示成 1798）。数组的长度才是字符数。
export const SELECTION_LEVELS = [
  {
    key: 'l1',
    label: '一级常用字',
    note: '《通用规范汉字表》一级：常用字集，主要满足基础教育和文化普及的基本用字需要',
    chars: ALL.slice(0, l1)
  },
  {
    key: 'l2',
    label: '二级次常用字',
    note: '《通用规范汉字表》二级：使用度仅次于一级字；一、二级合计 6500 字，满足出版印刷、辞书编纂与信息处理的一般用字需要',
    chars: ALL.slice(l1, l1 + l2)
  },
  {
    key: 'l3',
    label: '三级字',
    note: '《通用规范汉字表》三级：姓氏人名、地名、科学技术术语与中小学文言文用字中较通用的一部分',
    chars: ALL.slice(l1 + l2, l1 + l2 + l3)
  },
  {
    key: 'base',
    label: '基础字符',
    note: '半角 ASCII（空格到 ~，含 # @ % &）+ 中文标点 + 常用全角符号：做一套日常可用的字体，这批要先有（如「2026年」这类中英混排）',
    chars: ALL.slice(l1 + l2 + l3)
  }
]

// 统计（界面展示与自检用）
export const SELECTION_META = {
  charsetTotal: ALL.length,
  levels: SELECTION_LEVELS.map((level) => ({ key: level.key, label: level.label, count: level.chars.length }))
}

// 按分类取字（返回字符数组，顺序即字表顺序）。返回副本，避免调用方改到分类表
export function getLevelChars(levelKey) {
  const level = SELECTION_LEVELS.find((item) => item.key === levelKey)
  return level ? level.chars.slice() : []
}

// 某个字属于哪一类（找不到返回 null）—— 字网格上给每个字标类型用
export function findLevelOf(char) {
  return SELECTION_LEVELS.find((level) => level.chars.includes(char)) || null
}

// 把任意字符列表过滤成"字表内的字"，并按字表顺序排序 —— 选字的统一出口（决策记录 八-6）
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
