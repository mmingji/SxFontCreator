// "纸还在、库没了"的批次恢复（决策 五-9；入口在顶栏「项目备份」弹窗里）
//
// 场景：项目被清空、换了电脑或换了浏览器 —— 手头那张**已经写好、甚至已经写完一半**的模板纸还在，
//   但库里的批次记录没了。没有批次就没法上传识别：`resolveBatchChars()` 在没有批次信息时
//   会退回**全量字表**，字序整体错位（那比拦住用户糟得多，沿用 二-6 的"静默拿错数据不如拒绝"口径）。
//
// 两条恢复路径（都由"这一批要写哪些字"反推，纸面本身只印了 12 位校验码，是哈希、不可反推）：
//   ① 按档位回推：把三个预置档位 × 两种排列方式的候选字序都算出来（lib/templateScope.js），
//      拿**纸面读到的校验码**去比对 —— 命中即"这一批是什么"确定无疑，用户不需要记得当初选了什么；
//   ② 从模板 PDF 恢复：模板 PDF 有文字层，逐页把每格的参考字读回来 —— 连"自定义选字"的纸也能救。
//      "取文字项"那一步依赖 pdf.js（放在组件里做），"还原字序"是本文件的纯逻辑，可在 Node 侧断言。
import { LAYOUT, cellRect } from './layout.js'
import { getAllChars } from './charset.js'
import { computeBatchCode } from './batchCode.js'
import { findPresetByBatchCode, presetPlan } from './templateScope.js'

// 批次来源标记：界面上要能看出"这一批是从纸 / 模板 PDF 恢复出来的"（与正常出模板记的批次区分）
export const RESTORE_SOURCE = {
  scope: 'restore-scope',
  pdf: 'restore-pdf'
}

export const RESTORE_SOURCE_LABEL = {
  [RESTORE_SOURCE.scope]: '由纸恢复（按档位）',
  [RESTORE_SOURCE.pdf]: '由模板 PDF 恢复'
}

/**
 * 拿纸面读到的校验码认档位。
 * @param {number} batchCode 页脚高 12 位（gridDetector.decodeFooterCode 解出的 batchCode）
 * @returns {object|null} 命中时返回带 source / message 的候选计划
 */
export function matchPresetByBatchCode(batchCode) {
  const plan = findPresetByBatchCode(batchCode)
  if (!plan) return null
  return {
    ...plan,
    source: RESTORE_SOURCE.scope,
    message: '识别为：' + plan.label + '（共 ' + plan.pageCount + ' 页，校验码 ' + plan.batchCode + '）'
  }
}

/** 手动指定档位时的候选计划（没带纸、但知道当初选的是哪一档） */
export function planFromPreset(scopeKey, orderMode) {
  const plan = presetPlan(scopeKey, orderMode)
  return { ...plan, source: RESTORE_SOURCE.scope }
}

// ── 从模板 PDF 还原字序 ─────────────────────────────────────────────────────

export const PDF_RESTORE_DEFAULTS = {
  // 一页至少要有这么多格读到参考字，才认为它是**字表页**：
  // 模板页是 136/136；打印自检页是 0；更正册只有被圈的那几格（实测 9）—— 后两者都会被挡在外面。
  minFilledPerPage: Math.ceil(LAYOUT.perPage / 2),
  // 文字项归属到字位框时的容差（pt）：参考字是按各自墨迹外框在区域内居中的，基线会逐字浮动，
  // 但不越出字位框；留 1pt 只是免得浮点尾差把边缘的字判丢。
  tolerance: 1
}

function fail(reason, message) {
  return { ok: false, reason, message }
}

/**
 * 把"每页的文字项"还原成字序（纯逻辑，pdf.js 只负责提供 items）。
 * @param {Array<{pageNumber:number, items:Array<{str:string,x:number,y:number}>}>} pages
 *   items 的 x / y 用 **PDF 用户空间坐标**（pt，原点在左下）—— 与 layout.cellRect 同一坐标系，
 *   pdf.js 的 textItem.transform[4] / [5] 就是这个值，不需要任何换算。
 * @param {object} [options] PDF_RESTORE_DEFAULTS
 * @returns {{ok:boolean, reason?:string, message?:string, chars?:string, charCount?:number,
 *            sheetPages?:number, pages?:number, batchCode?:number, filledPerPage?:number[], warnings?:string[]}}
 *   失败一律**明确失败 + 中文原因**，绝不猜（沿用 二-6："静默拿错数据比拒绝处理糟得多"）。
 */
