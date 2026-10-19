// 识别产物的内存缓存（**不落盘**）
// 存什么：每页的整页缩略图、136 格拼图（识别结果可视化的原料），以及"有笔迹"的每格掩膜（字体合成 B3 的原料）。
// 为什么不落盘（清单 四-27 登记了这条取舍）：persist 每次改动都会重写整份项目对象，把几 MB 的图与掩膜塞进去
//   会让"改一个族名"也写几 MB；而这些东西**可以由扫描件重新算出来**（识别是确定性的，61 页约 100 秒）。
//   代价：刷新页面后缩略图与掩膜没了，要重新上传识别一次才能看大图 / 继续生成字体。
// 生命周期：每批识别开始时 clear()，逐页写入；界面刷新即空。
const pages = new Map() // fileIndex → { thumb, sheet, masks, designSize }

export function putPageCache(fileIndex, cache) {
  pages.set(fileIndex, cache)
}

export function getPageCache(fileIndex) {
  return pages.get(fileIndex) || null
}

export function clearPageCache() {
  pages.clear()
}

// 2026-10-13：原来这里还有三个导出 —— `cacheSize()`（缓存了几页）、`glyphMasks()`（把各页的笔迹掩膜
// 汇总给字体合成用）、`cacheStats()`（页数 / 掩膜数 / 图占多少字节）。三者**全库零引用**，一并删除：
//   · 字体合成实际走的是 `buildFont.collectGlyphInputs` —— 它按页 `getPageCache(fileIndex)` 取掩膜，
//     取不到再退回 `glyphStore` 的落盘分片（决策 二-16），不需要"先汇总成一个大数组"；
//   · 界面上的"字形已落盘 N 页 / M 个字 / X MB"用的是 `glyphStore.glyphStoreStats()`（落盘口径），
//     与内存缓存无关。
// 也就是"缓存里有几页"这个数从来没有上过界面。需要时从 git 历史取回。
