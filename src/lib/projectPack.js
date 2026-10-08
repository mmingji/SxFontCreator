// 项目包：导出 / 导入（阶段三步骤 3.5，口径见《决策记录》五-1 / 五-2 / 五-3 / 五-6）
// 职责：把"当前项目"打成一个压缩包（项目元信息 + 字形掩膜分片 + 一份给人看的说明），以及反过来读回来。
// 为什么这是必须做的一步：数据只在本机浏览器里（file:// 下所有页面还共享同一份存储，决策 六-4），
//   清一次浏览器数据、换一台电脑就全没了 —— 这是整个产品唯一带"数据丢失"性质的风险。
//
// 包内结构（2026-10-07 定稿，决策 五-6）：
//   项目包/
//     project.json          元信息 / 名称表 / 批次 / 进度 / 页记录 / 更正记录 + 字形分片的索引
//     说明.txt              包内是什么、怎么用、原图为什么不在包里（包是拿来救援的，得能看明白）
//     glyphs/<批次id>-P001.json   一页一条 = 一批字形掩膜（结构与 IndexedDB 里的分片一致）
//
// 两条刻意的口径：
//   ① **不含扫描件原图**（决策 五-2 于 2026-10-07 就地修订）：识别是"串行读取 + 立即释放"（决策 二-1），
//      原图从来不落盘；实测每页 8~12MB、51 页约 400~600MB，为归档塞进去不划算 —— 原图用户自己留着。
//   ② **分片照搬落盘格式**（`glyphStore` 的 record 形状），所以导出是"读出来换个容器"、导入是"按原键写回去"，
//      没有第二套转换逻辑，也就没有"导入后字形读不回来"这类静默损坏的空间。
//
// 依赖：只依赖 jszip 与"拿得到分片"的那几个函数 —— 纯逻辑（清单 / 文件名 / 校验 / 说明文案）都能在 Node 里断言，
//   不需要浏览器（见 test/project-pack.mjs）。
import JSZip from 'jszip'
// 字数按码点算（字表里有 196 个扩展 B 区汉字是代理对，用 .length 会虚高）—— 见 lib/charset.js 的 countChars
import { countChars } from './charset.js'

/** 项目包的格式标记与版本：导入时先看这两个字段（格式不对直接拒，版本比本程序新也拒） */
export const PACK_FORMAT = 'sxfont.projectPack'
export const PACK_VERSION = 1

/** 包内固定的文件名与目录（导出与导入共用，避免两处各写一份字符串） */
export const PACK_DIR_PREFIX = '项目包'
export const PACK_MANIFEST = 'project.json'
export const PACK_README = '说明.txt'
export const PACK_GLYPH_DIR = 'glyphs'

// ── 纯逻辑：清单、文件名、说明文案 ────────────────────────────────────────
/** 导出时间戳：YYYYMMDD-HHmm（本地时区，人一眼能看出是哪次导的） */
export function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return p(date.getFullYear(), 4) + p(date.getMonth() + 1) + p(date.getDate()) +
    '-' + p(date.getHours()) + p(date.getMinutes())
}

/**
 * 分片文件名：`<批次id>-P<页序>.json`。
 * 用**批次 id 而不是页号**做主体：页号可能为 null（页脚读不出且还没手选，决策 二-7），
 * 而同批内 fileIndex 必然唯一 —— 这样任一分片都能反推出"该写回哪个键"。
 * 依次追加 `.1` / `.2` 防同一批里有重复的 fileIndex（异常输入也不至于互相覆盖）。
 */
export function shardFileName(batchId, fileIndex, used) {
  const base = (batchId || 'default') + '-P' + String(fileIndex).padStart(3, '0')
  let name = base + '.json'
  let n = 1
  while (used && used.has(name)) name = base + '.' + n++ + '.json'
  if (used) used.add(name)
  return name
}

/**
 * 组装项目清单（project.json 的内容）。
 * @param {object} input
 * @param {object} input.data 要落盘的整份项目数据（store.projectData() 的产物）
 * @param {Array} input.pages 字形分片列表（glyphStore.listGlyphPages() 的产物，含 key 与 count）
 * @param {string} input.appVersion 程序版本（package.json 的 version）
 * @param {Date} [input.date] 导出时间
 */
