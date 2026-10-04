// 字体 OS/2 表体检（只读工具，零依赖）
// 职责：把一个 TTF / OTF / TTC 的 OS/2 表关键字段打出来，用来核对"Windows / Word 认不认它当中文字体"。
// 为什么需要它：Word 的「中文字体」下拉看不看得见一个字体，取决于 OS/2 的**代码页位**（清单 三-12），
//   而这两个字段在字体管理界面里看不到；装机复测时（清单 三-4）用它量一下 C:\Windows\Fonts 里那一份，
//   就能分清"是字体字段不对"还是"Word 还没刷新字体列表"。
// 用法：node scripts/inspect-font-os2.mjs <字体文件> [更多文件...]
// 依据：OpenType 规范 OS/2 表的 ulUnicodeRange / ulCodePageRange 位表；对照值取自本机系统中文字体
//   （宋体 0x00040001 / 0x288F0000、黑体与楷体 0x00040001 / 0x38CF7CFA、微软雅黑 0x0004001F / 0x2ACF3C50）。
import { readFileSync, existsSync } from 'node:fs'
import { extractTtcFont } from '../src/lib/fontFormat.js'

// 只列我们关心的位（全表 128 位，其余留空即可；`?` 表示规范里未指派/少见的位）
const UNICODE_BITS = {
  0: '基本拉丁', 1: '拉丁字母补充', 2: '拉丁字母扩展 A', 3: '拉丁字母扩展 B', 9: '西里尔字母',
  31: '常用标点', 32: '上标与下标', 33: '货币符号', 35: '字母式符号', 36: '数字形式', 37: '箭头',
  38: '数学运算符', 42: '带圈字母数字', 43: '制表符', 44: '方块元素', 45: '几何图形', 46: '杂项符号',
  47: '装饰符号', 48: '中日韩符号和标点', 49: '平假名', 50: '片假名', 51: '注音符号',
  54: '中日韩带圈字母与月份', 55: '中日韩兼容字符', 56: '谚文音节', 57: '非基本多文种平面',
  59: 'CJK 统一表意文字', 60: '专用区（PUA）', 61: 'CJK 笔画 / CJK 兼容表意文字',
  62: '字母式展现形式', 63: '阿拉伯文展现形式 A', 68: '半角及全角形式'
}
const CODE_PAGE_BITS = {
  0: '1252 拉丁 1', 1: '1250 拉丁 2', 2: '1251 西里尔', 3: '1253 希腊', 4: '1254 土耳其',
  17: '932 日文', 18: '936 简体中文 GB2312', 19: '949 韩文', 20: '950 繁体中文 Big5', 30: 'OEM'
}
const bits32 = (value) => (value >>> 0).toString(16).padStart(8, '0')

function describe (value, offset, dict) {
  const on = []
  for (let i = 0; i < 32; i++) {
    if ((value >>> i) & 1) on.push((i + offset) + ':' + (dict[i + offset] || '?'))
  }
  return on.length ? on.join('  ') : '（无）'
}

// 按 sfnt 表目录找一张表的偏移（TTC 先取出第 0 个字体）
function findTable (bytes, tag) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const numTables = dv.getUint16(4)
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    const name = String.fromCharCode(dv.getUint8(rec), dv.getUint8(rec + 1), dv.getUint8(rec + 2), dv.getUint8(rec + 3))
    if (name === tag) return dv.getUint32(rec + 8)
  }
  return -1
}

