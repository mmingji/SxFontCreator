// 生成"填写示意"用手写体的子集（阶段一步骤 1.3 的界面增强：模板预览旁边那页示意）
// 职责：读开源手写体（悠哉字体 Yozai Regular）→ 只保留字表里的 6919 个码位 → 写出到 public/fonts/
// 为什么要预子集：完整字体 14.88MB，随产品分发太重，而示意页只用得到这 6919 个字（实测子集 3.84MB）。
// 选型依据（2026-10-07）：五款候选里唯一覆盖字表 6919 字全中、且观感最接近日常硬笔手写的一款；
//   其余候选（猫啃硬笔楷书缺 39 个超纲字、钟齐志莽行书与马善政毛笔楷书缺 49 字且毛笔感强）见《提交历史》第 59 条。
// 许可证：OFL-1.1 允许再分发与修改（含子集化），要求随附许可文本、不得单独售卖字体本身；
//         字体内部 name 表（版权、字体名）保持原样，不改用别的字体名（OFL 的保留名称条款）。
// 源文件不入库（体积大，见 .gitignore 的 .font-sources/），产物入库。
// 运行：npm run handwriting-subset
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import fonteditor from 'fonteditor-core'
import { getAllChars, charToCodePoint } from '../src/lib/charset.js'

const { Font } = fonteditor

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, '.font-sources', 'Yozai-Regular.ttf')
const OUT_DIR = join(ROOT, 'public', 'fonts')
const OUT = join(OUT_DIR, 'yozai-subset.ttf')
const EXPECT_COUNT = 6919

if (!existsSync(SOURCE)) {
  console.error('未找到字体源文件：' + SOURCE)
  console.error('请先下载悠哉字体（OFL-1.1）：')
  console.error('  curl -L -o .font-sources/Yozai-Regular.ttf \\')
  console.error('    https://github.com/lxgw/yozai-font/releases/download/v0.868/Yozai-Regular.ttf')
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

// hinting/kerning 都不保留：示意页的字由浏览器光栅化，hinting 无用；去掉可显著减小体积
let font
try {
  font = Font.create(ab, { type: 'ttf', subset: unicodes, hinting: false, kerning: false })
} catch (e) {
  console.error('读取或子集化字体失败：' + (e && e.message ? e.message : e))
  process.exit(1)
}

const data = font.get()
const outBuffer = Buffer.from(font.write({ type: 'ttf', hinting: false, kerning: false }))
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, outBuffer)

// 回读产物再校验：写之前的 font.get() 给的是**源字体**的完整 cmap，拿它判断覆盖没有意义；
// 必须校验真正落盘的文件，否则"看起来成功、示意页上却是空框"。
const checkRaw = readFileSync(OUT)
const checkAb = checkRaw.buffer.slice(checkRaw.byteOffset, checkRaw.byteOffset + checkRaw.byteLength)
const checkData = Font.create(checkAb, { type: 'ttf' }).get()
const cmap = checkData.cmap || {}
const glyphCount = (checkData.glyf || []).length
const badGlyph = []
for (const cp of unicodes) {
  const gid = cmap[String(cp)]
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
console.log('已生成手写体子集：' + OUT)
console.log('  源字体 ' + mb(sourceStat.size) + ' → 子集 ' + mb(outBuffer.length) +
  '（压缩到 ' + Math.round((outBuffer.length / sourceStat.size) * 100) + '%）')
console.log('  回读校验：字形 ' + glyphCount + ' 个，cmap ' + Object.keys(cmap).length +
  ' 项，字表 ' + unicodes.length + ' 个码位全部命中有效字形')
console.log('  字体名（取自源字体 name 表，OFL 要求不改名）：' + (data.name && data.name.fontFamily ? data.name.fontFamily : '未读到'))
