// 扫描识别的"轻量元数据"纯逻辑（阶段一「界面串联」B2）
// 为什么单独一个零依赖模块（与 lib/batchCode.js 同一套路）：store 需要按识别结果算"能拿出多少字形"、
//   以及"页内格号 → 字"的映射，但 store 是被首屏加载的 —— 不能为了这几个纯函数把 gridDetector /
//   scanPreprocessor 那些模块拖进首屏包（决策 六-9 的同一条理由）。
// 这里只依赖 layout（版面契约）与 charset（字表），没有任何浏览器 API。
import { LAYOUT } from './layout.js'
import { getAllChars } from './charset.js'

/** 这一批要写的字（字序即批次里的 chars）；没有批次信息时退回全量表 */
export function resolveBatchChars(batch) {
  if (batch && typeof batch.chars === 'string' && batch.chars.length) return batch.chars
  return getAllChars().join('')
}

/** 页内格号 → 字（决策 二-8 ⑤：全量字序 = (页码−1)×136 + 格号）；页码未知（页脚读不出且未手选）时返回 null */
export function charAtCell(chars, pageNumber, cellIndex) {
  if (!chars || !pageNumber) return null
  const i = (pageNumber - 1) * LAYOUT.perPage + cellIndex
  return i >= 0 && i < chars.length ? chars[i] : null
}

/** 某一页能不能继续用于字形识别（页脚读不出的页，只要用户手选了页序也算能收 —— 决策 二-7） */
export function usableForGlyphs(page) {
  return !!(page && page.ok && page.pageNumber)
}

/** 汇总"这批能拿出多少字形"：给流程状态（lib/flow.js）与后续字体构建用 */
export function collectGlyphStats(pages) {
  let written = 0
  let suspect = 0
  let marked = 0
  let pagesUsable = 0
  const chars = new Set()
  for (const p of pages || []) {
    if (!usableForGlyphs(p)) continue
    pagesUsable++
    written += p.counts ? p.counts.written : 0
    suspect += p.counts ? p.counts.suspect : 0
    marked += p.counts ? p.counts.marked : 0
    for (const c of p.cells || []) if (c.char && c.verdict !== 'empty') chars.add(c.char)
  }
  return { pagesUsable, written, suspect, marked, uniqueChars: chars.size }
}

/**
 * 用户手选页序后重新算"每格是哪个字"（决策 二-7：页脚读不出时由用户排定页序）。
 * 只重算字与页号，**不重新识别** —— 掩膜与页序无关。
 * @param {Array} pages 页记录数组
 * @param {object} overrides `{ [fileIndex]: pageNumber }`
 * @param {string} chars 这一批的字序
 */
export function reorderPages(pages, overrides, chars) {
  if (!overrides || Object.keys(overrides).length === 0) return pages
  return pages.map((p) => {
    const forced = overrides[p.fileIndex]
    if (typeof forced !== 'number' || forced <= 0) return p
    const pageNumber = forced | 0
    return {
      ...p,
      pageNumber,
      orderFromUser: true,
      cells: (p.cells || []).map((c) => ({ ...c, char: charAtCell(chars, pageNumber, c.index) }))
    }
  })
}

/**
 * 收批闸门：这批识别结果能不能进入下一步（更正核对 / 字体构建）。
 * 规则（2026-10-04 用户拍板 + 《决策记录》二-6、二-7、八-9、八-10）：
 *   · **单页失败**（找不到四角定位块、校正超限）→ **跳过并标红**，不拦整批（二-6 的口径是让那一页重扫）
 *   · **页脚读不出的页** → 必须由用户手选页序（二-7）；页脚的批次码也随之失效，
 *     所以还**必须显式确认"这批扫描件属于所选批次"**，否则拦下
 *   · **批次级问题** → 整批拦下：校验码与所选批次不符、同一页被重复上传、所选批次已作废（未显式放行）
 *   · 缺页只是提醒（warn），不拦 —— 用户可以先把已经写好的页做完
 * 判据全部来自 summarizeBatch 的 rows（按"种类"分拣），**不靠匹配提示文案** —— 文案会改，种类不会。
 * @param {object} input
 * @param {object} input.summary summarizeBatch 的结果（rows 在 summary.pages 里）
 * @param {Array} input.pages 页记录（含 ok / pageNumber / footerOk）
 * @param {boolean} input.batchConfirmed 用户是否显式确认了批次
 * @param {boolean} input.batchIsVoid 所选批次是否已作废
 * @param {boolean} input.allowVoidBatch 用户是否显式放行作废批次
 * @returns {{canProceed:boolean, blockers:Array<string>, skipped:Array<object>, notes:Array<string>, usablePages:number, needsConfirm:boolean}}
 */
export function evaluateScanGate(input = {}) {
  const pages = input.pages || []
  const summary = input.summary || { problems: [] }
  const rows = summary.pages || []
  const blockers = []
  const notes = []
  const skipped = []
  let usablePages = 0
  let needsConfirm = false
  let batchMismatch = 0

  const rowOf = (i) => rows[i] || {}
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    const row = rowOf(i)
    const label = '第 ' + (i + 1) + ' 个文件';
    if (row.batchMatch === false) {
      batchMismatch++
      continue
    }
    if (!row.ok || !page.ok) {
      // 单页失败：跳过并标红（决策 二-6：明确失败、提示重扫那一页）
      skipped.push({ fileIndex: page.fileIndex, fileName: page.fileName, reason: page.reason || '这一页没能识别' })
      if (!row.footerOk) needsConfirm = true
      continue
    }
    if (!row.footerOk) {
      // 页脚读不出：页序与批次码都不可信 → 必须手选页序 + 显式确认批次（决策 二-7）
      needsConfirm = true
      if (page.pageNumber) {
        usablePages++
        notes.push(label + ' 的页序是手选的：请确认它确实是第 ' + page.pageNumber + ' 页')
      } else {
        skipped.push({ fileIndex: page.fileIndex, fileName: page.fileName, reason: '页脚读不出、也还没手选页序' })
      }
      continue
    }
    usablePages++
  }

  if (batchMismatch > 0) {
    blockers.push('有 ' + batchMismatch + ' 页的页脚校验码与所选批次不符：请确认批次选对了，或重新生成模板、重印重写')
  }
  if ((summary.duplicates || []).length) {
    blockers.push('有 ' + summary.duplicates.length + ' 页被重复上传（页脚页号相同）：请去掉重复的那一张')
  }
  if (input.batchIsVoid && !input.allowVoidBatch) {
    blockers.push('所选批次已经作废（改过选字就会作废）：要么重新生成模板、重印重写，要么勾选"我知道这是作废模板"再继续')
  }
  if (needsConfirm && !input.batchConfirmed) {
    blockers.push('有扫描件的页脚没读出（页序与批次码都不可信）：请在结果里手选页序，并勾选"确认这批扫描件属于所选批次"')
  }
  for (const m of summary.problems || []) {
    if (m.level === 'warn') notes.push(m.text)
    else if (m.level === 'info') notes.push(m.text)
  }

  if (blockers.length === 0 && usablePages === 0) {
    blockers.push('没有任何一页可用（全部识别失败）：请确认扫描件是我们生成的模板、纸面平整、按实际大小打印')
  }
  return { canProceed: blockers.length === 0 && usablePages > 0, blockers, skipped, notes, usablePages, needsConfirm }
}
