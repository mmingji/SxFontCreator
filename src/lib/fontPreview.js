// 第 3 步「网页字体预览」：纯逻辑（零依赖、Node 侧可断言）+ FontFace 封装（只在浏览器里跑）
// 职责：
//   ① splitPreviewText —— 把用户输入按**码点**拆成"行 → 字"，代理对（emoji 这类两个码元的字符）不会被拆坏；
//   ② analyzePreviewText —— 逐字判定"有没有被这套字体收录"，给出未收录清单；
//   ③ previewFontFamily / registerPreviewFont —— 把生成好的字体字节用 FontFace（浏览器字体接口）
//      **动态注册**进当前页面，不装机也能看效果（决策 四-8）。
// 为什么必须有 ②：字体文件里只有"收录"的那些字形 —— 清单外的字在浏览器 / PS 里会**回退成系统字体**、
//   在 Word 里会显示成方框（清单 三-4 的装机实测结论）。不标出来，用户会以为预览里的样子就是安装后的样子。
// 数据来源：收录清单 = `store.font.coverage.chars`（生成字体时算出来的，下载包里的使用说明与 preview.html 同源）。
// 为什么独立成文件：①② 是纯函数，直接在 Node 里断言，不必起浏览器；③ 用 typeof 探测环境，缺 FontFace 时给中文错误。

// 预览字号三档（像素）：小字看字距与整体匀称、大字看笔画细节与起收笔（用户 2026-10-07 拍板）
export const PREVIEW_SIZES = [24, 36, 56]

// 「换一句常用话」的示例句：全是极常用字，用来演示"清单外的字会回退成系统字体"
export const SAMPLE_SENTENCE = '这套手写体是我自己写的，看看效果怎么样。'

// 默认预览文本 = 已收录的前 40 个字：保证 100% 命中，第一眼就看到自己写的字
export const DEFAULT_PREVIEW_CHARS = 40
export function defaultPreviewText(coveredChars, limit = DEFAULT_PREVIEW_CHARS) {
  const list = Array.isArray(coveredChars) ? coveredChars : []
  return list.slice(0, Math.max(0, limit)).join('')
}

// 空白字符（半角空格、全角空格、制表符等）：它们确实不在字表里、也会回退，
// 但不显示任何字形 —— 逐字标红只会让每个词之间挂一个记号，反而看不出真正缺的字，故不计入未收录。
const BLANK_RE = /^\s$/

/**
 * 按码点拆分输入文本（保留行结构）。
 * 用 Array.from 而不是 split('')：split('') 会把 emoji 这类代理对拆成两个半个字符，
 * 渲染时出现"两个问号方块"，与真实回退行为不符。
 * @param {string} text
 * @returns {Array<Array<string>>} 行 → 字符
 */
export function splitPreviewText(text) {
  const normalized = String(text == null ? '' : text).replace(/\r\n?/g, '\n')
  return normalized.split('\n').map((line) => Array.from(line))
}

/**
 * 逐字判定收录情况。
 * @param {string} text 用户输入的预览文本
 * @param {Iterable<string>} coveredChars 这套字体收录的字（store.font.coverage.chars）
 * @returns {{
 *   lines: Array<Array<{ char:string, blank:boolean, covered:boolean, missing:boolean }>>,
 *   total:number, coveredCount:number, missingCount:number, blankCount:number, missing:Array<string>
 * }} total / coveredCount / missingCount 都**不含空白字符**（见 BLANK_RE）；
 *    missing 是去重后的未收录字，按首次出现顺序排列（界面直接列出来给用户看）。
 */
