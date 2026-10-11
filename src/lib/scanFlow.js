// 上传识别流程编排（阶段一「界面串联」B2）
// 职责：一串扫描件 → 逐页「预处理 → 切格（含整页方向自动纠正）→ 红圈识别 → 字形提取（顺带剔除红圈像素）」
//   → 页级 + 格级结果；再按《决策记录》八-9 / 八-10 / 二-7 给出"这一批能不能继续"的判定与中文说明。
// 为什么单独成模块：这是界面与四个识别模块（1.4~1.7）之间**唯一的接缝** —— 界面只管渲染结果，
//   流程顺序、参数、失败处置、页序与批次的判定都在这里，因此可以用真件夹具整条跑通（test/scan-flow.mjs）。
// 内存（决策 二-1、清单 三-5）：**必须串行、逐页释放** —— 单页彩色 8MB、全量 51 页约 400MB，
//   所以每处理完一页就把灰度图 / 彩色像素 / 掩膜丢掉，只留下"能显示、能继续算"的压缩产物：
//   · 页记录（计数、每格判定、被圈格、页号与批次）—— 进 store，落盘
//   · 每页一张**格子缩略图**（136 格拼成一张 PNG）+ 一张**整页缩略图** + 每格的笔迹掩膜 —— 只放内存缓存
//     （掩膜是后续字体合成（B3）的原料；两张图是"识别结果可视化"的原料。都不落盘：
//      落盘会把整份项目对象撑到几 MB，每次改族名都要重写一遍，得不偿失 —— 见清单 四-27）
import { preprocessFile } from './scanPreprocessor.js'
import { analyzePage, summarizeBatch, DESIGN } from './gridDetector.js'
import { attachRedMarks, defaultCellRects } from './markRecognizer.js'
import { extractPage } from './handwritingExtractor.js'
import { LAYOUT } from './layout.js'
import { getAllChars } from './charset.js'
import { charAtCell, reorderPages, resolveBatchChars } from './scanMeta.js'
import { readPage as readReferenceChars } from './referenceCharReader.js'

// 纯逻辑（页内格号 → 字、页序重排、字形统计）在 scanMeta.js 里，这里再导出一次，
// 让调用方只记一个入口（组件里 `import { … } from '../lib/scanFlow.js'` 就够）
export {
  applyCorrectionOverrides,
  buildCorrectionInputs,
  buildFinalGlyphPlan,
  charAtCell,
  collectGlyphStats,
  evaluateRescanAccept,
  evaluateScanGate,
  pairCorrections,
  reorderPages,
  resolveBatchChars,
  usableForGlyphs
} from './scanMeta.js'

// 整批汇总判定（页号重复 / 批次码不符 / 缺页 / 闸门）在 gridDetector.js 里，这里再导出一次：
// 单页重传（清单 一-8）替换完一页后要重算整批，界面不该为此再记一个模块入口
export { summarizeBatch }

export const SCAN_DEFAULTS = {
  autoOrient: true, // 整页方向不对时自动纠正（决策 二-11）
  detectRedMarks: true, // 红圈识别 + 从笔迹里剔除（决策 二-12）
  expectedBatchCode: null, // 所选批次的 12 位校验码（八-10；为 null 时不做批次比对）
  // 参考字候选库（lib/referenceCharReader.js 的 buildLibrary 产物）：**传了它才做"认参考字 + 定字序"**；
  // 不传就退回旧口径（按批次的全局字序取字），供纯逻辑测试与没有字体可用的环境使用。
  library: null,
  // 这一页上"有参考字的格"占比低于它 → 判定**不是本程序生成的模板**，整页失败
  // （用户 2026-10-11 拍板：只认自家模板产出的纸，外来图片一个字形也不产生）。
  // 实测自家模板在这条上是 0.99~1.00（参考字是印上去的，即使模糊也能取到）。
  minInkRatio: 0.6,
  // 格子缩略图里每格的像素边长：96 够看清"这一格写了没、写得正不正"，又让整页拼图只有 1632×768
  cellThumbSize: 96,
  // 整页缩略图的宽度（高度按比例）：页级行里看一眼"这页长什么样"，300 够用
  pageThumbWidth: 300
}

