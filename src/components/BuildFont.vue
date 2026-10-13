<script setup>
// 第 3 步：生成（原第 5 步「生成字体」+ 第 6 步「下载安装」合并，决策 八-15 ①）
// 职责（**一页到底**，原两步的全部功能都在这里）：
//   ① 名称表字段（决策 四-1：默认值齐全、可在这里改）
//   ② 字形计划与「生成字体」：位图追踪 → 组装 TTF / woff / woff2，进度按字走（全量约 30 秒）
//   ③ 产物信息（体积 / 字形数 / 覆盖字数 / 跳过与缺原料）
//   ④ 网页字体预览（决策 四-8）：不装机也能先看观感，原生未收录的字标出来
//   ⑤ 下载 zip / 单件 / 字形总览图 + 安装与使用说明
//   ⑥ 字形体检与「剔除 / 待重写」清单（决策 四-7、八-8）；体检默认收起，只给一行摘要（八-16 ⑥）
//   ⑦ 两级清空：清空识别结果 / 清空全部数据（决策 五-11，行内确认条 + 标红）
// 与上一步的关系（用户 2026-10-11 口径：**这一步随时可点进来**，但没料时动作不可点）：
//   本页顶部始终显示上一步的状态 —— 没有识别结果、或有被圈字还没确认更正时，"生成字体"不可点并说明原因；
//   字体没生成时，下载区整块给出"先点上面的生成字体"的提示而不是摆一排点不动的按钮。
// 原料来源：优先内存缓存（刚识别完），刷新过页面就从**落盘的掩膜**读回（决策 二-16）——
//   所以"关掉浏览器再回来"也能直接生成字体、也能当场重建一次用于下载，不必重扫。
// 产物字节暂存在内存（lib/buildFont.js），下载按需打包；只把元信息落盘（决策 五-5）。
import { computed, onMounted, ref } from 'vue'
import { useProjectStore } from '../store/project.js'
import { buildFinalGlyphPlan } from '../lib/scanFlow.js'
import { buildFontFromPlan, clearLastBuild, getLastBuild } from '../lib/buildFont.js'
import { buildGuideText, buildPreviewHtml, packFontZip } from '../lib/fontPack.js'
import { downloadBytes, downloadText } from '../lib/download.js'
import { OVERVIEW_DEFAULTS, overviewFileName, renderOverviewPng } from '../lib/glyphOverview.js'
import { clearPageCache } from '../lib/scanCache.js'
import { clearGlyphs } from '../lib/glyphStore.js'
import { releaseAllPreviewFonts } from '../lib/fontPreview.js'
import FontPreview from './FontPreview.vue'

const store = useProjectStore()
const busy = ref(false)
const stage = ref('')
const progress = ref({ done: 0, total: 0 })
const message = ref('')
const messageType = ref('info')

const pages = computed(() => store.scan.pages)
const hasResult = computed(() => pages.value.some((p) => p.ok))
const needsCorrection = computed(() => (store.correction.circled || []).length > 0)
const correctionPending = computed(() => needsCorrection.value && !store.correction.confirmed)
// 字形计划（与识别页同一份纯逻辑）：主区字形 + 更正册覆盖
const plan = computed(() => buildFinalGlyphPlan(pages.value, {
  pairs: store.correction.pairs || [],
  circled: store.correction.circled || []
}))
const canBuild = computed(() => hasResult.value && plan.value.items.length > 0 && !correctionPending.value)
// 上一步的状态（顶部提示与"动作能不能点"共用这一份判断，避免两处各写一套）
const prevStateNote = computed(() => {
  if (!hasResult.value) {
    return '还没有识别结果：先在第 2 步「识别」里选好扫描件所在的文件夹、跑完识别，再回来生成字体。'
  }
  if (plan.value.items.length === 0) {
    return '识别结果里没有可用的字形：回第 2 步看看那一批的失败原因（多半是纸不是本程序模板印的，或打印时没选实际大小）。'
  }
  if (correctionPending.value) {
    return '主区有 ' + (store.correction.circled || []).length +
      ' 个被红笔圈掉的字还没确认更正对应：先在第 2 步的「更正核对」里核对并确认，否则生成出来的字体里这些字仍是写错的那个。'
  }
  return ''
})

const META_FIELDS = [
  { key: 'familyName', label: '字体族名', placeholder: 'SxFontCreator', hint: 'Word / PS 字体列表里的名字' },
  { key: 'fullName', label: '全名', placeholder: '我的手写体 SxFontCreator', hint: '' },
  { key: 'version', label: '版本', placeholder: '1.0', hint: '只写数字与点' },
  { key: 'designer', label: '设计者', placeholder: '（可留空）', hint: '' },
  { key: 'copyright', label: '版权', placeholder: '（留空则自动生成一行）', hint: '' },
  { key: 'licence', label: '许可', placeholder: '（可留空）', hint: '例如：仅限个人使用' },
  { key: 'licenceUrl', label: '许可链接', placeholder: '（可留空）', hint: '' },
  { key: 'description', label: '说明', placeholder: '（可留空）', hint: '' }
]

function setMessage(text, type) {
  message.value = text
  messageType.value = type || 'info'
}

