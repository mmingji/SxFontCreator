// 识别产物的内存缓存（**不落盘**）
// 存什么：每页的整页缩略图、136 格拼图（识别结果可视化的原料），以及"有笔迹"的每格掩膜（字体合成 B3 的原料）。
// 为什么不落盘（清单 四-27 登记了这条取舍）：persist 每次改动都会重写整份项目对象，把几 MB 的图与掩膜塞进去
//   会让"改一个族名"也写几 MB；而这些东西**可以由扫描件重新算出来**（识别是确定性的，51 页约 85 秒）。
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

export function cacheSize() {
  return pages.size
}

/**
 * 汇总所有页的"有笔迹掩膜"（字体合成用）。
 * @returns {Array<{index:number, fileIndex:number, char:string, mask:Uint8Array, width:number, height:number, boxInSlice:object}>}
 */
export function glyphMasks() {
  const out = []
  for (const [fileIndex, cache] of pages) {
    for (const item of cache.masks || []) {
      if (item.char) out.push({ ...item, fileIndex })
    }
  }
  return out
}

// 统计（界面提示用）：多少页有缓存、共多少张掩膜、图占多少字节（dataURL 长度的近似值）
export function cacheStats() {
  let masks = 0
  let bytes = 0
  for (const cache of pages.values()) {
    masks += (cache.masks || []).length
    bytes += (cache.thumb ? cache.thumb.length : 0) + (cache.sheet ? cache.sheet.length : 0)
  }
  return { pages: pages.size, masks, imageBytes: bytes }
}
