// 生成《使用说明》单文件 HTML（阶段一步骤 1.3 的界面增强：把各步长说明整合成一份可离线阅读的页面）
// 输入：src/lib/guide.js（单一内容源，零依赖数据）
// 产物：public/使用说明.html —— **单文件**：样式内联、没有任何外链（双击可看、可保存到本地、可打印）
// 为什么要生成而不是手写：界面摘要与说明页必须同源，否则改了口径两边会各说各话（与 charset / charRank 同一套路）。
// 运行：npm run guide
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GUIDE_TITLE, GUIDE_SUBTITLE, GUIDE_INTRO, GUIDE_SECTIONS } from '../src/lib/guide.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', '使用说明.html')

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// 只支持一种行内标记：**强调**（其余原样输出，避免把说明页写成模板引擎）
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

function renderItems(items) {
  return items.map((it) => {
    if (it.type === 'p') return '      <p>' + inline(it.text) + '</p>'
    if (it.type === 'note') return '      <p class="note">' + inline(it.text) + '</p>'
    if (it.type === 'ul') return '      <ul>\n' + it.list.map((li) => '        <li>' + inline(li) + '</li>').join('\n') + '\n      </ul>'
    if (it.type === 'ol') return '      <ol>\n' + it.list.map((li) => '        <li>' + inline(li) + '</li>').join('\n') + '\n      </ol>'
    throw new Error('未知的说明条目类型：' + it.type)
  }).join('\n')
}

const toc = GUIDE_SECTIONS.map((s) => '        <li><a href="#' + s.id + '">' + esc(s.no + '、' + s.title) + '</a></li>').join('\n')
const sections = GUIDE_SECTIONS.map((s) => [
  '    <section id="' + s.id + '">',
  '      <h2>' + esc(s.no + '、' + s.title) + '</h2>',
  '      <p class="summary">' + inline(s.summary) + '</p>',
  renderItems(s.items),
  '    </section>'
].join('\n')).join('\n')

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(GUIDE_TITLE)}</title>
<!-- 单文件说明页：样式全部内联，没有外链资源（离线可看、可另存、可直接打印） -->
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px 64px;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    font-size: 14px; line-height: 1.85; color: #1f2933; background: #f6f7f9;
  }
  main { max-width: 820px; margin: 0 auto; background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 28px 32px 36px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { margin: 0 0 6px; font-size: 12px; color: #667180; }
  .intro { margin: 0 0 18px; padding-bottom: 14px; border-bottom: 1px solid #e3e6ea; color: #3d4852; }
  nav { margin: 0 0 24px; padding: 12px 16px; background: #f2f5f8; border-radius: 8px; }
  nav p { margin: 0 0 6px; font-size: 12px; color: #667180; }
  nav ul { margin: 0; padding-left: 20px; }
  nav li { margin: 2px 0; }
  section { margin: 0 0 26px; }
  h2 { font-size: 17px; margin: 0 0 8px; padding-top: 6px; }
  .summary { margin: 0 0 10px; padding: 8px 12px; background: #eef6f7; border-left: 3px solid #2e6e7e; border-radius: 0 6px 6px 0; }
  p { margin: 0 0 10px; }
  ul, ol { margin: 0 0 12px; padding-left: 22px; }
  li { margin: 4px 0; }
  .note { margin: 10px 0; padding: 8px 12px; background: #fdf6e6; border-left: 3px solid #c9a227; border-radius: 0 6px 6px 0; }
  code { font-family: Consolas, "Courier New", monospace; font-size: 13px; background: #f2f5f8; padding: 1px 4px; border-radius: 3px; }
  strong { color: #101820; }
  a { color: #2e6e7e; }
  footer { max-width: 820px; margin: 18px auto 0; font-size: 12px; color: #667180; text-align: center; }
  @media print {
    body { background: #fff; padding: 0; }
    main { border: 0; border-radius: 0; padding: 0; }
    nav { display: none; }
    section { break-inside: avoid; }
  }
</style>
</head>
<body>
  <main>
    <h1>${esc(GUIDE_TITLE)}</h1>
    <p class="sub">${esc(GUIDE_SUBTITLE)}</p>
    <p class="intro">${inline(GUIDE_INTRO)}</p>
    <nav>
      <p>目录</p>
      <ul>
${toc}
      </ul>
    </nav>
${sections}
  </main>
  <footer>本页是单文件说明，可离线保存、可打印；界面每一步只写一句摘要，完整要求以本页为准。</footer>
</body>
</html>
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, html)
const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)
console.log('已生成使用说明：' + OUT)
console.log('  单文件 ' + kb + 'KB，' + GUIDE_SECTIONS.length + ' 节：' + GUIDE_SECTIONS.map((s) => s.no + s.title).join(' / '))
if (/<link|<script|src="http|href="http/i.test(html)) {
  console.error('检测到外链资源，说明页将无法离线打开，已中止')
  process.exit(1)
}
// 产物自检：读回确认没有残留的行内标记
const back = readFileSync(OUT, 'utf8')
if (back.includes('**')) {
  console.error('产物里仍有未渲染的 ** 标记，已中止')
  process.exit(1)
}
console.log('  自检：无外链资源、无残留行内标记')
