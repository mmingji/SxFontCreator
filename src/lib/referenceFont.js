// 参考字字体来源：模板 PDF 里每个字位上方印的那个字用什么字体画
// 两条来源（决策记录 一-11）：
//   ① 内置子集 —— public/fonts/lxgw-wenkai-subset.ttf，霞鹜文楷（OFL-1.1），只含字表 6919 字，零配置可用
//   ② 本机字体文件 —— 用户自己选（如 C:\Windows\Fonts\simkai.ttf），只在本机内存里用，不上传、不入库
// 数据去向：字体字节只传给模板生成模块，用于嵌入 PDF；本模块不写任何存储。

export const BUILTIN_FONT_URL = './fonts/lxgw-wenkai-subset.ttf'
export const BUILTIN_FONT_LABEL = '内置楷体（霞鹜文楷子集）'

// 读取内置字体子集；失败时给出中文原因（原错误码放括号里便于排查）
export async function loadBuiltinFont() {
  let res
  try {
    res = await fetch(BUILTIN_FONT_URL)
  } catch (e) {
    throw new Error('内置字体读取失败：当前打开方式不允许读取本地文件（' + (e && e.message ? e.message : e) + '）')
  }
  if (!res.ok) {
    throw new Error('内置字体读取失败：文件缺失或不可读（HTTP ' + res.status + '）')
  }
  const buf = await res.arrayBuffer()
  if (!buf.byteLength) throw new Error('内置字体读取失败：文件为空')
  return new Uint8Array(buf)
}

// 读取用户选择的本机字体文件（File 对象）
export async function loadFontFromFile(file) {
  if (!file) throw new Error('未选择字体文件')
  const buf = await file.arrayBuffer()
  if (!buf.byteLength) throw new Error('字体文件为空：' + file.name)
  // TTF 以 0x00010000 或 'true' 开头；OTF/CFF 为 'OTTO'（pdf-lib 不支持 CFF 子集化，这里提前拦住）
  const tag = new Uint8Array(buf.slice(0, 4))
  const isTto = tag[0] === 0x00 && tag[1] === 0x01 && tag[2] === 0x00 && tag[3] === 0x00
  const isTrue = tag[0] === 0x74 && tag[1] === 0x72 && tag[2] === 0x75 && tag[3] === 0x65
  if (!isTto && !isTrue) {
    throw new Error('只支持 TrueType 字体（.ttf）：' + file.name + ' 不是 TTF，请改用 ttf 文件')
  }
  return new Uint8Array(buf)
}
