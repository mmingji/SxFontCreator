// 出模板的"档位 → 字序"唯一出口（决策 八-2 / 八-3、一-3）
//
// 职责：把"写哪些字"的三个预置档位 × 两种排列方式，解析成**确定的一份字序**，供界面共用 ——
//   第 1 步出模板（components/TemplatePreview.vue）与第 1 步的档位说明都从这里取。
// 为什么必须共用一份：档位口径一改（比如「常用 6500 字」的范围变了），
//   出纸的字序与界面上说的范围必须同时变 —— 各写一遍就会出现"纸上排的与界面说的不是一套"。
//
// 零依赖（只用字表 / 频序 / 分级 / 版面），可在 Node 侧直接断言。
import { LAYOUT } from './layout.js'
import { getLevelChars } from './frequency.js'

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

// 2026-10-13：`charsForPreset()` 也一并删了 —— 它本来只被上面的 `presetPlan()` 调用，而后者已随
//   "凭纸恢复批次"那条未接线的路一起删除；现在"档位 → 字序"的计算在 `TemplatePreview.vue` 里
//   按界面当前选择现算（那里的 `charsForScope()` 是唯一实现，本模块只提供档位与排列方式的**标签口径**）。
//   顺带把这个模块的依赖收干净：只剩版面常量与分级计数，不必再引字表 / 频序 / 校验码哈希。

// 2026-10-13：原来这里还有一组"候选批次"的推导（`presetPlan()` / `presetPlans()` /
// `findPresetByBatchCode()`）—— 它们是给"凭纸恢复批次"服务的：拿纸面读到的校验码去认这是哪一档。
// 那个功能从未接线（`lib/restoreBatch.js` 与 `components/RestoreBatch.vue` 都不存在，
// 入口「项目备份」也已随决策 五-10 删除），三个导出因此**全库零引用**（`presetPlans` 只被
// `findPresetByBatchCode` 调用、后者无人调用），一并删除。需要时从 git 历史取回。
//
// 现在这个模块的用途只剩一条、也是它真正的价值：**第 1 步"档位 × 排列方式 → 一份确定字序"的唯一出口**
// —— 界面上的档位说明、界面文案与将来的任何调用方都从这里取，避免"两处各写一遍档位口径"。
