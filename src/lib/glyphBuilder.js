// 字形 → 字体（阶段一步骤 1.9）
// 职责：把 1.6 提取出的手写掩膜，经"位图追踪（traceImage）→ 按书写格线性映射到 em 方格 → 只裁不放大（svgPath）
//   → 组装字体（fonteditor-core）"变成可安装的 TTF / woff / woff2 与一份 @font-face CSS。
// 为什么不用参考项目的 `buildFont.js`：那是**图标项目专用**的 —— PUA 码位分配、GSUB 连字表、内置 94 个拉丁基础字形、
//   按 bbox 铺满的坐标映射，汉字一样都用不上（用标准 Unicode、advanceWidth 分全角半角、按书写格线性映射）。
//   本项目只借它的骨架：走 SVG font 中间格式 → `fonteditor.svg2ttfobject` → 修 name 表 → `createFont().write()`。
// 关键参数（决策 四-2、四-3、四-4）：
//   em 方格 1000；字形占位 900×900（左右各留 50，顶部到 800、底部到 -100）；
//   汉字与中文标点全角 1000、数字与拉丁字母半角 500（笔迹水平居中收进 500 宽的格子）；
//   映射按**书写格线性映射**（用户写多大就是多大），**不按包围盒铺满** —— 否则"一"和"国"会一样大。
// 运行环境：需要打包器（fonteditor-core 的发布产物是 CJS 包装，浏览器不能直接加载）；
//   potrace 是 WASM、woff2 还要一个单独的 wasm 文件（放在 public/woff2.wasm，见下面的常量说明）——
//   生产走 vite 打包，测试里用 vite 打一个专用 bundle。
import fonteditor from 'fonteditor-core'
import { maskToPathData } from './traceImage.js'
import { commandsToPathData, parsePathCommands, pathBBox } from './svgPath.js'
import { charToCodePoint, classifyChar } from './charset.js'

// woff2 编码器要一个单独的 wasm（727KB）。**不能**从 node_modules 里 import：
//   fonteditor-core 的 package.json `exports` 只声明了 `.` 与 `./lib/*`，`fonteditor-core/woff2/woff2.wasm` 会被拦下
//   （实测报 Missing specifier）。所以把它放进 public/（构建时复制到产物根目录），运行时按 URL 加载。
export const DEFAULT_WOFF2_WASM_URL = '/woff2.wasm'

// 字体几何参数（取值型参数：改这里要同步《决策记录》四-2 / 四-3 与《实施计划》1.9）
export const FONT_DEFAULTS = {
  unitsPerEm: 1000, // em 方格
  glyphBox: 900, // 字形占位边长（占 em 的 90%）
  glyphLeft: 50, // 占位框左边距（右边距同为 50）
  glyphTop: 800, // 书写格顶边映射到 y=800
  glyphBottom: -100, // 书写格底边映射到 y=-100（上伸 800 / 下伸 -200 的口径）
  fullWidth: 1000, // 汉字与中文标点的 advanceWidth
  halfWidth: 500, // 数字与拉丁字母的 advanceWidth
  turdsize: 2, // 透传给 potrace 的去噪点（1.6 已按面积过滤过，这里只兜底）
  alphamax: 1
}

// Unicode 非字符（U+FDD0–U+FDEF 与每个平面末尾的 U+xFFFE / U+xFFFF）：
// 写进字体的 cmap 会让解析器中断、其后的字形全部丢失（参考项目 2026-09 实测），必须过滤
export function isNoncharacter(code) {
  return (code >= 0xfdd0 && code <= 0xfdef) || (code & 0xfffe) === 0xfffe
}

// 字体族名 → PostScript 名（PostScript 名只允许 ASCII、不能有空格，否则部分软件装不上）
export function toPostScriptName(familyName) {
  const ascii = String(familyName || 'SxFontCreator').replace(/[^\x20-\x7e]/g, '').replace(/[^A-Za-z0-9-]/g, '')
  return ascii || 'SxFontCreator'
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]))
}