// ── 缩略图（浏览器端画布；只在这些函数里碰画布，别的都是纯计算）──────────────
// 把设计坐标灰度图降采样成一张小图（页级缩略图）
function grayThumb(gray, targetWidth) {
  const factor = Math.max(1, Math.round(gray.width / targetWidth))
  const w = Math.max(1, Math.floor(gray.width / factor))
  const h = Math.max(1, Math.floor(gray.height / factor))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(w, h)
  const src = gray.data
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = src[(y * factor) * gray.width + x * factor]
      const o = (y * w + x) * 4
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v
      img.data[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}

// 把一页 136 格的笔迹掩膜拼成一张图（格级视图的背景图）：
// 一页只做一次 toDataURL，比"每格一个 dataURL"快两个数量级（136 次编码 vs 1 次），体积也小得多
function cellSheet(cells, size) {
  const cols = LAYOUT.cols
  const rows = LAYOUT.rows
  const gap = 2
  const canvas = new OffscreenCanvas(cols * size, rows * size)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#f4f5f8'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const cellCanvas = new OffscreenCanvas(size, size)
  const cellCtx = cellCanvas.getContext('2d')
  for (const cell of cells) {
    const col = cell.index % cols
    const row = Math.floor(cell.index / cols)
    const ox = col * size
    const oy = row * size
    cellCtx.fillStyle = cell.marked ? '#fff5f5' : '#ffffff'
    cellCtx.fillRect(0, 0, size, size)
    const mask = cell.mask
    if (mask) {
      // 掩膜按最近邻放大（保持笔画形状，不糊）
      const mw = cell.width
      const mh = cell.height
      const box = cell.boxInSlice
      const img = cellCtx.createImageData(size, size)
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          // 只画书写格那一块（切片含 14 像素外扩，缩略图里不需要）
          const sx = box.x + Math.floor(((x / size) * box.width))
          const sy = box.y + Math.floor(((y / size) * box.height))
          const inside = sx >= 0 && sy >= 0 && sx < mw && sy < mh
          const v = inside && mask[sy * mw + sx] ? 0 : 255
          const o = (y * size + x) * 4
          img.data[o] = img.data[o + 1] = img.data[o + 2] = v
          img.data[o + 3] = 255
        }
      }
      cellCtx.putImageData(img, 0, 0)
    }
    ctx.drawImage(cellCanvas, ox + gap / 2, oy + gap / 2, size - gap, size - gap)
    // 格号：小字标在左上角（缩略图大小有限，只标每页第 1、17、… 这类不进；这里标格号便于核对）
    if (cell.marked) {
      ctx.strokeStyle = '#e0483c'
      ctx.lineWidth = 2
      ctx.strokeRect(ox + 1, oy + 1, size - 2, size - 2)
    }
  }
  return canvas.convertToBlob({ type: 'image/png' })
}

// Blob → dataURL（界面 <img> 直接用；ObjectURL 需要生命周期管理，dataURL 更省心）
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('缩略图编码失败'))
    reader.readAsDataURL(blob)
  })
}

/**
 * 识别一页扫描件。
 * @param {File} file 图片文件
 * @param {object} options
 * @param {string} options.chars 这一批要写的字（按字序；见 resolveBatchChars）
 * @param {number} [options.expectedBatchCode] 所选批次的校验码（用于页面级比对提示）
 * @param {number} [options.fileIndex] 第几个文件（0 起，仅用于展示与缓存键）
 * @param {number} [options.pageNumberOverride] 页脚读不出时由用户指定的页号（决策 二-7）
 * @returns {Promise<{record:object, cache:object}>} record 是可落盘的轻量记录，cache 是只放内存的图与掩膜
 */
