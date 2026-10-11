// 制作流程的步骤定义与状态推导
// 职责：把"三步流程"落成**可推导的状态**——每步是"已完成 / 当前 / 未开始 / 待接入"，由项目数据算出来，
//   而不是另一份需要手工维护的状态机。界面只负责按这份状态渲染，判断逻辑（含"为什么还不能进入下一步"）
//   全在这里，因此可以在 Node 里直接断言（test/flow.mjs）。
// 数据来源：调用方传入的 progress（模板元信息、识别页数、更正确认、字体产物），由 store 提供。
// 步骤沿革（决策 八-15）：原 7 步并入 6 步（"选字"并进"出模板"，2026-10-04），
//   2026-10-11 用户拍板"流程不该分这么细"→ **6 步并为 3 步**：
//     · 原「手写与扫描」不再占一步（它是纸面动作、内容本来只是一段说明，要点并入第 1 步末尾的说明段）；
//     · 原第 2、3、4 步（写与扫 / 上传识别 / 更正核对）并为第 2 步「识别」；
//     · 原第 5、6 步（生成字体 / 下载安装）并为第 3 步「生成」。

// 步骤表：key 用于状态推导与界面定位，label 是给用户看的一句话，hint 是这一步要干什么
export const FLOW_STEPS = [
  {
    key: 'template',
    label: '选模板',
    hint: '挑要写的字，下载模板压缩包（模板 PDF + 更正册 + 完整说明 + 字序文件），打印出来照着写'
  },
  {
    key: 'scan',
    label: '识别',
    hint: '指定扫描件所在的文件夹，程序读里面的图片与字序文件，逐页切格、提取笔迹，并核对更正'
  },
  {
    key: 'build',
    label: '生成',
    hint: '矢量化并组装字体，可先做字形体检 / 剔除 / 标记待重写，最后下载 zip 安装到系统'
  }
]

// 哪些步骤已经接入实现（三步全部接入）
export const IMPLEMENTED_STEPS = {
  template: true,
  scan: true,
  build: true
}

// 空的进度快照：调用方只传它有的字段，其余按"还没做"处理
export function emptyProgress() {
  return {
    // 第 1 步的完成判据：生成过模板（读 store.template 那笔元信息 —— 第 1 步不记批次，决策 五-9 ⑩）
    templatePages: 0,
    uploadedPages: 0, // 已识别的扫描页数（第 2 步）
    glyphCount: 0, // 已提取到笔迹的字形数
    needsCorrection: false, // 主区有没有被红笔圈掉的字（有就必须先确认更正对应）
    correctionConfirmed: false, // 更正对应是否已人工确认
    fontBuilt: false // 字体是否已生成（第 3 步的完成判据，也是"下载"能不能点的判据）
  }
}

// 每一步的完成判据（写成表，便于核对"状态是从哪算出来的"）
const DONE_WHEN = {
  template: (p) => p.templatePages > 0,
  scan: (p) => p.uploadedPages > 0,
  build: (p) => p.fontBuilt === true
}

// 每一步"能不能进入"的判据 + 不能进入时的中文原因（界面直接把 reason 显示出来）
const AVAILABLE_WHEN = {
  template: () => ({ ok: true, reason: '' }),
  scan: (p) => (p.templatePages > 0
    ? { ok: true, reason: '' }
    : { ok: false, reason: '还没有生成过模板（先在第 1 步下载模板压缩包、打印出来写）' }),
  // 第 3 步**随时可进**（用户 2026-10-11 口径："这一步随时可点进去看"）——
  // 进来之后页内会提示上一步的状态，且"生成字体""下载"这类动作在扫描没完成 / 没有可用结果时不可点
  // （判断在组件里，理由是那几条要读具体的识别统计，不是流程级的一句话能说清的）。
  // 为什么不做成"进不去"：用户想先看一眼名称表、先改族名是合理需求，挡在门外只会让人以为程序坏了。
  build: () => ({ ok: true, reason: '' })
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
    // "当前"= 第一个还没完成、且条件已满足的步骤
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
 * **当前界面不渲染这两个按钮**（2026-10-08 用户要求去掉步骤卡底部的导航栏，导航走顶部步骤条 ——
 * 步骤条点不进去时给的是同一套 `step.reason`）；这两项推导保留为**流程相邻关系**的定义，
 * `test/flow.mjs` 仍在验，将来若要加键盘快捷键或恢复按钮，规则现成。
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

// 流程概览文案：给界面上"已完成 x / 3 步"用
export function flowSummary(state) {
  return '已完成 ' + state.doneCount + ' / ' + state.total + ' 步'
}
