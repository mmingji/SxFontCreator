// 位图 → 矢量轮廓（阶段一步骤 1.9）
// 来源：复用参考项目 sn-font-manager 的 `src/lib/traceImage.js`（已跑通），按本项目需要裁剪与改造：
//   **保留** potrace（esm-potrace-wasm，GPL-2.0，决策 六-7）的调用方式、wasm 懒初始化、二值化的方向修正；
//   **改造**输入：本项目喂进来的是 1.6 产出的**手写掩膜**（Uint8Array，1 = 笔迹），
//     不是用户上传的图片文件 —— 于是删掉解码/缩放/File 相关部分（那是图标场景的入口，本项目没有）；
//   **不要**参考项目里"强制归一化到 0~1000 全幅"的那一步：汉字按书写格线性映射（决策 四-4），
//     归一化会把"一"和"国"拉成一样大。
// 环境限制：potrace 是 WASM、ImageData 是浏览器 API —— 本模块**只能在浏览器（或带 canvas 的 Web Worker）里跑**。
import { potrace, init as initPotrace } from 'esm-potrace-wasm'
import { collectPathCommands, commandsToPathData } from './svgPath.js'

// potrace 参数（沿用参考项目实测值；本项目在它之前已有"面积过滤 10 像素"，turdsize 只作兜底）
export const TRACE_DEFAULTS = {
  turdsize: 2, // 面积小于它的孤立噪点丛忽略
  turnpolicy: 4, // minority：potrace 推荐的拐角决策策略
  alphamax: 1, // 拐角平滑阈值上限（1 = 默认平滑；手写笔画的起收笔锐角保留得住）
  opticurve: 1, // 启用贝塞尔拟合，输出 path 更精简
  opttolerance: 0.2 // 曲线拟合容差：越小越贴原像素轮廓
}

// wasm 懒初始化：第一次转换时才加载（约 70KB，内联在包里，无需额外网络请求）
let readyPromise = null
function ensurePotraceReady() {
  if (!readyPromise) readyPromise = initPotrace()
  return readyPromise
}

// 掩膜 → 二值 ImageData（黑 = 前景/笔迹，白 = 背景）。
// **不镜像**（mirror 默认 false）：potrace 的输出与输入位图同向（位图首行 → SVG 顶部）。
//   参考项目在喂入前做了一次垂直镜像，那是为了让它的图标流程"看起来对"，本项目实测会**把字形上下颠倒** ——
//   验证方式是渲染样张与系统字体逐字对照（2026-10-04 踩到：第一版样张里所有字都是倒的）。
//   mirror 参数留着是为了将来遇到方向异常的 potrace 版本时能一键翻回来。
export function maskToImageData(mask, width, height, mirror = false) {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const srcRow = (mirror ? height - 1 - y : y) * width
    const dstRow = y * width
    for (let x = 0; x < width; x++) {
      const v = mask[srcRow + x] ? 0 : 255
      const i = (dstRow + x) * 4
      out[i] = v
      out[i + 1] = v
      out[i + 2] = v
      out[i + 3] = 255
    }
  }
  return new ImageData(out, width, height)
}

// potrace 输出的 SVG 形如：
//   <svg width="146" height="146" viewBox="0 0 146 146"><g transform="translate(0.000000,146.000000) scale(0.100000,-0.100000)"><path d="..."/></g></svg>
// **path 的坐标是"像素 × 10"，而且 y 轴方向与位图相反** —— 缩放与翻转都藏在这个 transform 里。
// 只取 d 而丢掉 transform 会让坐标差 10 倍且上下颠倒（实测踩到：所有字形都被判成越界、统统裁成整框）。
// 所以这里把 transform 解析出来交给调用方合并进自己的坐标映射（不在这里直接改命令，避免多一次字符串往返）。
export function parseTraceTransform(svg) {
  const m = /transform="translate\(\s*(-?[\d.]+)[,\s]+(-?[\d.]+)\s*\)\s*scale\(\s*(-?[\d.]+)[,\s]+(-?[\d.]+)\s*\)"/.exec(String(svg))
  if (!m) return { a: 0, b: 0, c: 1, d: 1, found: false }
  return { a: +m[1], b: +m[2], c: +m[3], d: +m[4], found: true }
}

/**
 * 手写掩膜 → path 命令序列。
 * @param {Uint8Array} mask 1 = 笔迹（尺寸 width × height）
 * @param {{width:number,height:number,turdsize?:number,alphamax?:number,mirror?:boolean}} options
 * @returns {{cmds:Array, d:string, transform:object, empty:boolean}} cmds 是**未应用 transform** 的原始命令，
 *   transform 是 potrace 的 `<g transform>` 参数（见上面说明）；d 是应用 transform 后的像素坐标路径（调试/展示用）；
 *   empty 为真表示掩膜是空的或没追踪到轮廓
 */
export async function maskToPathData(mask, { width, height, turdsize, alphamax, mirror } = {}) {
  if (!mask || !width || !height) throw new Error('位图追踪需要掩膜与尺寸（mask / width / height）')
  // 空掩膜直接短路：不必惊动 wasm，也避免"全白图会不会吐出整幅矩形"这类不确定行为
  let hasInk = false
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      hasInk = true
      break
    }
  }
  if (!hasInk) return { cmds: [], d: '', transform: { a: 0, b: 0, c: 1, d: 1, found: false }, empty: true }
  await ensurePotraceReady()
  const imageData = maskToImageData(mask, width, height, mirror === true)
  const svg = await potrace(imageData, {
    ...TRACE_DEFAULTS,
    turdsize: typeof turdsize === 'number' ? turdsize : TRACE_DEFAULTS.turdsize,
    alphamax: typeof alphamax === 'number' ? alphamax : TRACE_DEFAULTS.alphamax
  })
  const cmds = collectPathCommands(svg)
  const transform = parseTraceTransform(svg)
  return {
    cmds,
    transform,
    d: cmds.length ? commandsToPathData(cmds, transform.c, transform.d, transform.a, transform.b) : '',
    empty: cmds.length === 0,
    svg // 原始输出留一份：出问题时能直接看清 potrace 到底给了什么（诊断用，不影响正常流程）
  }
}
