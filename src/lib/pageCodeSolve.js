// 指纹反解：用右侧方块里那 12 位校验码，把"逐格认字认错的格"纠正回来（2026-10-18 新增）
//
// 为什么需要它：逐格认字是**没有候选字序时**的最后一条路（自定义档丢了 字序.sxorder、参考字又被
//   红圈 / 手写序号盖住时尤其容易错几个字）。而右侧方块里的指纹是"这一页的字"的整页哈希 —— 错一个字就全变，
//   于是现在只能整页失败、写过的字白写（用户实测问出来的）。可**每格的候选其实已经算好了**：
//   referenceCharReader 的 `cells[i].candidates` 就是 top-5（带分数与 margin），这里做一件小事 ——
//   在"最可疑的 U 格"的 top-K 候选里穷举，找出使指纹与纸面一致的那一组。
//
// **一个必须正视的性质（2026-10-18 实测踩到）**：12 位指纹只有 4096 种值，而组合空间一旦超过它，
//   就会撞上"假匹配"（实测 3^12=53 万组里会碰到上百个指纹相同、字却不同的组合）。所以本模块**不是**
//   "找到第一个匹配就返回"，而是要：
//     ① 遍历**全部**组合、收集所有指纹匹配者；
//     ② 按"候选分数总和"挑最像的那一个（真值的匹配分数通常最好：它就是纸上那个字）；
//     ③ 加**置信度判据** —— 多个匹配时，最优必须明显优于次优（默认差 ≥ 10%），否则宁可返回 null。
//   这条性质决定了它只是**概率性兜底**；真正无歧义的方案是"每页自带整页字序"（二维码，见 一-19 的后续）。
//
// 判据仍然是**宁严勿宽**：搜不到、或匹配之间分不开 → 返回 null，调用方照旧整页失败。
//
// 与"候选全序反推页号"（pageCode.matchPageCode）的分工：
//   · matchPageCode 需要**候选字序**（字序文件 / 预置全序 / 内置试打页），逐页试哈希；
//   · 本模块**不需要任何候选**，候选来自纸面自己（每格的 top-K）→ 自定义档也能救回来。
import { isBlankChar } from './pageCode.js'

// FNV-1a 的一步（与 pageCode.computePageCode 必须同一个算法：改一处就要改另一处，测试里有对照断言）
const fnvStep = (hash, byte) => Math.imul((hash ^ byte) >>> 0, 0x01000193) >>> 0

/** 默认参数：最多在 12 个"最可疑的格"上分叉、每格取前 2 个候选（4096 组，与 12 位指纹同一量级） */
export const SOLVE_DEFAULTS = {
  maxCells: 12,
  topK: 2,
  // 最多保留多少个"指纹匹配"的候选组合（防御：假匹配可能很多，没必要全存）
  maxMatches: 64,
  // 置信度：有多个匹配时，最优的分数总和必须比次优低这么多（相对值），否则判"分不开"→ 返回 null
  minGain: 0.1,
  // 步数上限（防某个病态页把浏览器卡住）
  maxSteps: 6000000
}

/**
 * 在每格候选里穷举，找出与目标指纹一致、且"最像"的整页字序。
 * @param {Array} cells referenceCharReader 产出的格（每格 `{ index, empty, char, candidates:[{char,score}], margin }`）
 * @param {number} pageCode 纸面右侧方块读出的 12 位指纹（0 表示没读出来 → 无法反解）
 * @param {object} [options]
 * @returns {{chars:string[], code:number, fixed:number, tried:number, matches:number, gain:number}|null}
 *   `chars` 是**整页**字序（空格格是 null，与调用方约定一致）；`fixed` = 与逐格认字结果相比改了几格；
 *   `gain` = 最优与次优的分数差（相对值；只有一个匹配时是 1）
 */
