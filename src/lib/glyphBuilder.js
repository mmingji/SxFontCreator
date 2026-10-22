// 字形 → 字体（阶段一步骤 1.9）
// 职责：把 1.6 提取出的手写掩膜，经"位图追踪（traceImage）→ 按书写格线性映射到 em 方格 → 只裁不放大（svgPath）
//   → 直接写 TTF（ttfWriter）→ woff / woff2 编码（fonteditor-core）"变成可安装的字体与一份 @font-face CSS。
// 为什么不用参考项目的 `buildFont.js`：那是**图标项目专用**的 —— PUA 码位分配、GSUB 连字表、内置 94 个拉丁基础字形、
//   按 bbox 铺满的坐标映射，汉字一样都用不上（用标准 Unicode、统一全角 1000、按书写格线性映射）。
//   本项目只用 fonteditor 做 woff / woff2 编码（它接受我们写出的 TTF 字节），**不再经过 SVG font 中间格式**。
// 关键参数（决策 四-2、四-3、四-4）：
//   em 方格 1000；字形占位 1000×1000（字面率 100%，书写格横向 0~1000、竖向 −100~900 —— 2026-10-04 由 900×900 抬高，清单 一-5）；
//   汉字与中文标点全角 1000；数字/拉丁字母按**实际宽度**（0.3~0.8em，比例字体）；补的空格 **300**；
//   **hmtx 全量**（`numberOfHMetrics = numGlyphs`，与系统手写体一致，见 ②）；
//   映射按**书写格线性映射**（用户写多大就是多大），**不按包围盒铺满** —— 否则"一"和"国"会一样大。
// 运行环境：需要打包器（fonteditor-core 的发布产物是 CJS 包装，浏览器不能直接加载）；
//   potrace 是 WASM、woff2 还要一个单独的 wasm 文件（放在 public/woff2.wasm，见下面的常量说明）——
//   生产走 vite 打包，测试里用 vite 打一个专用 bundle。
import fonteditor from 'fonteditor-core'
import { maskToPathData } from './traceImage.js'
import { commandsToPathData, parsePathCommands, pathBBox } from './svgPath.js'
import { charToCodePoint, classifyChar } from './charset.js'
import { ensureInlineAsset, hasInlineAssets } from './inlineAssets.js'
import { FONT_DEFAULTS, glyphMapping, mapBBoxToDesignBox } from './glyphGeometry.js'
import { buildTrueTypeFont } from './ttfWriter.js'

// woff2 编码器要一个单独的 wasm（710KB）。**不能**从 node_modules 里 import：
//   fonteditor-core 的 package.json `exports` 只声明了 `.` 与 `./lib/*`，`fonteditor-core/woff2/woff2.wasm` 会被拦下
//   （实测报 Missing specifier）。所以把它放进 public/，运行时按 URL 加载。
// 路径用**相对**的 './woff2.wasm'（不是 '/woff2.wasm'）：交付形态是 file:// 双击打开，
//   绝对路径会被解析成 `file:///woff2.wasm` 而指向磁盘根目录；相对路径在 http 与 file:// 下都指向产物目录。
// file:// 下连相对路径也读不了（清单 三-8：fetch 被拦）—— 那种形态改用构建期内联的 wasm（见下）。
export const DEFAULT_WOFF2_WASM_URL = './woff2.wasm'

// 字体几何参数（取值型参数：改这里要同步《决策记录》四-2 / 四-3 与《实施计划》1.9）
// 2026-10-04 调整（清单 一-5：装机实测"同等字号观感偏小"）：书写格的映射上限由 900 抬到 1000。
//   实测依据：79 字样本的字面高度中位只有 0.734em，而宋体 0.910em、楷体 0.859em、雅黑 0.956em ——
//   两个原因叠加：① 书写占格率中位只有书写格的 81.6%（主因，属用户书写习惯，见模板那行要点）；
//   ② 映射上限 0.9em（旧值 900）。抬到 1000 后同样的笔迹字面 +11%，且**对已经手写好的纸也生效**（重扫即可）。
// 2026-10-07：常量搬到零依赖的 `glyphGeometry.js`（体检模块也要用同一份几何，不能为此加载本模块），
//   这里**再导出**保持既有引用不变（与 layout.js / templatePdf.js 同一套路）。
export { FONT_DEFAULTS }

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


/**
 * 单个字形：掩膜 → em 方格坐标的 path。
 * @param {{mask:Uint8Array,width:number,height:number,boxInSlice:object,char:string}} glyph
 *   mask 来自 1.6（1 = 手写笔迹），boxInSlice 是书写格在切片内的像素矩形（切格给的基准）
 * @param {object} [options] FONT_DEFAULTS 的子集
 * @returns {{empty:boolean,d:string,advanceWidth:number,clamped:boolean,bbox:object}}
 */
