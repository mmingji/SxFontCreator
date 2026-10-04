// 制作流程的步骤定义与状态推导（阶段一「界面串联」的第一步）
// 职责：把"七步流程"落成**可推导的状态**——每步是"已完成 / 当前 / 未开始 / 待接入"，由项目数据算出来，
//   而不是另一份需要手工维护的状态机。界面只负责按这份状态渲染，判断逻辑（含"为什么还不能进入下一步"）
//   全在这里，因此可以在 Node 里直接断言（test/flow.mjs）。
// 数据来源：调用方传入的 progress（批次、上传页数、更正确认、字体产物），目前由 store 提供一部分，
//   扫描上传 / 更正核对 / 字体构建接入后补齐（步骤 1.10 那一轮）。
// 为什么把步骤由 7 步并为 6 步：原第 1 步「选字」在第 2 步「出模板」里只是一个下级选项（用户 2026-10-04 拍板），
//   单独占一步会让流程看起来多一步、也让"选字"与"当前选字 / 自定义选字"两处说法打架。

// 步骤表：key 用于状态推导与界面定位，label 是给用户看的一句话，hint 是这一步要干什么
export const FLOW_STEPS = [
  {
    key: 'template',
    label: '选字与出模板',
    hint: '挑要写的字、生成模板 PDF 打印（可以先打单页确认版式）'
  },
  {
    key: 'write',
    label: '手写与扫描',
    hint: '照着格子写，按 300dpi 彩色扫描回传'
  },
  {
    key: 'upload',
    label: '上传识别',
    hint: '上传扫描件，自动切格、提取笔迹、识别被红笔圈掉的字'
  },
  {
    key: 'correct',
    label: '更正核对',
    hint: '核对"更正册第 k 格 → 主区哪个字"，可改派 / 删除 / 补录'
  },
  {
    key: 'build',
    label: '生成字体',
    hint: '矢量化并组装 TTF / woff / woff2，可先做字形体检'
  },
  {
    key: 'download',
    label: '下载安装',
    hint: '下载 zip（字体 + CSS + 使用说明）并安装到系统'
  }
]

// 哪些步骤已经接入实现（2026-10-04：只有第 1 步「选字与出模板」；其余在后续轮次接入）
// 「手写与扫描」不需要代码，它是纸面动作 + 说明，所以算已接入
export const IMPLEMENTED_STEPS = {
  template: true,
  write: true,
  upload: false,
  correct: false,
  build: false,
  download: false
}

// 空的进度快照：调用方只传它有的字段，其余按"还没做"处理
export function emptyProgress() {
  return {
    batchCount: 0, // 已记录的批次数（生成过正式模板）
    activeBatchCount: 0, // 其中仍可上传的批次数
    uploadedPages: 0, // 已识别的扫描页数
    glyphCount: 0, // 已提取到笔迹的字形数
    correctionConfirmed: false, // 更正对应是否已人工确认
    fontBuilt: false, // 字体是否已生成
    exported: false // 是否已下载过（下载步骤没有"完成"以外的强判据，先留给后续）
  }
}

// 每一步的完成判据（写成表，便于核对"状态是从哪算出来的"）
const DONE_WHEN = {
  template: (p) => p.batchCount > 0,
  write: (p) => p.uploadedPages > 0,
  upload: (p) => p.uploadedPages > 0,
  correct: (p) => p.correctionConfirmed === true,
  build: (p) => p.fontBuilt === true,
  download: (p) => p.exported === true
}

