// 字形总览图（阶段三步骤 3.6，2026-10-07 用户拍板"要做"，清单 一-1）
// 职责：把这一套字体**收录的字**排成一张图（PNG），用作版权登记的材料；图上标注族名、版本、
//   收录字数与生成时间。
// 三个关键取舍：
//   ① **用生成的字体字节渲染**（`FontFace` 注册，与第 3 步的网页字体预览同一条路），而不是用系统里装的
//      那份 —— 图上的字形必须与产物一致（"装错版本"是这套流程里出现过的真实问题，决策 四-8 ②）。
//   ② **排版计算与画布绘制分开**：`planOverviewLayout()` 是纯函数（每行几字、几行、图多大、每个字的
//      格子坐标、标题与页脚的位置），可以在 Node 里直接断言；真正碰 canvas / FontFace 的只有
//      `renderOverviewPng()`。
//   ③ **图太宽就整体等比缩小**（`maxWidth`）：一行 25 字是给"全量 277 行"这种高图定的；一页写满
//      136 字时只有 6 行，按 25 字排出来是"又矮又宽"的一条（740 × 364）。**曾试过"字少就把格子放大"
//      来凑成 2:1，但那是错的**：放大格子只会让宽度按比例涨得更快（宽度 25 格、高度只有 6 行），
//      永远追不上，反而更宽 —— 所以不做这件事，短图就让它短，反正是给人看的清单。
//
// 版式：一行 25 字（用户 2026-10-07 拍板 A，与界面上的字网格、版权登记习惯一致，一眼能数出每行字数）。
export const OVERVIEW_DEFAULTS = {
  cols: 25, // 一行 25 字
  cellSize: 28, // **基准**格边长（像素）：留白、标题、字号都按它与实际格宽的比例换算
  rowGap: 4, // 行与行之间额外留白
  padding: 20, // 图四周留白
  headerHeight: 64, // 标题区高度（标题 + 收录统计一行）
  footerHeight: 32, // 页脚区（生成说明一行）
  maxWidth: 2000, // 图的最大宽度：超了就缩小（避免以后"一行几十字"时图宽到没法用）
  maxHeight: 16000, // 图的最大高度：**画布上限是 16384**，留一点余量
  maxCellSize: 64, // 格子最大边长（一页 136 字时按预算放大到这里，观感才够看）
  background: '#ffffff',
  inkColor: '#111111',
  gridColor: '#e8e8e8', // 极淡的格子参考线（便于数行列）
  titleColor: '#111111',
  noteColor: '#666666'
}

// 标题与说明的字号。
// **2026-10-15 用户口径**：灰色说明（收录统计、页脚）**固定 12 像素** —— 原来它按格宽的一半算，
//   放大版式之后一页 136 字时它有 32 像素，比格子里的字还抢眼；"改到 12px 试试"。
//   标题仍与格宽挂钩（它是这张图的主标题，随图的大小走）。
function fontSizes(cell) {
  return {
    title: Math.max(18, Math.round(cell * 1.0)),
    note: 12,
    glyph: Math.max(12, Math.round(cell * 0.857)) // 6/7 ≈ 0.857：字占格子的 86%，四周留白
  }
}
// 说明文字的行高（固定：字号固定 12px，行高跟着固定）
const NOTE_LINE = 18

/**
 * 排布计算（纯函数，可在 Node 里断言）。
 * @param {object} input
 * @param {number} input.count 收录字数
 * @param {object} [input.options] OVERVIEW_DEFAULTS 的子集
 * @returns {{width:number, height:number, cols:number, rows:number, cellSize:number, rowHeight:number,
 *   gridTop:number, gridLeft:number, scale:number, fontSizes:object,
 *   glyphs:Array<{index:number,x:number,y:number}>}}
 */
