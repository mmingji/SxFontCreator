// 浏览器能力检测（《实施计划》步骤 3.4 浏览器兼容）
// 为什么要它：交付形态是 file:// 下双击 index.html，用户可能用旧浏览器打开 —— 版本太低时页面
//   往往"看起来能开、点到某一步才炸"（例如没有 OffscreenCanvas 就没法切格）。启动时先检测**真实依赖的能力**，
//   缺哪一项就用中文说清"哪一步会干不了 + 怎么办"，比让人猜到第 2 步才发现要好。
// 判据为什么用"能力"而不是版本号：能力检测是确定性的 —— 各种套壳内核、企业版浏览器、Firefox / Safari
//   都能得到正确结论；版本号只能靠 UA 字符串猜，而 UA 是可以被改写的。
// 支持口径（《决策记录》六-10）：Chrome / Edge 90 以上；Win7 上 Chrome / Edge 最高到 109，仍满足要求。
//   因此**不需要**版本号判断，能力检测通过就等于满足口径（清单里的每一项在 Chrome 87 之前就已具备）。
export const BROWSER_REQUIREMENTS = {
  minChrome: 90,
  note: 'Win7 上可装 Chrome / Edge 109（最后一个支持 Win7 的版本），同样满足要求；IE 不支持'
}

// 每一项都是"某一步真的会用到"的能力，并写清缺了会怎样（提示里要直接说影响，不只报名字）
export const REQUIRED_FEATURES = [
  {
    key: 'indexedDB',
    label: '本地数据库（IndexedDB）',
    impact: '数据没法保存在本机，刷新就丢',
    test: (env) => typeof env.indexedDB !== 'undefined' && env.indexedDB !== null
  },
  {
    key: 'canvas2d',
    label: '画布 2D',
    impact: '切格与笔迹提取都用不了',
    test: (env) => {
      try {
        return !!(env.document && env.document.createElement('canvas').getContext('2d'))
      } catch {
        return false
      }
    }
  },
  {
    key: 'wasm',
    label: 'WebAssembly',
    impact: '字形矢量化与字体合成用不了',
    test: (env) => typeof env.WebAssembly === 'object' && env.WebAssembly !== null && typeof env.WebAssembly.instantiate === 'function'
  },
  {
    key: 'worker',
    label: 'Web Worker 与 Blob URL',
    impact: '模板预览渲染不出来（pdf.js 的 worker 起不来）',
    test: (env) => typeof env.Worker === 'function' && typeof env.Blob === 'function' &&
      typeof env.URL !== 'undefined' && typeof env.URL.createObjectURL === 'function'
  },
  {
    key: 'offscreenCanvas',
    label: 'OffscreenCanvas',
    impact: '扫描件的预处理与切格用不了',
    test: (env) => typeof env.OffscreenCanvas === 'function'
  },
  {
    key: 'imageBitmap',
    label: 'createImageBitmap',
    impact: '笔迹掩膜没法压缩落盘（识别完刷新就白写）',
    test: (env) => typeof env.createImageBitmap === 'function'
  },
  {
    key: 'fontFace',
    label: 'FontFace',
    impact: '第 3 步的字体预览与字形总览图渲染不了',
    test: (env) => typeof env.FontFace === 'function'
  },
  {
    key: 'fileArrayBuffer',
    label: 'File.arrayBuffer',
    impact: '选中的扫描件读不进来',
    test: (env) => typeof env.File === 'function' && typeof env.File.prototype.arrayBuffer === 'function'
  },
  {
    key: 'blobDownload',
    label: 'Blob 下载（a[download]）',
    impact: '模板、字体与项目包都下载不了',
    test: (env) => {
      try {
        return !!(env.document && 'download' in env.document.createElement('a'))
      } catch {
        return false
      }
    }
  }
]

/**
 * 检测当前环境缺哪些能力（纯函数，可在 Node 里喂假环境做断言）
 * @param {object} [env] 环境对象，默认 globalThis
 * @returns {{ok: boolean, missing: Array<{key:string,label:string,impact:string}>, message: string}}
 */
export function checkBrowserSupport(env = globalThis) {
  const missing = REQUIRED_FEATURES.filter((feature) => {
    try {
      return !feature.test(env)
    } catch {
      return true // 检测本身抛错（比如 document 被策略禁用）也算缺失
    }
  }).map((feature) => ({ key: feature.key, label: feature.label, impact: feature.impact }))

  return {
    ok: missing.length === 0,
    missing,
    message: missing.length === 0
      ? ''
      : '当前浏览器缺少 ' + missing.map((m) => m.label).join('、') + ' —— ' +
        missing.map((m) => m.impact).join('；') + '。请改用较新的 Chrome 或 Edge（' +
        BROWSER_REQUIREMENTS.minChrome + ' 以上；' + BROWSER_REQUIREMENTS.note + '）'
  }
}
