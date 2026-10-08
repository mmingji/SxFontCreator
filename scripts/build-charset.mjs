// 生成字表数据（阶段一步骤 1.2；2026-10-08 换成官方口径）
// 职责：读《通用规范汉字表》官方字表（scripts/sources/，已入库）→ 拼上基础字符 169 → 校验规模与重复 → 输出 src/data/charset.js。
//
// 为什么换源：原字表取自做字体网 V4.0 模板的 GBK 字序文件（第三方资料、GBK 字序），
//   用户 2026-10-08 明确两条硬约束 —— 字表不得取自第三方资料、GB2312 这类过时标准不应再出现。
//   新口径（《决策记录》三-1、八-1、八-2；调研见 docs/字表标准与收字口径.md 第七节）：
//   **字表 = 《通用规范汉字表》8105 汉字（官方笔画序）+ 基础字符 169 个**。
//   官方说明第八条：本表字序遵循《GB 13000.1 字符集汉字字序（笔画序）规范》—— 所以源文件的行序就是字序，
//   脚本不做任何重排（重排一次，模板上的页码与格位就全变了）。
//
// 为什么基础字符清单写在脚本里：它是"我们收哪些非汉字字符"的**唯一定义**，必须逐字可审、可 diff；
//   全部按 Unicode 码位定义，不依赖任何第三方字表。清单构成（169 = 95 + 30 + 23 + 21）：
//   ① 半角 ASCII 95（U+0020 空格 ~ U+007E ~）；② 中文标点 30；③ 全角符号 44（全角 ASCII 符号 23 + 常用符号 21）。
//   **不做**全角数字、全角字母（用户 2026-10-08 定），也不做全角空格。
//
// 为什么连空格一起收：模板 PDF 与界面文案要用到半角空格，字体里没有它就会印成方块（《待办与风险清单》四-7 踩过三次）。
//
// 规模不符、序号断档或出现重复字符时**中止写出**：宁可报错，也不要静默产出一份错字表。
// 运行：npm run charset
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'scripts', 'sources', '通用规范汉字表-2013-8105.txt')
const OUT = join(ROOT, 'src', 'data', 'charset.js')
const LINE_SIZE = 100 // 每行字符数：只为便于阅读与 diff，拼接后顺序不变

// 源文件实测规模（2026-10-08 核对：8105 行、序号 1~8105 连续、零重复）
const EXPECT = { han: 8105, l1: 3500, l2: 3000, l3: 1605, base: 169 }

// 汉字码位范围：**必须四个区都算上** —— 官方字表里有 273 个非基本区汉字（扩展 A 区 77 个 +
//   扩展 B 区及以后 196 个，如 「𬉼」U+2C27C）。只认 U+4E00~U+9FFF 会把这 273 字误判成符号，
//   连带把"汉字 8105"的统计与字体构建的字形宽度判据一起算错。
const HAN_RANGES = [
  [0x3400, 0x4dbf], // 扩展 A
  [0x4e00, 0x9fff], // 基本区
  [0xf900, 0xfaff], // 兼容汉字
  [0x20000, 0x3ffff] // 扩展 B ~ F
]
const isHan = (cp) => HAN_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)

// ───────────────────────── 基础字符 169 ─────────────────────────
// 写法约定：每个非 ASCII 字符都写成「字符 + 码位 + 名称」三元组，脚本会逐条断言"字符的码位与写的码位一致"
//   —— 手抄错一个码位会当场中止，而不是静默产出一份对不上的字表。

// ① 半角 ASCII 95 个：U+0020（空格）~ U+007E（~）整段，含 # @ % & 等符号
const ASCII_BASIC = Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i))

// ② 中文标点 30 个（按《标点符号用法》里中文排版最常用的一批；「·」「＿」分别是间隔号与专名号）
const CJK_PUNCT = [
  ['。', 0x3002, '句号'],
  ['？', 0xff1f, '问号'],
  ['！', 0xff01, '叹号'],
  ['，', 0xff0c, '逗号'],
  ['、', 0x3001, '顿号'],
  ['；', 0xff1b, '分号'],
  ['：', 0xff1a, '冒号'],
  ['“', 0x201c, '左双引号'],
  ['”', 0x201d, '右双引号'],
  ['‘', 0x2018, '左单引号'],
  ['’', 0x2019, '右单引号'],
  ['「', 0x300c, '左直角引号'],
  ['」', 0x300d, '右直角引号'],
  ['『', 0x300e, '左双直角引号'],
  ['』', 0x300f, '右双直角引号'],
  ['（', 0xff08, '左圆括号'],
  ['）', 0xff09, '右圆括号'],
  ['〔', 0x3014, '左六角括号'],
  ['〕', 0x3015, '右六角括号'],
  ['【', 0x3010, '左方头括号'],
  ['】', 0x3011, '右方头括号'],
  ['《', 0x300a, '左书名号'],
  ['》', 0x300b, '右书名号'],
  ['〈', 0x3008, '左单书名号'],
  ['〉', 0x3009, '右单书名号'],
  ['—', 0x2014, '破折号'],
  ['…', 0x2026, '省略号'],
  ['～', 0xff5e, '波浪连接号'],
  ['·', 0x00b7, '间隔号'],
  ['＿', 0xff3f, '专名号']
]

