// 扫描识别的"轻量元数据"纯逻辑（阶段一「界面串联」B2）
// 为什么单独一个零依赖模块（与 lib/batchCode.js 同一套路）：store 需要按识别结果算"能拿出多少字形"、
//   以及"页内格号 → 字"的映射，但 store 是被首屏加载的 —— 不能为了这几个纯函数把 gridDetector /
//   scanPreprocessor 那些模块拖进首屏包（决策 六-9 的同一条理由）。
// 这里只依赖 layout（版面契约）与 charset（字表），没有任何浏览器 API。
import { LAYOUT } from './layout.js'
import { getAllChars } from './charset.js'
import { buildCorrectionCells, continuousIndex, mapCorrections } from './correctionMapper.js'

/** 这一批要写的字（字序即批次里的 chars）；没有批次信息时退回全量表 */
export function resolveBatchChars(batch) {
  if (batch && typeof batch.chars === 'string' && batch.chars.length) return batch.chars
  return getAllChars().join('')
}

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

/** 页内格号 → 字（决策 二-8 ⑤：全量字序 = (页码−1)×136 + 格号）；页码未知（页脚读不出且未手选）时返回 null */
export function charAtCell(chars, pageNumber, cellIndex) {
  if (!chars || !pageNumber) return null
  const list = toCharList(chars)
  const i = (pageNumber - 1) * LAYOUT.perPage + cellIndex
  return i >= 0 && i < list.length ? list[i] : null
}

