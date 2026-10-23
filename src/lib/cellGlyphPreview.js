// 第 2 步「看格子」的单格字形预览（2026-10-23 用户口径：点开一格看字形效果，而不是像素化的掩膜）
// 职责：取"这一格"的笔迹掩膜 → 用**生成字体同一条路径**（glyphOutline.buildGlyphPath）现算矢量轮廓。
// 为什么不用"第 3 步生成的字体"来渲染这一格：第 2 步通常还没生成字体；字体可能是旧的（重新识别后
//   没重新生成）；被剔除 / 待重写 / 被更正册覆盖的字与"这一格"不是一一对应；「轮廓」档位改了字体也
//   不会自动变。用同一条生成路径现算，才能保证"这里看到的就是下次生成字体得到的字形"。
// 取数的两条来源（与 lib/pageSheet.js 的格子拼图同一套路）：
//   ① 当前会话：识别时把掩膜留在 scanCache（不落盘，清单 四-27）；
//   ② 刷新 / 关浏览器之后：从落盘的字形分片里**只解码这一格**（glyphStore.loadGlyphPage）。
// 注意：落盘只存"有笔迹"的格，空白格查不到 —— 调用方按"这一格没写"处理，不必去追踪空掩膜。
import { getPageCache } from './scanCache.js'
import { loadGlyphPage, pngDataUrlToMask } from './glyphStore.js'
import { buildGlyphPath } from './glyphOutline.js'
import { traceOptionsFromPreset } from './scanPresets.js'

/**
 * 取某一格的笔迹掩膜（内存优先，其次落盘）。
 * @param {{fileIndex:number, cellIndex:number}} input
 * @returns {Promise<{mask:Uint8Array,width:number,height:number,boxInSlice:object,char:string}|null>}
 *   这一格没有笔迹 / 没有落盘分片时返回 null
 */
export async function loadCellGlyph({ fileIndex, cellIndex }) {
  const cache = getPageCache(fileIndex)
  const cached = ((cache && cache.masks) || []).find((m) => m.index === cellIndex)
  if (cached && cached.mask) {
    return {
      mask: cached.mask,
      width: cached.width,
      height: cached.height,
      boxInSlice: cached.boxInSlice,
      char: cached.char || ''
    }
  }
  const page = await loadGlyphPage({ fileIndex })
  const glyph = ((page && page.glyphs) || []).find((g) => g.cellIndex === cellIndex)
  if (!glyph) return null
  return {
    mask: await pngDataUrlToMask(glyph.png, glyph.width, glyph.height),
    width: glyph.width,
    height: glyph.height,
    boxInSlice: glyph.boxInSlice,
    char: glyph.char || ''
  }
}

/**
 * 现算这一格的矢量轮廓（设计框坐标，y 向上）。
 * @param {object} glyph loadCellGlyph 的产物
 * @param {object} advanced 识别高级档位（store.scan.advanced；只用到「轮廓」→ alphamax）
 * @returns {Promise<{empty:boolean,d:string,advanceWidth:number,clamped:boolean,bbox:object|null}>}
 */
export async function buildCellOutline(glyph, advanced) {
  const { alphamax } = traceOptionsFromPreset(advanced)
  const path = await buildGlyphPath(glyph, { alphamax })
  return {
    empty: path.empty,
    d: path.d,
    advanceWidth: path.advanceWidth,
    clamped: path.clamped,
    bbox: path.bbox
  }
}
