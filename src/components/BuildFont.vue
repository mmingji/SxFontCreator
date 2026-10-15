<script setup>
// 第 3 步：生成（原第 5 步「生成字体」+ 第 6 步「下载安装」合并，决策 八-15 ①）
// 职责（**一页到底**，原两步的全部功能都在这里）：
//   ① 名称表字段（决策 四-1：默认值齐全、可在这里改）
//   ② 字形计划与「生成字体」：位图追踪 → 组装 TTF / woff / woff2，进度按字走（全量约 30 秒）
//   ③ 产物信息（体积 / 字形数 / 覆盖字数 / 跳过与缺原料）
//   ④ 网页字体预览（决策 四-8）：不装机也能先看观感，原生未收录的字标出来
//   ⑤ 下载 zip / 单件 / 字形总览图 + 安装与使用说明
//   ⑥ 字形体检与「剔除 / 待重写」清单（决策 四-7、八-8）；体检默认收起，只给一行摘要（八-16 ⑥）
//   ⑦ 「重新生成」：生成之后**回到点了生成字体之前**（2026-10-13 用户口径；原来这里还有一块
//      「清理数据」两级清空，按用户要求去掉了 —— 清空识别结果在第 2 步有「清空结果」那个入口）
// 与上一步的关系（用户 2026-10-11 口径：**这一步随时可点进来**，但没料时动作不可点）：
//   本页顶部始终显示上一步的状态 —— 没有识别结果、或有被圈字还没确认更正时，"生成字体"不可点并说明原因；
//   字体没生成时，下载区整块给出"先点上面的生成字体"的提示而不是摆一排点不动的按钮。
// 原料来源：优先内存缓存（刚识别完），刷新过页面就从**落盘的掩膜**读回（决策 二-16）——
//   所以"关掉浏览器再回来"也能直接生成字体、也能当场重建一次用于下载，不必重扫。
// 产物字节暂存在内存（lib/buildFont.js），下载按需打包；只把元信息落盘（决策 五-5）。
import { computed, onMounted, ref, watch } from 'vue'
import { useProjectStore } from '../store/project.js'
import { buildFinalGlyphPlan } from '../lib/scanFlow.js'
import { buildFontFromPlan, clearLastBuild, getLastBuild } from '../lib/buildFont.js'
import { buildPreviewHtml, packFontZip } from '../lib/fontPack.js'
import { downloadBytes } from '../lib/download.js'
import { OVERVIEW_DEFAULTS, overviewFileName, renderOverviewPng } from '../lib/glyphOverview.js'
import { openBlobInNewTab } from '../lib/openBlob.js'
import { clearScanDirHandle } from '../lib/scanDirHandle.js'
import { loadBuiltinFont } from '../lib/referenceFont.js'
import { buildTemplatePdf } from '../lib/templatePdf.js'
import { dateStamp } from '../lib/orderFile.js'
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
// 字形计划（与识别页同一份纯逻辑）：主区字形 + 更正册覆盖
const plan = computed(() => buildFinalGlyphPlan(pages.value, {
  pairs: store.correction.pairs || [],
  circled: store.correction.circled || []
}))
const canBuild = computed(() => hasResult.value && plan.value.items.length > 0)
// 上一步的状态（顶部提示与"动作能不能点"共用这一份判断，避免两处各写一套）
const prevStateNote = computed(() => {
  if (!hasResult.value) {
    return '还没有识别结果：先在第 2 步「识别」里选好扫描件所在的文件夹、跑完识别，再回来生成字体。'
  }
  if (plan.value.items.length === 0) {
    return '识别结果里没有可用的字形：回第 2 步看看那一批的失败原因（多半是纸不是本程序模板印的，或打印时没选实际大小）。'
  }
  // 2026-10-13 用户口径：原来这里还有一句"主区有 N 个被红笔圈掉的字：更正册能对上的字用更正册的字形…
  //   （要改就去第 2 步的「更正核对」逐行改派或删除）"—— 与下面的「字形计划」行说的是同一件事，去掉
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
  // 2026-10-15 用户口径：这里**不再写"内存里没有字体字节（刷新过页面），正在用落盘的掩膜重建一次…"**——
  //   「字体预览」区已经把那件事说清并给了「加载预览」按钮，同一个事实说两遍只会让人以为出错了；
  //   而用户点的明明是"查看字形总览 / 查看网页预览"，弹出一句与按钮无关的重建说明更困惑。
  //   重建本身仍有反馈：调用方会报"正在画字形总览图（…）/ 正在准备网页预览…"，按钮旁的阶段文字也在走。
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
    // 2026-10-15 用户口径：不再往消息行里写"正在准备字形原料…"这类过程话 ——
    //   按钮旁的进度文字（`stage` + 计数）已经把"在做什么、到哪了"说清了，消息行只留结论与错误
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
    // 2026-10-13：这里改取 `plan.replaced`（**按不同的字**计数），不再用"items 里 correction 项的条数"——
    //   后者在"同一个字被圈了多处、或有重复页"时会把同一个字算好几遍，于是第 2 步说"覆盖 9 处（4 个字）"、
    //   这里却说别的数，界面上两个数字打架（用户真机问的正是这条）。口径统一到"不同的字"。
    const fromCorrection = plan.value.replaced
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
    setMessage('字体已生成：' + chars.length + ' 个字形' +
      (plan.value.replaced ? '（其中 ' + plan.value.replaced + ' 个来自更正册）' : '') +
      '，TTF ' + kb(built.ttf.byteLength) +
      (built.woff2 ? '、woff2 ' + kb(built.woff2.byteLength) : '（woff2 不可用，已跳过）') +
      '；用时 ' + secs + ' 秒' + checkNote +
      (suspect ? '；这批里有 ' + suspect + ' 个可疑字形（偏淡或写得太小），可以回第 2 步的格级视图逐格看' : ''), 'done')
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
    // 2026-10-15 用户口径：下载完**不再弹绿色提示**（"已下载 zip（144KB）：解压后双击 preview.html…
    //   装字体请右键 …"）—— 浏览器自己的下载条已经说明下载完成，这句话只是把《使用说明》里的内容
    //   又抄了一遍；它还会把"字体已生成：…"那条结论顶掉（两处共用同一个消息位）
  } catch (e) {
    setMessage('打包失败：' + (e && e.message ? e.message : e), 'error')
  }
}

