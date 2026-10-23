// 识别高级预设（2026-10-23 用户拍板 A）
// 职责：把"会影响成字观感、但用户不该直接看数字"的提取 / 追踪 / 红圈参数，包成 5 组档位；
//   界面只显示中文档位，映射到这里再由各模块使用。数字仍以各模块的默认值为准，这里只做"档位 → 参数"。
// 为什么集中在一处：界面上改档位、识别端与生成端各自取值；分散写会把同一档位的含义写出两套。
// 口径（《决策记录》二-10 与新增的识别高级档位条目）：
//   ink      墨色：偏淡 = 阈值更低（保留淡笔迹）、偏深 = 阈值更高（只留深墨）
//   dots     小点：保留 = 面积门槛更低（8，连"调"的 10 像素点都留）、严格 = 更高（15）
//   closeGaps 补断笔：开 = 闭运算半径 1（断口 1~2 像素补上）、关 = 0
//   outline  轮廓：圆润 = alphamax 1.3、硬朗 = 0.6（越小起收笔越锐）
//   marks    红圈灵敏度：高 = 红度阈值更低（50，更容易认淡圈）、低 = 更高（70）
export const PRESET_DEFAULTS = {
  ink: 'normal',
  dots: 'normal',
  closeGaps: false,
  outline: 'normal',
  marks: 'normal'
}

export const PRESET_GROUPS = [
  {
    key: 'ink',
    title: '墨色',
    hint: '字迹淡、扫描后发灰 → 偏淡；纸面偏脏 → 偏深。',
    options: [
      { value: 'light', label: '偏淡' },
      { value: 'normal', label: '标准' },
      { value: 'dark', label: '偏深' }
    ]
  },
  {
    key: 'dots',
    title: '小点',
    hint: '点、小笔画容易被当纸面灰尘删掉；"保留"留得最全，"严格"清得最干净。',
    options: [
      { value: 'keep', label: '保留' },
      { value: 'normal', label: '标准' },
      { value: 'strict', label: '严格' }
    ]
  },
  {
    key: 'closeGaps',
    title: '补断笔',
    hint: '笔画断开时补 1~2 像素；开得太多可能让相邻笔画粘住。',
    options: [
      { value: 'off', label: '关' },
      { value: 'on', label: '开' }
    ]
  },
  {
    key: 'outline',
    title: '轮廓',
    hint: '轮廓拐角的平滑程度：圆润更顺，硬朗更保留手写的起收笔锐角。',
    options: [
      { value: 'round', label: '圆润' },
      { value: 'normal', label: '标准' },
      { value: 'sharp', label: '硬朗' }
    ]
  },
  {
    key: 'marks',
    title: '红圈灵敏度',
    hint: '淡红圈认不出 → 高；红色批注被误当成圈 → 低。',
    options: [
      { value: 'high', label: '高' },
      { value: 'normal', label: '标准' },
      { value: 'low', label: '低' }
    ]
  }
]

const valid = {
  ink: ['light', 'normal', 'dark'],
  dots: ['keep', 'normal', 'strict'],
  closeGaps: [true, false],
  outline: ['round', 'normal', 'sharp'],
  marks: ['high', 'normal', 'low']
}

/** 把落盘 / 界面传来的预设收成一份完整、合法的对象：缺字段补默认、非法值回默认 */
export function normalizePreset(input) {
  const src = input && typeof input === 'object' ? input : {}
  const out = { ...PRESET_DEFAULTS }
  for (const key of Object.keys(PRESET_DEFAULTS)) {
    const v = src[key]
    if (key === 'closeGaps') out.closeGaps = v === true
    else if (valid[key].includes(v)) out[key] = v
  }
  return out
}

/** 识别端的字形提取参数（handwritingExtractor 的 EXTRACT_DEFAULTS 子集） */
export function extractOptionsFromPreset(input) {
  const p = normalizePreset(input)
  return {
    inkThreshold: p.ink === 'light' ? 130 : p.ink === 'dark' ? 170 : 150,
    minBlobArea: p.dots === 'keep' ? 8 : p.dots === 'strict' ? 15 : 10,
    closeRadius: p.closeGaps ? 1 : 0
  }
}

/** 红圈识别参数（markRecognizer 的 MARK_DEFAULTS 子集） */
export function markOptionsFromPreset(input) {
  const p = normalizePreset(input)
  return {
    redThreshold: p.marks === 'high' ? 50 : p.marks === 'low' ? 70 : 60
  }
}

/** 追踪参数（traceImage / potrace）：只有 alphamax 跟"轮廓"档走，turdsize 保持 2 */
export function traceOptionsFromPreset(input) {
  const p = normalizePreset(input)
  return {
    alphamax: p.outline === 'round' ? 1.3 : p.outline === 'sharp' ? 0.6 : 1
  }
}

/** 一句话说明当前档位（界面上显示"当前：墨色 标准 · 小点 保留…"） */
export function describePreset(input) {
  const p = normalizePreset(input)
  const parts = []
  for (const g of PRESET_GROUPS) {
    const v = g.key === 'closeGaps' ? (p.closeGaps ? 'on' : 'off') : p[g.key]
    const opt = g.options.find((o) => String(o.value) === String(v))
    if (opt) parts.push(g.title + ' ' + opt.label)
  }
  return parts.join(' · ')
}
