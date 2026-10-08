// 按使用频率排列的字序（界面上的"排列方式：使用频率"）
// 职责：把 data/charRank.js 里那个频序字符串包成几个查询函数 —— 取全序、查某个字的名次。
// 数据来源：Jun Da《Modern Chinese Character Frequency List》（见 scripts/build-char-rank.mjs 与
//   THIRD-PARTY-NOTICES.md 的许可说明）。6976 个被收录的字按频序在前，1298 个未收录的
//   （1129 个汉字 + 169 个基础字符）按字表顺序（官方笔画序）排在末尾。
// 为什么单独一层：数据文件是"生成物"（重跑脚本会整份覆盖），查询与缓存放这里；
//   与 frequency.js（分级）/ charset.js（字表）的分工保持一致。
import { RANK_ORDER, CHAR_RANK_META } from '../data/charRank.js'

export { CHAR_RANK_META }

// 惰性建索引：八千多个字符的 Map 很小，但没必要在模块加载时就建（首屏只用到字表时用不上它）。
// **只给"被字频表收录"的前 covered 字建索引**（6976 个）—— 未收录的 1298 字（1129 个汉字与
// 169 个基础字符）虽然也在频序表里（排在末尾），但它们的"常用度名次"是没有意义的，查询一律返回 null。
let cache = null
function index() {
  if (!cache) {
    const list = Array.from(RANK_ORDER)
    const pos = new Map()
    const covered = Math.min(CHAR_RANK_META.covered, list.length)
    for (let i = 0; i < covered; i++) pos.set(list[i], i)
    cache = { list, pos }
  }
  return cache
}

// 按使用频率从高到低排列的**全部字表字符**（返回副本，避免调用方改到缓存）
export function getRankOrder() {
  return index().list.slice()
}

// 某个字在频序里的名次（1 起）；未被字频表收录的（部分生僻汉字与基础字符）返回 null
export function getRankOf(char) {
  const i = index().pos.get(char)
  return i === undefined ? null : i + 1
}

// 某个字是否被字频表收录（界面可以用它区分"常用度排序"里的两类字）
export function hasRank(char) {
  return index().pos.has(char)
}

// 按频序排列给定的字集（不在字频表里的排到最后，并保持原相对顺序）——
// 用于"当前选字"这种子集：用户选了一批字，希望按常用度而不是拼音顺序来写
export function sortByRank(chars) {
  const pos = index().pos
  return chars
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const pa = pos.has(a.c) ? pos.get(a.c) : Infinity
      const pb = pos.has(b.c) ? pos.get(b.c) : Infinity
      if (pa !== pb) return pa - pb
      return a.i - b.i // 都没收录时保持传入顺序（稳定排序）
    })
    .map((x) => x.c)
}
