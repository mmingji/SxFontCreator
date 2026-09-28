// 生成字表数据（阶段一步骤 1.2）
// 职责：读做字体网 V4.0 的 GBK 字序文件（GB18030 编码）→ 校验规模 → 输出 src/data/charset.js
// 为什么产物要入库：源文件是第三方资料、在 .gitignore 里（决策记录 三-1），产物入库才能保证
// 任何人 clone 后直接有字表可用；脚本保留下来用于复核，以及将来换字序来源时重新生成。
// 规模不符或出现重复字符时**中止写出**：宁可报错，也不要静默产出一份错字表。
// 运行：node scripts/build-charset.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, '做字体网标准模板V4.0', '做字体网标准模板V4.0.txt')
const OUT = join(ROOT, 'src', 'data', 'charset.js')
const LINE_SIZE = 100 // 每行字符数：只为便于阅读与 diff，拼接后顺序不变

// 源文件实测规模（见《决策记录》三-1）：6919 = 6812 汉字 + 107 个数字/字母/标点
const EXPECT = { total: 6919, han: 6812, symbol: 107 }

if (!existsSync(SOURCE)) {
  console.error('未找到字序源文件：' + SOURCE)
  console.error('该文件属第三方模板资料、不入库；请放回上述路径后重跑本脚本。')
  process.exit(1)
}

// GB18030 解码：TextDecoder 在 Node 18+ 默认带 full-icu，支持 gb18030
const text = new TextDecoder('gb18030').decode(readFileSync(SOURCE)).replace(/\s+/g, '')
const chars = Array.from(text)
const isHan = (c) => {
  const cp = c.codePointAt(0)
  return cp >= 0x4e00 && cp <= 0x9fff
}
const hanCount = chars.filter(isHan).length
const symbolCount = chars.length - hanCount

if (chars.length !== EXPECT.total || hanCount !== EXPECT.han || symbolCount !== EXPECT.symbol) {
  console.error('字表规模与预期不符，已中止写出：')
  console.error(
    '  实际 总数 ' + chars.length + ' / 汉字 ' + hanCount + ' / 符号 ' + symbolCount + '，预期 ' + EXPECT.total + ' / ' + EXPECT.han + ' / ' + EXPECT.symbol
  )
  process.exit(1)
}
const uniqueCount = new Set(chars).size
if (uniqueCount !== chars.length) {
  console.error('字表存在重复字符（' + chars.length + ' 个字符中仅 ' + uniqueCount + ' 个唯一），已中止写出')
  process.exit(1)
}

const lines = []
for (let i = 0; i < chars.length; i += LINE_SIZE) {
  lines.push(chars.slice(i, i + LINE_SIZE).join(''))
}

const body = `// 本文件由 scripts/build-charset.mjs 生成，请勿手改（要改字表就改源文件后重跑脚本）。
// 数据来源：做字体网标准模板V4.0 的 GBK 字序文件（GB18030 编码；第三方资料，不入库）。
// 内容：${EXPECT.total} 个字符 = ${EXPECT.han} 汉字 + ${EXPECT.symbol} 个数字/字母/标点，
//       顺序即模板字序（决策记录 三-1）。
// 用法：见 src/lib/charset.js。

// 按每行 ${LINE_SIZE} 字折行，仅为便于阅读与 diff；join('') 后顺序与源文件一致
const LINES = [
${lines.map((line) => '  ' + JSON.stringify(line)).join(',\n')}
]

export const CHARSET = LINES.join('')

export const CHARSET_META = {
  total: ${EXPECT.total},
  han: ${EXPECT.han},
  symbol: ${EXPECT.symbol},
  source: '做字体网标准模板V4.0.txt'
}
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, body, 'utf8')
console.log('已生成字表：' + OUT)
console.log('  总数 ' + chars.length + '（汉字 ' + hanCount + ' + 符号 ' + symbolCount + '），无重复，共 ' + lines.length + ' 行')