export function buildProjectManifest({ data, pages = [], appVersion = '', date = new Date() }) {
  const index = {}
  const used = new Set()
  for (const info of pages) {
    const file = PACK_GLYPH_DIR + '/' + shardFileName(info.batchId, info.fileIndex, used)
    index[info.key] = { file, count: info.count || 0, batchId: info.batchId, pageNumber: info.pageNumber, savedAt: info.savedAt }
  }
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    app: 'SxFontCreator',
    appVersion,
    exportedAt: date.toISOString(),
    kind: 'full', // 现在是"整份项目包"；将来若做增量包，导入侧按这个字段分支
    containsScanOriginals: false, // 明确写出来：界面与说明都据此说"原图不在包里"
    glyphIndex: index,
    data
  }
}

/**
 * 把一个分片转成包内文件的内容。
 * 刻意**照搬落盘记录的形状**（key 之外的字段与 IndexedDB 里的一模一样）：一条路径、无转换损失。
 */
export function shardToFile(info, record) {
  return {
    key: info.key,
    batchId: record.batchId,
    fileIndex: record.fileIndex,
    pageNumber: record.pageNumber,
    savedAt: record.savedAt,
    glyphs: record.glyphs || []
  }
}

/**
 * 包内文件 → 落盘记录（导入时直接交给 glyphStore 按 key 写回）。
 * @returns {{ok:boolean, key:string, record:object|null, error:string}}
 */
export function fileToShard(text) {
  let obj = null
  try {
    obj = JSON.parse(text)
  } catch {
    return { ok: false, key: '', record: null, error: '不是有效的 JSON' }
  }
  if (!obj || typeof obj !== 'object') return { ok: false, key: '', record: null, error: '内容不是对象' }
  const key = typeof obj.key === 'string' ? obj.key : ''
  if (!key.startsWith('sxfont.glyphs.')) return { ok: false, key, record: null, error: '缺少分片键（key）或键的格式不对' }
  if (!Array.isArray(obj.glyphs)) return { ok: false, key, record: null, error: '缺少字形数组（glyphs）' }
  return {
    ok: true,
    key,
    record: {
      batchId: obj.batchId || 'default',
      fileIndex: Number.isFinite(obj.fileIndex) ? obj.fileIndex : 0,
      pageNumber: obj.pageNumber === undefined ? null : obj.pageNumber,
      savedAt: obj.savedAt || new Date().toISOString(),
      glyphs: obj.glyphs
    },
    error: ''
  }
}

/** 索引里的路径要待在 `glyphs/` 下、且不含 `..`（包里来的路径不能被当成"往哪写"的依据） */
export function safePackPath(file) {
  if (typeof file !== 'string' || !file) return null
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized.includes('..')) return null
  if (!normalized.startsWith(PACK_GLYPH_DIR + '/')) return null
  if (!normalized.toLowerCase().endsWith('.json')) return null
  return normalized
}

/**
 * 校验读出来的清单：结构不对就明确失败（**绝不在数据存疑时动用户现有的项目** —— 决策 二-6 的同一条口径：
 * 静默拿错数据比拒绝处理糟得多）。
 * @returns {{ok:boolean, problems:Array<string>, manifest:object|null, index:Array<{key:string, file:string, count:number}>}}
 */
export function validateProjectManifest(manifest) {
  const problems = []
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, problems: ['项目包里没有读到可用的 project.json'], manifest: null, index: [] }
  }
  if (manifest.format !== PACK_FORMAT) {
    problems.push('这不是本程序导出的项目包（格式标记为 ' + String(manifest.format) + '）')
  }
  const version = Number(manifest.version)
  if (!Number.isFinite(version)) problems.push('项目包缺少版本号')
  else if (version > PACK_VERSION) problems.push('项目包版本（' + version + '）比当前程序支持的（' + PACK_VERSION + '）新，请用更新的程序打开')

  const data = manifest.data
  if (!data || typeof data !== 'object') problems.push('项目包里没有项目数据（data 段）')
  else {
    for (const field of ['meta', 'selection']) {
      if (!data[field] || typeof data[field] !== 'object') problems.push('项目数据缺少 ' + field + ' 段')
    }
    for (const field of ['batches', 'scan', 'correction']) {
      if (data[field] === undefined || data[field] === null) problems.push('项目数据缺少 ' + field + ' 段')
    }
  }

  const index = []
  const rawIndex = manifest.glyphIndex
  if (rawIndex === undefined || rawIndex === null) problems.push('项目包缺少字形分片索引（glyphIndex）')
  else if (typeof rawIndex !== 'object' || Array.isArray(rawIndex)) problems.push('字形分片索引的格式不对')
  else {
    for (const [key, entry] of Object.entries(rawIndex)) {
      const file = safePackPath(entry && entry.file)
      if (!file) {
        problems.push('分片索引里 ' + key + ' 的路径不合法')
        continue
      }
      index.push({ key, file, count: Number(entry.count) || 0 })
    }
  }
  return { ok: problems.length === 0, problems, manifest, index }
}

