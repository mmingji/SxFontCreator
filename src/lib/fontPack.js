// 字体产物打包（阶段一步骤 1.10）
// 职责：把构建出来的字体组装成一个 zip：字体文件（TTF / woff / woff2）+ font.css + 使用说明.txt +
//   一个**可双击打开的样张预览页**（用这套字体渲染一段文字，并列出收录了哪些字、还缺哪些常用字）。
// 为什么单独成模块、且**只依赖 jszip**：这条链路是"拿字节 → 打包"，不碰 fonteditor / potrace，
//   因此可以在 Node 里直接断言 zip 内容（见 test/font-pack.mjs），不必拖进浏览器跑一遍。
import JSZip from 'jszip'

// 使用说明的正文（纯文本 → 不受 PDF 那个"字表内字符"的限制，可以正常写冒号、括号与英文）
// `hasWoff2`（2026-10-18）：包内文件清单要按**实际打进去的文件**列 —— woff2 编码失败时包里没有它，
//   清单里就不该出现（否则用户按清单找一个不存在的文件，见 font.css 里同一条口径）
export function buildGuideText({ familyName, fullName, version, fileName, coverage, missingNote, designer, copyright, licence, hasWoff2 = true }) {
  const lines = [
    'SxFontCreator 手写体使用说明',
    '========================================',
    '',
    '字体族名：' + familyName,
    fullName && fullName !== familyName ? '全名：' + fullName : '',
    '版本：' + version,
    designer ? '设计者：' + designer : '',
    copyright ? '版权：' + copyright : '',
    licence ? '许可：' + licence : '',
    '',
    '包内文件',
    '----------------------------------------',
    '  ' + fileName + '.ttf    安装到系统用（Windows / macOS 双击或右键安装）',
    hasWoff2 ? '  ' + fileName + '.woff2  网页用（体积最小，现代浏览器）' : '',
    '  ' + fileName + '.woff   网页用（兼容旧浏览器）',
    '  font.css                网页引用用的 @font-face 片段',
    '  preview.html            样张预览（双击就能看，右侧字体文件要放在同一目录）',
    '',
    '怎么安装',
    '----------------------------------------',
    'Windows：右键 ' + fileName + '.ttf → 「为所有用户安装」（或复制到 C:\\Windows\\Fonts）',
    'macOS  ：双击 ' + fileName + '.ttf → 点「安装字体」',
    '装完请重启 Word / Photoshop：它们只在启动时读一次字体列表。',
    '',
    '怎么用',
    '----------------------------------------',
    'Word：在「开始 → 字体」里选「' + familyName + '」；找不到就确认装好并重启过 Word。',
    'Photoshop：先用文字工具打字，再全选文字、在字体列表里选「' + familyName + '」—— 直接在选项栏',
    '           选了字体再输入不生效（出来的还是默认字体的样子），选中已有文字再选一次即可。',
    '网页：把 font.css 与字体文件放同一目录，然后',
    '      <link rel="stylesheet" href="./font.css">',
    '      body { font-family: "' + familyName + '", sans-serif; }',
    '',
    '这套字体收录了什么',
    '----------------------------------------',
    '收录 ' + coverage.total + ' 个字（其中 ' + coverage.fromCorrection + ' 个来自更正册覆盖）。',
    '另外附带一个空格字形（宽度 0.3 个汉字，空轮廓）—— 打空格不必再回退到别的字体。',
    coverage.suspectNote ? coverage.suspectNote : '',
    missingNote ? missingNote : '',
    '完整的收录清单见 preview.html（或直接把字体装进系统，在字符映射表里看）。',
    '',
    '注意',
    '----------------------------------------',
    '没写的字在 Word、Photoshop 与浏览器里都会回退成系统字体 —— 想要一套完整可用的字体，',
    '建议先把常用字补齐（前 2000 字覆盖日常语料约 97%，见产品界面里的说明）。',
    'Photoshop 注意：这套字体没有拉丁字母，输入中文时输入法先把拼音字母上屏，这些字母不在字体里，',
    '会触发「字形保护」把整个文字图层换成系统字体（等汉字上屏已经是系统字体了）；新建文字图层默认预置的',
    '占位文本（Lorem Ipsum）同样会触发。做法：先打字再全选文字换一次字体，或在 首选项 → 文字 里',
    '关掉「用占位文本填充新文字图层」。',
    '字体的观感取决于书写：居中书写、别出格、大小匀称（笔画多的字撑满格，天生小的字居中写小），成品的字距与字重才稳定。',
    ''
  ]
  return lines.filter((l) => l !== '').join('\n')
}

