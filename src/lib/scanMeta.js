// 扫描识别的"轻量元数据"纯逻辑（阶段一「界面串联」B2）
// 为什么单独一个零依赖模块（与 lib/pageCode.js 同一套路）：store 需要按识别结果算"能拿出多少字形"、
//   以及"页内格号 → 字"的映射，但 store 是被首屏加载的 —— 不能为了这几个纯函数把 gridDetector /
//   scanPreprocessor 那些模块拖进首屏包（决策 六-9 的同一条理由）。
// 这里只依赖 layout（版面契约）与 correctionMapper（配对），没有任何浏览器 API。
// **2026-10-15**：`resolveBatchChars`（按批次字序兜底）随"批次"一起删除 —— 字序只来自字序文件或纸面参考字。
import { LAYOUT } from './layout.js'
import { buildCorrectionCells, continuousIndex, mapCorrections } from './correctionMapper.js'

// 字符串 → 码点数组，带**单槽缓存**。两件事一起解决：
//   ① **正确性**：字表里有 196 个扩展 B 区汉字（UTF-16 代理对），字符串下标 chars[i] 按码元取，
//      遇到它们会取到半个字符、后面的索引整体错位（旧字表全在 BMP 内，这条一直没暴露）；
//   ② **性能**：识别一页要按格取字 136 次，若每次都 Array.from 会把八千多字的字符串重扫 136 遍。
//   缓存只留最近一次用到的那个字符串 —— 识别是串行按批处理的，同一批的 chars 在整页处理期间不变。
let cachedText = null
let cachedList = null
function toCharList(chars) {
  if (Array.isArray(chars)) return chars
  if (chars === cachedText) return cachedList
  cachedText = chars
  cachedList = Array.from(chars)
  return cachedList
}

/** 页内格号 → 字（决策 二-8 ⑤：全量字序 = (页码−1)×136 + 格号）；页码没定出来时返回 null */
export function charAtCell(chars, pageNumber, cellIndex) {
  if (!chars || !pageNumber) return null
  const list = toCharList(chars)
  const i = (pageNumber - 1) * LAYOUT.perPage + cellIndex
  return i >= 0 && i < list.length ? list[i] : null
}

/**
 * 某一页能不能继续用于字形识别（要求整页成功、且页号已经定出来）。
 * **2026-10-14 补**：重复页里**没被采用**的那些也不算可用（去重的结果落在 `duplicateOf` 上，
 * 见 `dedupeDuplicatePages`）—— 这一处判据是统计、更正配对、字形计划、字体构建共同的分叉点，
 * 所以只在这里加一条，下游全都跟着生效。
 */
export function usableForGlyphs(page) {
  const dropped = !!page && page.duplicateOf !== undefined && page.duplicateOf !== null
  return !!(page && page.ok && page.pageNumber && !dropped)
}

/**
 * 重复页去重（2026-10-14 用户拍板，**修订**"不自动去重、只提示"的旧口径）。
 *
 * 背景（用户真机实测）：把同一张纸的不同来源（手机拍、扫描 App 各档、重复拷贝）一起放进目录时，
 *   识别出的"可用 12 页"其实只有 1 页的内容 —— 于是"被红笔圈 29 个""更正册覆盖 9 处"这类统计
 *   全部翻倍错乱，更正配对也跟着乱（同一个字被配到好几行、下面一大片"没有对应格"）。
 * 口径：**同一页号出现多份时，自动采用"效果最好"的一份**，其余打上 `duplicateOf: <采用的 fileIndex>`；
 *   界面上它们显示成"重复页"（灰），既不算可用页、也不算失败页。
 * 判据（效果最好），按优先级：
 *   ① **认出的红圈数多的** —— 为什么它在最前（2026-10-14 真夹具实测补的）：同一张纸的多份来源里，
 *      某些档（去底色 / 转黑白 / 锐化）会把红圈洗掉。只按"能用的字形数"挑，真夹具上挑中的那份
 *      **被圈 0 个** —— 而去重一旦生效，被圈清单就从 29 变 0、更正配对 0 处、更正册那 9 格全成
 *      "多写的格"（用户白写一册）。红圈是用户特意留下的信息，丢了补不回来；字形质量差一点还有
 *      "可疑格"提示兜着。
 *   ② 再比"能用的字形数"（写出格数 − 可疑格数）多的：不同来源的曝光不同，写出多不等于写得准，
 *      扣掉可疑格之后更接近"这一份好不好用"。
 *   ③ 再比四角误差小的；④ 最后按文件顺序（结果可复现）。
 * 不参与去重的情形：更正册（它是另一类件）、没有页号的页（页号没定出来就谈不上判重）。
 * @param {Array} pages 页记录（store.scan.pages）
 * @returns {{groups:Array, ignored:Map<number,number>}} groups 供界面/文案说明，ignored 是 fileIndex → 采用的 fileIndex
 */