// 每一步"能不能进入"的判据 + 不能进入时的中文原因（界面直接把 reason 显示出来）
const AVAILABLE_WHEN = {
  template: () => ({ ok: true, reason: '' }),
  write: (p) => (p.batchCount > 0
    ? { ok: true, reason: '' }
    : { ok: false, reason: '还没有生成过正式模板（先在第一步出模板并打印）' }),
  upload: (p) => {
    if (p.batchCount === 0) return { ok: false, reason: '还没有生成过正式模板（先在第一步出模板并打印）' }
    if (p.activeBatchCount === 0) return { ok: false, reason: '现有批次都已作废（选字改过就要重新生成模板）' }
    return { ok: true, reason: '' }
  },
  correct: (p) => (p.uploadedPages > 0
    ? { ok: true, reason: '' }
    : { ok: false, reason: '还没有上传识别结果（先在第三步上传扫描件）' }),
  build: (p) => (p.uploadedPages > 0 && p.glyphCount > 0
    ? { ok: true, reason: '' }
    : { ok: false, reason: '还没有可用的字形（先完成「上传识别」这一步、提取到笔迹）' }),
  download: (p) => (p.fontBuilt
    ? { ok: true, reason: '' }
    : { ok: false, reason: '还没有生成字体（先在第五步生成字体）' })
}

/**
 * 推导整条流程的状态。
 * @param {object} [progress] 见 emptyProgress()；缺省字段按"还没做"处理
 * @returns {{steps:Array, currentKey:string, doneCount:number, total:number}}
 *   steps[i] = { key, label, hint, status, note, available, reason, implemented }
 *   status: done 已完成 / current 当前 / todo 未开始 / pending 待接入（功能还没做出来）
 */
export function buildFlowState(progress) {
  const p = { ...emptyProgress(), ...(progress || {}) }
  let seenCurrent = false
  const steps = FLOW_STEPS.map((step) => {
    const implemented = IMPLEMENTED_STEPS[step.key] === true
    // "完成"只看数据，不看功能有没有接入 —— 数据齐了就是齐了（接入与否只影响界面上能不能操作）
    const done = DONE_WHEN[step.key](p)
    const avail = AVAILABLE_WHEN[step.key](p)
    // "当前"= 第一个还没完成、且条件已满足的步骤；**不跳过未接入的步骤** ——
    // 跳过会让流程指针落到"下载安装"上（明明还没生成字体），用户看到的是一个不合理的落点
    let status
    if (done) status = 'done'
    else if (!seenCurrent && avail.ok) {
      status = 'current'
      seenCurrent = true
    } else status = implemented ? 'todo' : 'pending'
    return {
      key: step.key,
      label: step.label,
      hint: step.hint,
      implemented,
      done,
      available: avail.ok,
      reason: avail.reason,
      status,
      note: !implemented
        ? '这一步的功能还没接入（后续轮次做），现在点进来只看到说明'
        : (avail.ok ? '' : avail.reason)
    }
  })
  const current = steps.find((s) => s.status === 'current')
  return {
    steps,
    currentKey: current ? current.key : steps[steps.length - 1].key,
    doneCount: steps.filter((s) => s.status === 'done').length,
    total: steps.length
  }
}

// 当前步骤在步骤表里的下标；找不到按 0 处理（界面初次渲染要有个落点）
export function stepIndex(key) {
  const i = FLOW_STEPS.findIndex((s) => s.key === key)
  return i < 0 ? 0 : i
}

/**
 * 上一步 / 下一步能不能走。
 * 规则：**往回走永远允许**（回看已完成的步骤不该被拦）；往前走要求目标步骤 available。
 * @returns {{prevKey:string|null, nextKey:string|null, canPrev:boolean, canNext:boolean, nextReason:string}}
 */
export function stepNavigation(state, currentKey) {
  const i = stepIndex(currentKey)
  const prev = i > 0 ? state.steps[i - 1] : null
  const next = i < state.steps.length - 1 ? state.steps[i + 1] : null
  return {
    prevKey: prev ? prev.key : null,
    canPrev: !!prev,
    nextKey: next ? next.key : null,
    canNext: !!next && next.available,
    // 下一步走不了时给出的中文原因（直接显示在按钮旁，不让用户猜）
    nextReason: next && !next.available ? next.reason : ''
  }
}

// 流程概览文案：给界面上"已完成 x / 6 步"用
export function flowSummary(state) {
  return '已完成 ' + state.doneCount + ' / ' + state.total + ' 步'
}
