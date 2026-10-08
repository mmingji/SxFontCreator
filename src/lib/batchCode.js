// 批次校验码（《决策记录》八-10）—— 零依赖的纯函数，单独成文件是有原因的：
// 它既被模板生成端（templatePdf.js，依赖 pdf-lib）使用，也被 store 用来给批次记账；
// 如果留在 templatePdf.js 里，store 就会为了一个哈希函数把 pdf-lib（2.3MB）拖进首屏。
//
// 契约（生成端与切格解码端必须一致）：
//   算法 FNV-1a 32 位，取低 12 位；输入是"这一批要写的字的**字符序列**"（不是字表索引 ——
//   顺序若调整，同一索引会指向别的字，索引算出的码会造成假匹配）；空值 = 全量 8274 字。
// 为什么用 FNV-1a：同步、零依赖，在 file:// 下也确定可用（crypto.subtle 的 SHA-256 要求安全上下文）；
//   而 12 位的碰撞率上限本就是 1/4096，换更强的哈希并不降低它。
import { getAllChars } from './charset.js'

// FNV-1a 32 位的一步：先与一个字节异或，再乘质数（Math.imul 保证 32 位乘法不丢精度，>>> 0 保持无符号）
function fnv1aStep(hash, byte) {
  return Math.imul((hash ^ byte) >>> 0, 0x01000193) >>> 0
}

/**
 * 算一批选字的 12 位校验码
 * @param {string|string[]} [chars] 这批要写的字（字符序列）；空值 = 全量 8274 字
 * @returns {number} 0~4095
 */
export function computeBatchCode(chars) {
  const list = chars && chars.length ? chars : getAllChars()
  let hash = 0x811c9dc5 // FNV-1a 32 位的偏移基准
  for (const ch of list) {
    const cp = ch.codePointAt(0)
    // 按码位的三个字节依次喂入（顺序固定即可）。三个字节足够覆盖到 U+FFFFFF：字表里最大的码位是
    // U+2CB73 一带的扩展 B 区汉字（代理对），第三字节不会再被截断
    hash = fnv1aStep(hash, cp & 0xff)
    hash = fnv1aStep(hash, (cp >> 8) & 0xff)
    hash = fnv1aStep(hash, (cp >> 16) & 0xff)
  }
  return hash & 0xfff
}