export function dedupeDuplicatePages(pages) {
  const byPage = new Map()
  for (const p of pages || []) {
    if (!p || !p.ok || p.kind === 'correction') continue
    const pageNumber = p.pageNumber
    if (pageNumber === null || pageNumber === undefined) continue
    if (!byPage.has(pageNumber)) byPage.set(pageNumber, [])
    byPage.get(pageNumber).push(p)
  }
  const groups = []
  const ignored = new Map()
  for (const [pageNumber, group] of byPage) {
    if (group.length < 2) continue
    const scored = group.map((p) => ({
      page: p,
      marked: (p.counts && p.counts.marked) || 0,
      usable: p.counts ? p.counts.written - p.counts.suspect : 0,
      corner: (p.cornerMaxError === null || p.cornerMaxError === undefined) ? 999 : p.cornerMaxError
    }))
    scored.sort((a, b) => (b.marked - a.marked) || (b.usable - a.usable) ||
      (a.corner - b.corner) || (a.page.fileIndex - b.page.fileIndex))
    const adopted = scored[0].page
    const dropped = scored.slice(1).map((s) => s.page)
    for (const p of dropped) ignored.set(p.fileIndex, adopted.fileIndex)
    groups.push({
      pageNumber,
      adoptedFileIndex: adopted.fileIndex,
      adoptedName: adopted.fileName,
      adoptedMarked: scored[0].marked,
      adoptedUsable: scored[0].usable,
      droppedFileIndexes: dropped.map((p) => p.fileIndex),
      droppedNames: dropped.map((p) => p.fileName),
      // 有没有哪一份认出了红圈、而采用的那份一个都没认出 —— 界面据此明确提醒"更正配对会少"
      // （这是"判据 ① 生效了但差距仍在"的情形：例如另一份认出了圈、却因字形更差而没被采用）
      droppedWithMarks: dropped.filter((p) => ((p.counts && p.counts.marked) || 0) > scored[0].marked).length
    })
  }
  groups.sort((a, b) => a.pageNumber - b.pageNumber)
  return { groups, ignored }
}

/**
 * 单页重传 / 补传能不能收下这一页（清单 一-8，决策 八-14 ③；**2026-10-15 用户口径后收敛为一条判据**）。
 *
 * **只拒绝"整页没能识别"** —— 把失败原因原样带出来，让用户知道重扫要注意什么。
 * 这里不再做任何校验码比对：右侧方块里那 12 位现在是"这一页那些字的指纹"（lib/pageCode.js），
 *   它的自证发生在识别内部（对不上就整页失败，见 scanFlow 的 ③.6）—— 走到这一步的记录已经自证过了。
 * @param {object} input
 * @param {object|null} input.record 新识别出来的页记录（recognizePage 的产物）
 * @returns {{accept: boolean, reason: 'ok'|'page-failed', message: string}}
 */
export function evaluateRescanAccept({ record } = {}) {
  if (!record || !record.ok) {
    return {
      accept: false,
      reason: 'page-failed',
      message: '这一页没能识别：' + ((record && record.reason) || '原因未知') + '。原来的结果与字形都没动，可以重扫一页再试'
    }
  }
  return { accept: true, reason: 'ok', message: '已收下这一页' }
}

/** 汇总"这批能拿出多少字形"：给流程状态（lib/flow.js）与后续字体构建用 */
export function collectGlyphStats(pages) {
  let written = 0
  let suspect = 0
  let marked = 0
  let pagesUsable = 0
  let correctionPages = 0
  let correctionWritten = 0
  const chars = new Set()
  for (const p of pages || []) {
    if (!usableForGlyphs(p)) continue
    pagesUsable++
    const isCorrection = p.kind === 'correction'
    if (isCorrection) correctionPages++
    const writtenHere = p.counts ? p.counts.written : 0
    written += writtenHere
    if (isCorrection) correctionWritten += writtenHere
    suspect += p.counts ? p.counts.suspect : 0
    marked += p.counts ? p.counts.marked : 0
    // 更正册的格没有字（字由更正核对决定），所以只统计主区
    if (!isCorrection) {
      for (const c of p.cells || []) if (c.char && c.verdict !== 'empty') chars.add(c.char)
    }
  }
  return { pagesUsable, written, suspect, marked, uniqueChars: chars.size, correctionPages, correctionWritten }
}

