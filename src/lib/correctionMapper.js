// 更正对应（阶段一步骤 1.8）
// 职责：把「1.7 识别出的被圈字清单」与「更正册扫描件里写了字的格」按顺序配成一张对照表，
//   供界面并排核对（决策 一-7），用户确认后由 1.9 用更正册的字形覆盖主区那个字。
// 规则（决策 一-6、一-7 与 二-13，2026-10-04 拍板）：
//   ① **严格顺序**：更正册主段第 k 格 ↔ 被圈字清单第 k 个字；**留空的格 = 这个字保留主区原字形**；
//   ② **红圈作废**：用户在更正册上用红笔圈掉写坏的格 → 该格作废，对应的字进「待补写队列」；
//      （红圈在主区模板上的语义是"这个字写错了"、在更正册上是"这一格作废"，靠**件的类型**区分 ——
//        更正册走页脚的 128+ 专用页号区间、主区是 1~127，不会混，决策 一-9 / 一-19）
//   ③ **末尾补写**：补写区从第 N+1 格起（N = 被圈字数），按连续格号顺序取用；补写格又被圈掉就再进队列，
//      所以"写到一半写坏一格"不必整册重写；
//   ④ 配对只是**初始猜测**：界面可改派 / 删除 / 补录（决策 一-7 的最后一道闸），本模块只给初值。
// 数据来源：被圈字清单 = 1.7 的 markedCells；更正册"写了字的格" = 1.6 的 verdict；
//   "被红圈圈掉的格" = 1.7 在**更正册件**上再跑一遍得到的 markedCells。
import { LAYOUT } from './layout.js'

// 连续格号：更正册的格号跨页连续（第 2 页从 137 起，清单 四-4），是"第 k 格"的统一口径
export function continuousIndex(pageNumber, cellIndex, perPage = LAYOUT.perPage) {
  return (pageNumber - 1) * perPage + cellIndex + 1 // 1 起
}

/**
 * 把 1.6 的提取结果整理成配对用的格清单（按连续格号升序）。
 * @param {Array} cells extractPage 产出的 cells（带 index / pageNumber / verdict / inkPixels）
 * @param {{perPage?:number, fallbackPage?:number}} [options] fallbackPage 用于页号没定出来（pageNumber 为 0）时
 *   按机械顶替（调用方给什么用什么，本函数不猜；"手选页序"那条界面操作已于 2026-10-15 去掉）
 */
export function buildCorrectionCells(cells, options = {}) {
  const perPage = options.perPage || LAYOUT.perPage
  const fallbackPage = options.fallbackPage || 1
  return cells
    .map((c) => {
      const pageNumber = c.pageNumber || fallbackPage
      return {
        continuousIndex: continuousIndex(pageNumber, c.index, perPage),
        pageNumber,
        cellIndex: c.index,
        hasInk: c.verdict !== 'empty',
        inkPixels: c.inkPixels,
        charIndex: c.charIndex
      }
    })
    .sort((a, b) => a.continuousIndex - b.continuousIndex)
}

/**
 * 按顺序把被圈字与更正格配起来。
 * @param {Array} circledChars 被圈字清单，**顺序由调用方定**（通常按页码、页内格号升序）：
 *   `[{ mainCellIndex, pageNumber, charIndex, char }]`
 * @param {Array} correctionCells buildCorrectionCells 的产物（按连续格号升序）
 * @param {{discarded?:Array<number>, perPage?:number}} [options] discarded 是被红圈标为作废的**连续格号**
 * @returns {{pairs:Array, unmatched:Array, discarded:Array, extra:Array, messages:Array, stats:object}}
 */
