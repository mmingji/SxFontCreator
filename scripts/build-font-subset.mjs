// 生成内置参考字字体的子集（阶段一步骤 1.3 的依赖）
// 职责：读开源楷体（霞鹜文楷 LXGW WenKai Regular）→ 只保留字表里的 8274 个码位 → 写出到 public/fonts/
// 为什么要预子集：完整字体 24MB，随产品分发太重，而模板只用得到这 8274 个字符（官方 8105 汉字 + 基础字符 169）。
// **这里的回读校验就是"源字体覆盖全字表"的验证装置**（解析落盘产物的 cmap，逐码位确认有有效字形）：
//   换成官方字表后字表里多了 196 个扩展 B 区汉字（代理对）与 169 个基础字符，缺任何一个都会在模板上印成空框。
// 许可证：OFL-1.1 允许再分发与修改（含子集化），要求随附许可文本、不得单独售卖字体本身；
//         字体内部 name 表（版权、字体名）保持原样，不改成别的字体名。
// 源文件不入库（体积大，见 .gitignore 的 .font-sources/），产物入库。
// 运行：npm run font-subset
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import fonteditor from 'fonteditor-core'
import { getAllChars, charToCodePoint } from '../src/lib/charset.js'

const { Font } = fonteditor

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, '.font-sources', 'LXGWWenKai-Regular.ttf')
const OUT_DIR = join(ROOT, 'public', 'fonts')
const OUT = join(OUT_DIR, 'lxgw-wenkai-subset.ttf')
// 子集后必须覆盖的字表码位（缺一个都会让模板上出现空框）
const EXPECT_COUNT = 8274

if (!existsSync(SOURCE)) {
  console.error('未找到字体源文件：' + SOURCE)
  console.error('请先下载霞鹜文楷（OFL-1.1）：')
  console.error('  curl -L -o .font-sources/LXGWWenKai-Regular.ttf \\')
  console.error('    https://github.com/lxgw/LxgwWenKai/releases/download/v1.522/LXGWWenKai-Regular.ttf')
  process.exit(1)
}

const unicodes = getAllChars().map(charToCodePoint)
if (unicodes.length !== EXPECT_COUNT) {
  console.error('字表规模异常（' + unicodes.length + '，预期 ' + EXPECT_COUNT + '），已中止子集化')
  process.exit(1)
}

const sourceStat = statSync(SOURCE)
const raw = readFileSync(SOURCE)
// Buffer → ArrayBuffer（fonteditor 需要 ArrayBuffer 视图）
const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)

// hinting/kerning 都不保留：PDF 里字形由阅读器光栅化，hinting 无用；去掉可显著减小体积
let font
try {
  font = Font.create(ab, { type: 'ttf', subset: unicodes, hinting: false, kerning: false })
} catch (e) {
  console.error('读取或子集化字体失败：' + (e && e.message ? e.message : e))
  process.exit(1)
}

// 字体名与版权信息取自 name 表（下面打印用；子集不修改 name 表，满足 OFL 的保留要求）
const data = font.get()

const outBuffer = Buffer.from(font.write({ type: 'ttf', hinting: false, kerning: false }))
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, outBuffer)

// 回读产物再校验一次：写之前的 font.get() 给的是**源字体**的完整 cmap（4 万多条），
// 拿它判断覆盖情况没有意义；必须校验真正落盘的文件，否则"看起来成功、模板上却是空框"。
const checkRaw = readFileSync(OUT)
const checkAb = checkRaw.buffer.slice(checkRaw.byteOffset, checkRaw.byteOffset + checkRaw.byteLength)
const checkFont = Font.create(checkAb, { type: 'ttf' })
const checkData = checkFont.get()
const cmap = checkData.cmap || {}
const glyphCount = (checkData.glyf || []).length
const badGlyph = []
for (const cp of unicodes) {
  const gid = cmap[String(cp)]
  // cmap 的值是字形序号（glyph id）；0 是 .notdef，等于它是空框
  if (typeof gid !== 'number' || gid <= 0 || gid >= glyphCount) {
    if (badGlyph.length < 10) badGlyph.push('U+' + cp.toString(16).toUpperCase() + '→' + gid)
  }
}
if (badGlyph.length) {
  console.error('子集产物校验失败：' + badGlyph.length + ' 个码位没有有效字形（' + badGlyph.join(' ') + '），已删除产物')
  rmSync(OUT, { force: true })
  process.exit(1)
}

const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB'
const wanted = new Set(unicodes)
const extra = Object.keys(cmap).filter((k) => !wanted.has(Number(k)))
console.log('已生成字体子集：' + OUT)
console.log('  源字体 ' + mb(sourceStat.size) + ' → 子集 ' + mb(outBuffer.length) +
  '（压缩到 ' + Math.round((outBuffer.length / sourceStat.size) * 100) + '%）')
console.log('  回读校验：字形 ' + glyphCount + ' 个，cmap ' + Object.keys(cmap).length +
  ' 项，字表 ' + unicodes.length + ' 个码位全部命中有效字形')
if (extra.length) console.log('  附带保留的码位 ' + extra.length + ' 个（字体自带映射，不影响使用）')
console.log('  字体名（取自源字体 name 表）：' + (data.name && data.name.fontFamily ? data.name.fontFamily : '未读到'))