/**
 * 收批闸门：这批识别结果能不能进入下一步（更正核对 / 字体构建）。
 * 规则（《决策记录》二-6、五-9 的 2026-10-15 口径）：
 *   · **单页失败**（找不到四角定位块、校正超限、右侧方块里的校验码与字序对不上）→ **跳过并标红**，不拦整批
 *   · **右侧方块读不出的页** → 页号与字序由纸面参考字序列定位定；定不出来时那一页会自己整页失败
 *     （"手选页序"这条界面兜底已去掉 —— 页级校验码让识别端能自证，不必让用户填数字）
 *   · **整批拦下**只剩一条：同一页被重复上传（页号重复）；「批次」这一层与批次校验码都已删
 *   · 缺页只是提醒（warn），不拦 —— 用户可以先把已经写好的页做完
 * 判据全部来自 summarizeBatch 的 rows（按"种类"分拣），**不靠匹配提示文案** —— 文案会改，种类不会。
 * @param {object} input
 * @param {object} input.summary summarizeBatch 的结果（rows 在 summary.pages 里）
 * @param {Array} input.pages 页记录（含 ok / pageNumber / footerOk）
 * @returns {{canProceed:boolean, blockers:Array<string>, skipped:Array<object>, notes:Array<string>, usablePages:number}}
 */
export function evaluateScanGate(input = {}) {
  const pages = input.pages || []
  const summary = input.summary || { problems: [] }
  const rows = summary.pages || []
  const blockers = []
  const notes = []
  const skipped = []
  let usablePages = 0
  let footerlessFailed = 0 // 右侧方块读不出、且整页失败的页数（见下面失败分支的注释）
  let duplicatePages = 0 // 重复页里**没被采用**的页数（去重结果，见 dedupeDuplicatePages）

  // 判据优先用 summarizeBatch 的 rows，但**只在行数与页数对得上时**才信它 ——
  // 汇总可能来自上一轮（或还没重算），那时 rows 与 pages 描述的不是同一批件，
  // 混着用会得出自相矛盾的结论（实测踩到：行说"右侧方块没读出"、页记录说"右侧方块读出了第 1 页"）。
  // 对不上时退回页记录本身：识别是逐页回调的，"这一页刚处理完、摘要还没算"本来就是常态。
  const useRows = rows.length === pages.length
  const rowOf = (i) => {
    if (useRows) return rows[i]
    const page = pages[i] || {}
    return {
      ok: !!page.ok,
      footerOk: !!page.footerOk,
      pageNumber: page.pageNumber === undefined ? null : page.pageNumber,
      kind: page.kind || 'unknown'
    }
  }
  let correctionPages = 0
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    const row = rowOf(i)
    const label = '第 ' + (i + 1) + ' 个文件'
    // 更正册与主区分别计数：主区页是"能拿出字形"的页，更正册页是"用来覆盖被圈字"的页
    const isCorrection = (row.kind || page.kind) === 'correction'
    // 2026-10-14（去重落地）：被忽略的重复页既不算可用、也不算跳过（它不是失败）—— 单独计数，下面给一条提示
    if (page.duplicateOf !== undefined && page.duplicateOf !== null) {
      duplicatePages++
      continue
    }
    // 单页失败：跳过并标红（决策 二-6：明确失败、提示重扫那一页）。
    // 2026-10-15 起这里不再有任何"校验码比对"的分支 —— 右侧方块里那 12 位改成本页指纹，识别端在
    // scanFlow 里已经拿它自证过（对不上就整页失败），走到这一步的记录都是自证通过的。
    if (!row.ok || !page.ok) {
      skipped.push({ fileIndex: page.fileIndex, fileName: page.fileName, reason: page.reason || '这一页没能识别' })
      if (!row.footerOk) footerlessFailed++
      continue
    }
    if (!row.footerOk) {
      // 右侧方块读不出：页号与字序由纸面参考字序列定位定（决策 五-9）；定不出来的页在识别里就会整页失败，
      //   所以走到这里而 pageNumber 为空的极罕见（例如序列定位给了页号、右侧方块却坏）——只提示，不拦
      if (page.pageNumber) {
        if (isCorrection) correctionPages++
        else usablePages++
        notes.push(label + ' 的右侧方块读不出：页序按' +
          (page.pageNumberSource === 'sequence' ? '纸面参考字序定位得到' : '沿用原页') +
          '第 ' + page.pageNumber + ' 页')
      } else {
        notes.push(label + ' 的右侧方块读不出，页号也没定出来：这一页不进字形，请重扫一次')
      }
      continue
    }
    if (isCorrection) correctionPages++
    else usablePages++
  }

  if (duplicatePages > 0) {
    // 2026-10-14 用户拍板：重复页**自动去重**（采用效果最好的一份），这里如实说清采用了哪一份
    const adoptedIndexes = new Set()
    for (const p of pages) {
      if (p.duplicateOf !== undefined && p.duplicateOf !== null) adoptedIndexes.add(p.duplicateOf)
    }
    const adoptedNames = [...adoptedIndexes]
      .map((idx) => ((pages.find((p) => p.fileIndex === idx) || {}).fileName) || ('第 ' + (idx + 1) + ' 个文件'))
    notes.push('有 ' + duplicatePages + ' 页与别的页页号相同（重复上传）：已**自动采用效果最好的一份**' +
      (adoptedNames.length ? '（' + adoptedNames.join('、') + '）' : '') +
      '，其余 ' + duplicatePages + ' 页已忽略、不计入结果；想换用另一份，就在「看文件清单」里去掉不想要的那张再识别一遍')
  }
  // 2026-10-15：「手选页序」这条界面操作已去掉，所以这里不再有"请去手选页序"的提示。
  //   右侧方块读不出时页号与字序由纸面参考字序列定位定；定不出来时识别本身就会把那一页判为失败。
  if (footerlessFailed > 0) {
    notes.push('有 ' + footerlessFailed + ' 页的右侧方块没读出来、方向也就认不准：整页没能识别 —— ' +
      '把纸按横向放正重拍或重扫这一页')
  }
  for (const m of summary.problems || []) {
    if (m.level === 'warn') notes.push(m.text)
    else if (m.level === 'info') notes.push(m.text)
  }

  if (blockers.length === 0 && usablePages === 0) {
    blockers.push(correctionPages > 0
      ? '只有更正册可用、没有任何一页主区扫描件：请把主区（写了字的那些页）也一起上传'
      : '没有任何一页可用（全部识别失败）：请确认扫描件是我们生成的模板、纸面平整、按实际大小打印')
  }
  return { canProceed: blockers.length === 0 && usablePages > 0, blockers, skipped, notes, usablePages, correctionPages }
}