/**
 * 包内《说明.txt》：这个包是拿来救援的，得让人（也包括几年后的自己）看明白里面是什么。
 * 纯文本，不受 PDF 那条"只能用字表内的字"的限制。
 */
export function buildProjectReadme(manifest, { data, glyphCount, shardCount } = {}) {
  const meta = (data && data.meta) || {}
  const selection = (data && data.selection) || {}
  const batches = (data && data.batches) || []
  const scan = (data && data.scan) || {}
  const scannedPages = Array.isArray(scan.pages) ? scan.pages.length : 0
  const exported = manifest && manifest.exportedAt ? new Date(manifest.exportedAt) : new Date()
  const when = exported.getFullYear() + '-' + String(exported.getMonth() + 1).padStart(2, '0') + '-' +
    String(exported.getDate()).padStart(2, '0') + ' ' + String(exported.getHours()).padStart(2, '0') + ':' +
    String(exported.getMinutes()).padStart(2, '0')
  return [
    'SxFontCreator 项目包说明',
    '========================================',
    '',
    '导出时间：' + when + (manifest && manifest.appVersion ? '（程序版本 ' + manifest.appVersion + '）' : ''),
    '字体族名：' + (meta.familyName || '（未命名）'),
    '该项目的选字：' + (selection.chars ? countChars(selection.chars) + ' 个字' : '全部 8274 字（未自定义选字）'),
    '批次：' + batches.length + ' 个（其中仍有效 ' + batches.filter((b) => b.status === 'active').length + ' 个）',
    '识别结果：' + scannedPages + ' 页扫描件的记录',
    '字形掩膜：' + (glyphCount || 0) + ' 个字，分 ' + (shardCount || 0) + ' 片',
    '',
    '包内是什么',
    '----------------------------------------',
    '  project.json           项目元信息（名称表字段、选字、批次、识别进度、更正记录）',
    '  glyphs/                字形掩膜，一页一个文件（PNG 无损，导入后可直接重新生成字体）',
    '  说明.txt               本文件',
    '',
    '怎么用',
    '----------------------------------------',
    '在 SxFontCreator 界面右上角点「项目备份」→「导入项目包」→ 选择本 zip。',
    '导入会**整份替换**当前项目（界面会先让你核对包里的内容，确认后才覆盖）。',
    '想直接看包里的东西：用任何解压软件解开即可，project.json 是给人看的 JSON。',
    '',
    '两件要知道的事',
    '----------------------------------------',
    '  1. 包内**不含扫描件原图**：识别时原图是"读完即释放"的，从不落盘。原图请自己留一份',
    '     （纸还在手上，重扫一次也能得到同样的字形）。',
    '  2. 数据只在本机浏览器里：复制程序目录、把程序发给别人都不会带走数据，',
    '     换电脑或清理浏览器数据之前，请先导出本包（右上角「项目备份」）。',
    ''
  ].join('\n')
}

