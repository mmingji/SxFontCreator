// 出模板的"档位 → 字序"唯一出口（决策 八-2 / 八-3、一-3）
//
// 职责：把"写哪些字"的三个预置档位 × 两种排列方式，解析成**确定的一份字序**，供两处共用 ——
//   ① 第 1 步出模板（components/TemplatePreview.vue）；
//   ② "纸还在、库没了"时凭档位重建批次（lib/restoreBatch.js，入口在顶栏「项目备份」）。
// 为什么必须共用一份：两处各写一遍的话，档位口径一改（比如「常用 6500 字」的范围变了）就会出现
//   "恢复出来的批次与实际打印的纸不是同一套字序" —— 这种错在识别阶段表现为"校验码不符"、
//   在成字阶段表现为"字全对不上"，事后很难查。
//
// 零依赖（只用字表 / 频序 / 分级 / 版面 + 批次校验码哈希），可在 Node 侧直接断言。
import { LAYOUT } from './layout.js'
import { getAllChars } from './charset.js'
import { getRankOrder, sortByRank } from './charRank.js'
import { getLevelChars } from './frequency.js'
import { computeBatchCode } from './batchCode.js'

// 排列方式（与第 1 步界面上的两个选项一一对应）
export const ORDER_MODES = [
  { key: 'rank', label: '按使用频率' },
  { key: 'charset', label: '按笔画序' }
]

// 预置档位。数字一律现算（改字表时说明自动跟着变，不硬编码）
const L1 = getLevelChars('l1').length
const L2 = getLevelChars('l2').length
const BASE = getLevelChars('base').length

export const SCOPE_PRESETS = [
  { key: 'single', label: '单页试打', note: '只写第 1 页（前 ' + LAYOUT.perPage + ' 字）' },
  { key: 'common', label: '常用 6500 字', note: '一级 ' + L1 + ' + 二级 ' + L2 + ' + 基础字符 ' + BASE + ' = ' + (L1 + L2 + BASE) + ' 字' },
  { key: 'full', label: '全量字表', note: '《通用规范汉字表》' + (L1 + L2 + getLevelChars('l3').length) + ' + 基础字符 ' + BASE + ' = ' + (L1 + L2 + getLevelChars('l3').length + BASE) + ' 字' }
]

export function scopePreset(key) {
  return SCOPE_PRESETS.find((s) => s.key === key) || null
}

export function scopeLabel(key) {
  const s = scopePreset(key)
  return s ? s.label : key
}

export function orderModeLabel(key) {
  const o = ORDER_MODES.find((m) => m.key === key)
  return o ? o.label : key
}

/**
 * 某个预置档位在某种排列方式下的完整字序。
 * 口径与第 1 步界面的「写哪些字」严格一致：
 *   - single：先把**全序**排好（频序或笔画序），再取前 136 字 —— 所以频序下就是"最常用的 136 字"；
 *   - common：一级 + 二级 + 基础字符（按字表顺序拼接），再按排列方式排序；
 *   - full  ：全量 8274 字，再按排列方式排序。
 * @param {'single'|'common'|'full'} scopeKey
 * @param {'rank'|'charset'} [orderMode]
 * @returns {string[]} 字序数组（副本；调用方可以安全地改动它）
 */
export function charsForPreset(scopeKey, orderMode = 'rank') {
  const wantRank = orderMode === 'rank'
  if (scopeKey === 'single') {
    const base = wantRank ? getRankOrder() : getAllChars()
    return base.slice(0, LAYOUT.perPage)
  }
  if (scopeKey === 'common') {
    const picked = [...getLevelChars('l1'), ...getLevelChars('l2'), ...getLevelChars('base')]
    return wantRank ? sortByRank(picked) : picked
  }
  if (scopeKey === 'full') {
    const base = getAllChars()
    return wantRank ? sortByRank(base) : base
  }
  return []
}

/**
 * 一个"候选批次"的完整描述 —— 恢复批次时拿它与纸面对比（校验码）或直接落库。
 * @returns {{scope:string, order:string, label:string, chars:string[], charsText:string,
 *            charCount:number, pageCount:number, batchCode:number}}
 */
export function presetPlan(scopeKey, orderMode = 'rank') {
  const chars = charsForPreset(scopeKey, orderMode)
  return {
    scope: scopeKey,
    order: orderMode,
    label: scopeLabel(scopeKey) + ' · ' + orderModeLabel(orderMode),
    chars,
    charsText: chars.join(''),
    charCount: chars.length,
    pageCount: Math.max(1, Math.ceil(chars.length / LAYOUT.perPage)),
    batchCode: computeBatchCode(chars)
  }
}

// 6 种候选（3 档 × 2 排列）只算一次：算一遍要把八千多字排序，恢复流程里会反复比对同一批候选。
// 字表与频序在运行期不变，缓存安全。
let plansCache = null
export function presetPlans() {
  if (!plansCache) {
    plansCache = []
    for (const s of SCOPE_PRESETS) for (const o of ORDER_MODES) plansCache.push(presetPlan(s.key, o.key))
  }
  return plansCache
}

/** 拿纸面读到的 12 位校验码去认"这是哪一档"；命中返回该候选，否则 null */
export function findPresetByBatchCode(batchCode) {
  if (batchCode === null || batchCode === undefined) return null
  return presetPlans().find((p) => p.batchCode === (batchCode | 0)) || null
}
