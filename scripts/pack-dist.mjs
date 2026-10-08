// 把 dist/ 打成可分发 zip（阶段三步骤 3.3 的最后一小项）
// 职责：**只打包、不构建** —— 构建由 package.json 的 `pack` 脚本先跑一次，避免把过期的 dist 打进去。
// 输入：dist/（`npm run build` 的产物）
// 产物：release/SxFontCreator-<版本>-便携版.zip —— 解压后是一个同名文件夹，双击其中的 index.html 即用
// 两条命名口径（2026-10-08 定）：
//   ① **zip 里套一层同名文件夹**：解压到桌面时不会散落十来个文件，双击入口也只有一层；
//   ② **名字带版本、不带日期**：版本号已能区分新旧，日期交给文件系统显示，不必在文件名里重复。
// 运行：npm run pack（= build + 本脚本）；测试见 test/pack-dist.mjs
import { existsSync, readdirSync, readFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { DROP_AFTER_BUILD } from '../vite.config.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SELF = fileURLToPath(import.meta.url)
// 包内根目录名与 zip 名共用这一个（两处不一致会让"解压出来叫什么"变得不可预期）
export const PACK_FOLDER_SUFFIX = '便携版'
export const PACK_PREFIX = 'SxFontCreator'

// 递归列出目录下所有文件，相对路径统一用 / 分隔（zip 内部就是这个格式，Windows 的反斜杠会被解压成一层文件名）
function listFiles(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(abs, base))
    else if (entry.isFile()) out.push(relative(base, abs).split(sep).join('/'))
  }
  return out.sort()
}

const mb = (n) => (n / 1024 / 1024).toFixed(1)

// 打包。返回产物信息供命令行打印与测试断言；出错时抛出中文原因（由调用方决定怎么报）
export async function packDist(options = {}) {
  const distDir = options.distDir || join(ROOT, 'dist')
  const outDir = options.outDir || join(ROOT, 'release')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const version = options.version || pkg.version
  const folder = options.folderName || PACK_PREFIX + '-' + version + '-' + PACK_FOLDER_SUFFIX

  if (!existsSync(join(distDir, 'index.html'))) {
    throw new Error('未找到 ' + join(distDir, 'index.html') + '，请先运行 npm run build')
  }

  // 构建收尾会把已内联的文件删掉（vite.config.js 的 DROP_AFTER_BUILD）；
  // 若它们还在，说明这次 dist 来路不对（构建中断、或用了旧的产物目录），
  // 打进去会让交付包白白多约 9MB —— 明确失败，别让"体积翻倍"悄悄发出去。
  const leftovers = DROP_AFTER_BUILD.filter((rel) => existsSync(join(distDir, rel)))
  if (leftovers.length) {
    throw new Error('dist 里仍有已内联的重复文件（' + leftovers.join(' / ') + '）：构建收尾没跑完，请重新运行 npm run build')
  }

  const files = listFiles(distDir)
  if (!files.length) throw new Error('dist 目录里没有任何文件：' + distDir)

  // 包内容 = dist 内容（一一对应，不再额外增删）：这样"包里有什么"永远等于"程序跑起来用到什么"，
  // 也省掉第二套文件清单要维护。文件夹条目由 jszip 自动补。
  const zip = new JSZip()
  const root = zip.folder(folder)
  for (const rel of files) root.file(rel, readFileSync(join(distDir, rel)))

  // 压缩级别用默认的 6：产物大头是 base64 文本，再往上调收益很小、耗时线性增长
  const started = Date.now()
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  const elapsed = Date.now() - started

  mkdirSync(outDir, { recursive: true })
  const zipPath = join(outDir, folder + '.zip')
  writeFileSync(zipPath, bytes)

  const rawBytes = files.reduce((sum, rel) => sum + statSync(join(distDir, rel)).size, 0)
  return { zipPath, folder, files, fileCount: files.length, rawBytes, zipBytes: bytes.length, bytes, elapsed }
}

// 命令行入口：打印中文结果（包内结构 / 体积 / 怎么用）
async function main() {
  try {
    const res = await packDist()
    console.log('已打包：' + res.zipPath)
    console.log('  包内根目录 ' + res.folder + '/，共 ' + res.fileCount + ' 个文件')
    console.log('  原始 ' + mb(res.rawBytes) + 'MB → 压缩后 ' + mb(res.zipBytes) + 'MB（' + res.elapsed + 'ms）')
    console.log('  用法：解压后双击 ' + res.folder + '/index.html 即用（无需安装、无需本地服务）')
  } catch (err) {
    console.error('打包失败：' + err.message)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) await main()
