// 参考字字体来源：模板 PDF 里每个字位上方印的那个字用什么字体画
// 两条来源（决策记录 一-11）：
//   ① 内置子集 —— public/fonts/lxgw-wenkai-subset.ttf，霞鹜文楷（OFL-1.1），只含字表 6919 字，零配置可用
//   ② 本机字体文件 —— 用户自己选（如 C:\Windows\Fonts\simkai.ttf），只在本机内存里用，不上传、不入库
// 格式支持（2026-09-29 扩展）：ttf / otf 直接用；ttc 由 fontFormat.js 零依赖提取出单个字体；
//   woff 解包成 sfnt；woff2 明确不支持并给中文提示（见 fontFormat.js 顶部说明与实测结论）。
// 数据去向：字体字节只传给模板生成模块，用于嵌入 PDF；本模块不写任何存储。
import { normalizeFontBytes } from './fontFormat.js'

export const BUILTIN_FONT_URL = './fonts/lxgw-wenkai-subset.ttf'
export const BUILTIN_FONT_LABEL = '内置楷体（霞鹜文楷子集）'

// 填写示意的示范手写体：悠哉字体 Yozai 子集（OFL-1.1，2026-10-07 定案）。
// 为什么单列一条：它只服务第 1 步「填写示意」那一页（在书写格里示范"这个字该怎么写"），
// 与参考字的楷体是两回事 —— 参考字要端正易辨认，示范字要像"人手写出来的样子"。
// 选型依据（覆盖字表 6919 字全中、字号子集 3.84MB）与其余候选的对比见《提交历史》第 59 条。
export const HANDWRITING_FONT_URL = './fonts/yozai-subset.ttf'
export const HANDWRITING_FONT_LABEL = '悠哉字体（手写体子集）'

// 按 URL 取字体字节：两条内置字体走同一条路径，失败时都给出中文原因（原错误码放括号里便于排查）
async function loadFontBytes(url, what) {
  let res
  try {
    res = await fetch(url)
  } catch (e) {
    throw new Error(what + '读取失败：当前打开方式不允许读取本地文件（' + (e && e.message ? e.message : e) + '）')
  }
  if (!res.ok) {
    throw new Error(what + '读取失败：文件缺失或不可读（HTTP ' + res.status + '）')
  }
  const buf = await res.arrayBuffer()
  if (!buf.byteLength) throw new Error(what + '读取失败：文件为空')
  return new Uint8Array(buf)
}

// 读取内置参考字字体子集（霞鹜文楷）
export async function loadBuiltinFont() {
  return loadFontBytes(BUILTIN_FONT_URL, '内置字体')
}

// 读取内置示范手写体子集（悠哉字体）；只给"填写示意"用
export async function loadHandwritingFont() {
  return loadFontBytes(HANDWRITING_FONT_URL, '手写示范字体')
}

/**
 * 读取用户选择的本机字体文件（File 对象），并规整成可嵌入的单个字体
 * @returns {Promise<{bytes: Uint8Array, format: string, label: string, note: string}>}
 *   note 是给用户看的中文说明（如"这个文件是字体集合，含 2 个字体，已取用第 1 个（SimSun）"）
 */
export async function loadFontFromFile(file) {
  if (!file) throw new Error('未选择字体文件')
  const buf = new Uint8Array(await file.arrayBuffer())
  if (!buf.byteLength) throw new Error('字体文件为空：' + file.name)
  try {
    return await normalizeFontBytes(buf)
  } catch (e) {
    // 把文件名补进错误信息，用户一眼知道是哪个文件出的问题
    throw new Error((e && e.message ? e.message : e) + '（文件：' + file.name + '）')
  }
}