// 样张预览页：自包含（默认只引用同目录的字体文件，双击即可看）
// `fontDataUrl`（2026-10-15 新增）：把字体字节**内联**进页面（base64 data URL）——
//   给"在新标签页里查看网页预览"用：那条路没有"同目录的字体文件"可引用（file:// 下 fetch 也被拦），
//   不内联就只能看到回退后的系统字体，等于没预览。zip 里那一份仍走外链（体积小、可替换）。
// `hasWoff2`（2026-10-18）：外链那一份按包里**实际有的文件**写 src（woff2 可能没生成出来，
//   见 buildFontCss 的同一条口径）；内联那一份只有一个 data URL，与它无关。
export function buildPreviewHtml({ familyName, fileName, coverage, sampleText, missingNote, fontDataUrl = '', hasWoff2 = true }) {
  const list = (coverage.chars || []).join('')
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const fontSrc = fontDataUrl
    ? "src: url('" + fontDataUrl + "') format('truetype');"
    : (hasWoff2 ? "src: url('./" + esc(fileName) + ".woff2') format('woff2'),\n         " : 'src: ') +
      "url('./" + esc(fileName) + ".woff') format('woff'),\n         url('./" + esc(fileName) + ".ttf') format('truetype');"
  const subNote = fontDataUrl
    ? '用这套手写体渲染的样张 —— 字体字节已经内联在这一页里，换台机器打开也是这个样子；共收录 ' + coverage.total + ' 个字。'
    : '用这套手写体渲染的样张 —— 字体文件与本源张放在同一目录即可正常显示；共收录 ' + coverage.total + ' 个字。'
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${esc(familyName)} 样张预览</title>
<style>
  /* 用这套字体渲染（zip 里那一份引用同目录字体文件；"在新标签页查看"那一份把字节内联进来） */
  @font-face {
    font-family: '${esc(familyName)}';
    ${fontSrc}
  }
  body { margin: 0; padding: 24px 28px; font-family: -apple-system, "Microsoft YaHei", sans-serif; color: #1f2329; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .sub { font-size: 12px; color: #6b7280; margin: 0 0 18px; }
  .sample { font-family: '${esc(familyName)}', sans-serif; font-size: 40px; line-height: 1.7; margin: 0 0 6px; }
  .sample-small { font-family: '${esc(familyName)}', sans-serif; font-size: 20px; line-height: 1.9; margin: 0 0 20px; }
  h2 { font-size: 13px; margin: 22px 0 8px; color: #374151; }
  .cover { font-family: '${esc(familyName)}', sans-serif; font-size: 22px; line-height: 1.8; word-break: break-all; border: 1px solid #e4e7ee; border-radius: 10px; padding: 12px; }
  .note { font-size: 12px; color: #6b7280; line-height: 1.8; }
  code { background: #f4f5f8; padding: 1px 4px; border-radius: 4px; }
</style>
</head>
<body>
  <h1>${esc(familyName)}</h1>
  <p class="sub">${esc(subNote)}</p>

  <h2>样张（大字）</h2>
  <p class="sample">${esc(sampleText)}</p>
  <h2>样张（小字，接近正文大小）</h2>
  <p class="sample-small">${esc(sampleText)}</p>

  <h2>收录的字（${coverage.total} 个${coverage.fromCorrection ? '，其中 ' + coverage.fromCorrection + ' 个来自更正册' : ''}）</h2>
  <p class="cover">${esc(list)}</p>

  <p class="note">
    没写的字不会出现在上面这串里 —— 它们在这套字体里没有字形，Word、Photoshop 与浏览器都会回退成系统字体。
    ${missingNote ? esc(missingNote) : ''}
  </p>
  <p class="note">
    安装：右键或双击包内的 <code>${esc(fileName)}.ttf</code>；网页引用见 <code>font.css</code>；完整说明见 <code>使用说明.txt</code>。
  </p>
</body>
</html>
`
}

/**
 * 打包成 zip。
 * @param {object} input
 * @param {Uint8Array|ArrayBuffer} input.ttf / woff / woff2 字体字节（woff2 允许为 null）
 * @param {string} input.css @font-face 片段
 * @param {string} input.familyName 族名
 * @param {string} input.fileName PostScript 名（文件名主干）
 * @param {object} input.coverage `{ total, fromCorrection, chars:[], suspectNote, missingNote }`
 * @param {string} input.sampleText 样张文字
 * @returns {Promise<Uint8Array>} zip 字节
 */
/**
 * zip 条目的时间：**把本地时间伪装成 UTC**。
 * 为什么（2026-10-22 用户实测发现）：JSZip 写 DOS 时间用的是 `date.getUTCHours()`（见
 *   `node_modules/jszip/lib/generate/ZipFileWorker.js`），而 zip 的 DOS 时间字段没有时区概念、
 *   解压工具按**本地时间**读。中国时区（UTC+8）下直接用 `new Date()` 会让包内文件时间比实际早 8 小时 ——
 *   用户 21:50 生成的字体，解压后显示 13:50，排查时被误当成"旧字体"（这次就踩了）。
 * 做法：把时刻加回 `getTimezoneOffset()` 的偏移，让 `getUTCHours()` 正好等于本地小时。
 */
function zipDate(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
}

export async function packFontZip(input) {
  const zip = new JSZip()
  const folder = zip.folder(input.fileName) || zip
  const date = zipDate()
  folder.file(input.fileName + '.ttf', input.ttf, { date })
  if (input.woff) folder.file(input.fileName + '.woff', input.woff, { date })
  if (input.woff2) folder.file(input.fileName + '.woff2', input.woff2, { date })
  folder.file('font.css', input.css, { date })
  folder.file('使用说明.txt', buildGuideText({
    familyName: input.familyName,
    fullName: input.fullName,
    version: input.version || '1.0',
    fileName: input.fileName,
    coverage: input.coverage,
    missingNote: input.coverage.missingNote,
    designer: input.designer,
    copyright: input.copyright,
    licence: input.licence,
    // 说明里的"包内文件"清单要与实际打进 zip 的一致（woff2 可能是没有的）
    hasWoff2: !!input.woff2
  }), { date })
  folder.file('preview.html', buildPreviewHtml({
    familyName: input.familyName,
    fileName: input.fileName,
    coverage: input.coverage,
    sampleText: input.sampleText,
    missingNote: input.coverage.missingNote,
    hasWoff2: !!input.woff2
  }), { date })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}

/** zip 里的文件清单（测试与界面提示共用，避免两处写死同一份名单） */
export const PACK_ENTRIES = ['ttf', 'woff', 'woff2', 'font.css', '使用说明.txt', 'preview.html']