export async function buildGlyphPath({ mask, width, height, boxInSlice, char }, options = {}) {
  const opt = { ...FONT_DEFAULTS, ...options }
  // 数字 / 拉丁字母：**按字形实际宽度给 advance（比例字体）**，对照系统里的手写体：
  //   方正小楷数字 287~430、悠哉 539~718、飞波 376~766；固定全角 1000 太宽、固定半角 500
  //   又不能反映"写得宽 / 窄"。这里按墨迹宽度 + 左右各 0.05em，夹在 0.3~0.8em。
  //   汉字与中文标点仍是全角 1000。
  const isHalf = classifyChar(char) === 'halfwidth'
  let advanceWidth = opt.fullWidth
  const traced = await maskToPathData(mask, {
    width, height, turdsize: opt.turdsize, alphamax: opt.alphamax
  })
  if (traced.empty) return { empty: true, d: '', advanceWidth, clamped: false, bbox: null }

  // ① 按书写格线性映射：书写格（118 像素见方）→ **设计框**（横向 0~1000、竖向 −100~900；决策 四-2 / 四-4），
  //    y 轴同时翻转（图像向下 → 字体向上）。**不是**映射到 0~1000 的正方形 —— 越界判据、缩放与平移
  //    都按设计框算（见 glyphGeometry.mapBBoxToDesignBox 与本文件下面的收缩逻辑）。
  //    注意要**合并 potrace 自己的 transform**：它的 path 坐标是"像素 × 10"且 y 反向（见 traceImage 的说明），
  //    所以像素坐标 = (c·x + a, d·y + b)。漏掉这一步会让坐标差 10 倍、上下颠倒（实测踩到）。
  //    数字/字母也用全角映射（书写格 0~1000），字形保持用户写的位置，再按实际宽度定 advance。
  const bb = pathBBox(traced.cmds)
  const box = boxInSlice || { x: 0, y: 0, width, height } // 缺省退化成"整张切片都算书写格"（与 1.6 同口径）
  const tr = traced.transform || { a: 0, b: 0, c: 1, d: 1 }
  const mapping = glyphMapping({ boxInSlice: box, half: false, traceTransform: tr }, opt)
  const { scaleX, offsetX, scaleY, offsetY } = mapping
  const { mapped, box: designBox, outside, clampScale } = mapBBoxToDesignBox(bb, mapping, false)

  // ② 越界处理：**以"书写格映射出来的设计框"为界**（决策 四-2 ④、四-4），越出设计框的笔画按
  //    "只裁不放大"等比收缩并平移回框内。为什么界要用设计框、不用"0~1000 的 em 方格"：
  //    书写格底边落在基线下方 0.1em（glyphBottom = −100），按 0~1000 判会把**格内**那一段合法笔迹
  //    当成越界、把整个字上移 0.1em —— 破坏基线一致性（2026-10-04 实测：60/79 个字形被"处理"过，
  //    其中多数只是被平移、并非真的越界）。
  let k = 1
  let dx = 0
  let dy = 0
  if (outside) {
    k = clampScale
    const x0 = mapped.minX * k
    const x1 = mapped.maxX * k
    const yy0 = mapped.minY * k
    const yy1 = mapped.maxY * k
    if (x0 < designBox.left) dx = designBox.left - x0
    if (x1 + dx > designBox.right) dx = designBox.right - x1
    if (yy0 < designBox.bottom) dy = designBox.bottom - yy0
    if (yy1 + dy > designBox.top) dy = designBox.top - yy1
  }
  const baseD = commandsToPathData(traced.cmds, scaleX * k, scaleY * k, offsetX * k + dx, offsetY * k + dy)
  // 数字/字母：按墨迹宽度定 advance，并把字形左移到 0.05em 边距处
  let shift = 0
  if (isHalf) {
    const pre = pathBBox(parsePathCommands(baseD))
    const inkWidth = pre.maxX - pre.minX
    const pad = 50
    advanceWidth = Math.max(300, Math.min(800, Math.round(inkWidth + pad * 2)))
    shift = pad - pre.minX
  }
  const d = shift
    ? commandsToPathData(traced.cmds, scaleX * k, scaleY * k, offsetX * k + dx + shift, offsetY * k + dy)
    : baseD
  // 最终包围盒：解析回命令再算（供体检与测试断言；d 是自己生成的规范格式，解析成本可忽略）
  const bbox = pathBBox(parsePathCommands(d))
  return {
    empty: false,
    d,
    advanceWidth,
    clamped: outside,
    bbox,
    // 度量信息：原始包围盒与最终映射参数 —— 3.2 字形体检（越界 / 偏大偏小）要用，排查也靠它
    metrics: {
      rawBBox: bb,
      mappedBBox: mapped,
      scaleX, scaleY, offsetX, offsetY, clampScale: k, clampDx: dx, clampDy: dy,
      traceTransform: tr
    }
  }
}