export function planOverviewLayout({ count, options = {} }) {
  const opt = { ...OVERVIEW_DEFAULTS, ...options }
  // 字数与行数分开算：**0 个字就画 0 个格**（但要留一行的高度，图不至于是一张纸片）
  const n = Math.max(0, Math.floor(Number(count) || 0))
  const cols = Math.max(1, Math.floor(opt.cols))
  const rows = Math.max(1, Math.ceil(n / cols))

  // 格宽：在"宽度 ≤ maxWidth、高度 ≤ maxHeight"的预算里**尽量放大**（上限 maxCellSize）。
  // 为什么要放大（2026-10-15 用户口径："字形总览预览图太小了"）：一页 136 字时旧口径只画到
  //   740 × 364（一格 28 像素），在 2K 屏上就是一张邮票；按预算放大之后同一个字有 55 像素。
  // 两个预算都是从 `measure()` 的等比关系里解出来的闭式解（版面比例不变）：
  //   宽 = 格 × (2×padding + 列数×基准) / 基准；高 = 格 × (2×padding + 页眉 + 页脚 + 行数×行距) / 基准 + 行数×格
  const base = opt.cellSize
  const widthPerCell = (2 * opt.padding + cols * base) / base
  const heightPerCell = (2 * opt.padding + opt.headerHeight + opt.footerHeight + rows * opt.rowGap) / base + rows
  const wanted = Math.min(
    opt.maxCellSize,
    opt.maxWidth / widthPerCell,
    (opt.maxHeight || Infinity) / heightPerCell
  )
  // 向下取整：宁可比预算小一点，也不因为取整顶破上限（画布有硬上限 16384）
  const cell = Math.max(1, Math.floor(wanted))
  const final = measure(opt, cols, rows, cell)

  const glyphs = []
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols)
    const c = i % cols
    glyphs.push({ index: i, x: final.gridLeft + c * final.cellSize, y: final.gridTop + r * final.rowHeight })
  }
  return {
    ...final,
    cols,
    rows,
    scale: cell / base,
    fontSizes: fontSizes(final.cellSize),
    glyphs
  }
}

// 给定格宽与行列数算一次整体尺寸（相对格宽等比换算留白与页眉页脚）
function measure(opt, cols, rows, cell) {
  const k = cell / opt.cellSize
  const rowHeight = Math.round(cell + opt.rowGap * k)
  const padding = Math.round(opt.padding * k)
  const header = Math.round(opt.headerHeight * k)
  const footer = Math.round(opt.footerHeight * k)
  return {
    width: Math.round(padding * 2 + cols * cell),
    height: Math.round(padding * 2 + header + rows * rowHeight + footer),
    cellSize: Math.round(cell),
    rowHeight,
    gridLeft: padding,
    gridTop: padding + header
  }
}

/**
 * 图上要写的几行文字（标题 / 收录统计 / 页脚）—— 抽出来是为了能在 Node 里断言内容与口径。
 * **2026-10-15 去掉了"收录范围"那一行**（用户口径：`收录范围：的 … 由（共 129 字，按生成顺序排列）`
 *   这种"首尾两个字 + 总数"的说法对人没有用 —— 图上一眼看得到的就是全部收录字，
 *   而"的 … 由"既说不清范围也不好核对）。
 */
export function buildOverviewTexts({ familyName, version, total, generatedAt, fromCorrection, excluded }) {
  const when = generatedAt instanceof Date ? generatedAt : new Date(generatedAt || Date.now())
  const p = (v) => String(v).padStart(2, '0')
  const stamp = when.getFullYear() + '-' + p(when.getMonth() + 1) + '-' + p(when.getDate()) +
    ' ' + p(when.getHours()) + ':' + p(when.getMinutes())
  const title = familyName + ' v' + (version || '1.0') + '　字形总览'
  const bits = ['收录 ' + total + ' 字']
  if (fromCorrection) bits.push('其中 ' + fromCorrection + ' 字来自更正册')
  if (excluded) bits.push('已剔除 ' + excluded + ' 字（不在本图内）')
  bits.push('生成时间 ' + stamp)
  const sub = bits.join('　·　')
  const footer = '本图由 SxFontCreator 生成，用于版权登记材料　·　字体文件中没有收录的字不在本图内'
  return { title, sub, footer, stamp }
}

/** 判断当前环境能不能画图（供界面给中文提示；Node 里没有 canvas） */
export function canRenderOverview() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function' &&
    typeof FontFace !== 'undefined'
}

/**
 * 画图并导出 PNG（浏览器内）。
 * @param {object} input
 * @param {Uint8Array|ArrayBuffer} input.fontBytes 生成的字体字节（TTF）
 * @param {string} input.familyName 族名（渲染时用带后缀的临时族名，避免与系统里装的同名版本混）
 * @param {string[]} input.chars 收录的字（按生成顺序）
 * @param {string} [input.version] / [input.fromCorrection] / [input.excluded] / [input.generatedAt]
 * @param {object} [input.options] OVERVIEW_DEFAULTS 的子集
 * @returns {Promise<{blob:Blob, width:number, height:number, rows:number, cols:number, scale:number, count:number, texts:object}>}
 */