// ── Windows 认中文字体所需的 OS/2 字段（清单 三-12，口径见《决策记录》四-5）──────────
// 为什么必须补：Windows（Word / GDI / DirectWrite）判断"这个字体能不能用于中文"看的是 OS/2 表的**代码页位**。
//   我们的字体原来 `ulCodePageRange1 = 1`（只声明 Latin-1）→ Word 的「中文字体」下拉里选不中它、
//   输入中文一律回退宋体，而同一份字体在 PS 里中英文都正常（2026-10-04 装机实测，清单 三-4 / 三-12）。
// 实测对照（零依赖探针直接解析 OS/2 二进制，2026-10-04）：
//   SimSun 宋体   usWeightClass 400、fsSelection 0x0040、ulUnicodeRange2 含第 59 位、ulCodePageRange1 0x00040001
//   SimHei 黑体 / KaiTi 楷体 / Microsoft YaHei 微软雅黑 同前（雅黑为 0x0004001F）
//   我们的字体      usWeightClass 0（**非法值**，规范要求 100~900）、fsSelection 0x00C0、无第 59 位、代码页位只有 Latin-1
// 位号依据：OpenType 规范 OS/2 表的 ulUnicodeRange 位表 —— 第 48 位 = CJK 符号和标点（U+3000–303F）、
//   第 59 位 = **CJK 统一表意文字**（U+4E00–9FFF）。要小心：第 59 位落在 ulUnicodeRange2 的 bit27，
//   不是 bit16（bit16 只是"中日韩符号和标点"）。下面这几个位都对应字表**实际覆盖**的字符块。
const OS2_UNICODE_RANGE1 = 1 << 31 // 第 31 位：常用标点（字表内 6 个：“”‘’—…）
const OS2_UNICODE_RANGE2 = (1 << 16) | (1 << 27) // 第 48 位中日韩符号和标点（14 个）+ 第 59 位 CJK 统一表意文字
const OS2_UNICODE_RANGE3 = 1 << 4 // 第 68 位：半角及全角形式（字表内 8 个：？！，；：（）～）
const OS2_PUA_BIT_IN_RANGE2 = 1 << 28 // 第 60 位：专用区（PUA）—— 我们没有 PUA 字形，要清掉（见下面的"接管"）
const OS2_CODE_PAGE_GB2312 = 1 << 18 // 第 18 位：936 简体中文 GB2312 —— Windows 判定"能用于中文"的那一位

/**
 * 补 Windows 认中文字体所需的 OS/2 字段。必须在 `fonteditor.svg2ttfobject()` 之后、
 * `createFont().write()` 之前调用（否则会被写盘逻辑改写，见下面 ulUnicodeRange2 的说明）。
 *
 * 四处改动：
 *   ① `usWeightClass`（字重级）= 400 —— 原来 0 是非法值，根因是生成的 SVG font-face 没声明 font-weight，
 *      fonteditor 解析时取到 0。常规体按规范是 400。
 *   ② `fsSelection`（字体选择标志）= 0x0040 —— 原来 0x00C0 = REGULAR | USE_TYPO_METRICS，两位都合法，
 *      但设了 USE_TYPO_METRICS 后行距改用 sTypoAscender−Descender+LineGap = 1.116em；改成只留 REGULAR
 *      后与四个系统中文字体一致，行距改用 usWinAscent+usWinDescent = 1.024em（字形只占 800 ~ −100，切不到）。
 *   ③ `ulCodePageRange1` / `ulUnicodeRange1` / `ulUnicodeRange3`：写盘时不会被改写，直接按位补。
 *   ④ `ulUnicodeRange2`：**必须用访问器（getter/setter）接管** —— fonteditor 的 OS/2 表在写盘时会硬写
 *      `ulUnicodeRange2 = 0x10000000`（第 60 位 = 专用区 PUA），直接赋值会被它抹掉（实测：赋完产物里仍是
 *      0x10000000、CJK 位为假）。用 setter 在它硬写之后把我们的位补回去（实测产物 = 0x08010000）。
 *
 * @param {object} ttfObj `fonteditor.svg2ttfobject()` 的返回值（就地修改）
 * @returns {object} 同一个对象，便于链式调用
 */