export function charsFromPages(pages, options = {}) {
  const opt = { ...PDF_RESTORE_DEFAULTS, ...options }
  const rects = []
  for (let i = 0; i < LAYOUT.perPage; i++) rects.push(cellRect(i))

  const sheetPages = []
  const filledPerPage = []
  const warnings = []
  const list = Array.isArray(pages) ? pages : []

  for (const page of list) {
    const cells = new Array(LAYOUT.perPage).fill(null)
    let filled = 0
    for (const item of page.items || []) {
      const text = String(item.str == null ? '' : item.str).trim()
      if (!text) continue
      const idx = rects.findIndex((r) => item.x >= r.x - opt.tolerance && item.x <= r.x + r.width + opt.tolerance &&
        item.y >= r.y - opt.tolerance && item.y <= r.y + r.height + opt.tolerance)
      // 不在任何字位框里：表格上方那行打印要点、自检页的说明文字 —— 直接忽略
      if (idx < 0) continue
      if (cells[idx] !== null) {
        warnings.push('第 ' + page.pageNumber + ' 页第 ' + (idx + 1) + ' 格读到多个文字项，只取第一个')
        continue
      }
      // 一个格里读到多字 = 这不是本程序的模板排版（参考字是逐格单独绘制的），宁可拒绝
      if (Array.from(text).length > 1) {
        return fail('multi-char-cell',
          '第 ' + page.pageNumber + ' 页第 ' + (idx + 1) + ' 格里读到 ' + Array.from(text).length +
          ' 个字（' + text + '）—— 本程序生成的模板每格只印一个参考字，这个 PDF 不是模板，或已被改过。')
      }
      cells[idx] = text
      filled++
    }
    filledPerPage.push(filled)
    if (filled >= opt.minFilledPerPage) {
      sheetPages.push({ pageNumber: page.pageNumber, cells, filled })
    } else if (filled > 0) {
      warnings.push('第 ' + page.pageNumber + ' 页只读到 ' + filled + ' 格参考字，按非字表页跳过（打印自检页或更正册）')
    }
  }

  if (!sheetPages.length) {
    return fail('no-reference-chars',
      '这个 PDF 里没读到参考字 —— 可能不是本程序生成的模板（比如是自检页、更正册，或别的 PDF）。' +
      '请选第 1 步「生成模板 PDF」下载的那份文件。')
  }

  // 字表页必须格格齐全：缺一格就会让后面所有格的字整体串位
  for (const p of sheetPages) {
    if (p.filled !== LAYOUT.perPage) {
      return fail('incomplete-page',
        '第 ' + p.pageNumber + ' 页只读到 ' + p.filled + ' / ' + LAYOUT.perPage +
        ' 个参考字，这一页不完整 —— 字序会整体串位，所以拒绝恢复。请换一份完整的模板 PDF。')
    }
  }

  const known = new Set(getAllChars())
  const chars = []
  for (const p of sheetPages) {
    for (const ch of p.cells) {
      if (!known.has(ch)) {
        return fail('char-outside-charset',
          '第 ' + p.pageNumber + ' 页出现了字表之外的字符「' + ch + '」—— 这不是本程序按当前字表生成的模板。')
      }
      chars.push(ch)
    }
  }

  return {
    ok: true,
    chars: chars.join(''),
    charCount: chars.length,
    sheetPages: sheetPages.length,
    pages: list.length,
    batchCode: computeBatchCode(chars),
    filledPerPage,
    warnings
  }
}

/**
 * 把恢复结果落成一个与正常批次同构的对象（store.addBatch 的形状）。
 * @param {{chars:string, sheetPages:number, batchCode:number}} restored charsFromPages 的结果
 * @param {object} [options] { order } 排列方式（从 PDF 恢复时无法判定，按笔画序记 —— 它只影响展示用的名字）
 */
export function planRestoredFromPdf(restored, options = {}) {
  const chars = String(restored.chars || '')
  return {
    source: RESTORE_SOURCE.pdf,
    order: options.order || 'charset',
    chars,
    charsText: chars,
    charCount: Array.from(chars).length,
    pageCount: Math.max(1, restored.sheetPages || Math.ceil(Array.from(chars).length / LAYOUT.perPage)),
    batchCode: restored.batchCode,
    label: '从模板 PDF 恢复',
    message: '已从模板 PDF 恢复这一批：共 ' + (restored.sheetPages || '?') + ' 页、' +
      Array.from(chars).length + ' 字，校验码 ' + restored.batchCode +
      '（上传时程序会拿它与纸面页脚的码比对，一致才收）'
  }
}