// 单件下载（只下载 TTF / font.css / 使用说明.txt / preview.html）**2026-10-15 去掉了**：
//   用户口径是"标题行只留「查看字形总览 / 查看网页预览」+ 下载 zip" —— 那几件本来都在 zip 里，
//   摆一排按钮只会让"到底该点哪个"变成新问题（完整说明在《使用说明》里）。
// 想看样张用「查看网页预览」（新标签页），想存样张在那页 Ctrl+S。

// ── 字形总览图 / 网页预览：都在**新标签页**里打开（2026-10-15 用户口径）────────────────
// 为什么改成"看"而不是"下载"：这两样是"看一眼再决定"的东西（图对不对、字形长什么样），
//   看完关掉即可；真要存档，在那一页上右键另存（总览图）或 Ctrl+S（预览页）。
// 打开方式的两条路与"被弹窗拦截"的处置见 lib/openBlob.js。
/** 把字体字节转成 data URL 用的 base64（分块转换：一次性 apply 几 MB 会爆栈） */
function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function openOverview() {
  if (busy.value) return
  busy.value = true
  const t0 = performance.now()
  try {
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
    const opened = openBlobInNewTab(out.blob, { title: name })
    const secs = ((performance.now() - t0) / 1000).toFixed(1)
    if (!opened) {
      setMessage('字形总览图已经画好了，但浏览器拦下了新标签页：请允许本页打开弹窗，再点一次「查看字形总览」', 'error')
      return
    }
    setMessage('已在新标签页里打开字形总览图（' + out.width + ' × ' + out.height + ' 像素，' + out.rows +
      ' 行，用时 ' + secs + ' 秒）—— 要存档的话，在那一页上右键「图片另存为」', 'done')
  } catch (e) {
    setMessage('生成总览图失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    busy.value = false
    stage.value = ''
    progress.value = { done: 0, total: 0 }
  }
}

/** 查看网页预览：把样张页（**字体字节内联在里面**）在新标签页打开 —— file:// 下没有"同目录字体"可引用 */
async function openPreviewPage() {
  if (busy.value) return
  busy.value = true
  try {
    setMessage('正在准备网页预览…', 'info')
    const built = await ensureBuild()
    if (!built) return
    const coverage = coverageInfo({})
    const html = buildPreviewHtml({
      familyName: built.familyName,
      fileName: built.fileName,
      coverage,
      sampleText: coverage.chars.slice(0, 80).join(''),
      missingNote: '',
      fontDataUrl: 'data:font/ttf;base64,' + bytesToBase64(built.ttf)
    })
    const opened = openBlobInNewTab(new Blob([html], { type: 'text/html;charset=utf-8' }), {
      title: built.familyName + ' 样张预览'
    })
    if (!opened) {
      setMessage('网页预览已经生成好了，但浏览器拦下了新标签页：请允许本页打开弹窗，再点一次「查看网页预览」', 'error')
      return
    }
    setMessage('已在新标签页里打开网页预览（字体字节内联在页面里，不装机也能看真实效果）', 'done')
  } catch (e) {
    setMessage('打开网页预览失败：' + (e && e.message ? e.message : e), 'error')
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
// 一屏最多列这么多条；点「看全部」之后该栏不再截断。
// 2026-10-14 用户口径（原话："没列出来的字，我去哪里看，去哪里操作？"）：原来只写一句
//   "还有 N 个字没列出来"，界面上**没有任何看全 / 操作的入口** —— 现在截断那一行自带「看全部」按钮
const listSlice = (list, key) => ((key && showAll.value[key]) ? list : list.slice(0, LIST_LIMIT))
const showAll = ref({ rewrite: false, onRewrite: false, note: false, excluded: false })
function toggleAll(key) {
  showAll.value = { ...showAll.value, [key]: !showAll.value[key] }
}

// ── 体检清单：两栏 tab + 表格 + 每页 20 条（2026-10-15 用户口径）──────────────
// 为什么要把"建议重写 / 只是留意"改成 tab：全量下两栏加起来可能上千条，上下铺开之后
//   用户既看不完也找不到"我刚才改到哪"；同一时刻只看一栏、各带自己的说明，翻页看完即可。
// 表格样式与第 2 步的「更正核对表」同一套（`.corr-table` / `.corr-row`）—— 但**不带上色**：
//   那两种底色（浅绿 / 浅红）在核对表里表示"已替换 / 已删除"，体检清单里没有这层含义。
const CHECKUP_PAGE_SIZE = 20
const checkupTab = ref('rewrite') // rewrite = 建议重写 / note = 只是留意
const checkupPage = ref(1)
const checkupShowAll = ref(false) // 「看全部」：不分页，一次列出这一栏的全部字
const activeCheckupList = computed(() => (checkupTab.value === 'rewrite' ? rewriteList.value : noteList.value))
const checkupPageCount = computed(() => Math.max(1, Math.ceil(activeCheckupList.value.length / CHECKUP_PAGE_SIZE)))
const pagedCheckupList = computed(() => (checkupShowAll.value
  ? activeCheckupList.value
  : activeCheckupList.value.slice((checkupPage.value - 1) * CHECKUP_PAGE_SIZE, checkupPage.value * CHECKUP_PAGE_SIZE)))
// 行号一律按"这一栏里的第几个"数（分页之后也要能从 1 数到 N，不能每页都从 1 开始）
function checkupRowNumber(i) {
  return (checkupShowAll.value ? 0 : (checkupPage.value - 1) * CHECKUP_PAGE_SIZE) + i + 1
}
// 换栏回到第 1 页、并取消"看全部"（上一栏的展开状态带到下一栏只会让人以为没切过去）
watch(checkupTab, () => { checkupPage.value = 1; checkupShowAll.value = false })
// 字变少了（加入重写清单 / 剔除）时页码可能越界：退到最后一页，不留空白页
watch(checkupPageCount, (n) => { if (checkupPage.value > n) checkupPage.value = n })

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
// ── 重写模板（2026-10-15 用户口径："重写清单应该直接按重写字生成可下载的模板"）──────────
// 原来只有一个 txt 清单（"第几页第几格、写成什么样"），用户还得自己去翻出那一页重写；
// 现在直接照重写清单**出一份模板 PDF**：格子与参考字都印好，照着写就行。
// 页号（页脚的编码）**接在现有纸之后**（startPage = 现有最大页号 + 1）：写完后用第 2 步的
//   「补传扫描件」丢进来，会按页号**追加成新页**，不会覆盖已经识别过的那些页 ——
//   撞号会覆盖，覆盖就把那一页原来的其它字形丢了（这正是补传的归位规则要避开的事）。
// 自检页不附（它是给"整批打印"用的，重写模板通常只有一两页）。
async function downloadRewriteTemplate() {
  if (busy.value || !onRewriteList.value.length) return
  busy.value = true
  try {
    setMessage('正在准备参考字…', 'info')
    const fontBytes = await loadBuiltinFont()
    const chars = onRewriteList.value.map((r) => r.char)
    const maxPage = pages.value.reduce((m, p) => Math.max(m, p.pageNumber || 0), 0)
    const out = await buildTemplatePdf({
      chars,
      fontBytes,
      includeSelfCheck: false,
      startPage: maxPage + 1,
      onProgress: (done, total) => setMessage('正在生成重写模板：第 ' + done + ' / ' + total + ' 页…', 'info')
    })
    downloadBytes(out.bytes, '重写模板-' + dateStamp() + '.pdf', 'application/pdf')
    setMessage('已下载重写模板（' + chars.length + ' 个字、' + out.sheetPages + ' 页，页号 ' +
      (maxPage + 1) + ' 起）：照着写完后，把扫描件用第 2 步的「补传扫描件」丢进来 —— ' +
      '它会按页号追加成新的页，不会覆盖你已经识别过的那些页；认不准的格可以在卡片上「逐格确认」过一眼', 'done')
  } catch (e) {
    setMessage('生成重写模板失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    busy.value = false
    stage.value = ''
    progress.value = { done: 0, total: 0 }
  }
}
// 剔除了字、或改了名称表之后，之前那份体检快照就与当前状态不一致了（store 会置 checkupStale）
const staleAfterExclude = computed(() => !!checkup.value && store.font.checkupStale)
// 内存里还有没有刚生成的字节（没有就说明刷新过页面，下载会当场重建一次）。
// 2026-10-14 修：原来读的是模块级变量（`getLastBuild()`）—— **不是响应式的**，于是点「加载预览 / 重新加载」
//   把字节重建出来之后，那句"字体字节在刷新后不在内存里了…"还一直挂在那儿（用户真机反馈：
//   "已经显示了绿色字'字体已经生成…'它还是显示，我觉得它不该显示了"）。
//   改成盯 `previewBytes` 这个 ref：它在每次 `syncPreviewBytes()` 里更新，是同一件事的响应式镜像。
const hasMemoryBuild = computed(() => !!previewBytes.value)

// 体检摘要那一行（收起时也看得到）：把"要处理几件"说全。
// 2026-10-13 用户口径：**只说一遍** —— 原来 message（"已体检 1360 个字形：42 个建议重写、18 个只是留意"）
//   后面又接一句"建议重写 42 个；只是留意 18 个"，同一件事说了两遍；现在只补 message 里没有的那一项
//   （重写清单是用户自己标出来的，体检摘要里不含它）
const checkupSummaryText = computed(() => {
  const ck = checkup.value
  if (!ck) return ''
  const parts = [ck.summary ? ck.summary.message : '']
  if (onRewriteList.value.length) parts.push('重写清单里 ' + onRewriteList.value.length + ' 个')
  return parts.filter(Boolean).join('；')
})

// ── 「生成结果」标题后面那句"收录情况"（2026-10-14 用户口径：从字体预览挪到这里）──────
// 数据由预览组件上报：**"未收录几个"取决于当前预览文本**，只有它自己算得出来；
// 这里存一份用于显示（默认 0，预览还没加载时显示"共收录 N 个字、未收录 0 个"也说得通）
const previewCoverage = ref({ total: 0, missing: 0 })
function onPreviewCoverage(payload) {
  previewCoverage.value = {
    total: Number(payload && payload.total) || 0,
    missing: Number(payload && payload.missing) || 0
  }
}

// ── 「重新生成」（2026-10-13 用户口径）────────────────────────────────────────
/**
 * 回到"点了生成字体之前"的状态：清掉**产物**（元信息 + 内存字节 + 注册进页面的预览字体），
 * 名称表、识别结果、剔除与重写清单都留着（它们不是产物）。
 * 为什么要它：生成之后「生成字体」按钮与那行产物信息就不必再占位置（结果方框已经说清），
 *   想改名称表或剔除字形再生成一次，得先回到生成前 —— 按钮挂在步骤标题行右侧（与第 1 步「更新预览」同一个位置）。
 */
function resetBuild() {
  releaseAllPreviewFonts()
  clearLastBuild()
  syncPreviewBytes()
  store.clearFont()
  setMessage('已回到生成前的状态：名称表与字形都留着，改完再点「生成字体」即可', 'info')
}

// ── 「清空全部数据」（2026-10-13 用户口径）────────────────────────────────────
// 入口放第 3 步标题行、在「重新生成」**左边**（重新生成没出现时它自己也在），用默认的文本按钮样式；
// 点它先弹窗二次确认：写清后果 + **要求手输「清空」两个字**（沿用 五-8 ④ 的形态，只是从行内确认条改成弹窗 ——
// 入口在标题行，那里没有展开确认条的地方）。删完提示刷新一次（读数见 store.clearAllData 的注释）。
const CLEAR_WORD = '清空' // 需要手输的确认词
const clearAllOpen = ref(false)
const clearAllWord = ref('')
const clearAllBusy = ref(false)
const clearAllDone = ref(false)
const clearAllReady = computed(() => clearAllWord.value.trim() === CLEAR_WORD)

function openClearAll() {
  clearAllWord.value = ''
  clearAllDone.value = false
  clearAllOpen.value = true
  setMessage('', 'info')
}

async function doClearAll() {
  if (!clearAllReady.value || clearAllBusy.value || clearAllDone.value) return
  clearAllBusy.value = true
  try {
    const res = await store.clearAllData()
    // 只活在内存里的那些也要释放：预览字体、已构建的字节（页面缩略图与掩膜缓存随组件一起走）
    releaseAllPreviewFonts()
    clearLastBuild()
    syncPreviewBytes()
    // 扫描件文件夹的句柄也一并清掉（2026-10-15）：它是"上次选的那个目录"的凭据，
    // 数据都清空了还留着它，下次点「重新识别」会去重读一个与当前状态无关的目录
    clearScanDirHandle()
    if (res.ok) {
      clearAllDone.value = true
      setMessage('已清空全部数据，回到刚打开软件的状态。请刷新一次页面（刷新后就是全新的空项目）。', 'done')
    } else {
      setMessage('清空全部数据失败：' + (res.error || '未知原因') + '。数据可能仍在盘上，请刷新后再试一次。', 'error')
    }
  } finally {
    clearAllBusy.value = false
  }
}

// 清空之后：界面里的 store 已被 $reset、盘上那一份也删了，刷新即回到全新状态
function reloadNow() {
  window.location.reload()
}
</script>

<template>
  <div class="step-body">
    <!-- 上一步的状态（用户口径：这一步随时可进，但要提示上一步状态、对应功能不可点） -->
    <p v-if="prevStateNote" class="step-note" data-role="prev-state">{{ prevStateNote }}</p>

    <!-- ① 字形计划行：口径与第 2 步「更正核对」一致（都按**不同的字**计数）——
         2026-10-13 用户口径："这一行的所有信息应该和上一步保持一致"（原来这里按"处"数、对上一步按"字"数，
         同一件事会得出两个数）。原来还会罗列"哪些被圈的字没用上更正册"，与第 2 步重复，已去掉 -->
    <!-- 字形计划行：**用与"还没有识别结果…再回来生成字体"同一种提示条样式**（2026-10-14 用户口径）——
         它是"这次会出多少字形"的结论，与上下那些输入控件不是一类东西 -->
    <p v-if="hasResult" class="step-note" data-role="glyph-plan">
      字形计划：共 <strong>{{ plan.items.length }}</strong> 个字形，其中 <strong>{{ plan.replaced }}</strong> 个来自更正册；
      这批共写出 {{ store.scanGlyphStats.written }} 格、可疑 {{ store.scanGlyphStats.suspect }} 个。
      <span v-for="(p, i) in plan.problems" :key="'p' + i">{{ p }} </span>
    </p>

    <!-- 名称表：**生成过之后就不再出现**（2026-10-13 用户口径：点了生成字体，这一块也不要了）——
         字体元信息此刻已经固化进产物，留着输入框只会让人误改（改了要重新生成才有意义）；
         想改就点标题行的「重新生成」回到生成前 -->
    <div v-if="!ready" class="panel-row">
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

    <!-- 生成字体按钮：**生成过之后就不再出现**（2026-10-13 用户口径：生成完这里只需要结果方框）——
         想再生成一次，点步骤标题行右侧的「重新生成」回到生成前，改完名称表 / 剔除字形再点它。
         没料时按钮仍在（只是不可点）：消失会让人以为程序坏了 -->
    <div v-if="!ready" class="panel-actions">
      <button class="primary" data-role="build-font" :disabled="busy || !canBuild" @click="build">生成字体</button>
      <span v-if="busy" class="panel-hint">{{ stage }}（{{ progress.done }} / {{ progress.total }} 个字形）</span>
    </div>
    <!-- 消息行：**成功消息进「生成结果」框**（2026-10-14 用户口径：放在"生成结果"四个字下面的第一行），
         其余消息（失败 / 提示）仍留在这里 —— 它们往往发生在"还没有结果"的时候，进框就看不到了。
         两处共用一个 data-role（互斥渲染），测试与样式钩子照旧只认一个 -->
    <p v-if="message && !(ready && messageType === 'done')" class="panel-message" :class="messageType" data-role="build-message">{{ message }}</p>

    <!-- 生成过之后：「重新生成」挂在步骤标题行右侧（与第 1 步「更新预览」同一个位置）——
         点它回到"点了生成字体之前"的状态（清产物、留名称表与字形）。
         2026-10-13 用户口径：「清空全部数据」放在它**左边**（重新生成没出现时它自己也在），
         默认的文本按钮样式；点它先弹窗二次确认（要手输「清空」两个字） -->
    <Teleport to="#step-head-actions">
      <button class="text" type="button" data-role="clear-all-open" :disabled="busy" @click="openClearAll">
        清空全部数据
      </button>
      <button v-if="ready" class="text" type="button" data-role="rebuild-reset" :disabled="busy" @click="resetBuild">
        重新生成
      </button>
    </Teleport>

    <!-- ③ 生成之后：**整套结果并进「字体预览」这一张卡片**（2026-10-15 用户口径）——
         原来那个独立的「生成结果」框去掉了，里面的东西按用户的话处置：
           · "字体已生成：…"这条结论 → 挪到「字体预览」四个字下面；
           · "收录情况：…"整句去掉（字体收了多少字，样张页与《使用说明》里都有）；
           · 产物 / 怎么装 / 怎么用 → 去掉（完整说明在《使用说明》里，界面上不必再抄一遍）；
           · "字体字节在刷新后…（重新加载）" → 去掉（刷新后进这一步，预览区自己会给「加载预览」按钮）；
           · 下载：标题行最右只留「下载 zip」，左边是两个"看一眼"的文本按钮（在新标签页打开）。 -->
    <template v-if="ready">
      <div class="card nested" data-role="font-result">
        <FontPreview
          :bytes="previewBytes"
          :covered-chars="font.coverage ? font.coverage.chars : []"
          :family-name="font.familyName || ''"
          :loading="busy"
          :loading-text="busy ? stage + '（' + progress.done + ' / ' + progress.total + ' 个字形）' : ''"
          @request-bytes="loadPreview"
          @coverage="onPreviewCoverage"
        >
          <template #head-actions>
            <button class="text" type="button" data-role="overview-open" :disabled="busy" @click="openOverview">查看字形总览</button>
            <button class="text" type="button" data-role="preview-open" :disabled="busy" @click="openPreviewPage">查看网页预览</button>
            <button class="primary" data-role="download-zip" :disabled="busy" @click="downloadZip">下载 zip</button>
          </template>
          <!-- 标题下面第一行：生成成功的结论（"字体已生成：136 个字形…可以回第 2 步的格级视图逐格看"） -->
          <template #head-note>
            <p v-if="message && messageType === 'done'" class="panel-message done" data-role="build-message">{{ message }}</p>
          </template>
        </FontPreview>
      </div>
    </template>

    <!-- ④ 字形体检（阶段三 3.2，决策 四-7）：只提示、不改字形；处置手段是"剔除"或"重写那一格"。
         放在 ready 分支**之外**：剔除一个字之后 `store.font.built` 会被清掉（提示"要重新生成"），
         如果它在里面，面板会跟着整块消失 —— 那样就看不清单、也没法恢复（实测踩到）。
         2026-10-12（决策 八-16 ⑥）：整块**默认收起**，只显示一行摘要，点开才看清单 -->
    <div v-if="checkup" class="card nested" data-role="glyph-checkup">
      <div class="panel-head">
        <!-- 说明紧跟"字形体检"四个字（2026-10-13 用户口径：不要被推到行尾去） -->
        <h3>字形体检 <span class="panel-hint">只提示、不改字形 —— 字形大小与笔画粗细取决于你的书写</span></h3>
      </div>
      <!-- 摘要那一行：收起时也能一眼看到"有没有要处理的"。
           2026-10-13 用户口径：「看清单」按钮**放在摘要文字前面**、默认用主题色（原来在右上角、要悬停才变蓝） -->
      <p class="panel-hint" data-role="checkup-summary">
        <button
          type="button"
          class="text accent"
          data-role="checkup-toggle"
          @click="checkupOpen = !checkupOpen"
        >{{ checkupOpen ? '收起清单' : '看清单' }}</button>
        {{ checkupSummaryText }}
      </p>

      <!-- 批量动作与"体检已过期"提示**同一行**（2026-10-15 用户口径）：**按钮组在左、提示文字在右** ——
           这样没有提示文字时（入口照样要在）看着也自然。原来按钮另占一行，与这一行里的按钮**重复了一遍**
           （真机截图里被一眼看出来：同一排按钮出现两次）。 -->
      <p
        v-if="staleAfterExclude || excludedList.length || onRewriteList.length"
        class="checkup-note-row"
        data-role="checkup-stale-row"
      >
        <span class="panel-actions" data-role="checkup-bulk">
          <button v-if="onRewriteList.length" type="button" class="text" :disabled="busy" data-role="rewrite-template" @click="downloadRewriteTemplate">下载重写模板</button>
          <button v-if="onRewriteList.length" type="button" class="text" :disabled="busy" data-role="rewrite-clear" @click="clearRewriteAll">全部移出重写清单</button>
          <button v-if="excludedList.length" type="button" class="text" :disabled="busy" data-role="restore-all" @click="restoreAll">
            恢复全部被剔除的字（{{ excludedList.length }}）
          </button>
        </span>
        <span v-if="staleAfterExclude" class="checkup-note-text" data-role="checkup-stale">
          体检之后你剔除过字形（或改过名称表），点上面的「生成字体」重新生成一次即生效。
        </span>
      </p>

      <template v-if="checkupOpen">
      <!-- 两栏做成 tab（2026-10-15 用户口径）：同一时刻只看一栏，各带自己的表格、分页与说明 -->
      <div class="checkup-tabs" data-role="checkup-tabs">
        <button
          type="button"
          class="checkup-tab"
          :class="{ active: checkupTab === 'rewrite' }"
          data-role="checkup-tab-rewrite"
          @click="checkupTab = 'rewrite'"
        >建议重写（{{ rewriteList.length }}）</button>
        <button
          type="button"
          class="checkup-tab"
          :class="{ active: checkupTab === 'note' }"
          data-role="checkup-tab-note"
          @click="checkupTab = 'note'"
        >只是留意（{{ noteList.length }}）</button>
      </div>

      <!-- 说明文字**紧跟 tab**（2026-10-15 用户口径：切到哪一栏，先看到的就是这一栏是干什么的） -->
      <p class="panel-hint" data-role="checkup-tab-note">
        <template v-if="checkupTab === 'rewrite'">
          <strong>成字后这些字会明显偏小或不成形</strong>；<strong>加入重写清单</strong> = 这次先不进字体、
          以后重写补上，<strong>剔除</strong> = 这个字不要了。
        </template>
        <template v-else>
          <strong>不影响成字，看一眼就行</strong>；想重写的字也可以在这里加入重写清单。
        </template>
      </p>

      <p v-if="!activeCheckupList.length" class="panel-message done" data-role="checkup-empty">
        {{ checkupTab === 'rewrite' ? '没有需要重写的字形 —— 这一批可以直接生成字体。' : '没有「只是留意」的字形。' }}
      </p>

      <template v-else>
        <!-- 表格：与第 2 步的更正核对表同一套样式（表头 + 行 + 分页），但**不带上色** ——
             核对表那两个底色表示"已替换 / 已删除"，体检清单里没有这层含义 -->
        <div class="corr-table checkup-table" :data-role="checkupTab === 'rewrite' ? 'rewrite-list' : 'note-list'">
          <div class="corr-head checkup-head">
            <span>#</span><span>字</span><span>位置</span><span>体检提示</span><span>操作</span>
          </div>
          <div
            v-for="(g, i) in pagedCheckupList"
            :key="checkupTab + g.char"
            class="corr-row checkup-row"
            :data-char="g.char"
          >
            <span class="corr-index">{{ checkupRowNumber(i) }}</span>
            <span class="checkup-char">{{ g.char }}</span>
            <span class="checkup-where">第 {{ g.pageNumber }} 页 · 第 {{ g.cellIndex }} 格</span>
            <span class="checkup-msgs">{{ (g.messages || []).join('；') }}</span>
            <span class="corr-actions checkup-actions">
              <button type="button" class="text" :disabled="busy" data-role="mark-rewrite" @click="markRewrite(g.char, (g.messages || []).join('；'))">加入重写清单</button>
              <button type="button" class="text" :disabled="busy" @click="excludeGlyph(g.char)">剔除这个字</button>
            </span>
          </div>
        </div>

        <!-- 表格下面一行（2026-10-15 用户口径）：**上一页 / 下一页 挨在一起放左边**（原来说明夹在中间，
             两个翻页按钮隔着半屏），说明跟在后面，最后是「看全部」—— 都用默认文本色 -->
        <div class="table-pager" data-role="checkup-pager">
          <button v-if="!checkupShowAll" class="text" type="button" :disabled="checkupPage <= 1" @click="checkupPage--">上一页</button>
          <button v-if="!checkupShowAll" class="text" type="button" :disabled="checkupPage >= checkupPageCount" @click="checkupPage++">下一页</button>
          <span class="panel-hint">
            <template v-if="checkupShowAll">已列出全部 {{ activeCheckupList.length }} 个字</template>
            <template v-else>第 {{ checkupPage }} / {{ checkupPageCount }} 页（共 {{ activeCheckupList.length }} 个字，每页 {{ CHECKUP_PAGE_SIZE }} 个）</template>
          </span>
          <button class="text" type="button" :data-role="'show-all-' + checkupTab" @click="checkupShowAll = !checkupShowAll">
            {{ checkupShowAll ? '分页显示' : '看全部（' + activeCheckupList.length + ' 个）' }}
          </button>
        </div>


      </template>

      <!-- 重写清单（八-8 第四态，清单一-12）：与上面"建议重写"分开列 ——
           上面那份是**体检建议**（还没决定），这份是**已经决定要重写**的，它们本次不进字体，
           清单一直挂着直到被移出（"移出清单（继续采用）"= 就用现在这个字形，不再等重写） -->
      <div v-if="onRewriteList.length" class="checkup-group" data-role="rewrite-plan">
        <p class="panel-hint">
          <strong>重写清单（{{ onRewriteList.length }}）</strong>：这些字这次不进字体。
          用上面那一行的「下载重写模板」按这些字印一张模板（页号接在现有纸之后），
          照着写完后用第 2 步的「补传扫描件」丢进来（按页号归位：已有这一页就覆盖、没有就追加），
          再回这里点「生成字体」。
        </p>
        <ul class="checkup-list" data-role="rewrite-plan-list">
          <li v-for="r in listSlice(onRewriteList, 'onRewrite')" :key="'w' + r.char">
            <span class="checkup-char">{{ r.char }}</span>
            <span class="checkup-where">{{ r.pageNumber === null ? '页号未知' : '第 ' + r.pageNumber + ' 页 · 第 ' + r.cellIndex + ' 格' }}</span>
            <span class="checkup-msgs">{{ r.messages.length ? r.messages.join('；') : r.reason }}</span>
            <button type="button" class="text" :disabled="busy" data-role="unmark-rewrite" @click="unmarkRewrite(r.char)">移出清单（继续采用）</button>
          </li>
        </ul>
        <p v-if="onRewriteList.length > LIST_LIMIT" class="panel-hint">
          还有 {{ onRewriteList.length - LIST_LIMIT }} 个字没列出来（一屏只列前 {{ LIST_LIMIT }} 个）——
          <button class="text accent" type="button" data-role="show-all-onrewrite" @click="toggleAll('onRewrite')">
            {{ showAll.onRewrite ? '只列前 ' + LIST_LIMIT + ' 个' : '看全部（' + onRewriteList.length + ' 个）' }}
          </button>
        </p>
      </div>

      <div v-if="excludedList.length" class="checkup-group">
        <p class="panel-hint">
          <strong>已剔除（{{ excludedList.length }}）</strong>：这些字不进字体、也不计入收录数
          <button type="button" class="text" :disabled="busy" @click="restoreAll">全部恢复</button>
        </p>
        <ul class="checkup-list" data-role="excluded-list">
          <li v-for="g in listSlice(excludedList, 'excluded')" :key="'x' + g.char">
            <span class="checkup-char">{{ g.char }}</span>
            <span class="checkup-msgs">{{ (g.messages || []).join('；') }}</span>
            <button type="button" class="text" :disabled="busy" @click="restoreGlyph(g.char)">恢复</button>
          </li>
        </ul>
        <p v-if="excludedList.length > LIST_LIMIT" class="panel-hint">
          还有 {{ excludedList.length - LIST_LIMIT }} 个字没列出来 ——
          <button class="text accent" type="button" data-role="show-all-excluded" @click="toggleAll('excluded')">
            {{ showAll.excluded ? '只列前 ' + LIST_LIMIT + ' 个' : '看全部（' + excludedList.length + ' 个）' }}
          </button>
        </p>
        <p class="panel-hint">
          剔除只影响<strong>这一次生成</strong>的字库：想真正补上，还是重写那一格、重新扫这一页（或用更正册覆盖）。
          重新识别之后，剔除记录仍会保留（可在上面「全部恢复」）。
        </p>
      </div>
      </template>
    </div>

     <!-- 2026-10-13 用户口径：原来这里那一块「清理数据」（清空识别结果 / 清空全部数据）整块去掉了 ——
          清空识别结果在第 2 步有「清空结果」入口（同一件事）；「清空全部数据」改到步骤标题行，
          点它开下面这个弹窗做二次确认（要手输「清空」两个字）。 -->

    <!-- 「清空全部数据」的二次确认弹窗：写清后果 + 手输确认词（沿用 五-8 ④ 的形态，
         只是从行内确认条改成弹窗 —— 入口在标题行，那里没有展开确认条的地方） -->
    <div v-if="clearAllOpen" class="backup-overlay" @click.self="clearAllOpen = false">
      <div class="backup-modal" role="dialog" aria-label="清空全部数据" data-role="clear-all-modal">
        <div class="backup-head">
          <h3>清空全部数据</h3>
          <button class="text" type="button" data-role="clear-all-close" @click="clearAllOpen = false">关闭</button>
        </div>
        <p class="panel-hint">
          会删掉：识别结果、落盘的字形、更正配对、体检与筛选记录、<strong>模板记录、名称表与选字</strong> ——
          等于回到刚打开软件的状态。本机浏览器里的这一份数据会被删除，<strong>不能撤销</strong>。
        </p>
        <p class="step-note">
          删完请<strong>刷新一次页面</strong>（刷新后就是全新的空项目）。已经下载的字体压缩包、以及装进系统的字体
          不受影响；扫描件原图本来就不在程序里（要重做就重新走一遍第 1 步）。
        </p>
        <label class="meta-field">
          <span class="field-label">请输入「{{ CLEAR_WORD }}」两个字确认</span>
          <input
            type="text"
            data-role="clear-all-input"
            :value="clearAllWord"
            :disabled="clearAllBusy || clearAllDone"
            @input="clearAllWord = $event.target.value"
          />
        </label>
        <div class="panel-actions">
          <button
            class="text danger"
            type="button"
            data-role="clear-all-confirm"
            :disabled="!clearAllReady || clearAllBusy || clearAllDone"
            @click="doClearAll"
          >{{ clearAllBusy ? '正在清空…' : '确认清空全部数据' }}</button>
          <button class="text" type="button" data-role="clear-all-cancel" @click="clearAllOpen = false">取消</button>
          <button v-if="clearAllDone" class="primary" type="button" data-role="reload-now" @click="reloadNow">立即刷新</button>
        </div>
      </div>
    </div>
  </div>
</template>