export async function renderOverviewPng(input) {
  if (!canRenderOverview()) throw new Error('当前环境不支持画布（无法导出总览图）')
  if (!input || !input.fontBytes) throw new Error('没有字体字节：先生成一次字体')
  const opt = { ...OVERVIEW_DEFAULTS, ...(input.options || {}) }
  const chars = Array.isArray(input.chars) ? input.chars : []
  if (!chars.length) throw new Error('还没有收录任何字：先生成一次字体')

  // ① 注册字体：族名带唯一后缀（与决策 四-8 同一条理由 —— 系统里可能装过同名旧版本）
  const previewFamily = 'SxFontCreator Overview ' + Date.now().toString(36)
  const bytes = input.fontBytes instanceof Uint8Array ? input.fontBytes.slice() : new Uint8Array(input.fontBytes).slice()
  const face = new FontFace(previewFamily, bytes)
  await face.load()
  document.fonts.add(face)

  try {
    const layout = planOverviewLayout({ count: chars.length, options: opt })
    const canvas = document.createElement('canvas')
    canvas.width = layout.width
    canvas.height = layout.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('拿不到画布上下文（无法导出总览图）')
    ctx.fillStyle = opt.background
    ctx.fillRect(0, 0, layout.width, layout.height)

    const texts = buildOverviewTexts({
      familyName: input.familyName || 'SxFontCreator',
      version: input.version,
      total: chars.length,
      generatedAt: input.generatedAt,
      fromCorrection: input.fromCorrection,
      excluded: input.excluded
    })
    const fonts = layout.fontSizes

    // ② 标题区（两行：标题 / 收录统计）——
    // **2026-10-15 修**：原来"收录统计"与"收录范围"两行的 y 分别按 title / note 的倍数算，
    //   而 note = 0.5 × cell、title = 1.0 × cell 时 `title × 1.2` 与 `note × 2.4` 恰好相等（都是 33.6）——
    //   两行文字**永远重叠**（真机截图里标题下面那行小字糊成一团）。现在按"行高"从下往上排；
    //   同一轮里"收录范围"那一行按用户口径**整行去掉**（`的 … 由` 对人没有用）。
    const subY = layout.gridTop - NOTE_LINE
    const titleY = Math.max(layout.gridLeft, subY - Math.round(fonts.title * 1.35))
    ctx.fillStyle = opt.titleColor
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    ctx.font = '600 ' + fonts.title + 'px "Microsoft YaHei", sans-serif'
    ctx.fillText(texts.title, layout.gridLeft, titleY)
    ctx.font = fonts.note + 'px "Microsoft YaHei", sans-serif'
    ctx.fillStyle = opt.noteColor
    ctx.fillText(texts.sub, layout.gridLeft, subY)

    // ③ 字形网格：极淡的格子参考线 + 每格一个字（按码点逐字画，代理对不会被拆坏）
    ctx.strokeStyle = opt.gridColor
    ctx.lineWidth = 1
    ctx.font = fonts.glyph + 'px "' + previewFamily + '"'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.fillStyle = opt.inkColor
    const list = Array.from(chars)
    for (let i = 0; i < layout.glyphs.length; i++) {
      const g = layout.glyphs[i]
      ctx.strokeRect(g.x + 0.5, g.y + 0.5, layout.cellSize - 1, layout.cellSize - 1)
      ctx.fillText(list[i] || '', g.x + layout.cellSize / 2, g.y + layout.cellSize / 2)
    }

    // ④ 页脚
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = opt.noteColor
    ctx.font = fonts.note + 'px "Microsoft YaHei", sans-serif'
    ctx.fillText(texts.footer, layout.gridLeft, layout.height - Math.round(layout.gridLeft))

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画布导出 PNG 失败'))), 'image/png')
    })
    return {
      blob,
      width: layout.width,
      height: layout.height,
      rows: layout.rows,
      cols: layout.cols,
      scale: layout.scale,
      count: chars.length,
      texts
    }
  } finally {
    // 用完就把这份预览字体摘掉：它会一直持有字节（与第 3 步的预览同一处理）
    if (document.fonts && typeof document.fonts.delete === 'function') {
      try { document.fonts.delete(face) } catch (e) { /* 摘不掉也不影响：页面关掉就没了 */ }
    }
  }
}

/** 总览图的文件名：族名 + 版本 + 日期（便于归档与登记时对号） */
export function overviewFileName({ familyName, version, generatedAt }) {
  const when = generatedAt instanceof Date ? generatedAt : new Date(generatedAt || Date.now())
  const p = (v) => String(v).padStart(2, '0')
  const safe = String(familyName || 'SxFontCreator').replace(/[\\/:*?"<>|]/g, '')
  return safe + '-字形总览-v' + (version || '1.0') + '-' +
    when.getFullYear() + p(when.getMonth() + 1) + p(when.getDate()) + '.png'
}