function onMetaChange(key, value) {
  store.setFontMeta({ [key]: value })
  setMessage('已保存名称表字段；改了名称要重新点一次「生成字体」（产物里的 name 表才会跟着变）', 'info')
}

// ── 产物字节：内存里没有就重建（刷新过页面就会走到这里；原料是落盘的掩膜，不必重扫）──
// 为什么用 ref 而不是直接读 getLastBuild()：那份暂存不在响应式系统里，改了界面不会重渲染
const previewBytes = ref(null)
function syncPreviewBytes() {
  const b = getLastBuild()
  previewBytes.value = b && b.ttf ? b.ttf : null
}
onMounted(syncPreviewBytes)

async function ensureBuild() {
  const existing = getLastBuild()
  if (existing && existing.ttf) return existing
  setMessage('内存里没有字体字节（刷新过页面），正在用落盘的掩膜重建一次…', 'info')
  return await build()
}

// ── 生成字体 ──────────────────────────────────────────────────────────────
async function build() {
  if (busy.value) return null
  if (!canBuild.value) {
    setMessage(prevStateNote.value || '还没有可用的字形', 'error')
    return null
  }
  busy.value = true
  progress.value = { done: 0, total: plan.value.items.length }
  const t0 = performance.now()
  try {
    setMessage('正在准备字形原料…', 'info')
    // excluded：被人工剔除的字不进字体（决策 八-8 的"已剔除"），但它们仍在体检清单里显示为"已剔除"，
    // 好让用户看得到、也能恢复
    const built = await buildFontFromPlan({
      items: plan.value.items,
      meta: { ...store.meta },
      batchId: store.scan.batchId,
      // 排除两类字（八-8）：**已剔除**（这个字不要了）与**待重写**（先不进字体、以后补上）——
      // 构建时一视同仁地排除，区别只在清单与提示上（收录数说明会分别写出来）
      excluded: [...store.excludedChars, ...store.rewriteChars],
      woff2WasmUrl: './woff2.wasm',
      onStage: (text) => { stage.value = text },
      onProgress: (done, total) => { progress.value = { done, total } }
    })
    // 覆盖清单：这一套字体到底收了哪些字（preview.html 与使用说明都要用）
    const chars = built.mapping.map((m) => m.char)
    const fromCorrection = plan.value.items.filter((i) => i.source === 'correction').length
    const suspect = store.scanGlyphStats.suspect
    store.setFontResult({
      fileName: built.fileName,
      familyName: built.familyName,
      sizes: {
        ttf: built.ttf.byteLength,
        woff: built.woff ? built.woff.byteLength : 0,
        woff2: built.woff2 ? built.woff2.byteLength : 0
      },
      stats: built.stats,
      coverage: { total: chars.length, fromCorrection, chars },
      skipped: built.skipped.length,
      missing: built.missing.length,
      checkup: built.checkup
    })
    syncPreviewBytes() // 刚生成的字节同时交给网页预览用（先看效果再下载）
    const secs = ((performance.now() - t0) / 1000).toFixed(1)
    const kb = (n) => (n / 1024).toFixed(1) + 'KB'
    const ck = built.checkup && built.checkup.summary
    const checkNote = ck ? '；字形体检：' + (ck.rewrite ? ck.rewrite + ' 个建议重写' : '没有要重写的') +
      (store.excludedCount ? '、已剔除 ' + store.excludedCount + ' 个' : '') : ''
    setMessage('字体已生成：' + chars.length + ' 个字形，TTF ' + kb(built.ttf.byteLength) +
      (built.woff2 ? '、woff2 ' + kb(built.woff2.byteLength) : '（woff2 不可用，已跳过）') +
      '；用时 ' + secs + ' 秒' + checkNote +
      (suspect ? '；这批里有 ' + suspect + ' 个可疑字形（偏淡或写得太小），可以回第 2 步的格级视图逐格看' : '') +
      '。下面的下载区可以取走了', 'done')
    return built
  } catch (e) {
    setMessage('生成失败：' + (e && e.message ? e.message : e), 'error')
    return null
  } finally {
    busy.value = false
    stage.value = ''
    progress.value = { done: 0, total: 0 }
  }
}

// ── 下载（原第 6 步）──────────────────────────────────────────────────────
const font = computed(() => store.font)
const ready = computed(() => font.value.built === true)

// 预览区点「加载预览」：重建一次字节再交给预览（全量约 30 秒，所以做成按钮而不是自动跑）
async function loadPreview() {
  if (busy.value) return
  try {
    await ensureBuild()
    syncPreviewBytes()
  } catch (e) {
    setMessage('重建字体失败：' + (e && e.message ? e.message : e), 'error')
  }
}