export function inspectOs2 (file) {
  const raw = readFileSync(file)
  let bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  const isTtc = bytes[0] === 0x74 && bytes[1] === 0x74 && bytes[2] === 0x63 && bytes[3] === 0x66
  if (isTtc) bytes = extractTtcFont(bytes, 0)
  const offset = findTable(bytes, 'OS/2')
  if (offset < 0) throw new Error('这个字体没有 OS/2 表（Windows 无法判断它的语言支持）')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (d) => dv.getUint16(offset + d)
  const i16 = (d) => dv.getInt16(offset + d)
  const u32 = (d) => dv.getUint32(offset + d)
  const fields = {
    isTtc,
    version: u16(0),
    usWeightClass: u16(4),
    fsSelection: u16(62),
    ulUnicodeRange1: u32(42),
    ulUnicodeRange2: u32(46),
    ulUnicodeRange3: u32(50),
    ulUnicodeRange4: u32(54),
    ulCodePageRange1: u32(78),
    ulCodePageRange2: u32(82),
    usWinAscent: u16(74),
    usWinDescent: u16(76),
    sTypoAscender: i16(68),
    sTypoDescender: i16(70),
    sTypoLineGap: i16(72)
  }
  // 结论（只说这一轮关心的两件事：判不判成中文字体、字段合不合规）
  fields.chineseByCodePage = (fields.ulCodePageRange1 & (1 << 18)) !== 0
  fields.cjkIdeographs = (fields.ulUnicodeRange2 & (1 << 27)) !== 0
  fields.weightValid = fields.usWeightClass >= 100 && fields.usWeightClass <= 900
  fields.regularFlag = (fields.fsSelection & 0x40) !== 0 && (fields.fsSelection & 0x100) === 0
  return fields
}

function printOne (file) {
  if (!existsSync(file)) {
    console.log(file + '：文件不存在')
    return
  }
  const f = inspectOs2(file)
  console.log('\n=== ' + file + (f.isTtc ? '（TTC，取第 1 个字体）' : ''))
  console.log('  OS/2 版本            = ' + f.version)
  console.log('  usWeightClass 字重级  = ' + f.usWeightClass + (f.weightValid ? '（合规）' : '（**非法**：规范要求 100~900）'))
  console.log('  fsSelection 选择标志  = 0x' + f.fsSelection.toString(16).padStart(4, '0') +
    ((f.fsSelection & 0x40) ? '（含 REGULAR 常规体）' : '（**缺 REGULAR 位**）') +
    ((f.fsSelection & 0x80) ? '（含 USE_TYPO_METRICS：行距按 sTypo 值算）' : ''))
  console.log('  ulCodePageRange1     = 0x' + bits32(f.ulCodePageRange1) + '  ' + describe(f.ulCodePageRange1, 0, CODE_PAGE_BITS))
  console.log('  ulUnicodeRange1      = 0x' + bits32(f.ulUnicodeRange1) + '  ' + describe(f.ulUnicodeRange1, 0, UNICODE_BITS))
  console.log('  ulUnicodeRange2      = 0x' + bits32(f.ulUnicodeRange2) + '  ' + describe(f.ulUnicodeRange2, 32, UNICODE_BITS))
  console.log('  ulUnicodeRange3      = 0x' + bits32(f.ulUnicodeRange3) + '  ' + describe(f.ulUnicodeRange3, 64, UNICODE_BITS))
  console.log('  ulUnicodeRange4      = 0x' + bits32(f.ulUnicodeRange4) + '  ' + describe(f.ulUnicodeRange4, 96, UNICODE_BITS))
  console.log('  垂直度量              = usWin ' + f.usWinAscent + ' / ' + f.usWinDescent +
    '，sTypo ' + f.sTypoAscender + ' / ' + f.sTypoDescender + '，行距 ' + f.sTypoLineGap)
  console.log('  结论                  = ' + (f.chineseByCodePage ? '声明了 936 简体中文 ✓' : '**没有声明简体中文代码页（Word 的「中文字体」列表多半看不见它）**') +
    '；' + (f.cjkIdeographs ? '声明了 CJK 统一表意文字 ✓' : '**缺 CJK 统一表意文字位**'))
}

// 直接运行时才打印（被 import 时只导出函数）
if (process.argv[1] && process.argv[1].endsWith('inspect-font-os2.mjs')) {
  const files = process.argv.slice(2)
  if (!files.length) {
    console.log('用法：node scripts/inspect-font-os2.mjs <字体文件> [更多文件...]')
    console.log('例：  node scripts/inspect-font-os2.mjs docs/samples/SxFontCreator-sample.ttf')
    console.log('      node scripts/inspect-font-os2.mjs C:\\Windows\\Fonts\\simsun.ttc')
    process.exit(1)
  }
  for (const file of files) printOne(file)
}