// ── 更正核对（阶段一步骤 1.8 的输入组装）────────────────────────────────
/**
 * 从识别结果组装配对输入（决策 一-7、二-13）：
 *   · **被圈字** = 主区页里 `marked` 的格，按页码、页内格号升序 —— 这就是"从左到右、从上到下"的有序清单
 *   · **更正格** = 更正册页的全部 136 格，按连续格号升序（跨页连续，清单 四-4）
 *   · **作废格** = 更正册上被红笔圈掉的格（同一枚红圈在两件上语义不同，靠 `kind` 区分）
 * @param {Array} pages 识别页记录（store.scan.pages）
 */
export function buildCorrectionInputs(pages) {
  const circled = []
  const rawCells = []
  const discardedCells = []
  for (const p of pages || []) {
    if (!usableForGlyphs(p)) continue
    if (p.kind === 'correction') {
      for (const c of p.cells || []) {
        rawCells.push({ index: c.index, pageNumber: p.pageNumber, verdict: c.verdict, inkPixels: c.inkPixels, charIndex: null })
        if (c.marked) discardedCells.push(continuousIndex(p.pageNumber, c.index))
      }
      continue
    }
    for (const c of p.cells || []) {
      if (!c.marked) continue
      circled.push({
        mainCellIndex: c.index,
        pageNumber: p.pageNumber,
        // 全量字序（决策 二-8 ⑤）：0 起，便于回去找字表位置
        charIndex: (p.pageNumber - 1) * LAYOUT.perPage + c.index,
        char: c.char,
        fileIndex: p.fileIndex
      })
    }
  }
  circled.sort((a, b) => a.pageNumber - b.pageNumber || a.mainCellIndex - b.mainCellIndex)
  return { circled, correctionCells: buildCorrectionCells(rawCells), discardedCells }
}

/**
 * 配对（纯函数）：把上面的输入喂给 correctionMapper，得到"第 k 个被圈字 ↔ 更正册第 m 格"的初值。
 * @returns {{pairs, unmatched, discarded, extra, messages, stats, circled, correctionCells, discardedCells}}
 */
