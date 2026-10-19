// 页级校验码（印在右侧方块里的 12 位的那 12 位）—— 零依赖纯函数，单独成文件的原因与原来那个
// 批次校验码一样：生成端（templatePdf.js，依赖 pdf-lib 与 fontkit）与识别端（scanFlow /
// referenceCharReader）都要用它，把它留在任何一边都会让另一边为了一个哈希函数多背一份依赖。
//
// 契约（《决策记录》一-9 的 2026-10-15 修订，取代原「整批共用一个批次校验码」的口径）：
//   码 = FNV-1a 32 位取低 12 位；输入是**这一页实际印了参考字的那些格的字**，按格号升序、跳过空格。
//   · 满页模板 = 这一页那 136 个字；末页 / 重写模板 / 补写模板 = 那几十个或几个字。
//   · **算出 0 时存 1**：0 专门留给"这一页没有字"（打印自检页与更正册），识别端据此判定件类型。
//   · 生成端与识别端必须喂入同一份序列 —— 识别端要先把"这一页应当是哪些字"猜出来（字序文件、
//     纸面参考字序列定位、或逐格认字），再算一遍比对；一致 = 这一页的字序确定无疑。
// 为什么用 FNV-1a：同步、零依赖，file:// 下也确定可用（crypto.subtle 的 SHA-256 要求安全上下文）；
//   而 12 位的碰撞率上限本就是 1/4096，换更强的哈希并不降低它。
//
// 它**证明不了**"这是我们生成的模板"—— 知道字表与算法的人都能算出同一个码；那件事由四角定位块
// 与参考字版式承担（决策 五-9 ④）。它证明的是"这一页是第几页、上面是哪些字"。

// FNV-1a 32 位的一步：先与一个字节异或，再乘质数（Math.imul 保证 32 位乘法不丢精度，>>> 0 保持无符号）
function fnv1aStep(hash, byte) {
  return Math.imul((hash ^ byte) >>> 0, 0x01000193) >>> 0
}

/**
 * 空白字符判据（半角空格、全角空格、制表符等）—— **生成端与识别端必须用同一套判据**。
 * 为什么要有它（2026-10-16 修掉的一个潜伏缺陷）：字表 8274 里**恰好有一个半角空格**（U+0020，它是
 *   基础字符 169 的第 1 个），它落在**常用 6500 字档第 48 页第 109 格**、**全量档第 60 页第 82 格**。
 *   参考字字体给空格的是一个**空字形**（有 advance、无轮廓）→ 纸上那一格没有墨迹 → 识别端判它
 *   `empty`、**跳过不算指纹**；而生成端原来把空格照算 —— 实测两端对不上（常用档 836 vs 1132、
 *   全量档 2312 vs 434）→ **那一页必然整页失败**，用户会看到"这张纸可能不是用最新模板印的"。
 *   所以生成端也要把空白当作"这一格没有字"（**格位保留**，后面的字不前移 —— 页号 + 格号 → 字的
 *   映射与字序文件仍然一一对应）。
 * 识别端对应的判据是 `cells[i].empty`（那一格的参考字区域没有墨迹），语义与这里一致。
 */
export const isBlankChar = (ch) => !ch || /^\s$/.test(ch)

/**
 * 算"这一页"的 12 位校验码
 * @param {string|string[]} chars 这一页实际印了参考字的字（按格号升序；**不要**塞空格或 null）
 * @returns {number} 1~4095（算出 0 时返回 1 —— 0 是"这一页没有字"的专用值）
 *
 * **注意**：空清单（`[]` / `null`）返回的是普通哈希值（3525），**不是 0** —— "这一页没有字"这件事
 * 只有调用方**显式传 0** 时才成立（更正册与打印自检页就是这么印的，见 templatePdf 的 drawRegisterMarks）。
 * 为什么不做成"空清单自动返回 0"：那会让"算错了 / 没取到字"与"这一页本来就没字"变成同一件事，
 * 而这两者必须分得开（前者是缺陷，后者是正常件）。
 */
export function computePageCode(chars) {
  const list = chars || []
  let hash = 0x811c9dc5 // FNV-1a 32 位的偏移基准
  for (const ch of list) {
    if (!ch) continue
    const cp = ch.codePointAt(0)
    // 按码位的三个字节依次喂入（顺序固定即可）。三个字节足够覆盖到 U+FFFFFF：字表里最大的码位是
    // U+2CB73 一带的扩展 B 区汉字（代理对），第三字节不会再被截断
    hash = fnv1aStep(hash, cp & 0xff)
    hash = fnv1aStep(hash, (cp >> 8) & 0xff)
    hash = fnv1aStep(hash, (cp >> 16) & 0xff)
  }
  const code = hash & 0xfff
  return code === 0 ? 1 : code
}

/**
 * 取某个全序字序里的第 pageNumber 页那一段字（页号 1 起）。
 * 生成端（出模板）与识别端（按页号切段）共用这一处，保证"两边切出来的是同一段"。
 * @param {string|string[]} chars 全序字序
 * @param {number} pageNumber 页号（1 起）
 * @param {number} perPage 每页格数（LAYOUT.perPage）
 * @returns {string[]} 这一页的字（末页可能不足 perPage 个；越界返回空数组）
 */
export function pageCharsAt(chars, pageNumber, perPage) {
  const list = Array.isArray(chars) ? chars : Array.from(chars || '')
  const start = (Math.max(1, pageNumber | 0) - 1) * perPage
  return list.slice(start, start + perPage)
}

/**
 * 用指纹在候选字序里**反推页号**（识别端的救回路径：右侧方块里的页号位读错、或猜错了字序来源时）。
 * 逐页算指纹比对，命中即返回那一页 —— 全量 61 页只要 61 次哈希（每次 136 个字），耗时可忽略。
 * @param {number} pageCode 纸面右侧方块上的 12 位指纹
 * @param {string|string[]} chars 候选全序字序
 * @param {number} perPage 每页格数
 * @param {{maxPages?:number}} [options] maxPages 限制试多少页（默认按字序长度算满）
 * @returns {{pageNumber:number, chars:string[], code:number}|null} 命中那一页；没命中返回 null
 */
export function matchPageCode(pageCode, chars, perPage, options = {}) {
  if (!pageCode || !chars) return null
  const list = Array.isArray(chars) ? chars : Array.from(chars)
  const total = Math.ceil(list.length / perPage)
  const maxPages = Math.min(total, options.maxPages || total)
  for (let p = 1; p <= maxPages; p++) {
    const slice = pageCharsAt(list, p, perPage)
    if (!slice.length) continue
    const code = computePageCode(slice)
    if (code === pageCode) return { pageNumber: p, chars: slice, code }
  }
  return null
}