// 覆盖情况与缺字说明（使用说明与预览页共用）
function coverageInfo(extra = {}) {
  const suspectNote = store.scanGlyphStats.suspect
    ? '这批里有 ' + store.scanGlyphStats.suspect + ' 个字形被判为可疑（偏淡或写得太小），可以回第 2 步的格级视图逐格看。'
    : ''
  // 被剔除的字要说清"为什么不在里面"（决策 八-8）：不说的话用户会以为字体漏了字
  const excludedNote = store.excludedCount
    ? '其中有 ' + store.excludedCount + ' 个字是你在字形体检里剔除的（' + store.excludedChars.join('、') + '），它们不进字体；要收回请在上面点「恢复」。'
    : ''
  // 待重写的字（八-8 第四态）：与剔除**分开写** —— 一个是"不要了"，一个是"先不进、以后补"
  const rewriteNote = store.rewriteCount
    ? '另有 ' + store.rewriteCount + ' 个字标了待重写（' + store.rewriteChars.join('、') + '），本次也没进字体；等你重写那几页后，用第 2 步的「重传」覆盖即可。'
    : ''
  return {
    total: font.value.coverage ? font.value.coverage.total : 0,
    fromCorrection: font.value.coverage ? font.value.coverage.fromCorrection : 0,
    chars: font.value.coverage ? font.value.coverage.chars : [],
    suspectNote: [suspectNote, excludedNote, rewriteNote].filter(Boolean).join(' '),
    missingNote: extra.missingNote || '',
    ...extra
  }
}

async function downloadZip() {
  if (busy.value) return
  try {
    const built = await ensureBuild()
    if (!built) return
    const coverage = coverageInfo({ missingNote: '想要完整可用，建议先把常用字补齐（前 2000 字覆盖日常语料约 97%）。' })
    const zip = await packFontZip({
      ttf: built.ttf,
      woff: built.woff,
      woff2: built.woff2,
      css: built.css,
      familyName: built.familyName,
      fullName: store.meta.fullName,
      version: store.meta.version,
      designer: store.meta.designer,
      copyright: store.meta.copyright,
      licence: store.meta.licence,
      fileName: built.fileName,
      coverage,
      sampleText: coverage.chars.slice(0, 80).join('')
    })
    downloadBytes(zip, 'SxFontCreator-' + built.fileName + '.zip', 'application/zip')
    setMessage('已下载 zip（' + (zip.byteLength / 1024).toFixed(0) + 'KB）：解压后双击 preview.html 就能看样张，' +
      '装字体请右键 ' + built.fileName + '.ttf → 安装。', 'done')
  } catch (e) {
    setMessage('打包失败：' + (e && e.message ? e.message : e), 'error')
  }
}

async function downloadSingle(kind) {
  if (busy.value) return
  try {
    const built = await ensureBuild()
    if (!built) return
    if (kind === 'ttf') downloadBytes(built.ttf, built.fileName + '.ttf', 'font/ttf')
    else if (kind === 'css') downloadText(built.css, 'font.css', 'text/css;charset=utf-8')
    else if (kind === 'guide') {
      downloadText(buildGuideText({
        familyName: built.familyName, fullName: store.meta.fullName, version: store.meta.version,
        fileName: built.fileName, coverage: coverageInfo({}), designer: store.meta.designer,
        copyright: store.meta.copyright, licence: store.meta.licence
      }), '使用说明.txt')
    } else if (kind === 'preview') {
      downloadText(buildPreviewHtml({
        familyName: built.familyName, fileName: built.fileName,
        coverage: coverageInfo({}), sampleText: coverageInfo({}).chars.slice(0, 80).join(''),
        missingNote: ''
      }), 'preview.html', 'text/html;charset=utf-8')
    }
    setMessage('已开始下载 ' + kind, 'done')
  } catch (e) {
    setMessage('下载失败：' + (e && e.message ? e.message : e), 'error')
  }
}

