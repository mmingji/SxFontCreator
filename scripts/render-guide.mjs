// 《使用说明》单文件 HTML 的**渲染**（纯函数，零依赖 —— 只读 src/lib/guide.js 那份内容源）
// 为什么单独一个模块：它有两个调用方，而两边必须得到**逐字节相同**的结果 ——
//   ① `scripts/build-guide.mjs`（`npm run guide`）：渲染后写 public/使用说明.html；
//   ② `test/guide.mjs`：渲染一遍与落盘产物比对 —— **产物过期（改了内容源却忘了重新生成）当场就红**。
// 为什么要有 ②（2026-10-16 补）：这份产物是**入库**的（不在 .gitignore），而它由内容源生成 ——
//   改 guide.js 忘了跑 `npm run guide` 时，界面上看到的仍是旧说明，而"内容源"那几条断言照样全绿
//   （实测踩到：第四轮收敛改了上传与更正一整节，产物没重生成，直到下一轮重新生成才暴露）。
import { GUIDE_TITLE, GUIDE_SUBTITLE, GUIDE_INTRO, GUIDE_SECTIONS } from '../src/lib/guide.js'

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

/** 渲染整份单文件说明页（样式内联、没有任何外链资源） */
export function renderGuideHtml() {
  const toc = GUIDE_SECTIONS.map((s) => '        <li><a href="#' + s.id + '">' + esc(s.no + '、' + s.title) + '</a></li>').join('\n')
  const sections = GUIDE_SECTIONS.map((s) => [
    '    <section id="' + s.id + '">',
    '      <h2>' + esc(s.no + '、' + s.title) + '</h2>',
    '      <p class="summary">' + inline(s.summary) + '</p>',
    renderItems(s.items),
    '    </section>'
  ].join('\n')).join('\n')

  return `<!DOCTYPE html>
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
  main { max-width: 1200px; margin: 0 auto; background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 28px 32px 36px; }
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
  footer { max-width: 1200px; margin: 18px auto 0; font-size: 12px; color: #667180; text-align: center; }
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
}
