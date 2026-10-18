// 出模板的"档位 → 字序"唯一出口（决策 八-2 / 八-3、一-3）
//
// 职责：把"写哪些字"的三个预置档位 × 两种排列方式，解析成**确定的一份字序**，供界面共用 ——
//   第 1 步出模板（components/TemplatePreview.vue）与第 1 步的档位说明都从这里取。
// 为什么必须共用一份：档位口径一改（比如「常用 6500 字」的范围变了），
//   出纸的字序与界面上说的范围必须同时变 —— 各写一遍就会出现"纸上排的与界面说的不是一套"。
//
// 零依赖（只用字表 / 频序 / 分级 / 版面），可在 Node 侧直接断言。
import { LAYOUT } from './layout.js'
import { getAllChars } from './charset.js'
import { getRankOrder, sortByRank } from './charRank.js'
import { getLevelChars } from './frequency.js'
import { SINGLE_PAGE_TEXT, singlePageCharCount } from './singlePageText.js'

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
  {
    key: 'single',
    label: '单页试打',
    // 2026-10-16：试打页改成印一段成品文字（原来排"频序前 136 字"）—— 写起来像作品、字也都能进字体。
    // **2026-10-18 现口径：一页名句集锦** —— 汉字一个都不重复、标点去重后排在这一页末尾（用户口径
    //   "保证产出的所有模板都不会有重复的字"），内容见 lib/singlePageText.js。
    // 字数从 lib/singlePageText.js 现算，不写死（换内容时这里自动跟着变）。
    note: '只印一页名句（' + singlePageCharCount() + ' 字）+ 打印自检页'
  },
  { key: 'common', label: '常用 6500 字', note: '一级 ' + L1 + ' + 二级 ' + L2 + ' + 基础字符 ' + BASE + ' = ' + (L1 + L2 + BASE) + ' 字' }
]
// 2026-10-16 删掉了一个 `full`（"全量字表"）档位条目：它是对着**已经不存在的界面档位**写的
//   （2026-10-08 换官方字表后，界面上只剩"单页试打 / 常用 6500 字 / 自定义选字"三选，
//   全量 8274 字走自定义选字里的「全选全部」）—— 全库零引用，留着只会让人以为还有这一档。
// 同批删掉导出 `scopeLabel()`：同样零引用（界面用的是 TemplatePreview 里那个更细的 `scopeLabelOf()`，
//   它要给 custom 补一句中文名）。需要时从 git 历史取回。

export function scopePreset(key) {
  return SCOPE_PRESETS.find((s) => s.key === key) || null
}

export function orderModeLabel(key) {
  const o = ORDER_MODES.find((m) => m.key === key)
  return o ? o.label : key
}

/**
 * 「档位 × 排列方式 → 一份确定字序」的**唯一出口**（2026-10-16 从 `TemplatePreview.vue` 抽到这里）。
 * 为什么抽出来：这段口径原来写在组件里、单测够不到 —— 而它决定的正是"纸上排的是哪些字、什么顺序"，
 *   最该被断言钉住。抽出来的直接动因：试打档从"频序前 136 字"换成"一段成品文字"时，只有组件改了口径，
 *   没有任何测试能发现（`test:template` 测的是 `buildTemplatePdf({chars})` 这个库函数，与档位无关）。
 * 口径：
 *   · `single`（单页试打）—— **就是那一页名句本身**（固定顺序，与排列方式无关，见 lib/singlePageText.js）；
 *   · `common`（常用 6500 字）—— 一级 + 二级 + 基础字符，按排列方式排序；
 *   · `custom`（自定义选字）—— 已选的字，按排列方式排序；**一个字都没选时返回空数组**（没有字可排，
 *     不再退回全量，2026-10-16 用户口径：刚切到这一档时预览应当是空白）；
 *   · 其它值按全量表。
 * @param {string} scope 'single' | 'common' | 'custom' | 其它
 * @param {string} orderMode 'rank' | 'charset'
 * @param {string|string[]} [selectedChars] 自定义选字（custom 档用）
 * @returns {string[]} 字序
 */
export function charsForScope(scope, orderMode, selectedChars) {
  const wantRank = orderMode === 'rank'
  const base = wantRank ? getRankOrder() : getAllChars()
  if (scope === 'single') return Array.from(SINGLE_PAGE_TEXT)
  if (scope === 'common') {
    const picked = [...getLevelChars('l1'), ...getLevelChars('l2'), ...getLevelChars('base')]
    return wantRank ? sortByRank(picked) : picked
  }
  if (scope === 'custom') {
    const picked = Array.from(selectedChars || '')
    // **一个字都没选 = 没有字可排**（2026-10-16 用户口径）：原来这里是 `return base`（"空 = 全量"），
    //   于是刚切到「自定义选字」就按 8274 字出纸、预览显示全量第一页 —— 与"还没选字"的直觉相反。
    //   返回空数组的后果由调用方负责：第 1 步预览显示空白、点下载时明确提示先选字（都不许悄悄退回全量）。
    if (!picked.length) return []
    return wantRank ? sortByRank(picked) : picked
  }
  return base
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
