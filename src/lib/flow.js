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
    templateChars: 0, // 那份模板一共排了多少字（卡片上的进度文案要用）
    uploadedPages: 0, // 已识别的扫描页数（第 2 步）
    sheetPages: 0, // 这份纸一共几页（来自字序文件或纸面页号；0 = 还不知道）
    glyphCount: 0, // 已提取到笔迹的字形数
    fontCoverage: 0, // 字体产物收录了多少字（第 3 步卡片的进度分子）
    needsCorrection: false, // 主区有没有被红笔圈掉的字（有就必须先确认更正对应）
    correctionConfirmed: false, // 更正对应是否已人工确认
    fontBuilt: false // 字体是否已生成（第 3 步的完成判据，也是"下载"能不能点的判据）
  }
}

// 每一步的完成判据（写成表，便于核对"状态是从哪算出来的"）
export const DONE_WHEN = {
  template: (p) => p.templatePages > 0,
  scan: (p) => p.uploadedPages > 0,
  build: (p) => p.fontBuilt === true
}

// 一步做完没有：界面（卡片进度）与状态推导共用这一处，避免两处各写一套判据
export function isStepDone(key, progress) {
  const p = { ...emptyProgress(), ...(progress || {}) }
  const fn = DONE_WHEN[key]
  return fn ? fn(p) === true : false
}

// 当前该停在哪一步 = **第一个还没做完的步骤**（用户 2026-10-04 的向导口径：打开就落在该干的那一步）。
// 三步都做完就停在最后一步（回看产物）。
export function currentStepKey(progress) {
  const p = { ...emptyProgress(), ...(progress || {}) }
  for (const step of FLOW_STEPS) {
    if (!isStepDone(step.key, p)) return step.key
  }
  return FLOW_STEPS[FLOW_STEPS.length - 1].key
}

// 每一步"能不能进入"：2026-10-12（决策 八-16 ①）起**三步全部无条件可进** ——
//   · 第 2 步与模板脱钩：范围改由扫描件自己决定（决策 五-9），识别不再依赖"上一步做完没有"；
//   · 第 3 步本来就"随时可进"（决策 八-15 ③）：进得去页面，页内提示上一步状态、动作不可点时给中文原因。
// 所以原来那张 AVAILABLE_WHEN 判据表与"点了给阻止理由"一整套（available / reason / blockedReason）
// 都去掉了。**留下的是"进度"**：每步做完没有（isStepDone）、该落在哪一步（currentStepKey）、
// 卡片上的进度条（stepProgress）—— 都是事实，不是门槛。

/**
 * 推导整条流程的状态（**只记录事实，不再拦人**）。
 * @param {object} [progress] 见 emptyProgress()；缺省字段按"还没做"处理
 * @returns {{steps:Array, currentKey:string, doneCount:number, total:number}}
 *   steps[i] = { key, label, hint, implemented, done, status }
 *   status: done 已完成 / current 当前（第一个还没做完的）/ todo 未开始
 *
 * 2026-10-12（决策 八-16 ①②）：**界面已不再用这份推导渲染任何东西** ——
 *   三张步骤卡片样式一致、都能直接点进（"完成 / 当前 / 进不去"的区别与阻止理由都去掉了），
 *   卡片上只有 label / hint / 进度（stepCardList）。它保留下来是因为它仍是
 *   "每一步做完没有、打开该落在哪一步"的唯一定义：currentKey 与 isStepDone 都从这里取口径，
 *   test/flow.mjs 逐条验它。界面上不必有第二份状态机，也不该有。
 */
export function buildFlowState(progress) {
  const p = { ...emptyProgress(), ...(progress || {}) }
  const now = currentStepKey(p)
  const steps = FLOW_STEPS.map((step) => {
    const done = isStepDone(step.key, p)
    return {
      key: step.key,
      label: step.label,
      hint: step.hint,
      implemented: IMPLEMENTED_STEPS[step.key] === true,
      done,
      status: done ? 'done' : (step.key === now ? 'current' : 'todo')
    }
  })
  return {
    steps,
    currentKey: now,
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
 * 规则：**往回走永远允许**（回看这一步不该被拦）；往前走只要不是最后一步就允许 ——
 * 三步在界面上都无条件可点（决策 八-16 ①），"下一步"这件事本身也就没有门槛了。
 * **当前界面不渲染这两个按钮**（2026-10-08 去掉步骤卡底部的导航栏，导航只走顶部卡片）；
 * 这两项推导保留为**流程相邻关系**的定义，`test/flow.mjs` 仍在验，
 * 将来若要加键盘快捷键或恢复底部按钮，规则现成。
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
    canNext: !!next,
    nextReason: '' // 没有"下一步走不了"这回事了（保留字段是为了不动调用方）
  }
}