let woff2Ready = null
// 解析 woff2 编码器的 wasm 地址：内联形态（file:// 交付产物）用构建期内联的字节拼成 **data URL**
//   （emscripten 自己会去取这个 URL，file:// 下只有 data URL 能被它取到）；其余形态用相对路径的文件。
async function resolveWoff2WasmUrl(wasmUrl) {
  if (hasInlineAssets()) {
    try {
      const b64 = await ensureInlineAsset('woff2-wasm')
      if (b64) return 'data:application/wasm;base64,' + b64
    } catch (e) {
      // 内联取不到就退回文件路径；真不可用时 buildGlyphFont 会把 woff2 记成"未产出"而不是整体失败
    }
  }
  return wasmUrl || DEFAULT_WOFF2_WASM_URL
}

// 初始化 woff2 的 wasm（首次生成 woff2 时加载；调用方可传别的 URL 覆盖）
export async function ensureWoff2Ready(wasmUrl) {
  if (!woff2Ready) woff2Ready = resolveWoff2WasmUrl(wasmUrl).then((url) => fonteditor.woff2.init(url))
  await woff2Ready
}

// 生成 @font-face 用的 CSS（汉字字体不需要图标那套类名，一条声明即可）
// `hasWoff2`（2026-10-18）：woff2 编码失败时包里不会放 `.woff2`（见 buildGlyphFont 的 try/catch），
//   这时**不能**再写那一行 —— 否则 font.css 指着一个不存在的文件，浏览器先 404、再回退到 woff/ttf
//   （能用，但控制台多一条报错、用户会以为包坏了）。woff 与 ttf 视为恒有：woff 失败会让整条构建失败，
//   不会走到"包已经打出来"这一步。
export function buildFontCss({ familyName, fileName, version = '1.0', hasWoff2 = true }) {
  const src = []
  if (hasWoff2) src.push("url('./" + fileName + ".woff2') format('woff2'),")
  src.push("url('./" + fileName + ".woff') format('woff'),")
  src.push("url('./" + fileName + ".ttf') format('truetype');")
  return [
    '/* ' + familyName + ' v' + version + ' —— 由 SxFontCreator 生成 */',
    '@font-face {',
    "  font-family: '" + familyName + "';",
    ...src.map((line, i) => (i === 0 ? '  src: ' + line : '       ' + line)),
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
  // 同字多份（一个 `char` 只能有一个字形）：**后到的覆盖先前的**（2026-10-15 用户口径 ——
  //   "重写模板写完后补传回来，同一个字与主区都有字形时以新写的优先"）。
  //   补传进来的页排在 `pages` 最后，而字形计划按页顺序展开，所以"后到优先"正好等于"新写的优先"；
  //   改动之前是"先到先得"，主区那份（要重写的旧字形）会赢，重写就白写了。
  //   覆盖时**位置不动**（保持这个字第一次出现的次序），只把内容换成新的。
  const byChar = new Map()
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i]
    const code = charToCodePoint(g.char)
    // 防御：非字符码位、缺掩膜的字形都不进字体（宁缺勿错）
    if (!g.char || !g.mask || isNoncharacter(code)) {
      skipped.push({ char: g.char, reason: isNoncharacter(code) ? 'noncharacter' : 'empty' })
      continue
    }
    const path = await buildGlyphPath(g, opt)
    if (path.empty) {
      skipped.push({ char: g.char, reason: 'noOutline' })
      continue
    }
    const entry = { char: g.char, code, d: path.d, advanceWidth: path.advanceWidth, clamped: path.clamped }
    if (byChar.has(g.char)) {
      built[byChar.get(g.char)] = entry
      skipped.push({ char: g.char, reason: 'duplicate' })
    } else {
      byChar.set(g.char, built.length)
      built.push(entry)
    }
    if (cfg.onProgress) cfg.onProgress(i + 1, glyphs.length)
  }
  if (!built.length) {
    const err = new Error('没有可用的字形：这一批里没有任何一个格子提取到笔迹')
    err.code = 'EMPTY_FONT'
    throw err
  }

  // ① **补一个空格字形**（2026-10-16 用户拍板"补空格"；**2026-10-22 用户拍板宽度 300**）。
  //   为什么补：这份字体原来不含 U+0020 —— 用户打空格只能走系统回退；更要紧的是 **Adobe 的「字形保护」**
  //   （Glyph Protection，Photoshop 默认开启）：输入里只要有一个字符不在字体里，它就把**整个文字图层**
  //   换成系统字体（2026-10-16 实测：PS 新建文字图层默认预置的 "Lorem Ipsum" 就把这份只含汉字的字体
  //   当场换掉了；那次的实际触发字符是拉丁字母，见《使用说明》第五节 —— 空格同样是最常见的触发字符）。
  //   **宽度 300（0.3em）**：500 是系统西文空格（Arial 0.278em / Segoe UI 0.274em）的近两倍、看着太宽；
  //   300 与系统手写体里偏窄的两款（方正 296、悠哉 333）同档。它仍是空轮廓、只占位。
  //   **别把它与"Word 里汉字挤"混在一起**：挤的根因是 `.notdef` 的 advance（374），见《决策记录》四-3。
  //   它**不计入"收录"**：coverage / mapping / 界面上的"N 个字"说的都是"用户写了多少字"（八-21 的口径），
  //   程序补的这一格不算用户的书写成果 —— 只在 stats 里用 spaceGlyph 标出来，供测试与说明引用。
  const fontGlyphs = built.slice()
  const hasSpaceGlyph = !byChar.has(' ')
  if (hasSpaceGlyph) {
    fontGlyphs.unshift({ char: ' ', code: 0x20, d: '', advanceWidth: opt.spaceWidth, clamped: false })
  }

  // ② 写 TTF：**直接写表**（ttfWriter.js），不再走 "SVG font → svg2ttfobject → createFont().write()"。
  //   为什么换（清单 一-20 的排查结论）：1016（Word 正常）与交叉生成件（Word 里挤）除 glyf 编码外
  //   逐表相同 —— 差异来自 fonteditor 把连续 off-curve 点之间的**隐含中点**显式写成一个 on-curve 点
  //   （实测 285 → 306 点）。自研写盘按原始二次贝塞尔点序列编码（不插中点），
  //   其余各表的字段照抄 1016 的实测值，把变量收敛到"只有 glyf"。
  //   名称表（决策 四-1）：中英并列写在同一字段里（Windows 记录用 UTF-16，Mac 记录只写纯 ASCII 的字段）。
  const psName = toPostScriptName(familyName)
  const ttfBytes = buildTrueTypeFont({
    glyphs: fontGlyphs.map((g) => ({ code: g.code, advanceWidth: g.advanceWidth, d: g.d })),
    meta: {
      familyName,
      fontSubFamily: 'Regular',
      uniqueSubFamily: familyName + ' Regular ' + version,
      // 全名**跟着族名走**（2026-10-22 用户拍板）：Word / PS 的字体列表只看 Family（ID 1），
      //   全名（ID 4）被 Windows 用在安装注册与字体预览上。两者不一致时会出现"注册名是 A、Word 里找 B"，
      //   同族名的多份字体还会互相覆盖 —— 而且文件名只跟族名走，改全名根本区分不了版本。
      //   所以这里不再接受单独填写的全名：全名 = 族名（要区分版本请改族名）。
      fullName: familyName,
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
  })
  // **hmtx 全量**（每字 4 字节，`hhea.numberOfHMetrics = numGlyphs`）由 ttfWriter 直接写出 ——
  //   空格窄 + 全量 hmtx 是系统手写体（方正小楷 / 悠哉 / 飞波正点）共同的形态，本项目也按这个形态输出；
  //   **但它并不能修复 Word 里汉字挤的问题**（2026-10-22 用户实测，见清单 一-20），别再把它当"Word 修复"。
  //   ttf2woff / woff2.encode 要 ArrayBuffer（不是 Uint8Array 视图），下面统一切一次。
  const ttf = ttfBytes.buffer.slice(ttfBytes.byteOffset, ttfBytes.byteOffset + ttfBytes.byteLength)
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
    css: buildFontCss({ familyName, fileName, version, hasWoff2: !!woff2 }),
    fileName,
    familyName,
    mapping: built.map((g) => ({ char: g.char, code: g.code, advanceWidth: g.advanceWidth, clamped: g.clamped })),
    skipped,
    // 是否补了空格字形（2026-10-16）：字体里恒有（除非用户自己写了空格），但它**不在 mapping 里** ——
    // 上面那条"收录多少个字"的口径只算用户写的字（见 ① 的说明）。
    spaceGlyph: hasSpaceGlyph,
    stats: {
      total: glyphs.length,
      built: built.length,
      skipped: skipped.length,
      clamped: built.filter((g) => g.clamped).length,
      // 数字/字母按比例宽度构建（advance 在 300~800 之间），这里统计窄字形的数量
      halfwidth: built.filter((g) => g.advanceWidth < opt.glyphBox).length,
      // 程序补的空格字形（不进 built / mapping，见 ① 的说明）—— 界面统计与测试都靠它
      spaceGlyph: hasSpaceGlyph
    }
  }
}
