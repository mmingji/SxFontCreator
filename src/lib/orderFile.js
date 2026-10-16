// 字序文件（决策 一-18）：它说清"这批纸按什么顺序排字"，随模板压缩包发给用户，
// 第 2 步识别时**优先读它定字序** —— 认参考字的能力保留，降为"没有字序文件"时的退路（决策 五-9）。
//
// 为什么要有它：字序原来只活在程序内部（批次 + 页脚校验码），纸一旦离开程序就无从知道
//   "这一页写了哪些字、该按什么顺序对应"；显式落成一份文件之后，识别退化成"读文件 + 逐页对齐"。
//
// 只依赖零依赖的版面契约（lib/layout.js，决策 六-9）：不引字表、不引识别模块、不引 pdf-lib，
//   因此可以在 Node 侧直接断言（test/template-pack.mjs）。
import { LAYOUT } from './layout.js'

// 文件名固定（决策 一-18 ②）：识别时先按这个名字找，找不到再扫目录下同扩展名的其它文件、挑格式对得上的。
//
// **2026-10-16 用户口径：扩展名由 .json 改成 .sxorder；文件在 zip 里带只读属性。**
//   为什么：这是一份"给程序读"的文件，用户双击打开、手改一下（哪怕是换个编辑器另存）都可能让它读不出来
//   （解析宁严勿宽，一-18 ④），而用户根本不需要看它。实测（test/.tmp 的一次性探针）：zip 里的 DOS 只读位
//   在 7-Zip / WinRAR 解压后**会保留**，但 Windows 资源管理器双击 zip 解压**不保留** —— 所以主措施是扩展名
//   （双击没有关联程序、Windows 会问"如何打开"），只读位只算第二道（见 lib/templatePack.js）。
export const ORDER_FILE_NAME = '字序.sxorder'
export const ORDER_FILE_EXTENSION = '.sxorder'
// 改扩展名之前发出去的压缩包里是 字序.json —— 识别端继续认它（旧包与旧纸都不作废）
export const LEGACY_ORDER_FILE_NAME = '字序.json'
// 识别端认的扩展名：.sxorder 是当前的；.json 留给旧包，以及"用户自己改名 / 从别处拷来的副本"（一-18 ②）
export const ORDER_FILE_EXTENSIONS = ['.sxorder', '.json']
// 格式标记与版本：解析时用它俩把"我们的字序文件"与"目录里随便一个 json"区分开
export const ORDER_FILE_FORMAT = 'sxfont-order'
export const ORDER_FILE_VERSION = 1

/**
 * 候选优先级（越小越优先；返回 -1 = 不是字序文件候选）。
 * 次序：当前的固定名 → 别的 .sxorder → 旧的固定名 字序.json → 别的 .json。
 * 为什么还给 .json 留最低一档：改扩展名之前发出去的包、以及用户自己改名 / 从别处拷来的副本，都要能读
 *   —— 真伪最终由文件里的 `format` 标记判定（一-18 ④），扩展名只决定"先试谁"。
 */
export function orderFilePriority(name) {
  const lower = String(name || '').toLowerCase()
  const ext = lower.slice(lower.lastIndexOf('.')).toLowerCase()
  if (lower === ORDER_FILE_NAME.toLowerCase()) return 0
  if (ORDER_FILE_EXTENSIONS.indexOf(ext) < 0) return -1
  if (ext === ORDER_FILE_EXTENSION) return 1
  if (lower === LEGACY_ORDER_FILE_NAME.toLowerCase()) return 2
  return 3
}

/** 按码点数字数（与 lib/charset.js 的 countChars 同口径；这里自带一份，免得把字表数据拖进来） */
export function charCountOf(text) {
  return Array.from(String(text || '')).length
}

/**
 * 本机当天日期戳 `YYYYMMDD`（本地时区）—— 压缩包、包内文件夹与包内 PDF 的文件名都用它（决策 一-17 ④）。
 * 为什么不用 toISOString()：那是 UTC，晚上 8 点之后（北京时间）会得到前一天。
 */
export function dateStamp(date) {
  const d = date instanceof Date ? date : new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate())
}