// ── 字形总览图（阶段三 3.6，版权登记辅助）────────────────────────────────
// 用**生成的字体字节**渲染（FontFace 注册，与网页预览同一条路），好处是图上的字形与产物一致；
// 全量 8274 字 → 331 行（一行 25 字，尺寸由 glyphOverview.js 的版式常量决定），画完再编码 PNG，实测约 1~3 秒。
async function exportOverview() {
  if (busy.value) return
  busy.value = true
  const t0 = performance.now()
  try {
    setMessage('正在准备字体字节…', 'info')
    const built = await ensureBuild()
    if (!built) return
    const chars = (font.value.coverage && font.value.coverage.chars) || []
    if (!chars.length) throw new Error('这套字体还没有收录任何字')
    setMessage('正在画字形总览图（' + chars.length + ' 个字，约 ' +
      Math.ceil(chars.length / OVERVIEW_DEFAULTS.cols) + ' 行）…', 'info')
    const out = await renderOverviewPng({
      fontBytes: built.ttf,
      familyName: font.value.familyName || built.fileName,
      version: store.meta.version,
      chars,
      fromCorrection: font.value.coverage.fromCorrection,
      excluded: store.excludedCount,
      generatedAt: new Date()
    })
    const name = overviewFileName({
      familyName: font.value.familyName || built.fileName,
      version: store.meta.version,
      generatedAt: new Date()
    })
    downloadBytes(await out.blob.arrayBuffer(), name, 'image/png')
    const secs = ((performance.now() - t0) / 1000).toFixed(1)
    setMessage('已导出 ' + name + '（' + out.width + ' × ' + out.height + ' 像素，' +
      out.rows + ' 行，' + (out.blob.size / 1024 / 1024).toFixed(2) + 'MB，用时 ' + secs + ' 秒）。' +
      '图上标了族名、版本、收录字数与生成时间 —— 版权登记时可直接用这份材料。', 'done')
  } catch (e) {
    setMessage('导出总览图失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    busy.value = false
    stage.value = ''
    progress.value = { done: 0, total: 0 }
  }
}

// ── 字形体检清单（决策 四-7 的替代手段：只提示、不改字形；八-8 的"已剔除 / 待重写"在这里处置）──
const checkup = computed(() => store.font.checkup)
const LIST_LIMIT = 40 // 一屏最多列这么多条：全量下可能有几百个字要重写，全铺出来反而看不出重点
// 体检整块**默认收起**，只显示一行摘要（2026-10-12 用户口径，决策 八-16 ⑥）：
// 一屏给到"有没有要处理的"，想看细节再点开。**只在进入本页时收起一次** —— 用户点开之后
// 反复点「生成字体」不该把它又折回去（那会让人以为清单没了）；展开状态不落盘。
const checkupOpen = ref(false)
// 已在重写清单里的字：查的是 **store 的状态**、不是体检快照里的字段 —— 标了 / 移出之后
// computed 立刻重算，不必重跑体检（体检要几秒）
const rewriteSet = computed(() => new Set(store.rewriteChars))
// 体检判"建议重写"、但还没被标进清单、也没被剔除的字（可一键加入重写清单）
const rewriteList = computed(() => ((checkup.value && checkup.value.glyphs) || [])
  .filter((g) => g.needsRewrite && !g.excluded && !rewriteSet.value.has(g.char)))
// 两栏都要排掉"已经进了重写清单"的字（否则同一个字会在原栏与重写清单里各出现一次）——
// 这条是冒烟抓出来的真实缺陷：当初只给"建议重写"加了过滤、漏了"只是留意"
const noteList = computed(() => ((checkup.value && checkup.value.glyphs) || [])
  .filter((g) => !g.needsRewrite && !g.excluded && !rewriteSet.value.has(g.char) && (g.messages || []).length))
const excludedList = computed(() => ((checkup.value && checkup.value.glyphs) || []).filter((g) => g.excluded))
// 重写清单的内容：从体检快照里补出"第几页第几格、为什么"，快照里没有的字（比如换过一批扫描件）就只显示字
const onRewriteList = computed(() => store.rewriteChars.map((char) => {
  const g = ((checkup.value && checkup.value.glyphs) || []).find((x) => x.char === char)
  return {
    char,
    pageNumber: g ? g.pageNumber : null,
    cellIndex: g ? g.cellIndex : null,
    messages: (g && g.messages) || [],
    reason: (store.rewrite[char] && store.rewrite[char].reason) || '标为待重写'
  }
}))
const listSlice = (list) => list.slice(0, LIST_LIMIT)

function excludeGlyph(char) {
  store.setGlyphExcluded(char, true, '字形体检里剔除')
  setMessage('已剔除「' + char + '」：它不进字体，也不计入收录数；下次点「生成字体」生效（要收回就点「恢复」）', 'info')
}
function restoreGlyph(char) {
  store.setGlyphExcluded(char, false)
  setMessage('已恢复「' + char + '」：下次点「生成字体」时它重新进字体', 'info')
}
function restoreAll() {
  const n = store.excludedCount
  store.clearExcluded()
  setMessage(n ? '已恢复全部 ' + n + ' 个被剔除的字；下次点「生成字体」生效' : '没有被剔除的字', 'info')
}

// ── 待重写清单（八-8 的第四态，清单一-12）：与"剔除"的区别必须在文案里说清 ──────────
// 剔除 = 这个字不要了；待重写 = 这次先不进字体、以后补上（清单会一直记着，直到你移出）
function markRewrite(char, reason) {
  store.setGlyphRewrite(char, true, reason)
  setMessage('已把「' + char + '」放进重写清单：它这次不进字体；重写那几页后用第 2 步的「重传」覆盖，再回这里重新生成', 'info')
}
function unmarkRewrite(char) {
  store.setGlyphRewrite(char, false)
  setMessage('已把「' + char + '」移出重写清单：下次点「生成字体」时继续采用现有字形', 'info')
}
function clearRewriteAll() {
  const n = store.rewriteCount
  store.clearRewrite()
  setMessage(n ? '已移出全部 ' + n + ' 个待重写的字（都继续采用现有字形）' : '重写清单本来就是空的', 'info')
}
/**
 * 导出重写清单（按页归组）：拿着它去重写那几页 —— 重写后走第 2 步的「重传这一页」（决策 八-14），
 * 不需要额外的模板或册子（这也是决策 一-6 ①「按清单动态生成更正册」不做之后留下的路径）。
 */
function exportRewriteList() {
  const rows = onRewriteList.value
  if (!rows.length) return
  const byPage = new Map()
  for (const r of rows) {
    const key = r.pageNumber === null ? 0 : r.pageNumber
    if (!byPage.has(key)) byPage.set(key, [])
    byPage.get(key).push(r)
  }
  const lines = []
  lines.push('SxFontCreator 重写清单')
  lines.push('生成时间：' + new Date().toLocaleString('zh-CN'))
  lines.push('待重写 ' + rows.length + ' 个字 —— 它们这次没有进字体。')
  lines.push('')
  lines.push('怎么用：按下表的页号回去重写那几页（写法见《使用说明》「二、书写」）；')
  lines.push('写完后到第 2 步「识别」里找到那一页，点「重传」覆盖识别结果，再回第 3 步点「生成字体」。')
  lines.push('')
  for (const [page, list] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push((page ? '第 ' + page + ' 页' : '页号未知') + '（' + list.length + ' 个字）')
    for (const r of list) {
      // 格号取 1 起（与更正册上印的格号、人的数法一致）
      const where = r.cellIndex === null ? '' : ' 第 ' + (r.cellIndex + 1) + ' 格'
      const why = (r.messages && r.messages.length) ? '：' + r.messages.join('；') : ''
      lines.push('  ' + r.char + where + why)
    }
    lines.push('')
  }
  lines.push('（每格序号从 1 起：一页 136 格，从左到右、从上到下。）')
  downloadText(lines.join('\n'), '重写清单-' + new Date().toISOString().slice(0, 10) + '.txt', 'text/plain;charset=utf-8')
  setMessage('已导出重写清单：' + rows.length + ' 个字，按页归组', 'done')
}

// 剔除了字、或改了名称表之后，之前那份体检快照就与当前状态不一致了（store 会置 checkupStale）
const staleAfterExclude = computed(() => !!checkup.value && store.font.checkupStale)
// 内存里还有没有刚生成的字节（没有就说明刷新过页面，下载会当场重建一次）
const hasMemoryBuild = computed(() => !!getLastBuild())

// 体检摘要那一行（收起时也看得到）：把"要处理几件"说全 —— 建议重写 / 已剔除 / 重写清单 / 只是留意
const checkupSummaryText = computed(() => {
  const ck = checkup.value
  if (!ck) return ''
  const parts = [ck.summary ? ck.summary.message : '']
  if (rewriteList.value.length) parts.push('建议重写 ' + rewriteList.value.length + ' 个')
  if (onRewriteList.value.length) parts.push('重写清单里 ' + onRewriteList.value.length + ' 个')
  if (excludedList.value.length) parts.push('已剔除 ' + excludedList.value.length + ' 个')
  if (noteList.value.length) parts.push('只是留意 ' + noteList.value.length + ' 个')
  return parts.filter(Boolean).join('；')
})

// ── 两级清空（2026-10-12 用户拍板，决策 五-11）──────────────────────────────
// 形态：行内确认条（通用版 四-11：破坏性动作标红、原地行内确认、不用原生 confirm，
// 确认文案要写清"删掉什么、剩什么"）—— 点一下先问一次，说清会删掉什么。
const clearState = ref(null) // null | 'scan' | 'all'
const afterClearAll = ref(false) // 清空全部数据之后：提示刷新一次（读数见 store.clearAllData）
// 两个动作分别会删掉什么、删完剩什么（用户口径：说不清就别做破坏性动作）
const clearConfirmText = computed(() => (clearState.value === 'all'
  ? '「清空全部数据」会删掉：识别结果、字形、更正配对、体检与筛选记录、模板记录、名称表与选字 —— ' +
    '等于回到刚打开软件的状态。本机浏览器里这一份数据会被删除，不能撤销；删完请刷新一次页面。'
  : '「清空识别结果」会删掉：识别结果、落盘的字形、更正配对、体检快照、剔除与待重写清单 —— ' +
    '回到"还没识别"。模板记录与名称表保留（把扫描件文件夹重指一次就能重跑识别）。不能撤销。'))

function askClear(kind) {
  afterClearAll.value = false
  clearState.value = kind
  setMessage('', 'info')
}

/** 释放那些"只活在内存里"的东西：页面缩略图与掩膜缓存、已构建的字体字节、注册进页面的预览字体 */
function releaseMemory() {
  releaseAllPreviewFonts()
  clearLastBuild()
  clearPageCache()
}

async function doClear() {
  const kind = clearState.value
  if (!kind || busy.value) return
  busy.value = true
  try {
    if (kind === 'scan') {
      // store.clearScan() 就是「清空识别结果」的数据层实现：页级记录 + 汇总 + 手选页序 + 更正配对，
      // 外加体检快照、剔除与待重写清单、字体产物元信息（口径见 store.clearScanResults 的注释）
      const removed = store.clearScanResults()
      const glyphRes = await clearGlyphs({}) // 全部字形分片（清空之后旧批次再没有入口可管理）
      releaseMemory()
      syncPreviewBytes()
      setMessage(
        '已清空识别结果：' + removed.pages + ' 页记录' +
        (glyphRes && glyphRes.removed ? '、' + glyphRes.removed + ' 份字形分片' : '') +
        (removed.excluded ? '、' + removed.excluded + ' 个剔除记录' : '') +
        (removed.rewrite ? '、' + removed.rewrite + ' 个待重写字' : '') +
        (removed.hadFont ? '、上一次的字体产物与体检快照' : '') +
        '。模板记录与名称表保留着 —— 到第 2 步把扫描件文件夹重指一次就能重跑识别。',
        'done'
      )
    } else {
      const res = await store.clearAllData()
      releaseMemory()
      syncPreviewBytes()
      if (res.ok) {
        afterClearAll.value = true
        setMessage('已清空全部数据，回到刚打开软件的状态。请刷新一次页面（刷新后就是全新的空项目）。', 'done')
      } else {
        setMessage('清空全部数据失败：' + (res.error || '未知原因') + '。数据可能仍在盘上，请刷新后再试一次。', 'error')
      }
    }
  } catch (e) {
    setMessage('清空失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    busy.value = false
    clearState.value = null
  }
}

// 清空全部数据之后：界面里的 store 已被 $reset、盘上那一份也删了，刷新即回到全新状态
function reloadNow() {
  window.location.reload()
}
</script>

<template>
  <div class="step-body">
    <!-- 上一步的状态（用户口径：这一步随时可进，但要提示上一步状态、对应功能不可点） -->
    <p v-if="prevStateNote" class="step-note" data-role="prev-state">{{ prevStateNote }}</p>

    <!-- ① 字形计划 + 名称表 + 生成。名称表与按钮**始终在**，只是没有料时不可点 ——
         用户口径是"对应功能不可点"，不是"整块消失"（消失会让人以为程序坏了） -->
    <p v-if="hasResult" class="panel-hint" data-role="glyph-plan">
      字形计划：<strong>{{ plan.items.length }}</strong> 个字形（主区 {{ plan.items.length - plan.replaced }} 个，
      更正册覆盖 <strong>{{ plan.replaced }}</strong> 个）；
      这批共写出 {{ store.scanGlyphStats.written }} 格、可疑 {{ store.scanGlyphStats.suspect }} 个。
      <span v-for="(p, i) in plan.problems" :key="'p' + i">{{ p }} </span>
    </p>

    <div class="panel-row">
      <div class="panel-field meta-grid">
        <label v-for="field in META_FIELDS" :key="field.key" class="meta-field">
          <span class="field-label">{{ field.label }}</span>
          <input
            type="text"
            :value="store.meta[field.key]"
            :placeholder="field.placeholder"
            :disabled="busy"
            @change="onMetaChange(field.key, $event.target.value)"
          />
          <span v-if="field.hint" class="panel-hint">{{ field.hint }}</span>
        </label>
      </div>
    </div>

    <div class="panel-actions">
      <button class="primary" data-role="build-font" :disabled="busy || !canBuild" @click="build">生成字体</button>
      <span v-if="busy" class="panel-hint">{{ stage }}（{{ progress.done }} / {{ progress.total }} 个字形）</span>
    </div>
    <p v-if="message" class="panel-message" :class="messageType" data-role="build-message">{{ message }}</p>

    <!-- ② 产物信息 -->
    <div v-if="ready" class="scan-summary" data-role="font-result">
      <p class="panel-hint">
        产物：<strong>{{ font.fileName }}.ttf</strong>
        （TTF {{ (font.sizes.ttf / 1024).toFixed(1) }}KB<span v-if="font.sizes.woff2">、woff2 {{ (font.sizes.woff2 / 1024).toFixed(1) }}KB</span>）；
        收录 <strong>{{ font.coverage.total }}</strong> 个字，其中 {{ font.coverage.fromCorrection }} 个来自更正册；
        跳过 {{ font.skipped }} 个<span v-if="font.missing">、缺原料 {{ font.missing }} 个</span>
      </p>
      <p v-if="!hasMemoryBuild" class="panel-hint">
        字体字节在刷新后不在内存里了 —— 下载时会在打包步骤自动重建一次（约 30 秒），不用重扫。
      </p>
    </div>

    <!-- ③ 下载区：没生成字体时给提示而不是摆一排点不动的按钮 -->
    <p v-if="hasResult && !ready" class="panel-hint" data-role="download-waiting">
      还没有生成字体：点上面的「生成字体」，生成完成后这里会出现下载按钮（zip / 单件 / 字形总览图）。
    </p>

    <template v-if="ready">
      <p class="panel-hint">
        zip 内容：<strong>{{ font.fileName }}.ttf / .woff / .woff2</strong>、<strong>font.css</strong>、
        <strong>使用说明.txt</strong>、<strong>preview.html</strong>（双击看样张）；族名 <strong>{{ font.familyName }}</strong>。
      </p>

      <!-- 网页字体预览（决策 四-8）：用刚生成的字节当场注册，先看效果再下载 -->
      <div class="card nested">
        <h3>这套字体长什么样（网页预览，不装机也能看）</h3>
        <FontPreview
          :bytes="previewBytes"
          :covered-chars="font.coverage ? font.coverage.chars : []"
          :family-name="font.familyName || ''"
          :loading="busy"
          :loading-text="busy ? stage + '（' + progress.done + ' / ' + progress.total + ' 个字形）' : ''"
          @request-bytes="loadPreview"
        />
      </div>

      <div class="panel-actions">
        <button class="primary" data-role="download-zip" :disabled="busy" @click="downloadZip">下载 zip（推荐）</button>
        <button class="text" :disabled="busy" @click="downloadSingle('ttf')">只下载 TTF</button>
        <button class="text" :disabled="busy" @click="downloadSingle('css')">只下载 font.css</button>
        <button class="text" :disabled="busy" @click="downloadSingle('guide')">只下载使用说明.txt</button>
        <button class="text" :disabled="busy" @click="downloadSingle('preview')">只下载 preview.html</button>
        <button class="text" data-role="overview-export" :disabled="busy" @click="exportOverview">导出字形总览图</button>
        <span v-if="busy" class="panel-hint">{{ stage }}（{{ progress.done }} / {{ progress.total }} 个字形）</span>
      </div>

      <p class="panel-hint">
        <strong>字形总览图</strong>：把收录的 {{ font.coverage.total }} 个字排成一张 PNG（约 {{ Math.ceil(font.coverage.total / 25) }} 行），
        标注族名、版本、收录字数与生成时间，可用作<strong>版权登记</strong>材料。
      </p>

      <p class="panel-hint">
        <strong>怎么装</strong>：Windows 右键 <code>{{ font.fileName }}.ttf</code> → 「为所有用户安装」；macOS 双击 → 「安装字体」；
        <strong>装完请重启 Word / PS</strong>。
      </p>
      <p class="panel-hint">
        <strong>怎么用</strong>：Word 里在字体列表选「{{ font.familyName }}」；网页里把 font.css 与字体文件放同一目录即可。
      </p>
    </template>

    <!-- ④ 字形体检（阶段三 3.2，决策 四-7）：只提示、不改字形；处置手段是"剔除"或"重写那一格"。
         放在 ready 分支**之外**：剔除一个字之后 `store.font.built` 会被清掉（提示"要重新生成"），
         如果它在里面，面板会跟着整块消失 —— 那样就看不清单、也没法恢复（实测踩到）。
         2026-10-12（决策 八-16 ⑥）：整块**默认收起**，只显示一行摘要，点开才看清单 -->
    <div v-if="checkup" class="card nested" data-role="glyph-checkup">
      <div class="panel-head">
        <h3>字形体检</h3>
        <span class="panel-hint">只提示、不改字形 —— 字形大小与笔画粗细取决于你的书写</span>
        <button
          type="button"
          class="text"
          data-role="checkup-toggle"
          @click="checkupOpen = !checkupOpen"
        >{{ checkupOpen ? '收起清单' : '看清单' }}</button>
      </div>
      <!-- 摘要那一行：收起时也能一眼看到"有没有要处理的" -->
      <p class="panel-hint" data-role="checkup-summary">{{ checkupSummaryText }}</p>
      <!-- 批量动作留在**摘要行上**（不只在展开的清单里）：已剔除的字要能一键恢复、
           重写清单要能一键导出 / 全部移出 —— 收起状态下也是"一眼看到 + 一步做到"，
           不必为了恢复一个字先把整张清单铺开（冒烟里当场撞到过这个别扭） -->
      <div v-if="excludedList.length || onRewriteList.length" class="panel-actions" data-role="checkup-bulk">
        <button v-if="onRewriteList.length" type="button" class="text" :disabled="busy" data-role="rewrite-export" @click="exportRewriteList">导出重写清单</button>
        <button v-if="onRewriteList.length" type="button" class="text" :disabled="busy" data-role="rewrite-clear" @click="clearRewriteAll">全部移出重写清单</button>
        <button v-if="excludedList.length" type="button" class="text" :disabled="busy" data-role="restore-all" @click="restoreAll">
          恢复全部被剔除的字（{{ excludedList.length }}）
        </button>
      </div>
      <p v-if="staleAfterExclude" class="step-note" data-role="checkup-stale">
        体检之后你剔除过字形（或改过名称表）—— 现在显示的是上一次生成时的清单，
        点上面的「生成字体」重新生成一次即生效。
      </p>

      <template v-if="checkupOpen">
      <div v-if="rewriteList.length" class="checkup-group">
        <p class="panel-hint">
          <strong>建议重写（{{ rewriteList.length }}）</strong>：成字后这些字会明显偏小或不成形。
          <strong>加入重写清单</strong> = 这次先不进字体、以后重写补上；<strong>剔除</strong> = 这个字不要了。
        </p>
        <ul class="checkup-list" data-role="rewrite-list">
          <li v-for="g in listSlice(rewriteList)" :key="'r' + g.char">
            <span class="checkup-char">{{ g.char }}</span>
            <span class="checkup-where">第 {{ g.pageNumber }} 页 · 第 {{ g.cellIndex }} 格</span>
            <span class="checkup-msgs">{{ (g.messages || []).join('；') }}</span>
            <button type="button" class="text" :disabled="busy" data-role="mark-rewrite" @click="markRewrite(g.char, (g.messages || []).join('；'))">加入重写清单</button>
            <button type="button" class="text" :disabled="busy" @click="excludeGlyph(g.char)">剔除这个字</button>
          </li>
        </ul>
        <p v-if="rewriteList.length > LIST_LIMIT" class="panel-hint">
          还有 {{ rewriteList.length - LIST_LIMIT }} 个字没列出来（一屏只列前 {{ LIST_LIMIT }} 个）
        </p>
      </div>
      <p v-else-if="checkup.summary.rewrite === 0" class="panel-message done">
        没有需要重写的字形 —— 这一批可以直接生成字体。
      </p>

      <!-- 重写清单（八-8 第四态，清单一-12）：与上面"建议重写"分开列 ——
           上面那份是**体检建议**（还没决定），这份是**已经决定要重写**的，它们本次不进字体，
           清单一直挂着直到被移出（"移出清单（继续采用）"= 就用现在这个字形，不再等重写） -->
      <div v-if="onRewriteList.length" class="checkup-group" data-role="rewrite-plan">
        <p class="panel-hint">
          <strong>重写清单（{{ onRewriteList.length }}）</strong>：这些字这次不进字体。
          重写完那几页后，用第 2 步的「重传」覆盖，再回这里点「生成字体」。
        </p>
        <ul class="checkup-list" data-role="rewrite-plan-list">
          <li v-for="r in listSlice(onRewriteList)" :key="'w' + r.char">
            <span class="checkup-char">{{ r.char }}</span>
            <span class="checkup-where">{{ r.pageNumber === null ? '页号未知' : '第 ' + r.pageNumber + ' 页 · 第 ' + r.cellIndex + ' 格' }}</span>
            <span class="checkup-msgs">{{ r.messages.length ? r.messages.join('；') : r.reason }}</span>
            <button type="button" class="text" :disabled="busy" data-role="unmark-rewrite" @click="unmarkRewrite(r.char)">移出清单（继续采用）</button>
          </li>
        </ul>
        <p v-if="onRewriteList.length > LIST_LIMIT" class="panel-hint">
          还有 {{ onRewriteList.length - LIST_LIMIT }} 个字没列出来（一屏只列前 {{ LIST_LIMIT }} 个）
        </p>
      </div>

      <div v-if="noteList.length" class="checkup-group">
        <p class="panel-hint">
          <strong>只是留意（{{ noteList.length }}）</strong>：不影响成字，看一眼就行
        </p>
        <ul class="checkup-list" data-role="note-list">
          <li v-for="g in listSlice(noteList)" :key="'n' + g.char">
            <span class="checkup-char">{{ g.char }}</span>
            <span class="checkup-where">第 {{ g.pageNumber }} 页 · 第 {{ g.cellIndex }} 格</span>
            <span class="checkup-msgs">{{ (g.messages || []).join('；') }}</span>
            <!-- 两个动作与「建议重写」那栏保持一致：想重写的字不一定都落在"建议重写"里 -->
            <button type="button" class="text" :disabled="busy" data-role="mark-rewrite" @click="markRewrite(g.char, (g.messages || []).join('；'))">加入重写清单</button>
            <button type="button" class="text" :disabled="busy" @click="excludeGlyph(g.char)">剔除这个字</button>
          </li>
        </ul>
        <p v-if="noteList.length > LIST_LIMIT" class="panel-hint">
          还有 {{ noteList.length - LIST_LIMIT }} 个字没列出来
        </p>
      </div>

      <div v-if="excludedList.length" class="checkup-group">
        <p class="panel-hint">
          <strong>已剔除（{{ excludedList.length }}）</strong>：这些字不进字体、也不计入收录数
          <button type="button" class="text" :disabled="busy" @click="restoreAll">全部恢复</button>
        </p>
        <ul class="checkup-list" data-role="excluded-list">
          <li v-for="g in listSlice(excludedList)" :key="'x' + g.char">
            <span class="checkup-char">{{ g.char }}</span>
            <span class="checkup-msgs">{{ (g.messages || []).join('；') }}</span>
            <button type="button" class="text" :disabled="busy" @click="restoreGlyph(g.char)">恢复</button>
          </li>
        </ul>
        <p class="panel-hint">
          剔除只影响<strong>这一次生成</strong>的字库：想真正补上，还是重写那一格、重新扫这一页（或用更正册覆盖）。
          重新识别之后，剔除记录仍会保留（可在上面「全部恢复」）。
        </p>
      </div>
      </template>
    </div>

     <!-- ⑤ 清理入口（2026-10-12 用户拍板，决策 五-11）：两级清空，都在这一块里。
          起因：去掉「项目备份」「清空项目」两个功能页之后，界面上再没有清理旧数据的入口，
          用户真机上出现"体检信息一直留着、状态自相矛盾"。
          形态沿用通用版 四-11 / 项目 五-8：**行内确认条**（不用原生 confirm）、按钮标红、
          确认文案写清"删掉什么、剩什么" -->
    <div class="card nested danger-zone" data-role="clear-zone">
      <div class="panel-head">
        <h3>清理数据</h3>
        <span class="panel-hint">两个动作都<strong>不能撤销</strong>，会先问一次</span>
      </div>
      <div class="panel-actions">
        <button class="text danger" type="button" data-role="clear-scan-open" :disabled="busy || clearState" @click="askClear('scan')">
          清空识别结果
        </button>
        <button class="text danger" type="button" data-role="clear-all-open" :disabled="busy || clearState" @click="askClear('all')">
          清空全部数据
        </button>
      </div>

      <!-- 行内确认条：说清这一次会删掉什么、以及删完剩什么 -->
      <div v-if="clearState" class="inline-confirm" data-role="clear-confirm">
        <p class="panel-hint" data-role="clear-confirm-text">{{ clearConfirmText }}</p>
        <div class="panel-actions">
          <button class="text danger" type="button" data-role="clear-confirm-yes" :disabled="busy" @click="doClear">
            {{ clearState === 'all' ? '清空全部数据' : '清空识别结果' }}
          </button>
          <button class="text" type="button" data-role="clear-confirm-no" :disabled="busy" @click="clearState = null">取消</button>
        </div>
      </div>
      <!-- 清空全部数据之后要刷新一次才真正回到"刚打开软件"（读数见 store.clearAllData 的注释） -->
      <div v-if="afterClearAll" class="panel-actions">
        <button class="primary" type="button" data-role="reload-now" @click="reloadNow">立即刷新</button>
      </div>
    </div>
  </div>
</template>