/**
 * 某一页能不能继续用于字形识别（页脚读不出的页，只要用户手选了页序也算能收 —— 决策 二-7）。
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
 * 不参与去重的情形：更正册（它是另一类件）、没有页号的页（手选页序之后才谈得上判重）。
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
 * **只拒绝"整页没能识别"**（没有四角定位块、校正超限……）—— 把失败原因原样带出来，让用户知道重扫要注意什么。
 *
 * 为什么不再拿页脚校验码拦（2026-10-15 用户原话："重传有批次校验码？应该识别到是同一张纸就可以，
 *   批次校验的意义是啥，只要模板是我们提供的，模板内的字都是一样的"）：
 *   · 码的用途本来只有一个 —— 认出"这一页属于哪一批纸"（决策 八-10）。而**补传 / 重传是一个人拿着
 *     刚扫好的那一张纸、在那一张卡片上点的**，意图已经明确；此时拿码拦人，拦住的是"用户自己"；
 *   · 真出错的情形（拿错纸）由更硬的两道闸兜着：页脚读出的**页号**决定这 136 格对应哪些字，认错纸
 *     一眼就能在结果里看出来；而且模板与字表都是本程序给的，格子与字的对应关系不会因为批次不同而变。
 *   所以校验码降为**提示**：识别记录里的 `batchMatch` 照旧保留、卡片 hover 里照旧显示，只是不再拦写入。
 * 更正册页（kind === 'correction'，页脚校验码 0）同样直接接受（与 八-10 的分拣口径一致）。
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
  const note = record.batchMatch === false
    ? '（页脚校验码与这一批不一致：多半是不同一批纸，若结果里的字不对，就用这一页上的「手选页序」定一下页号）'
    : ''
  return { accept: true, reason: 'ok', message: '已收下这一页' + note }
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
 * 规则（《决策记录》二-6、二-7、五-9、六-14）：
 *   · **单页失败**（找不到四角定位块、校正超限）→ **跳过并标红**，不拦整批（二-6 的口径是让那一页重扫）
 *   · **页脚读不出的页** → 字序优先从纸面参考字 / 字序文件定位得到；定位不出来的那一页手选页序
 *     （手选本身即确认）。页脚的批次码只作自校验，**不再当闸门**（五-9 ⑥）
 *   · **整批拦下**只剩两条：页脚校验码与所选批次不符、同一页被重复上传；「批次作废」这一态已删（六-14）
 *   · 缺页只是提醒（warn），不拦 —— 用户可以先把已经写好的页做完
 * 判据全部来自 summarizeBatch 的 rows（按"种类"分拣），**不靠匹配提示文案** —— 文案会改，种类不会。
 * @param {object} input
 * @param {object} input.summary summarizeBatch 的结果（rows 在 summary.pages 里）
 * @param {Array} input.pages 页记录（含 ok / pageNumber / footerOk）
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
  let footerlessFailed = 0 // 页脚读不出、且整页失败的页数（见下面失败分支的注释）
  let duplicatePages = 0 // 重复页里**没被采用**的页数（去重结果，见 dedupeDuplicatePages）

  // 判据优先用 summarizeBatch 的 rows，但**只在行数与页数对得上时**才信它 ——
  // 汇总可能来自上一轮（或还没重算），那时 rows 与 pages 描述的不是同一批件，
  // 混着用会得出自相矛盾的结论（实测踩到：行说"页脚没读出"、页记录说"页脚读出了第 1 页"）。
  // 对不上时退回页记录本身：识别是逐页回调的，"这一页刚处理完、摘要还没算"本来就是常态。
  const useRows = rows.length === pages.length
  const rowOf = (i) => {
    if (useRows) return rows[i]
    const page = pages[i] || {}
    return {
      ok: !!page.ok,
      footerOk: !!page.footerOk,
      batchMatch: page.batchMatch === undefined ? null : page.batchMatch,
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
    // 页脚校验码与当前批次不一致：**只记一笔提示**，这一页照常按"能不能用"来数
    // （2026-10-15 口径，与重传 / 补传一致 —— 用户原话："批次校验的意义是啥，只要模板是我们提供的，
    //   模板内的字都是一样的"）。原来这里 `continue`（把这一页当成不可用），后果是：重传收下一张
    //   别的批次的纸之后，闸门会把整批判成"没有任何一页可用（全部识别失败）"—— 与"校验码不拦人"直接打架
    //   （冒烟里抓到的真缺陷）。判断"这一页到底是哪些字"靠页号与参考字，不靠这个码。
    if (row.batchMatch === false) batchMismatch++
    if (!row.ok || !page.ok) {
      // 单页失败：跳过并标红（决策 二-6：明确失败、提示重扫那一页）
      skipped.push({ fileIndex: page.fileIndex, fileName: page.fileName, reason: page.reason || '这一页没能识别' })
      // 2026-10-13 修（子代理实测发现的真缺陷）：**失败的页不再计入"需要手选页序"** ——
      //   它没有「手选页序」入口（`needsManualOrder` 要求整页成功），原来这里也置 needsConfirm，
      //   于是提示让用户"在它的结果卡片上点「手选页序」"，而那张卡片上根本没有那个按钮。
      //   这类页（页脚读不出 → 方向判据不成立 → 整页失败）单独数出来，下面给一条说清出路的提示。
      if (!row.footerOk) footerlessFailed++
      continue
    }
    if (!row.footerOk) {
      // 页脚读不出：新模型下不再要求"显式确认批次" —— 字序优先由纸面参考字定位得到（决策 五-9）；
      // 定位不出来的页才需要手选页序（手选本身即确认）
      if (page.pageNumber) {
        if (isCorrection) correctionPages++
        else usablePages++
        // 页号的来源要说准（2026-10-13）：序列定位定出来的页号不是"手选"，说成手选会让人以为要他去确认
        notes.push(label + ' 的页脚读不出：页序按' +
          (page.pageNumberSource === 'sequence' ? '纸面参考字序定位得到' : '手选定为') +
          '第 ' + page.pageNumber + ' 页')
      } else {
        // 真的需要用户定页序：这时卡片上才有「手选页序」入口（与 needsManualOrder 同一判据）
        needsConfirm = true
        skipped.push({ fileIndex: page.fileIndex, fileName: page.fileName, reason: '页脚读不出、也还没手选页序' })
      }
      continue
    }
    if (isCorrection) correctionPages++
    else usablePages++
  }

  // 2026-10-11（决策 六-14 ③）：页脚校验码不符**降为提示**，不再拦批 ——
  // 批次对用户不可见，界面上没有"改选批次"这条出路，拦下来就是死路；码本身仍照常解、照常显示，
  // 认错了字在识别结果里看得见（逐格复核 + 更正核对那两道闸还在）。
  if (batchMismatch > 0) {
    notes.push('有 ' + batchMismatch + ' 页的页脚校验码与当前批次不一致：多半不是同一批纸（或用的是旧模板），' +
      '请对照结果里的"字序来源"确认这几页认得对不对')
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
  // 2026-10-11（决策 五-9）：界面上「确认这批扫描件属于所选批次」「我知道这是作废模板」两个勾选框
  // 已随"批次对用户不可见"一起去掉，所以这两条**不能再拦人** —— 用户无从勾选，拦下来就是死路。
  // 页脚的码仍照常解、照常显示（自校验用）；作废的批次也不再拦（字序由纸面参考字定位得到）。
  if (needsConfirm) {
    // 2026-10-13 用户口径：提示得说清**操作在哪**（原来只说"在结果里手选页序"，用户找了半天）——
    // 卡片上现在直接有「手选页序」入口（点了打开这一页的格子弹窗，底部就是填页号的框）。
    // 2026-10-13 再改：这句只在**真的需要用户定页序**时出现（needsConfirm 的置真条件已收窄），
    //   所以它说的入口一定存在 —— 整页失败的页另有下面那条说明。
    notes.push('有扫描件的页脚没读出：字序会优先从纸面参考字定位得到；定位不出来的那一页，' +
      '在它的结果卡片上点「手选页序」填上第几页（也可以把卡片拖到另一张上交换）')
  }
  if (footerlessFailed > 0) {
    // 2026-10-13（子代理真件实测发现的真缺陷）：页脚读不出 → **方向纠正的判据也不成立** → 整页失败，
    //   这种页没有「手选页序」入口（那要求整页成功）。原来提示把用户指向一个不存在的按钮，
    //   这里改成说清它为什么没得选、以及出路是什么。
    notes.push('有 ' + footerlessFailed + ' 页的页脚没读出来、方向也就认不准：整页没能识别 —— ' +
      '把纸按横向放正重拍或重扫这一页（这几页没法在结果里指定页序）')
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
  return { canProceed: blockers.length === 0 && usablePages > 0, blockers, skipped, notes, usablePages, correctionPages, needsConfirm }
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