export function solvePageCharsByCode(cells, pageCode, options = {}) {
  const opt = { ...SOLVE_DEFAULTS, ...options }
  if (!pageCode || !Array.isArray(cells) || !cells.length) return null
  const target = pageCode & 0xfff
  if (target === 0) return null // 0 = "这一页没有字"，不参与

  // ① 每格的候选：优先用 candidates（top-K），没有候选的退回它自己认出的那个字
  const grid = cells.map((c) => {
    if (!c || c.empty) return { chars: [null], scores: [0], uncertain: false }
    const list = (c.candidates || []).filter((x) => x && x.char && !isBlankChar(x.char))
    const uniq = []
    for (const x of list) if (!uniq.some((u) => u.char === x.char)) uniq.push({ char: x.char, score: x.score || 0 })
    if (!uniq.length && c.char && !isBlankChar(c.char)) uniq.push({ char: c.char, score: 0 })
    if (!uniq.length) return { chars: [null], scores: [0], uncertain: false }
    const keep = uniq.slice(0, Math.max(1, opt.topK))
    return {
      chars: keep.map((u) => u.char),
      scores: keep.map((u) => u.score),
      uncertain: keep.length > 1,
      margin: typeof c.margin === 'number' ? c.margin : 1
    }
  })

  // ② 挑"最可疑的 U 格"来分叉：margin 越小（第一名与第二名越接近）越可能认错；
  //    红圈盖住参考字的格通常就落在这批里。
  const forkable = []
  for (let i = 0; i < grid.length; i++) if (grid[i].uncertain) forkable.push(i)
  forkable.sort((a, b) => (grid[a].margin ?? 1) - (grid[b].margin ?? 1))
  const forks = forkable.slice(0, Math.max(0, opt.maxCells))
  const forkSet = new Set(forks)
  const original = cells.map((c) => (c && !c.empty && c.char ? c.char : null))

  let steps = 0
  let tried = 0
  const matches = []

  // ③ 树形遍历：确定格只走一条路，分叉格走 K 条；每步只喂 3 个字节（FNV 的顺序累加让前缀可以共享），
  //    同时沿路累加候选分数 —— 分数越小越像，最后用它区分"多个指纹匹配"里哪个才是真值。
  function walk(i, hash, score, out) {
    if (steps++ > opt.maxSteps) return
    if (i === grid.length) {
      tried++
      if ((hash & 0xfff) === target) {
        matches.push({ chars: out.slice(), score })
        if (matches.length >= opt.maxMatches) steps = opt.maxSteps // 存满了就收手
      }
      return
    }
    const cell = grid[i]
    const idxs = forkSet.has(i) ? cell.chars.map((_, k) => k) : [0]
    for (const k of idxs) {
      const ch = cell.chars[k]
      out[i] = ch
      let h = hash
      if (ch) {
        const cp = ch.codePointAt(0)
        h = fnvStep(h, cp & 0xff)
        h = fnvStep(h, (cp >> 8) & 0xff)
        h = fnvStep(h, (cp >> 16) & 0xff)
      }
      walk(i + 1, h, score + (cell.scores[k] || 0), out)
    }
    out[i] = undefined
  }

  walk(0, 0x811c9dc5, 0, new Array(grid.length))
  if (!matches.length) return null

  // ④ 择优 + 置信度：分数总和最小的那个最像真值；若次优与它难分（相对差 < minGain）→ 判"分不开"，
  //    宁可返回 null（宁严勿宽：错一页字比失败一页糟得多）。
  matches.sort((a, b) => a.score - b.score)
  const best = matches[0]
  const second = matches[1]
  const gain = second ? (second.score - best.score) / (second.score || 1) : 1
  if (second && gain < opt.minGain) return null

  let fixed = 0
  for (let i = 0; i < best.chars.length; i++) if ((best.chars[i] || null) !== (original[i] || null)) fixed++
  return { chars: best.chars.map((ch) => ch || null), code: target, fixed, tried, matches: matches.length, gain }
}