export function patchOs2ForWindows(ttfObj) {
  const os2 = ttfObj && ttfObj['OS/2']
  if (!os2) return ttfObj
  os2.usWeightClass = 400
  os2.fsSelection = 0x40
  os2.ulCodePageRange1 = (os2.ulCodePageRange1 | OS2_CODE_PAGE_GB2312) >>> 0
  os2.ulUnicodeRange1 = (os2.ulUnicodeRange1 | OS2_UNICODE_RANGE1) >>> 0
  os2.ulUnicodeRange3 = (os2.ulUnicodeRange3 | OS2_UNICODE_RANGE3) >>> 0
  let range2 = (((os2.ulUnicodeRange2 | 0) & ~OS2_PUA_BIT_IN_RANGE2) | OS2_UNICODE_RANGE2) >>> 0
  Object.defineProperty(os2, 'ulUnicodeRange2', {
    get: () => range2,
    // 写盘方 set 时把我们的位补回去、并清掉不成立的 PUA 位：既保住 CJK 位，也不谎报有专用区字形
    set: (value) => { range2 = (((value | 0) & ~OS2_PUA_BIT_IN_RANGE2) | OS2_UNICODE_RANGE2) >>> 0 },
    enumerable: true,
    configurable: true
  })
  return ttfObj
}

// 汉字字形的 PostScript 名（uniXXXX 是惯例写法，Word / PS 的字符映射表按名字查找时能看到）
function glyphName(char) {
  const cp = charToCodePoint(char)
  return 'uni' + cp.toString(16).toUpperCase().padStart(4, '0')
}

/**
 * 单个字形：掩膜 → em 方格坐标的 path。
 * @param {{mask:Uint8Array,width:number,height:number,boxInSlice:object,char:string}} glyph
 *   mask 来自 1.6（1 = 手写笔迹），boxInSlice 是书写格在切片内的像素矩形（切格给的基准）
 * @param {object} [options] FONT_DEFAULTS 的子集
 * @returns {{empty:boolean,d:string,advanceWidth:number,clamped:boolean,bbox:object}}
 */
export async function buildGlyphPath({ mask, width, height, boxInSlice, char }, options = {}) {
  const opt = { ...FONT_DEFAULTS, ...options }
  const half = classifyChar(char) === 'halfwidth'
  const advanceWidth = half ? opt.halfWidth : opt.fullWidth
  const traced = await maskToPathData(mask, {
    width, height, turdsize: opt.turdsize, alphamax: opt.alphamax
  })
  if (traced.empty) return { empty: true, d: '', advanceWidth, clamped: false, bbox: null }

  // ① 按书写格线性映射：书写格（118 像素见方）→ 占位框（900×900），y 轴同时翻转（图像向下 → 字体向上）。
  //    注意要**合并 potrace 自己的 transform**：它的 path 坐标是"像素 × 10"且 y 反向（见 traceImage 的说明），
  //    所以像素坐标 = (c·x + a, d·y + b)。漏掉这一步会让坐标差 10 倍、上下颠倒（实测踩到）。
  const box = boxInSlice
  const tr = traced.transform || { a: 0, b: 0, c: 1, d: 1 }
  const sx = opt.glyphBox / box.width
  const sy = -opt.glyphBox / box.height
  const oxFull = (tr.a - box.x) * sx + opt.glyphLeft // 全角时字形左边落在 x = glyphLeft
  const oy = (tr.b - box.y) * sy + opt.glyphTop // 书写格顶边落在 y = glyphTop
  // ② 半角字形（数字、拉丁字母）：水平再压一半并居中到 500 宽的格子，垂直不变（决策 四-3）。
  //    推导：全角映射 x_tt = x·sx + oxFull；半角 x_half = (x_tt − 500)·0.5 + 500 = x·(sx·0.5) + (oxFull·0.5 + 250)
  const scaleX = (half ? 0.5 : 1) * tr.c * sx
  const offsetX = half ? oxFull * 0.5 + opt.halfWidth / 2 : oxFull
  const scaleY = tr.d * sy
  const offsetY = oy

  // ③ 越界裁剪：映射后若超出 0~1000（越界笔画），按"只裁不放大"收缩并平移回框内（决策 四-2）
  const bb = pathBBox(traced.cmds)
  const mappedMinX = bb.minX * scaleX + offsetX
  const mappedMaxX = bb.maxX * scaleX + offsetX
  const y1 = bb.minY * scaleY + offsetY
  const y2 = bb.maxY * scaleY + offsetY
  const mappedMinY = Math.min(y1, y2)
  const mappedMaxY = Math.max(y1, y2)
  const outTol = 0.5
  let k = 1
  let dx = 0
  let dy = 0
  let clamped = false
  if (mappedMinX < -outTol || mappedMinY < -outTol || mappedMaxX > opt.unitsPerEm + outTol || mappedMaxY > opt.unitsPerEm + outTol) {
    const w = mappedMaxX - mappedMinX
    const h = mappedMaxY - mappedMinY
    const boxSize = opt.unitsPerEm
    k = Math.min(1, boxSize / Math.max(w, boxSize), boxSize / Math.max(h, boxSize))
    const x0 = mappedMinX * k
    const x1 = mappedMaxX * k
    const yy0 = mappedMinY * k
    const yy1 = mappedMaxY * k
    if (x0 < 0) dx = -x0
    if (x1 + dx > boxSize) dx = boxSize - x1
    if (yy0 < 0) dy = -yy0
    if (yy1 + dy > boxSize) dy = boxSize - yy1
    clamped = true
  }
  const d = commandsToPathData(traced.cmds, scaleX * k, scaleY * k, offsetX * k + dx, offsetY * k + dy)
  // 最终包围盒：解析回命令再算（供体检与测试断言；d 是自己生成的规范格式，解析成本可忽略）
  const bbox = pathBBox(parsePathCommands(d))
  return {
    empty: false,
    d,
    advanceWidth,
    clamped,
    bbox,
    // 度量信息：原始包围盒与最终映射参数 —— 3.2 字形体检（越界 / 偏大偏小）要用，排查也靠它
    metrics: {
      rawBBox: bb,
      mappedBBox: { minX: mappedMinX, minY: mappedMinY, maxX: mappedMaxX, maxY: mappedMaxY },
      scaleX, scaleY, offsetX, offsetY, clampScale: k, clampDx: dx, clampDy: dy,
      traceTransform: tr
    }
  }
}