export async function recognizePage(file, options = {}) {
  const opt = { ...SCAN_DEFAULTS, ...options }
  const chars = opt.chars || getAllChars().join('')
  const fileIndex = opt.fileIndex || 0
  const messages = []

  // ① 预处理（1.4）：灰度（去噪）+ 二值图 + 彩色原图；彩色最大，用完立刻释放引用
  const prepared = await preprocessFile(file)
  const gray = prepared.gray
  let rgba = prepared.rgba

  // ② 切格（1.5）：方向纠正 → 找四角 → 透视校正 → 页脚解码 → 按已知网格切 136 格
  const page = analyzePage(gray, {
    autoOrient: opt.autoOrient,
    keepDesignGray: true,
    expectedBatchCode: typeof opt.expectedBatchCode === 'number' ? opt.expectedBatchCode : null
  })
  const record = {
    fileIndex,
    fileName: file.name,
    ok: false,
    reason: '',
    pageNumber: null,
    footerOk: false,
    batchCode: null,
    batchMatch: null,
    isSheetPage: null,
    // **页脚的原始结果要一起带上**：summarizeBatch（整批判定）读的是 `p.footer.ok / pageNumber / batchCode`，
    // 只给 footerOk 这些扁平字段的话，每页都会被当成"页脚读不出"（踩过：汇总里全是"页脚没读出"的警告，
    // 而页面记录明明读出了第 1 页与校验码 3362 —— 因为那种情形只产生 warn、ok 仍为 true，测试也没抓住）
    footer: null,
    orientation: page.orientation ? { corrected: !!page.orientation.corrected, turns: page.orientation.turns, tried: page.orientation.tried } : null,
    cornerMaxError: page.cornerErrors ? Math.round(page.cornerErrors.max * 10) / 10 : null,
    counts: { written: 0, empty: 0, suspect: 0, marked: 0, uncertain: 0, inkPixels: 0 },
    // 参考字识别与定字序（2026-10-11 新模型）：
    //   pageChars 是**这一页 136 格各自的字**（认不出为 null）—— 定位成功时由序列给出（整页确定），
    //   定位不上时是逐格识别结果（认不准的格记进 unsureCells，交界面复核）
    read: null,
    located: null,
    // 页脚自校验（决策 五-9 ⑥：页脚码降为自校验）：{ footerCode, readCode, agree } —— 对不上只提示复核，不拦
    footerSelfCheck: null,
    pageChars: null,
    pageNumberSource: null, // sequence（序列定位反推）| footer（页脚读出）| user（手选）| unknown
    unsureCells: [],
    // 复核用的候选（每格最多 5 个）：认不准的格在界面上让用户从候选里挑，或直接手输
    charCandidates: null,
    needReview: false,
    cells: [],
    messages: [],
    timings: page.timings ? { ...page.timings } : null
  }
  // 页脚摘要（喂给 summarizeBatch 的最小形状）：读不出时给 ok:false 与原因，好让整批判定说得清是哪一页的问题
  const footerShape = (footer) => (footer
    ? { ok: !!footer.ok, pageNumber: footer.ok ? footer.pageNumber : null, batchCode: footer.ok ? footer.batchCode : null, message: footer.message || '' }
    : { ok: false, pageNumber: null, batchCode: null, message: '这一页没有页脚结果（切格没走到页脚解码）' })
  record.footer = footerShape(page.footer)

  if (!page.ok || !page.boxes || !page.boxes.length) {
    // 整页失败：按决策 二-6 明确失败 + 中文提示（不静默拿错坐标切格）
    record.reason = page.reason || (page.messages && page.messages.find((m) => m.level === 'error') || {}).text || '这一页没能定位到四角定位块'
    record.messages = (page.messages || []).map((m) => ({ level: m.level, text: m.text }))
    if (record.messages.length === 0) record.messages = [{ level: 'error', text: record.reason }]
    return { record, cache: { thumb: null, sheet: null, masks: null } }
  }

  record.footerOk = !!(page.footer && page.footer.ok)
  record.pageNumber = page.footer && page.footer.ok ? page.footer.pageNumber : null
  record.batchCode = page.footer && page.footer.ok ? page.footer.batchCode : null
  // 件类型（决策 一-9、二-13）：更正册的页脚校验码为 0、主区是批次校验码、读不出时未知 ——
  // 与 summarizeBatch 同一口径（那边按 row.kind 分拣重复页与批次比对）。
  // **必须排在 batchMatch 之前**：下面要用它决定"这一页参不参与批次比对"。顺序写反过一次 ——
  //   kind 此刻还是 undefined，于是更正册页的 batchMatch 被算成"码 0 vs 所选批次"的 false；
  //   界面与收批闸门都按 kind 先分拣，用户看不到，所以这条只影响页记录本身（测试已钉住）。
  record.kind = record.footerOk ? (record.batchCode === 0 ? 'correction' : 'main') : 'unknown'
  record.batchMatch = record.kind === 'correction' ? null : (page.batch ? page.batch.match : null)
  record.footer = footerShape(page.footer)
  if (record.pageNumber === null && typeof opt.pageNumberOverride === 'number') {
    record.pageNumber = opt.pageNumberOverride
    record.orderFromUser = true // 页序是用户手选的（决策 二-7），界面要显式标出来
  }

  // ③ 红圈（1.7）：颜色分离 + 形态过滤 → 被圈格清单 + 红掩膜；再把红掩膜作为附加图层切到每格
  let extractionBoxes = page.boxes
  let designRedMask = null
  if (opt.detectRedMarks && rgba) {
    // attachRedMarks 在这些前提不满足时返回 null（页面不可用 / 没有矩阵 / 没开 keepDesignGray / 没彩色像素）：
    // 那就退回"不剔红圈"的切格结果，绝不因为拿不到红掩膜就整页失败
    const attached = attachRedMarks(page, rgba, {
      cellRects: defaultCellRects(),
      turns: page.orientation ? page.orientation.turns : 0
    })
    if (attached) {
      extractionBoxes = attached.boxes
      // 红掩膜留着给"认参考字"用：红圈在灰度图上是深色，不抹掉会把参考字的阈值带偏
      designRedMask = attached.marks && attached.marks.designRed ? attached.marks.designRed.data : null
      record.redStats = attached.marks ? { ...attached.marks.stats } : null
      record.markedCells = (attached.marks && attached.marks.markedCells) || []
      record.uncertainCells = (attached.marks && attached.marks.uncertainCells) || []
      for (const m of (attached.marks && attached.marks.messages) || []) messages.push({ level: m.level, text: m.text })
    } else {
      messages.push({ level: 'info', text: '这一页没有做红圈识别（缺少切格矩阵或彩色像素），被圈的字请在核对界面手工标记' })
    }
  }
  rgba = null // 彩色像素到此用完（红掩膜已经切成分片），显式释放

  // ③.5 认参考字 + 定字序（2026-10-11 新模型：生成范围由扫描件决定 —— 决策 五-9）
  // 为什么排在这里：① 认字只要设计灰度图 + 红掩膜，两者此刻都在手上；② 下面的字形提取要按
  //   "格号 → 字"给每格标字，字序必须先定下来。
  // 处置口径（用户 2026-10-11 拍板）：
  //   · 纸上没有本程序的参考字版式 → **整页失败**（只认自家模板，外来图片一个字形也不产生）
  //   · 有参考字：优先**序列定位** —— 预置档位的纸连页脚都不用读，页号与整页 136 字一起确定；
  //     定位不上（自定义选字的纸不是任何全序的连续段）→ 退到"逐格识别的字 + 页脚页号"，
  //     认不准的格记进 unsureCells 交界面复核
  if (opt.library && record.kind !== 'correction' && page.designGray) {
    const read = readReferenceChars(page.designGray, opt.library, { redMask: designRedMask })
    record.read = {
      emptyCount: read.emptyCount,
      sureCount: read.sureCount,
      unsureCount: read.unsureCount,
      inkRatio: Math.round(read.inkRatio * 1000) / 1000,
      located: read.located ? { seqKey: read.located.seqKey, start: read.located.start, agree: read.located.agree } : null
    }
    if (read.inkRatio < opt.minInkRatio) {
      record.reason = '这不是本程序生成的模板：这一页 ' + LAYOUT.perPage + ' 格里有 ' + read.emptyCount +
        ' 格取不到模板的参考字。请确认用的是第 1 步「生成模板 PDF」下载的那份文件、按实际大小（100%）打印的纸。'
      record.messages = [{ level: 'error', text: record.reason }]
      return { record, cache: { thumb: null, sheet: null, masks: null } }
    }
    record.unsureCells = read.unsureCells
    record.charCandidates = read.cells.map((c) => (c.candidates || []).map((x) => x.char))
    if (read.located) {
      // 序列定位命中：整页 136 个字全部确定（含那几个认不出的格），页号由起点反推
      record.located = record.read.located
      record.pageNumber = Math.floor(read.located.start / LAYOUT.perPage) + 1
      record.pageNumberSource = 'sequence'
      record.pageChars = read.located.chars.slice()
      record.batchCode = read.batchCode
      // 整页已由序列确定 → **没有"需要人工确认"的格**（认不出的那几格的字同样已确定）
      record.unsureCells = []
      // 自校验（用户拍板：页脚码留作自校验 / 可信度提示，不当闸门）：识别出的字序算出的码 vs 纸面码。
      // 实测两者一致（206 = 206）；对不上说明这一页多半不是按本程序模板写的，提示复核。
      if (page.footer && page.footer.ok && typeof page.footer.batchCode === 'number') {
        record.footerSelfCheck = {
          footerCode: page.footer.batchCode,
          readCode: read.batchCode,
          agree: page.footer.batchCode === read.batchCode
        }
        if (!record.footerSelfCheck.agree) {
          messages.push({
            level: 'warn',
            text: '这一页识别出的字序与纸面页脚对不上（纸面校验码 ' + page.footer.batchCode + '、识别出 ' +
              read.batchCode + '）：请核对这一页是不是本程序模板印的纸，或在界面上逐格确认后再用'
          })
        }
      }
    } else {
      record.pageChars = read.cells.map((c) => (c.empty ? null : c.char))
      record.pageNumberSource = record.pageNumber !== null ? 'footer' : (record.orderFromUser ? 'user' : 'unknown')
      record.needReview = read.unsureCount > 0 || read.emptyCount > 0
      messages.push({
        level: record.needReview ? 'warn' : 'info',
        text: '这一页认不出是哪一段字序（多半是自定义选字的模板）：已按逐格识别取字' +
          (record.needReview ? '，其中 ' + (read.unsureCount + read.emptyCount) + ' 格需要你在界面上确认' : '，且全部格都认准了')
      })
    }
  }

  // ④ 字形提取（1.6）：灰度分层 + 面积过滤，红圈像素按附加图层跳过
  const extracted = extractPage(extractionBoxes)
  const markedSet = new Set(record.markedCells || [])
  const uncertainSet = new Set(record.uncertainCells || [])
  const items = []
  for (const cell of extracted.cells) {
    // 更正册的格不按批次的字序映射：它是"第 k 个更正格"，字由更正核对（1.8）配对时决定（决策 二-13）
    // 字序来源：**优先用这一页自己认出来的字**（新模型：范围由扫描件决定）；没有认字结果时才退回
    // 批次的全局字序（旧口径，供没有候选库的环境使用）
    const char = record.kind === 'correction'
      ? null
      : ((record.pageChars && record.pageChars[cell.index]) || charAtCell(chars, record.pageNumber, cell.index))
    const item = {
      index: cell.index,
      char,
      verdict: cell.verdict,
      inkPixels: cell.inkPixels,
      inkPixelsOutside: cell.inkPixelsOutside,
      overflow: cell.overflow,
      marked: markedSet.has(cell.index),
      uncertain: uncertainSet.has(cell.index),
      // 被红圈掩膜挡掉的深色像素数：界面用它证明"红圈确实被剔除了"（诊断口径，见 四-18）
      redPixelsRemoved: cell.redPixelsRemoved || 0,
      // 掩膜与尺寸留在 cache 里（内存），record 只带统计
      mask: cell.mask,
      width: cell.width,
      height: cell.height,
      boxInSlice: cell.boxInSlice
    }
    items.push(item)
    record.counts.written += cell.verdict === 'empty' ? 0 : 1
    record.counts.empty += cell.verdict === 'empty' ? 1 : 0
    record.counts.suspect += cell.verdict === 'suspect' ? 1 : 0
    record.counts.inkPixels += cell.inkPixels || 0
  }
  record.counts.marked = (record.markedCells || []).length
  record.counts.uncertain = (record.uncertainCells || []).length

  // ⑤ 结果可视化：格子拼图 + 整页缩略图（各一次 PNG 编码）
  let thumb = null
  let sheet = null
  try {
    const [thumbBlob, sheetBlob] = await Promise.all([
      page.designGray ? grayThumb(page.designGray, opt.pageThumbWidth) : Promise.resolve(null),
      cellSheet(items, opt.cellThumbSize)
    ])
    thumb = thumbBlob ? await blobToDataUrl(thumbBlob) : null
    sheet = sheetBlob ? await blobToDataUrl(sheetBlob) : null
  } catch (e) {
    messages.push({ level: 'warn', text: '识别结果缩略图生成失败（不影响字形数据）：' + (e && e.message ? e.message : e) })
  }

  // ⑥ 组装轻量记录：cells 去掉掩膜（掩膜进 cache）
  record.cells = items.map((it) => ({
    index: it.index,
    char: it.char,
    verdict: it.verdict,
    inkPixels: it.inkPixels,
    inkPixelsOutside: it.inkPixelsOutside,
    overflow: it.overflow,
    marked: it.marked,
    uncertain: it.uncertain,
    redPixelsRemoved: it.redPixelsRemoved
  }))
  record.messages = [...(page.messages || []).map((m) => ({ level: m.level, text: m.text })), ...messages]
  record.ok = true
  record.reason = ''
  return {
    record,
    cache: {
      thumb,
      sheet,
      // 只留"有笔迹"的掩膜（空白格不需要参与字体合成），并把 boxInSlice 一起带上（B3 映射要用）；
      // redPixelsRemoved 一并留着，供界面/测试核对"红圈确实被剔除了"
      masks: items
        .filter((it) => it.verdict !== 'empty')
        .map((it) => ({
          index: it.index,
          char: it.char,
          mask: it.mask,
          width: it.width,
          height: it.height,
          boxInSlice: it.boxInSlice,
          redPixelsRemoved: it.redPixelsRemoved
        })),
      designSize: page.designGray ? { width: page.designGray.width, height: page.designGray.height } : DESIGN
    }
  }
}