// ③-1 全角 ASCII 符号 23 个：全角 ASCII 里除字母数字、以及已并入上面"中文标点"的那些字符
const FULLWIDTH_SYMBOLS = [
  ['＂', 0xff02, '全角双引号'],
  ['＃', 0xff03, '全角井号'],
  ['＄', 0xff04, '全角美元号'],
  ['％', 0xff05, '全角百分号'],
  ['＆', 0xff06, '全角 and 号'],
  ['＇', 0xff07, '全角撇号'],
  ['＊', 0xff0a, '全角星号'],
  ['＋', 0xff0b, '全角加号'],
  ['－', 0xff0d, '全角连字符'],
  ['．', 0xff0e, '全角句点'],
  ['／', 0xff0f, '全角斜杠'],
  ['＜', 0xff1c, '全角小于号'],
  ['＝', 0xff1d, '全角等号'],
  ['＞', 0xff1e, '全角大于号'],
  ['＠', 0xff20, '全角 at 号'],
  ['［', 0xff3b, '全角左方括号'],
  ['＼', 0xff3c, '全角反斜杠'],
  ['］', 0xff3d, '全角右方括号'],
  ['＾', 0xff3e, '全角脱字符'],
  ['｀', 0xff40, '全角重音符'],
  ['｛', 0xff5b, '全角左花括号'],
  ['｜', 0xff5c, '全角竖线'],
  ['｝', 0xff5d, '全角右花括号']
]

// ③-2 常用符号 21 个：货币、度量与排版符号（￥ 是用户点名要的）
const COMMON_SYMBOLS = [
  ['￥', 0xffe5, '全角人民币号'],
  ['€', 0x20ac, '欧元号'],
  ['£', 0x00a3, '英镑号'],
  ['℃', 0x2103, '摄氏度'],
  ['°', 0x00b0, '度'],
  ['±', 0x00b1, '正负号'],
  ['×', 0x00d7, '乘号'],
  ['÷', 0x00f7, '除号'],
  ['§', 0x00a7, '章节号'],
  ['¶', 0x00b6, '段落号'],
  ['※', 0x203b, '参考标记'],
  ['○', 0x25cb, '空心圆'],
  ['●', 0x25cf, '实心圆'],
  ['□', 0x25a1, '空心方框'],
  ['■', 0x25a0, '实心方框'],
  ['△', 0x25b3, '空心三角'],
  ['▲', 0x25b2, '实心三角'],
  ['☆', 0x2606, '空心星'],
  ['★', 0x2605, '实心星'],
  ['→', 0x2192, '右箭头'],
  ['←', 0x2190, '左箭头']
]

function fail(message) {
  console.error('字表校验不通过，已中止写出：' + message)
  process.exit(1)
}

// 逐字校验：数量对得上、每个字符的码位与写的码位一致、单个字符只占一个码点
function verifyRows(rows, expected, label) {
  if (rows.length !== expected) fail(label + '应为 ' + expected + ' 个，实际 ' + rows.length)
  for (const [char, cp, name] of rows) {
    if (Array.from(char).length !== 1) fail(label + '里的「' + char + '」不是单个字符')
    if (char.codePointAt(0) !== cp) {
      fail(label + '里的「' + char + '」码位写成 0x' + cp.toString(16) + '，实际 0x' + char.codePointAt(0).toString(16))
    }
    if (!name) fail(label + '里的「' + char + '」缺名称')
  }
}

if (!existsSync(SOURCE)) {
  console.error('未找到官方字表源文件：' + SOURCE)
  console.error('该文件已入库（scripts/sources/），请确认工作区完整后重跑本脚本。')
  process.exit(1)
}

// ───────────────────────── 读官方字表 ─────────────────────────
// 行格式：序号 + 制表符 + 字 + 制表符 + 拼音（如 `0001	一	yī`）；序号即官方笔画序。
const text = readFileSync(SOURCE, 'utf8')
const rows = text.split(/\r?\n/).filter((line) => line.trim())
if (rows.length !== EXPECT.han) fail('源文件应为 ' + EXPECT.han + ' 行，实际 ' + rows.length)