export function mapCorrections(circledChars, correctionCells, options = {}) {
  const discardSet = new Set(options.discarded || [])
  const byIndex = new Map(correctionCells.map((c) => [c.continuousIndex, c]))
  const N = circledChars.length
  const pairs = []
  const unmatched = []
  const discarded = []
  const queue = [] // 待补写的被圈字（主段里被圈掉的）

  // ① 主段：第 1~N 格，逐格对位
  for (let k = 0; k < N; k++) {
    const circled = circledChars[k]
    const cell = byIndex.get(k + 1)
    const base = {
      order: k, // 被圈字在被圈清单里的位次：输出要按它排序，界面才是"第 1 个、第 2 个…"的顺序
      mainCellIndex: circled.mainCellIndex,
      mainPageNumber: circled.pageNumber,
      mainCharIndex: circled.charIndex,
      mainChar: circled.char
    }
    if (!cell || (!cell.hasInk && !discardSet.has(cell.continuousIndex))) {
      // 留空（或这一格根本没扫到）：该字保留主区原字形，其余字不受影响
      unmatched.push({ ...base, reason: 'blank' })
      continue
    }
    if (discardSet.has(cell.continuousIndex)) {
      // 写坏了、用红笔圈掉：进待补写队列，到补写区再取用
      discarded.push({ continuousIndex: cell.continuousIndex, cellIndex: cell.cellIndex, pageNumber: cell.pageNumber, forMainCellIndex: base.mainCellIndex })
      queue.push({ base, from: cell })
      continue
    }
    pairs.push({
      ...base,
      correctContinuousIndex: cell.continuousIndex,
      correctPageNumber: cell.pageNumber,
      correctCellIndex: cell.cellIndex,
      source: 'main'
    })
  }

  // ② 补写区：从第 N+1 格起按顺序取用。
  //    补写区里的空格**跳过**（它只表示"这一格没用上"，与主段"留空 = 不更正"的语义不同）；
  //    补写格又被圈掉 → 它本要填的那个字重新排队，继续往后再补（规则只有一条，递归适用）
  let next = N + 1
  while (queue.length) {
    const cell = byIndex.get(next)
    if (!cell) break // 更正册的格用完了
    next++
    if (discardSet.has(cell.continuousIndex)) {
      const item = queue.shift()
      discarded.push({ continuousIndex: cell.continuousIndex, cellIndex: cell.cellIndex, pageNumber: cell.pageNumber, forMainCellIndex: item.base.mainCellIndex })
      queue.push(item) // 重新排队，等后面的格
      continue
    }
    if (!cell.hasInk) continue // 空格：跳过，继续往后找
    const item = queue.shift()
    pairs.push({
      ...item.base,
      correctContinuousIndex: cell.continuousIndex,
      correctPageNumber: cell.pageNumber,
      correctCellIndex: cell.cellIndex,
      source: 'replacement',
      replacedTheDiscarded: item.from.continuousIndex
    })
  }
  // 补写区没补完（格用完了）→ 这些字保留主区原字形
  for (const item of queue) unmatched.push({ ...item.base, reason: 'noReplacement' })

  // 输出顺序统一按"被圈字在被圈清单里的位次"：补写对是在主段之后才配上的，
  // 若按处理顺序输出，界面看到的第 2 项会变成第 3 个字，核对时会错行（决策 一-7 的并排核对要求按字序）
  pairs.sort((a, b) => a.order - b.order)
  unmatched.sort((a, b) => a.order - b.order)

  // ③ 超出配对需要的更正格：多写的字，记下来供界面补录/排查
  const used = new Set([...pairs.map((p) => p.correctContinuousIndex), ...discarded.map((d) => d.continuousIndex)])
  const extra = correctionCells
    .filter((c) => c.hasInk && !used.has(c.continuousIndex) && c.continuousIndex > N)
    .map((c) => ({ continuousIndex: c.continuousIndex, cellIndex: c.cellIndex, pageNumber: c.pageNumber }))

  const messages = []
  if (!N) {
    messages.push({ level: 'info', text: '主区没有检测到被圈的字，这份更正册暂时没有可对应的对象' })
  }
  // 2026-10-13（用户口径）：原来这里还会为"留空的格"单独出一条消息（列出主区格号），
  //   但它与界面描述行说的"N 个被圈的字保留主区原字形"是同一件事，而且只给页内格号、跨页时看起来像重复。
  //   留空的事实仍在返回值里（`unmatched` 的 reason='blank' 与 `stats.blank`），由界面统一说一次。
  if (discarded.length) {
    messages.push({
      level: 'info',
      text: '更正册上有 ' + discarded.length + ' 格被红笔圈掉（视为作废），已按顺序改从后面的补写格取字'
    })
  }
  const leftover = unmatched.filter((u) => u.reason === 'noReplacement')
  if (leftover.length) {
    messages.push({
      level: 'warn',
      text: '有 ' + leftover.length + ' 个作废的字在更正册后面没有找到补写（更正册格数不够），将保留主区原字形：' +
        '可以在一张空白纸上补写这些字后单独上传'
    })
  }
  if (extra.length) {
    messages.push({
      level: 'warn',
      text: '更正册上有 ' + extra.length + ' 个多写的格没有对应到被圈的字（第 ' + extra.map((e) => e.continuousIndex).join('、') +
        ' 格），可在界面上手动指派，或确认是否是写多了'
    })
  }

  return {
    pairs,
    unmatched,
    discarded,
    extra,
    messages,
    stats: {
      circled: N,
      paired: pairs.length,
      replaced: pairs.filter((p) => p.source === 'replacement').length,
      blank: unmatched.filter((u) => u.reason === 'blank').length,
      noReplacement: leftover.length,
      extra: extra.length
    }
  }
}
