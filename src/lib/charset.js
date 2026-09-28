// 字表 API：全量字表（有序）、码位换算、字符分类
// 数据来源：src/data/charset.js（由 scripts/build-charset.mjs 从做字体网 V4.0 的 GBK 字序文件生成）
// 顺序即模板字序：模板排版、扫描切格、字体构建都按这个顺序取值（决策记录 三-1）。
import { CHARSET, CHARSET_META } from '../data/charset.js'

// 全量字表（有序数组）。返回新数组，避免调用方意外改动共享状态
export function getAllChars() {
  return Array.from(CHARSET)
}

// 字符 → Unicode 码位（生成字体时写 cmap 用；汉字与常用标点都不需要 PUA 分配）
export function charToCodePoint(char) {
  return char.codePointAt(0)
}

// 字符分类，决定字形在 em 方格里的宽度（决策记录 四-3）：
//   halfwidth —— ASCII 可见字符（数字、拉丁字母、半角标点）→ 半角 500
//   han       —— 汉字 → 全角 1000
//   symbol    —— 其余（中文标点等全角符号）→ 全角 1000
export function classifyChar(char) {
  const cp = char.codePointAt(0)
  if (cp < 0x80) return 'halfwidth'
  if (cp >= 0x4e00 && cp <= 0x9fff) return 'han'
  return 'symbol'
}

// 字表元信息（总数与构成），供界面展示与自检使用
export function getCharsetMeta() {
  return { ...CHARSET_META }
}

// 全量字表的分类统计：键为 classifyChar 的返回值，值为字符数
export function countByClass() {
  const counts = { han: 0, halfwidth: 0, symbol: 0 }
  for (const char of CHARSET) counts[classifyChar(char)] += 1
  return counts
}
