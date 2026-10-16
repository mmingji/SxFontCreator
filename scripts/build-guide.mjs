// 生成《使用说明》单文件 HTML（阶段一步骤 1.3 的界面增强：把各步长说明整合成一份可离线阅读的页面）
// 输入：src/lib/guide.js（单一内容源，零依赖数据）→ 渲染在 scripts/render-guide.mjs（**纯函数**，
//   测试也 import 它做"产物与内容源逐字节一致"的断言 —— 见那个文件头写的理由）
// 产物：public/使用说明.html —— **单文件**：样式内联、没有任何外链（双击可看、可保存到本地、可打印）
// 为什么要生成而不是手写：界面摘要与说明页必须同源，否则改了口径两边会各说各话（与 charset / charRank 同一套路）。
// **改完 src/lib/guide.js 必须跑一次 `npm run guide`**（产物是入库文件；忘了跑的话 test:guide 会红）。
// 运行：npm run guide
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GUIDE_SECTIONS } from '../src/lib/guide.js'
import { renderGuideHtml } from './render-guide.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', '使用说明.html')

const html = renderGuideHtml()

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