/**
 * 组装字序文件对象（写进压缩包的那一份）。
 * 唯一必读字段是 chars，其余用于校验与界面显示（决策 一-18 ③）。
 * @param {object} input
 * @param {string[]|string} input.chars 字序（数组或字符串都收）
 * @param {string} input.scope 档位 key：single / common / full / custom
 * @param {string} input.scopeLabel 档位中文名
 * @param {string} input.order 排列方式 key：rank / charset
 * @param {string} input.orderLabel 排列方式中文名
 * @param {number} [input.perPage] 每页格数（默认取版面常量）
 * @param {string} [input.generatedAt] 生成时间（ISO 串）
 *
 * **2026-10-15（页级校验码落地）**：文件里不再带任何校验码 —— 页脚那 12 位改成"每页自证"
 *   （这一页那些字的指纹，见 lib/pageCode.js），字序文件只负责**给字**，不再参与校验。
 *   旧文件里可能还留着 `batchCode` 字段：解析时忽略它（多一个字段不影响），也不再显示。
 */
export function buildOrderFile(input = {}) {
  const chars = Array.isArray(input.chars) ? input.chars.join('') : String(input.chars || '')
  const perPage = Number(input.perPage) || LAYOUT.perPage
  const charCount = charCountOf(chars)
  return {
    format: ORDER_FILE_FORMAT,
    version: ORDER_FILE_VERSION,
    generatedAt: input.generatedAt || new Date().toISOString(),
    scope: input.scope || '',
    scopeLabel: input.scopeLabel || '',
    order: input.order || '',
    orderLabel: input.orderLabel || '',
    perPage,
    pageCount: Math.max(1, Math.ceil(charCount / perPage)),
    charCount,
    chars
  }
}

/** 序列化（缩进 2 空格：用户可能自己打开看，可读性比体积重要） */
export function serializeOrderFile(file) {
  return JSON.stringify(file, null, 2) + '\n'
}

/**
 * 解析字序文件。**校验宁严勿宽**（决策 一-18 ④，沿用 二-6 的口径）：
 * 格式标记不对、版本比程序新、chars 为空、字数与声明不符、每页格数与当前版面不符 —— 一律明确失败。
 * 静默按半份字序识别，比拒绝处理糟得多：那会让每个字都"看着像对上了"，错到成品里才发现。
 * @param {string} text 文件内容
 * @param {{perPage?:number}} [options] 期望的每页格数（传了就校验）
 * @returns {{ok:boolean, reason:string, file:object|null}}
 */
export function parseOrderFile(text, options = {}) {
  const fail = (reason) => ({ ok: false, reason, file: null })
  if (typeof text !== 'string' || !text.trim()) return fail('文件是空的')
  let raw = null
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return fail('不是有效的 JSON 文本')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('内容不是一个对象')
  if (raw.format !== ORDER_FILE_FORMAT) return fail('这不是本程序的字序文件（缺少格式标记）')
  const version = Number(raw.version)
  if (!Number.isFinite(version) || version < 1) return fail('版本号无效')
  if (version > ORDER_FILE_VERSION) return fail('这个字序文件来自更新的程序版本（版本 ' + version + '）')
  if (typeof raw.chars !== 'string' || !raw.chars.length) return fail('字序是空的')
  const charCount = charCountOf(raw.chars)
  if (raw.charCount !== undefined && Number(raw.charCount) !== charCount) {
    return fail('字数与声明不符（声明 ' + raw.charCount + '、实际 ' + charCount + '）')
  }
  const perPage = Number(raw.perPage) || LAYOUT.perPage
  if (options.perPage && perPage !== options.perPage) {
    return fail('每页格数与当前版面不符（文件 ' + perPage + '、版面 ' + options.perPage + '）')
  }
  return {
    ok: true,
    reason: '',
    file: {
      version,
      generatedAt: raw.generatedAt || '',
      scope: raw.scope || '',
      scopeLabel: raw.scopeLabel || '',
      order: raw.order || '',
      orderLabel: raw.orderLabel || '',
      perPage,
      pageCount: Number(raw.pageCount) || Math.max(1, Math.ceil(charCount / perPage)),
      charCount,
      // 旧文件里的 batchCode 字段**忽略**（2026-10-15 起校验码改成每页自证，见文件头）
      chars: raw.chars,
      charList: Array.from(raw.chars)
    }
  }
}

/** 一行中文摘要（第 2 步界面上显示"读到的字序文件是什么"） */
export function describeOrderFile(file) {
  if (!file) return ''
  const parts = []
  if (file.scopeLabel) parts.push(file.scopeLabel)
  if (file.orderLabel) parts.push(file.orderLabel)
  parts.push(file.charCount + ' 字 / ' + file.pageCount + ' 页')
  return parts.join(' · ')
}