let woff2Ready = null
// 初始化 woff2 的 wasm（首次生成 woff2 时加载；默认取 public/woff2.wasm，调用方可传别的 URL）
export async function ensureWoff2Ready(wasmUrl) {
  if (!woff2Ready) woff2Ready = fonteditor.woff2.init(wasmUrl || DEFAULT_WOFF2_WASM_URL)
  await woff2Ready
}

// 生成 @font-face 用的 CSS（汉字字体不需要图标那套类名，一条声明即可）
export function buildFontCss({ familyName, fileName, version = '1.0' }) {
  return [
    '/* ' + familyName + ' v' + version + ' —— 由 SxFontCreator 生成 */',
    '@font-face {',
    "  font-family: '" + familyName + "';",
    "  src: url('./" + fileName + ".woff2') format('woff2'),",
    "       url('./" + fileName + ".woff') format('woff'),",
    "       url('./" + fileName + ".ttf') format('truetype');",
    '  font-weight: 400;',
    '  font-style: normal;',
    '  font-display: swap;',
    '}',
    ''
  ].join('\n')
}

/**
 * 组装字体：一批字形 → TTF / woff / woff2 + CSS。
 * @param {Array} glyphs `[{ char, mask, width, height, boxInSlice }]`（char 必须唯一）
 * @param {object} meta 名称表字段（决策 四-1）：familyName / fullName / version / designer / copyright / licence / ...
 * @param {{onProgress?:Function, options?:object, woff2WasmUrl?:string}} [cfg]
 */