export function pairCorrections(pages) {
  const { circled, correctionCells, discardedCells } = buildCorrectionInputs(pages)
  const mapped = mapCorrections(circled, correctionCells, { discarded: discardedCells })
  return { ...mapped, circled, correctionCells, discardedCells }
}

/**
 * 应用用户在核对界面上的调整（改派 / 删除 / 补录）：
 *   `overrides` = `{ [order]: number|null }` —— 第 order 个被圈字改用某个**连续格号**的更正格；
 *   值为 `null` 表示"这一对删掉"（该字保留主区原字形）。
 * 为什么要这一层：配对只是初值，界面调整后要能重算出最终生效的字形（决策 一-7 的最后一道闸）。
 * @returns {{pairs:Array, effective:Map<string,{continuousIndex:number}|null>, removed:Array<number>}}
 */
export function applyCorrectionOverrides(pairs, overrides) {
  const list = pairs || []
  const out = []
  const removed = []
  for (const p of list) {
    const key = String(p.order)
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) {
      const value = overrides[key]
      if (value === null) {
        removed.push(p.order)
        continue
      }
      out.push({
        ...p,
        correctContinuousIndex: value,
        source: 'manual'
      })
      continue
    }
    out.push(p)
  }
  return { pairs: out, removed }
}

/**
 * 最终生效的字形清单（字体构建的输入）：主区每个写了字的格一个字形，**被更正的字用更正册的格替换**。
 * 规则（决策 一-7、二-13）：被红笔圈掉的字若在更正册上有对应格 → 用更正册的字形；留空 / 删掉配对 /
 * 补写不足 → **保留主区原字形**。所以"被圈"本身不改变字形，只有配对成功才改变。
 * @param {Array} pages 识别页记录
 * @param {{pairs?:Array, circled?:Array}} [correction] pairs 要是**应用过界面调整**之后的生效清单
 * @returns {{items:Array, problems:Array<string>, replaced:number}}
 *   items = `[{ char, source:'main'|'correction', fileIndex, cellIndex, pageNumber }]`（掩膜按 fileIndex+cellIndex 从字形库取）
 */
export function buildFinalGlyphPlan(pages, correction = {}) {
  const list = pages || []
  // 更正册的格：连续格号 → 它落在哪一页哪一格（掩膜按 fileIndex + cellIndex 取）
  const byContinuous = new Map()
  for (const p of list) {
    if (p.kind !== 'correction' || !usableForGlyphs(p)) continue
    for (const c of p.cells || []) {
      byContinuous.set(continuousIndex(p.pageNumber, c.index), {
        fileIndex: p.fileIndex,
        cellIndex: c.index,
        pageNumber: p.pageNumber,
        verdict: c.verdict
      })
    }
  }

  const items = []
  const problems = []
  for (const p of list) {
    if (p.kind === 'correction' || !usableForGlyphs(p)) continue
    for (const c of p.cells || []) {
      if (c.verdict === 'empty' || !c.char) continue
      items.push({
        char: c.char,
        source: 'main',
        fileIndex: p.fileIndex,
        cellIndex: c.index,
        pageNumber: p.pageNumber,
        marked: !!c.marked
      })
    }
  }

  const replacedChars = new Set()
  for (const pair of correction.pairs || []) {
    const cell = byContinuous.get(pair.correctContinuousIndex)
    if (!cell || cell.verdict === 'empty') {
      problems.push('第 ' + (pair.order + 1) + ' 个更正对（' + (pair.mainChar || '?') + '）指向的更正格没有笔迹，已按"保留主区原字形"处理')
      continue
    }
    replacedChars.add(pair.mainChar)
    const item = {
      char: pair.mainChar,
      source: 'correction',
      fileIndex: cell.fileIndex,
      cellIndex: cell.cellIndex,
      pageNumber: cell.pageNumber,
      replaced: true
    }
    const idx = items.findIndex((it) => it.char === pair.mainChar)
    if (idx >= 0) items[idx] = item
    else items.push(item)
  }

  // 2026-10-13 用户口径：这里原来还会追加一句"有 N 个被圈的字没有用上更正册（保留主区原字形）：力、力、叉…"——
  //   它和第 2 步「更正核对」描述行说的是同一件事，而且按"处"数、与按"字"数的口径对不上，去掉。
  //   留空 / 配对失败的结论由界面统一说一次（第 2 步描述行 + 第 3 步「字形计划」行，两处都按**不同的字**计）。
  return { items, problems, replaced: replacedChars.size }
}