export function analyzePreviewText(text, coveredChars) {
  const set = coveredChars instanceof Set ? coveredChars : new Set(coveredChars || [])
  const missing = []
  const missingSeen = new Set()
  let total = 0
  let coveredCount = 0
  let missingCount = 0
  let blankCount = 0
  const lines = splitPreviewText(text).map((chars) => chars.map((char) => {
    const blank = BLANK_RE.test(char)
    if (blank) {
      blankCount++
      return { char, blank: true, covered: true, missing: false }
    }
    const hit = set.has(char)
    total++
    if (hit) coveredCount++
    else {
      missingCount++
      if (!missingSeen.has(char)) {
        missingSeen.add(char)
        missing.push(char)
      }
    }
    return { char, blank: false, covered: hit, missing: !hit }
  }))
  return { lines, total, coveredCount, missingCount, blankCount, missing }
}

/**
 * 生成本次预览专用的族名。
 * 带唯一后缀的理由：用户系统里可能已经装过同族名的旧版本字体（装机复测时就会这样），
 * 名字撞上时看不出"预览用的到底是新生成的那份还是系统里那份"。
 * 保持 ASCII：族名要写进 CSS 的 font-family，含中文时虽然可行但要多一层引号转义。
 * @param {string} [base] 用户填的族名（store.font.familyName）
 * @param {number} [seq] 递增序号，便于区分同一会话里的多次注册
 */
export function previewFontFamily(base, seq = 1) {
  const ascii = String(base == null ? '' : base).replace(/[^\x20-\x7E]/g, '').replace(/["'\\]/g, '').trim()
  const prefix = ascii || 'SxFontCreator'
  return prefix + ' Preview ' + seq
}

// 未收录字符回退到哪：显式给系统中文字体栈，让"回退的字"一眼看得出不是这套手写体
export const PREVIEW_FALLBACK_STACK = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif'

// 本页已注册、还没释放的预览字体（模块级登记表）。
// 为什么要它：FontFace 一旦 add 进 document.fonts 就**常驻并持有整份字节**，
//   平时靠注册它的组件卸载时 release；但「清空项目」（决策 五-8）要求在那一刻当场放掉，
//   不能指望"组件恰好会卸载"—— 注册与释放是同一份资源的两头，登记表让释放不依赖调用时机。
const registeredFaces = new Set()

/**
 * 把字体字节注册成当前页面可用的字体（不装机也能预览）。
 * @param {ArrayBuffer|Uint8Array} bytes TTF / woff 字节（本项目给的是 TTF）
 * @param {string} family previewFontFamily() 生成的族名
 * @returns {Promise<{ family:string, release:() => void }>}
 * 为什么要 slice()：FontFace 会**持有**这份字节直到字体被移除；
 *   调用方（构建产物）后续可能复用同一块内存，复制一份互不影响，代价只有几十 KB ~ 几 MB。
 */
export async function registerPreviewFont(bytes, family) {
  // 参数校验放在环境校验之前：与实现无关的错误先报出来，Node 侧也能断言到
  if (!bytes || !bytes.byteLength) throw new Error('字体字节为空，无法预览')
  if (typeof FontFace !== 'function' || typeof document === 'undefined' || !document.fonts) {
    throw new Error('当前环境不支持 FontFace（浏览器字体接口），无法在网页里预览')
  }
  const copy = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes)
  const face = new FontFace(family, copy)
  await face.load()
  document.fonts.add(face)
  const handle = {
    family,
    release() {
      try {
        document.fonts.delete(face)
      } catch (e) {
        // 已经被移除（例如页面在注册途中被销毁）不算错误，不打扰用户
      }
      registeredFaces.delete(handle)
    }
  }
  registeredFaces.add(handle)
  return handle
}

/**
 * 释放本页注册过的**全部**预览字体（「清空项目」用，决策 五-8 的步骤 ①）。
 * 为什么要有：清空之后内存里不该再留着上一套字体的字节，也不该留下一个能渲染出旧字形的族名。
 * @returns {number} 释放了几个（界面可用它说明"顺手释放了 N 份预览字体"）
 */
export function releaseAllPreviewFonts() {
  const list = Array.from(registeredFaces)
  for (const handle of list) handle.release()
  registeredFaces.clear()
  return list.length
}