/**
 * 批量识别：串行逐页处理（决策 二-1），每页处理完立刻回调（界面可以边跑边显示），
 * 全部结束后按 summarizeBatch 给出"这一批能不能继续"的判定。
 * @param {File[]} files
 * @param {object} options 见 recognizePage，另加：
 * @param {Function} [options.onPage] (record, index, total) => void —— 每页处理完回调
 * @param {Function} [options.onStage] (text) => void —— 阶段文案（预处理 / 切格 / 提取）
 * @param {object} [options.batch] 所选批次（用于字序与校验码）
 */
export async function recognizeBatch(files, options = {}) {
  const opt = { ...SCAN_DEFAULTS, ...options }
  const batch = opt.batch || null
  const chars = resolveBatchChars(batch)
  // 新模型（决策 五-9）：**批次校验码不再当闸门** —— 字序由纸面参考字定位决定，而批次是自动建的容器
  // （`store.ensureScanBatch()`），两者的码本来就可能不同，拿它拦批会误伤。页脚码改用**自校验**：
  // recognizePage 把"识别出的字序算出的码"与"纸面读出的码"对一下（footerSelfCheck），对不上只提示复核。
  // 要旧口径（校验码不符即整批拦下）可显式传 expectedBatchCode。
  const expectedBatchCode = typeof opt.expectedBatchCode === 'number' ? opt.expectedBatchCode : null
  const pages = []
  const caches = new Map()
  for (let i = 0; i < files.length; i++) {
    // 可中止：长任务（51 页约 85 秒）要能让用户停下来；中止后已处理完的页仍然保留（界面照常显示）
    if (opt.shouldStop && opt.shouldStop()) {
      opt.stopped = true
      break
    }
    if (opt.onStage) opt.onStage('正在预处理第 ' + (i + 1) + ' / ' + files.length + ' 页…')
    const { record, cache } = await recognizePage(files[i], {
      ...opt,
      chars,
      expectedBatchCode,
      fileIndex: i
    })
    pages.push(record)
    caches.set(i, cache)
    // onPage 带上该页的内存缓存（缩略图 / 格子拼图 / 掩膜）：界面要**边跑边显示**，
    // 不能等整批结束才拿到（51 页要等 85 秒，期间什么都看不到）。
    // **要 await**：回调里要落盘字形（一页一次写），不等它就没有确定的完成顺序
    if (opt.onPage) await opt.onPage(record, i, files.length, cache)
  }
  const summary = summarizeBatch(pages, {
    expectedBatchCode,
    sheetPages: batch ? batch.pageCount : undefined
  })
  return { pages, caches, summary, chars, stopped: !!opt.stopped }
}

/**
 * 用户手选页序后重新算"每格是哪个字"，并按新页序重新做批次汇总（决策 二-7）。
 * 只重算字与页号，**不重新识别** —— 掩膜与页序无关（scanMeta.reorderPages 是纯的那一半）。
 * @param {Array} pages record 数组
 * @param {object} overrides `{ [fileIndex]: pageNumber }`
 * @param {string} chars 这一批的字序
 * @returns {{pages:Array, summary:object}}
 */
export function applyPageOrder(pages, overrides, chars, options = {}) {
  const next = reorderPages(pages, overrides, chars).map((p) => ({
    ...p,
    isSheetPage: typeof options.sheetPages === 'number' && p.pageNumber
      ? p.pageNumber <= options.sheetPages
      : p.isSheetPage
  }))
  const summary = summarizeBatch(next, {
    expectedBatchCode: typeof options.expectedBatchCode === 'number' ? options.expectedBatchCode : null,
    sheetPages: options.sheetPages
  })
  return { pages: next, summary }
}