export async function buildGlyphFont(glyphs, meta = {}, cfg = {}) {
  const opt = { ...FONT_DEFAULTS, ...(cfg.options || {}) }
  const familyName = meta.familyName || 'SxFontCreator'
  const version = meta.version || '1.0'
  const built = []
  const skipped = []
  const seen = new Set()
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i]
    const code = charToCodePoint(g.char)
    // 防御：非字符码位、重复字符、缺掩膜的字形都不进字体（宁缺勿错）
    if (!g.char || !g.mask || seen.has(g.char) || isNoncharacter(code)) {
      skipped.push({ char: g.char, reason: seen.has(g.char) ? 'duplicate' : (isNoncharacter(code) ? 'noncharacter' : 'empty') })
      continue
    }
    const path = await buildGlyphPath(g, opt)
    if (path.empty) {
      skipped.push({ char: g.char, reason: 'noOutline' })
      continue
    }
    seen.add(g.char)
    built.push({ char: g.char, code, d: path.d, advanceWidth: path.advanceWidth, clamped: path.clamped })
    if (cfg.onProgress) cfg.onProgress(i + 1, glyphs.length)
  }
  if (!built.length) {
    const err = new Error('没有可用的字形：这一批里没有任何一个格子提取到笔迹')
    err.code = 'EMPTY_FONT'
    throw err
  }

  // ① SVG font（中间格式）：glyph 的 unicode 决定 cmap、horiz-adv-x 决定字宽
  const glyphsXml = built.map((g) =>
    '<glyph glyph-name="' + glyphName(g.char) + '" unicode="&#x' + g.code.toString(16) + ';" ' +
    'horiz-adv-x="' + g.advanceWidth + '" d="' + escapeXml(g.d) + '"/>')
  const svgFont = '<svg xmlns="http://www.w3.org/2000/svg">\n<defs><font id="' + escapeXml(familyName) +
    '" horiz-adv-x="' + opt.fullWidth + '">\n<font-face font-family="' + escapeXml(familyName) +
    '" units-per-em="' + opt.unitsPerEm + '" ascent="' + opt.glyphTop + '" descent="' + opt.glyphBottom + '"/>\n' +
    glyphsXml.join('\n') + '\n</font></defs>\n</svg>'
  const ttfObj = fonteditor.svg2ttfobject(svgFont, { combinePath: false })

  // ② OS/2 字段补位：Word 靠它认"这是中文字体"（清单 三-12）。位置很关键 —— 必须在写盘之前，
  //   而且 ulUnicodeRange2 是用访问器接管的（fonteditor 写盘时会硬写这个字段，见 patchOs2ForWindows）
  patchOs2ForWindows(ttfObj)

  // ③ name 表（决策 四-1）：中英并列写在同一字段里 —— fonteditor 的 name 表按 platform/language 写记录
  //   （Mac 一条 + Windows 一条，同一字符串），塞不进两套语言；若要严格的双语双记录得自己拼 name 表二进制
  const psName = toPostScriptName(familyName)
  ttfObj.name = {
    ...ttfObj.name,
    fontFamily: familyName,
    fontSubFamily: 'Regular',
    uniqueSubFamily: familyName + ' Regular ' + version,
    fullName: meta.fullName || familyName,
    version: 'Version ' + version,
    postScriptName: psName,
    copyright: meta.copyright || ('Copyright ' + (meta.designer || '') + ' 由 SxFontCreator 生成'),
    designer: meta.designer || '',
    manufacturer: meta.manufacturer || 'SxFontCreator',
    description: meta.description || (familyName + ' —— 用 SxFontCreator 从手写稿生成的手写体'),
    licence: meta.licence || '',
    urlOfLicence: meta.licenceUrl || '',
    sampleText: meta.sampleText || built.slice(0, 12).map((g) => g.char).join('')
  }

  // ④ 写 TTF → woff → woff2
  const font = fonteditor.createFont(ttfObj)
  const ttf = font.write({ type: 'ttf', toBuffer: false })
  const woff = fonteditor.ttf2woff(ttf)
  let woff2 = null
  try {
    await ensureWoff2Ready(cfg.woff2WasmUrl)
    woff2 = fonteditor.woff2.encode(ttf)
  } catch (e) {
    // woff2 失败不该让整条链路失败：ttf 与 woff 已经可用（界面上会提示）
    skipped.push({ char: '', reason: 'woff2Failed' })
  }

  const fileName = psName
  return {
    ttf,
    woff,
    woff2,
    css: buildFontCss({ familyName, fileName, version }),
    fileName,
    familyName,
    mapping: built.map((g) => ({ char: g.char, code: g.code, advanceWidth: g.advanceWidth, clamped: g.clamped })),
    skipped,
    stats: {
      total: glyphs.length,
      built: built.length,
      skipped: skipped.length,
      clamped: built.filter((g) => g.clamped).length,
      halfwidth: built.filter((g) => g.advanceWidth === opt.halfWidth).length
    }
  }
}