const hanChars = []
for (let i = 0; i < rows.length; i++) {
  const cells = rows[i].split('\t')
  const no = Number((cells[0] || '').trim())
  const char = (cells[1] || '').trim()
  if (no !== i + 1) fail('第 ' + (i + 1) + ' 行的序号是「' + cells[0] + '」，应为 ' + (i + 1) + '（序号即笔画序，断档会让字序整体错位）')
  if (Array.from(char).length !== 1) fail('第 ' + (i + 1) + ' 行不是单个汉字：' + JSON.stringify(char))
  if (!isHan(char.codePointAt(0))) fail('第 ' + (i + 1) + ' 行的「' + char + '」不在已登记的汉字码位范围内（码位 0x' + char.codePointAt(0).toString(16) + '）')
  hanChars.push(char)
}
if (new Set(hanChars).size !== hanChars.length) fail('官方字表内出现重复字')

// ───────────────────────── 拼基础字符并校验 ─────────────────────────
verifyRows(CJK_PUNCT, 30, '中文标点')
verifyRows(FULLWIDTH_SYMBOLS, 23, '全角 ASCII 符号')
verifyRows(COMMON_SYMBOLS, 21, '常用符号')

const baseChars = [
  ...ASCII_BASIC,
  ...CJK_PUNCT.map((row) => row[0]),
  ...FULLWIDTH_SYMBOLS.map((row) => row[0]),
  ...COMMON_SYMBOLS.map((row) => row[0])
]
if (baseChars.length !== EXPECT.base) fail('基础字符应为 ' + EXPECT.base + ' 个，实际 ' + baseChars.length)
if (new Set(baseChars).size !== baseChars.length) fail('基础字符内出现重复字符')
const hanSet = new Set(hanChars)
const clash = baseChars.filter((ch) => hanSet.has(ch))
if (clash.length) fail('基础字符与汉字重复：' + clash.join(''))

const chars = hanChars.concat(baseChars)
if (chars.length !== EXPECT.han + EXPECT.base) fail('字表总数应为 ' + (EXPECT.han + EXPECT.base) + '，实际 ' + chars.length)
if (new Set(chars).size !== chars.length) fail('字表内出现重复字符')

// 分级：官方顺序切片 —— 1~3500 一级、3501~6500 二级、6501~8105 三级（《通用规范汉字表》说明第二条）
const levels = { l1: EXPECT.l1, l2: EXPECT.l2, l3: EXPECT.l3 }

// 折行成字符串数组再用 join('') 拼回 —— 按**码点**切分，扩展 B 区字符（代理对）不会被切成两半
const lines = []
for (let i = 0; i < chars.length; i += LINE_SIZE) {
  lines.push(chars.slice(i, i + LINE_SIZE).join(''))
}

const body = `// 本文件由 scripts/build-charset.mjs 生成，请勿手改（要改字表就改 scripts/sources/ 里的源文件后重跑 npm run charset）。
// 数据来源：《通用规范汉字表》（国务院 2013 年公布，国发〔2013〕23号）全表 ${EXPECT.han} 字，
//   源文件 scripts/sources/通用规范汉字表-2013-8105.txt（已入库；序号即官方笔画序）。
// 内容：${chars.length} 个字符 = ${EXPECT.han} 汉字（一级 ${levels.l1} + 二级 ${levels.l2} + 三级 ${levels.l3}）
//       + 基础字符 ${EXPECT.base}（半角 ASCII ${ASCII_BASIC.length} + 中文标点 ${CJK_PUNCT.length}
//       + 全角符号 ${FULLWIDTH_SYMBOLS.length + COMMON_SYMBOLS.length}）。
//       顺序即字表字序：**汉字在前（官方笔画序）、基础字符在后**（《决策记录》三-1、八-1、八-2）。
// 用法：见 src/lib/charset.js。

// 按每行 ${LINE_SIZE} 字折行，仅为便于阅读与 diff；join('') 后顺序与源文件一致
const LINES = [
${lines.map((line) => '  ' + JSON.stringify(line)).join(',\n')}
]

export const CHARSET = LINES.join('')

export const CHARSET_META = {
  total: ${chars.length},
  han: ${EXPECT.han},
  base: ${EXPECT.base},
  ascii: ${ASCII_BASIC.length},
  cjkPunct: ${CJK_PUNCT.length},
  fullwidthSymbol: ${FULLWIDTH_SYMBOLS.length + COMMON_SYMBOLS.length},
  // 规范三级（官方说明第二条：一级为常用字集、二级使用度次之、三级为姓氏人名地名与术语等专门领域用字）
  levels: { l1: ${levels.l1}, l2: ${levels.l2}, l3: ${levels.l3} },
  source: '通用规范汉字表-2013-8105.txt（国务院 2013 年公布，国发〔2013〕23号；字序为官方笔画序）'
}
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, body, 'utf8')
console.log('已生成字表：' + OUT)
console.log('  总数 ' + chars.length + '（汉字 ' + EXPECT.han + ' 一级 ' + levels.l1 + ' / 二级 ' + levels.l2 + ' / 三级 ' + levels.l3 +
  '，基础字符 ' + EXPECT.base + '），无重复，共 ' + lines.length + ' 行')
console.log('  每页 ' + 136 + ' 格 → 全量 ' + Math.ceil(chars.length / 136) + ' 页')