/**
 * 导出：把项目数据与字形分片打成一个 zip。
 * **先逐片读出来、再写 zip**：清单（含分片索引）必须在读完分片之后才定稿 ——
 *   若某个键读不出来就跳过，索引里也绝不能留它，否则包自己"指向一个不存在的文件"，
 *   导入时会在校验阶段被判成损坏（导出与导入的口径必须自洽）。
 * 内存：全部掩膜同时驻留一次（实测全量约 7~14MB），换来的是"先读后写"这一条确定性。
 * @param {object} input
 * @param {object} input.data 项目数据（store.projectData()）
 * @param {Array} input.pages listGlyphPages() 的结果
 * @param {(key:string)=>Promise<object|null>} input.readShard 按 key 读分片记录
 * @param {string} [input.appVersion]
 * @param {string} [input.folder] 包内文件夹名（重名时由调用方加序号，见 choosePackFolder）
 * @param {(percent:number, text:string)=>void} [input.onProgress]
 * @param {Date} [input.date]
 * @returns {Promise<{bytes:Uint8Array, fileName:string, folder:string, glyphCount:number, shardCount:number, skipped:number, manifest:object}>}
 */
export async function packProjectZip({ data, pages = [], readShard, appVersion = '', folder, onProgress, date = new Date() }) {
  const name = folder || choosePackFolder(date)
  const zip = new JSZip()
  const root = zip.folder(name) || zip
  let glyphCount = 0
  let skipped = 0
  const present = []
  for (let i = 0; i < pages.length; i++) {
    const record = await readShard(pages[i].key)
    if (!record) {
      skipped++ // 读不出来的键：不进索引、也不写文件（清单在下一行统一生成）
      continue
    }
    present.push({ info: pages[i], record })
    glyphCount += (record.glyphs || []).length
    if (onProgress) onProgress(Math.round(((i + 1) / Math.max(1, pages.length)) * 80), '正在打包字形（' + (i + 1) + ' / ' + pages.length + ' 页）…')
  }
  const manifest = buildProjectManifest({ data, pages: present.map((p) => p.info), appVersion, date })
  for (const { info, record } of present) {
    root.file(manifest.glyphIndex[info.key].file, JSON.stringify(shardToFile(info, record)))
  }
  root.file(PACK_README, buildProjectReadme(manifest, { data, glyphCount, shardCount: present.length }))
  root.file(PACK_MANIFEST, JSON.stringify(manifest, null, 2))
  const bytes = await zip.generateAsync(
    { type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    (meta) => { if (onProgress) onProgress(80 + Math.round((meta.percent || 0) * 0.2), '正在压缩项目包…') }
  )
  return { bytes, fileName: name + '.zip', folder: name, glyphCount, shardCount: present.length, skipped, manifest }
}

/** 包内文件夹名（也是下载的 zip 名）：同一次导出的两次调用同名，重名由调用方处理 */
export function choosePackFolder(date = new Date()) {
  return 'SxFontCreator-项目备份-' + stamp(date)
}

/**
 * 导入第一步：读包、校验、并把分片**全部读进内存**（返回给界面做预览 + 供第二步落盘）。
 * 为什么第一步就要读分片：**在动用户现有数据之前**必须确认包是完整可用的
 * （引用了不存在的文件、掩膜不是 PNG 这类问题，都要在覆盖之前发现）。
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {(text:string, percent:number)=>void} [onProgress]
 * @returns {Promise<{ok:boolean, problems:Array<string>, manifest:object|null, data:object|null,
 *   shards:Array<{key:string, record:object}>, glyphCount:number, shardCount:number, missing:Array<string>}>}
 */
export async function inspectProjectPack(bytes, onProgress) {
  const fail = (problems, extra = {}) => ({
    ok: false, problems, manifest: null, data: null, shards: [], glyphCount: 0, shardCount: 0, missing: [], ...extra
  })
  if (onProgress) onProgress('正在读取项目包…', 5)
  let zip = null
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch (e) {
    return fail(['这个文件不是压缩包，或者已经损坏（' + (e && e.message ? e.message : e) + '）'])
  }
  // 包内有一个顶层文件夹（导出时建的），先找到 project.json 在哪一层
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
  const manifestName = names.find((n) => n === PACK_MANIFEST || n.endsWith('/' + PACK_MANIFEST))
  if (!manifestName) return fail(['项目包里没有 project.json —— 这不是本程序导出的项目包'])
  let manifest = null
  try {
    manifest = JSON.parse(await zip.file(manifestName).async('string'))
  } catch (e) {
    return fail(['project.json 读不出来（' + (e && e.message ? e.message : e) + '）'])
  }
  const checked = validateProjectManifest(manifest)
  if (!checked.ok) return fail(checked.problems, { manifest: checked.manifest })
  const root = manifestName.slice(0, manifestName.length - PACK_MANIFEST.length) // '' 或 '项目包/'

  const shards = []
  const missing = []
  let glyphCount = 0
  const total = checked.index.length
  for (let i = 0; i < total; i++) {
    const item = checked.index[i]
    const entry = zip.file(root + item.file)
    if (!entry) {
      missing.push(item.file)
      continue
    }
    const parsed = fileToShard(await entry.async('string'))
    if (!parsed.ok) {
      missing.push(item.file + '（' + parsed.error + '）')
      continue
    }
    if (parsed.key !== item.key) {
      missing.push(item.file + '（分片键与索引对不上：' + parsed.key + '）')
      continue
    }
    // 掩膜必须是 PNG data URL：这是"字形能不能读回来"的底线（决策 二-16 的往返无损口径）
    const badGlyph = parsed.record.glyphs.some((g) => !g || typeof g !== 'object' ||
      typeof g.png !== 'string' || !g.png.startsWith('data:image/png;base64,'))
    if (badGlyph) {
      missing.push(item.file + '（字形掩膜不是 PNG）')
      continue
    }
    glyphCount += parsed.record.glyphs.length
    shards.push({ key: parsed.key, record: parsed.record })
    if (onProgress) onProgress('正在校验字形分片…（' + (i + 1) + ' / ' + total + '）', 5 + Math.round(((i + 1) / Math.max(1, total)) * 90))
  }
  const problems = []
  if (missing.length) problems.push('有 ' + missing.length + ' 个字形分片读不出来：' + missing.slice(0, 3).join('、') + (missing.length > 3 ? ' 等' : ''))
  return {
    ok: problems.length === 0,
    problems,
    manifest: checked.manifest,
    data: checked.manifest.data,
    shards,
    glyphCount,
    shardCount: shards.length,
    missing
  }
}

/** 给界面用的包内容摘要（导入前给用户核对，避免"点错了包把项目覆盖掉"） */
export function summarizeProjectPack(inspected) {
  const data = (inspected && inspected.data) || {}
  const meta = data.meta || {}
  const batches = Array.isArray(data.batches) ? data.batches : []
  const scan = data.scan || {}
  const pages = Array.isArray(scan.pages) ? scan.pages : []
  const correction = data.correction || {}
  const selected = data.selection && data.selection.chars ? countChars(data.selection.chars) : 0
  const exportedAt = inspected && inspected.manifest ? inspected.manifest.exportedAt : null
  return {
    familyName: meta.familyName || '（未命名）',
    version: meta.version || '',
    exportedAt,
    selectedChars: selected,
    batches: batches.length,
    activeBatches: batches.filter((b) => b.status === 'active').length,
    scannedPages: pages.length,
    glyphs: (inspected && inspected.glyphCount) || 0,
    shards: (inspected && inspected.shardCount) || 0,
    corrections: Array.isArray(correction.pairs) ? correction.pairs.length : 0,
    correctionConfirmed: !!correction.confirmed,
    containsScanOriginals: !!(inspected && inspected.manifest && inspected.manifest.containsScanOriginals),
    lines: [
      '字体族名：' + (meta.familyName || '（未命名）') + (meta.version ? '（版本 ' + meta.version + '）' : ''),
      '导出时间：' + formatTime(exportedAt),
      '选字：' + (selected ? selected + ' 个字' : '全部 8274 字（未自定义选字）'),
      '批次：' + batches.length + ' 个（仍有效 ' + batches.filter((b) => b.status === 'active').length + ' 个）',
      '识别结果：' + pages.length + ' 页记录',
      '字形掩膜：' + ((inspected && inspected.glyphCount) || 0) + ' 个字 / ' + ((inspected && inspected.shardCount) || 0) + ' 个分片',
      '更正记录：' + (Array.isArray(correction.pairs) ? correction.pairs.length : 0) + ' 对' +
        (correction.confirmed ? '（已确认）' : '')
    ]
  }
}

/** 时间显示：YYYY-MM-DD HH:mm（本地时区）；读不出来就返回"未知" */
export function formatTime(value) {
  if (!value) return '未知'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '未知'
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}