// 流程概览文案：给界面上"已完成 x / 3 步"用。
// 2026-10-12（决策 八-16 ②）：步骤卡片**不再显示完成态**（那行"已完成 X / 3 步 · 当前：…"已去掉），
// 这个函数因此没有界面调用者了；保留它是因为 doneCount 仍是"这一步做完没有"的唯一定义，
// test/flow.mjs 在验，将来要做进度总览时规则现成。
export function flowSummary(state) {
  return '已完成 ' + state.doneCount + ' / ' + state.total + ' 步'
}

// ── 三张步骤卡片底部的进度（2026-10-12 用户拍板，决策 八-16 ①）────────────────
// 为什么要放在这里：卡片要显示"这一步做到哪儿了"，而"有多少可做、已经做了多少"全由项目数据算出来 ——
//   与完成判据同一处推导，界面就不必再拼一套数字（两处各拼一次必然走样）。
/**
 * 三张步骤卡片的数据（界面直接渲染这一个数组）。
 * @param {object} [progress] 见 emptyProgress()
 * @returns {{cards:Array, currentKey:string}}
 *   cards[i] = { key, label, hint, implemented, done, progress:{done,total,ratio,label} }
 */
export function stepCardList(progress) {
  const p = { ...emptyProgress(), ...(progress || {}) }
  const cards = FLOW_STEPS.map((step) => ({
    key: step.key,
    label: step.label,
    hint: step.hint,
    implemented: IMPLEMENTED_STEPS[step.key] === true,
    done: isStepDone(step.key, p),
    progress: stepProgress(step.key, p)
  }))
  return { cards, currentKey: currentStepKey(p) }
}

/**
 * 一步的进度：`{ done 已完成量, total 可做量, ratio 0~1, label 给人看的一句话 }`。
 * 口径三条：
 *   ① **只报事实、不报口号**：label 是能对得上的中文（"已识别 3 页 / 共 12 页"），ratio 只用来画条；
 *   ② **没有可做的东西时不编数字**：分母为 0 时 ratio = 0、label 直说"还没有…"；
 *   ③ 第 2 步的分母是"这份纸一共几页"（读到的字序文件声明的页数，或纸面页号的最大值），
 *      **不是**某个批次的页数 —— 模板与识别早已脱钩（决策 五-9），拿批次页数当分母会与用户手上的纸对不上。
 * @param {string} key 'template' | 'scan' | 'build'
 * @param {object} progress 见 emptyProgress()
 */
export function stepProgress(key, progress) {
  const p = { ...emptyProgress(), ...(progress || {}) }
  const clamp = (n, d) => (d > 0 ? Math.max(0, Math.min(1, n / d)) : 0)
  if (key === 'template') {
    const total = p.glyphCount > 0 ? p.glyphCount : p.templateChars
    const label = p.templatePages > 0
      ? '已生成 ' + p.templateChars + ' 字 · ' + p.templatePages + ' 页'
      : '还没有生成模板'
    return { done: p.templatePages > 0 ? total : 0, total, ratio: p.templatePages > 0 ? 1 : 0, label }
  }
  if (key === 'scan') {
    // 分母还不知道时（没有页号、也没有字序文件声明的页数）只报"已识别 N 页"，不编一个分母出来
    const total = p.sheetPages > 0 ? Math.max(p.sheetPages, p.uploadedPages) : p.uploadedPages
    const label = p.uploadedPages > 0
      ? '已识别 ' + p.uploadedPages + ' 页' + (p.sheetPages > p.uploadedPages ? ' / 共 ' + p.sheetPages + ' 页' : '')
      : '还没有识别结果'
    return { done: p.uploadedPages, total, ratio: clamp(p.uploadedPages, total), label }
  }
  // build：分母是"这批纸能提供的字"；分母算不出来时退回"已收录多少字"，只报事实
  const total = p.glyphCount > 0 ? p.glyphCount : p.fontCoverage
  const label = p.fontBuilt
    ? '已收录 ' + p.fontCoverage + ' 字' + (p.glyphCount > p.fontCoverage ? ' / 共 ' + p.glyphCount + ' 字' : '')
    : (p.glyphCount > 0 ? '可收录 ' + p.glyphCount + ' 字 · 还没生成' : '还没有可收录的字形')
  return { done: p.fontCoverage, total, ratio: clamp(p.fontCoverage, total), label }
}
