// 字表 API：全量字表（有序）、码位换算、字符分类
// 数据来源：src/data/charset.js（由 scripts/build-charset.mjs 从《通用规范汉字表》官方字表生成）。
// 顺序即字序：**汉字在前（官方笔画序）、基础字符 169 在后**（《决策记录》三-1、八-1、八-2）——
//   模板排版、扫描切格、字体构建都按这个顺序取值。
import { CHARSET, CHARSET_META } from '../data/charset.js'

// 汉字码位范围：**四个区都要算**。官方字表 8105 字里有 273 个非基本区汉字（扩展 A 区 77 个 +
//   扩展 B 区及以后 196 个，如「𬉼」U+2C27C）—— 只认 U+4E00~U+9FFF 会把它们误判成符号，
//   连带把字符分类（`classifyChar` 的汉字 / 半角 / 符号）与统计一起算错。
//   （分类只决定字形宽度口径：halfwidth 按实际宽度、其余全角，见《决策记录》四-3；
//    `halfwidth` 这个名字只表示"ASCII 可见字符"这一类字符。）
const HAN_RANGES = [
  [0x3400, 0x4dbf], // 扩展 A
  [0x4e00, 0x9fff], // 基本区
  [0xf900, 0xfaff], // 兼容汉字
  [0x20000, 0x3ffff] // 扩展 B ~ F
]

// 全量字表（有序数组）。返回新数组，避免调用方意外改动共享状态
export function getAllChars() {
  return Array.from(CHARSET)
}

// 字符 → Unicode 码位（生成字体时写 cmap 用；汉字与常用标点都不需要 PUA 分配）
// 用 codePointAt 而不是 charCodeAt：扩展 B 区字符在 UTF-16 里占两个码元，charCodeAt 只能拿到半个代理对
export function charToCodePoint(char) {
  return char.codePointAt(0)
}

// 字符分类（决定字形宽度口径，见决策 四-3）：
//   halfwidth —— ASCII 可见字符（数字、拉丁字母、半角标点）→ 按实际宽度（0.3~0.8em）
//   han       —— 汉字（含扩展 A / B 区）→ 全角 1000
//   symbol    —— 其余（中文标点、全角符号）→ 全角 1000
export function classifyChar(char) {
  const cp = char.codePointAt(0)
  if (cp < 0x80) return 'halfwidth'
  if (HAN_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) return 'han'
  return 'symbol'
}

// 字表元信息（总数与构成），供界面展示与自检使用。
// levels（规范三级计数）单独复制一层：浅拷贝会让调用方拿到同一份可变对象
export function getCharsetMeta() {
  return { ...CHARSET_META, levels: { ...CHARSET_META.levels } }
}

// 按**码点**数一份选字清单有多少字。
// 为什么不能用 text.length：字表里有 196 个扩展 B 区汉字（UTF-16 里是代理对），字符串的 .length
//   按码元算，会把这些字各多算一个 —— 实测"二级次常用字"会显示成 3003、选字计数与模板页数也跟着虚高。
//   Array.from 与 for...of 都按码点迭代，取前者是因为这里只需要个数、写法更直白。
export function countChars(text) {
  return Array.from(String(text || '')).length
}

// 全量字表的分类统计：键为 classifyChar 的返回值，值为字符数
export function countByClass() {
  const counts = { han: 0, halfwidth: 0, symbol: 0 }
  for (const char of CHARSET) counts[classifyChar(char)] += 1
  return counts
}

// 字 → 它在字表里的下标（0 基）—— **底部条码打包字序要用**（《决策记录》一-20）：
//   把一个字映射成 0~8273 的序号写进条码，识别端凭序号就能从字表还原"这一页是哪些字"，
//   不必再去认参考字。缓存一份 Map：生成一页要查 136 次，逐次 indexOf 是 O(8274) 太浪费。
// **必须按码点遍历**（2026-10-20 重锚新纸时抓到的真缺陷）：原来写 `for (let i = 0; i < CHARSET.length; i++)`
//   是**按 UTF-16 码元**走的 —— 字表里有 196 个扩展 B 区汉字（代理对，占两个码元），它们之后的字
//   索引会逐个多 1（全角标点实测 8203 → 8399，超出字表长度）。生成端把 8399 写进条码，识别端却按
//   `getAllChars()` 的码点下标还原，拿不到字（条码给出的字序最后两个标点变成 null）。
//   `Array.from(CHARSET)` 与 `getAllChars()` 同一口径，两边才对得上。
let charIndexCache = null
export function charIndexMap() {
  if (!charIndexCache) {
    charIndexCache = new Map()
    const all = Array.from(CHARSET)
    for (let i = 0; i < all.length; i++) if (!charIndexCache.has(all[i])) charIndexCache.set(all[i], i)
  }
  return charIndexCache
}
