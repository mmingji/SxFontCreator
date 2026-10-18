<script setup>
// 第 1 步：选字与出模板（阶段一步骤 1.3 的界面；2026-10-04 按用户要求改造成向导的第一步）
// 职责：① 选**写哪些字**（**一组三选**：单页试打 / 常用 6500 字 / 自定义选字，2026-10-07 由原来的
//      「选字 + 生成范围」两组单选合并而来；2026-10-08 换官方字表后第二项由"全量字表"改为"常用 6500 字"；
//      **2026-10-18 单页试打 = 一页名句集锦**（汉字一个不重复、标点去重排末尾），来源 `lib/singlePageText.js`）
//   ② 选排列方式与参考字体
//   ③ **先看到模板第一页的真实预览**（pdf.js 渲染真实 PDF）④ 生成模板 PDF / 更正册并下载。
// 版面：由 templatePdf.js 的 LAYOUT 统一控制（A4 横向、每页 136 格，见《决策记录》一-3、一-4）。
// 数据来源：字表来自 src/lib/charset.js（8274 字 = 官方 8105 + 基础字符 169，决策 三-1、八-1、八-2）；
//   字体固定用内置楷体子集（referenceFont.js；2026-10-11 起界面不再提供"选本机字体"，见决策 五-9）；试打页内容来自 singlePageText.js。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { LAYOUT, buildTemplatePdf, buildCorrectionBookPdf, buildSamplePagePdf } from '../lib/templatePdf.js'
import { CHAR_RANK_META } from '../lib/charRank.js'
import { singlePageCharCount } from '../lib/singlePageText.js'
import { orderModeLabel, scopePreset, charsForScope as charsForScopeLib } from '../lib/templateScope.js'
import { getLevelChars } from '../lib/frequency.js'
import {
  CHARSET_STANDARD_TITLE,
  CHARSET_STANDARD_NOTES,
  CHARSET_STANDARD_SOURCES,
  CHARSET_SCOPE_LINE
} from '../lib/charsetStandard.js'
import { BUILTIN_FONT_LABEL, loadBuiltinFont, loadHandwritingFont } from '../lib/referenceFont.js'
import { buildOrderFile, dateStamp } from '../lib/orderFile.js'
import { CORRECTION_BOOK_PAGES, packTemplateZip, templatePackNames } from '../lib/templatePack.js'
import { loadGuideHtml } from '../lib/guideHtml.js'
import { downloadBytes } from '../lib/download.js'
import { useProjectStore } from '../store/project.js'
import SelectionPanel from './SelectionPanel.vue'
import PdfPreview from './PdfPreview.vue'

const store = useProjectStore()
// 字表构成的几个数字**全部从字表分级算出来**，不硬编码 —— 改字表时口径说明自动跟着变。
// 「常用 6500 字」档 = 一级 3500 + 二级 3000 + 基础字符 169 = 6669 字；
// 全量（8274 字）走「自定义选字」里的「全选全部」。
// （`getCharsetMeta()` 那个全量数字的引用 2026-10-18 随"自定义选字"的旧文案一起去掉了：
//   那句"一个字都没选时按全部 8274 字出"是 2026-10-16 就作废的口径。）
const l1Count = getLevelChars('l1').length
const l2Count = getLevelChars('l2').length
const baseCount = getLevelChars('base').length
const commonCount = l1Count + l2Count + baseCount
const commonPages = Math.ceil(commonCount / LAYOUT.perPage)

// 写哪些字出模板：**一组三选**（2026-10-07 用户要求把原来的「选字 + 生成范围」两组单选合并成一组）。
//   single —— 单页试打：只出**一页名句集锦**（104 个汉字 + 2 个标点 = 106 格）+ 自检页，先确认版式与打印设置。
//     **2026-10-16 用户口径（提高观感）**：原来排的是"频序前 136 字"（一页互不相干的常用字，像抄字帖），
//     改成一段成品文字 —— 写一遍既确认了版式，又像写了一页作品，这些字还会直接进字体。
//     **2026-10-18 用户口径（不留重复字）**：再把"短文里重复的字"这个缺口去掉 —— 现在这一页
//     **汉字一个不重复、标点去重后排在最末**（用户原话"保证我们产出的所有模板都不会有重复的字"：
//     重复字在成字时只有一份能进字体、白占格子；字表与各档位本来就无重复，试打页曾是唯一的例外）。
//     内容与三条约束见 `lib/singlePageText.js`（106 格、全部落在频序前 3000、字字不同）。
//   common —— 常用 6500 字：一级 + 二级 + 基础字符全出（按当前排列方式）
//   custom —— 自定义选字：展开下面的选字面板，按已选的字出。**一个字都没选 = 没有字可排**（2026-10-16 修订：
//     原来是"空 = 全量"，于是刚切到这一档就按 8274 字出纸、预览显示全量第一页，与"还没选字"的直觉相反）
// 默认单页试打（用户 2026-10-04 拍板）：先打一页确认版式，再打正式的。
// 三个档位都只"出一份纸"：模板不再记任何项目数据，只留一笔"生成过模板"的元信息（决策 五-9 ⑩）。
const scope = ref('single')
const pickerOpen = computed(() => scope.value === 'custom')
// 参考字字体：**只有内置楷体一条路**（2026-10-11 去掉"选本机字体"，决策 五-9）——
// 参考字是第 2 步"认字定序"的比对基准，必须与内置子集一致；换了字体，纸上那套参考字就认不出来。
// （lib/referenceFont.js 的 loadFontFromFile 与 lib/fontFormat.js 的规整能力保留：那是可复用的库能力，
//   测试仍在覆盖；界面上不再暴露入口。）

const busy = ref(false)
const message = ref('')
const messageType = ref('info') // info | error | done
const progress = ref({ done: 0, total: 0 })
const lastResult = ref(null) // { name, pages, bytes }

// 预览：**按需只生成"当前这一页"**（2026-10-16 用户口径，决策 一-14 补注）。
// 为什么改：原来是"一次生成整份 PDF"—— 全量档要画 61 字表页 + 1 自检页（约 1.5 秒），
//   书写示意还要再画 61 页、每格画两次字（约 2.9 秒），切个档位要等 4~5 秒、界面像卡住。
//   预览一次只看一页，所以现在只生成当前页（几十~几百毫秒），翻页时再生成那一页。
//   **页码与页脚指纹照整份算**（见 lib/templatePdf.js 的 onlyPage），所以预览里的那一页与下载件里的
//   同一页逐格一致；**下载走另一条路**（`buildCurrentPdf()` 不传 onlyPage、当场整份生成），
//   与"预览翻到第几页"毫无关系。
const previewBytes = ref(null)
const previewBusy = ref(false)
const previewPage = ref(1) // 模板预览当前页（1 起；最后一页是打印自检页）
const previewPages = ref(0) // 模板总页数 = 字表页 + 1 页自检；0 = 没有可预览的内容
// 两块预览的**灰底板宽高比**：非就绪态（生成中 / 空态）按它撑住与成品一样大的底板，
// 免得"载入完成"那一下卡片长高、下面的内容跟着跳（2026-10-18 用户要求）。
// 值从 LAYOUT 取 —— 纸型只有那一个出处（决策 六-9）
const pageRatio = LAYOUT.pageWidth / LAYOUT.pageHeight

// 书写示意（用户 2026-10-07 要求，原名"填写示意"、2026-10-08 按用户要求改名）：与模板**同版式**的一页，
// 但每个书写格里已经用工整手写体写好了那个字，让用户一眼看到"这个格子应该写成什么样"
// （口径见《决策记录》一-13：笔画多的字撑满格、天生小的字居中写小）。
// 四点约束：① **页数与当前范围一致**（2026-10-08 由"只出第 1 页"改成跟着范围逐页生成、可翻页，见一-14 ②，
//   2026-10-16 起改为**按需只生成当前页**）；② **不进正式模板 PDF**（它是给人看的示范，不画定位块、
//   不印页脚编码、不参与识别）；③ 参考字用当前选的字体，示范字固定用内置手写体子集（悠哉字体，OFL-1.1）；
//   ④ **印可见页码**（2026-10-16 用户要求）：与模板同一位置、同一个页号，打印出来当字帖时能与模板逐页对上。
const sampleBytes = ref(null)
const sampleBusy = ref(false)
const sampleNote = ref('')
const samplePage = ref(1)
const samplePages = ref(0)
// 每次"换设置 / 翻页"都递增：异步回来先核对它，**过期的那一轮不许落地**。
// 这正是原来那个 bug 的根因：`refreshPreview` 开头 `if (previewBusy) return` 把新请求直接丢了，
//   而在途的旧生成照样把结果写进预览 —— 于是"清空选字 → 立刻切单页试打"看到的是那次全量生成的第一页。
let previewToken = 0
let sampleToken = 0
let previewPending = false
let previewQueued = false

// 当前档位的字序与页数（两块预览共用同一份推算，避免"字序一套、页数另一套"）
function scopePlan() {
  const chars = charsForScope()
  const sheetPages = chars.length ? Math.max(1, Math.ceil(chars.length / LAYOUT.perPage)) : 0
  return { chars, templatePages: sheetPages ? sheetPages + 1 : 0, samplePages: sheetPages }
}

// 生成模板预览的"当前页"（只一页）
async function generatePreviewPage() {
  const token = ++previewToken
  const plan = scopePlan()
  previewPages.value = plan.templatePages
  if (!plan.templatePages) {
    // 自定义档一个字都没选：没有可排的字 → 预览空白（不再退回"全量"）
    previewBytes.value = null
    previewBusy.value = false
    return
  }
  const p = Math.min(Math.max(1, previewPage.value), plan.templatePages)
  previewPage.value = p
  previewBusy.value = true
  try {
    const font = await resolveFont()
    const out = await buildTemplatePdf({ chars: plan.chars, fontBytes: font.bytes, onlyPage: p })
    if (token !== previewToken) return // 这一轮已过期（用户又改了设置或翻了页）：丢掉，别动新状态
    previewBytes.value = out.bytes
  } catch (e) {
    if (token === previewToken) setMessage('预览生成失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    if (token === previewToken) previewBusy.value = false
  }
}

// 手写体子集 3.84MB：一个会话只 fetch 一次，之后所有示意页复用同一份字节
let handwritingFont = null
async function resolveHandwritingFont() {
  if (!handwritingFont) handwritingFont = await loadHandwritingFont()
  return handwritingFont
}

// 生成书写示意的"当前页"（只一页）
async function generateSamplePage() {
  const token = ++sampleToken
  const plan = scopePlan()
  samplePages.value = plan.samplePages
  if (!plan.samplePages) {
    sampleBytes.value = null
    sampleBusy.value = false
    return
  }
  const p = Math.min(Math.max(1, samplePage.value), plan.samplePages)
  samplePage.value = p
  sampleBusy.value = true
  try {
    const font = await resolveFont()
    const sampleFont = await resolveHandwritingFont()
    const out = await buildSamplePagePdf({
      chars: plan.chars,
      fontBytes: font.bytes,
      sampleFontBytes: sampleFont,
      onlyPage: p
    })
    if (token !== sampleToken) return
    sampleBytes.value = out.bytes
    sampleNote.value = ''
  } catch (e) {
    // 示意页失败不影响模板预览与生成：只在这一块显示中文原因
    if (token === sampleToken) sampleNote.value = '书写示意生成失败：' + (e && e.message ? e.message : e)
  } finally {
    if (token === sampleToken) sampleBusy.value = false
  }
}

// 「字表标准与收字口径」问号浮窗（2026-10-08 新增）：显示《通用规范汉字表》来源核对 + 官方说明节选。
// **本机字体那个浮窗随"参考字体"选项一起去掉了**（2026-10-11）：参考字一律用内置楷体 —— 纸上印的那套
// 参考字必须能被认出来，换了字体就认不出（决策 五-9）。
const standardHelpOpen = ref(false)
// 浮窗位置在打开时按按钮位置算，并夹进视口：实测固定的 left / right 都不行 ——
// 1180px 视口下向左展开会把文字裁在视口外（左边缘到 -53px），900px 视口下向右展开又顶出右边界。
const standardHelpStyle = ref({ left: '0px', top: 'calc(100% + 8px)' })

// 相对 .help-holder 的偏移，三级优先：① 右对齐到按钮右边缘（浮窗贴问号左下）② 放不下就左对齐到按钮
// ③ 仍放不下（窄窗口）再夹进视口 —— 这样 1180px 下浮窗正好落在问号下方，900px 下贴着右边界也不溢出
function placePopover(buttonEl, width) {
  const holder = buttonEl.closest('.help-holder')
  const btnRect = buttonEl.getBoundingClientRect()
  const holderRect = holder.getBoundingClientRect()
  const w = Math.min(width, window.innerWidth - 48)
  const minLeft = 12 - holderRect.left
  const maxLeft = window.innerWidth - w - 12 - holderRect.left
  let left = btnRect.right - holderRect.left - w
  if (left < minLeft) left = btnRect.left - holderRect.left
  left = Math.max(minLeft, Math.min(maxLeft, left))
  return { left: Math.round(left) + 'px', top: 'calc(100% + 8px)', width: Math.round(w) + 'px' }
}

function toggleStandardHelp(e) {
  standardHelpOpen.value = !standardHelpOpen.value
  if (!standardHelpOpen.value) return
  standardHelpStyle.value = placePopover(e.currentTarget, 620)
}

function onDocumentClick(e) {
  // 点在任何 .help-holder 区域（问号或浮窗）内都不关闭 —— 否则"点问号展开"会被同一次冒泡立刻收掉
  if (e.target && e.target.closest && e.target.closest('.help-holder')) return
  standardHelpOpen.value = false
}
function onDocumentKeydown(e) {
  if (e.key === 'Escape') standardHelpOpen.value = false
}
onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onDocumentKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onDocumentKeydown)
})

// 三选一的提示：每一种都当场说清"这次会排哪些字、多少页"
const scopeHint = computed(() => {
  if (scope.value === 'single') {
    // 2026-10-18 用户口径（原文案"太臃肿了"）：这一行只说"印什么、多少字、接着做什么" ——
    //   格数、"汉字不重复 / 标点排末尾"这类细节属于纸面与《使用说明》，堆在档位说明里只会让人读不完。
    return '单页试打：只印一页名句集锦 ' + singlePageCharCount() + ' 字 + 打印自检页，先确认版式与打印设置；'
  }
  if (scope.value === 'custom') {
    return store.selectedCount
      ? '自定义选字：已选 ' + store.selectedCount + ' 字 ≈ ' + Math.ceil(store.selectedCount / LAYOUT.perPage) + ' 页'
      // 2026-10-18 用户报：这里还挂着**旧口径**"一个字都没选时按全部 8274 字出" —— 那条 2026-10-16
      //   就改掉了（八-4 补注：没选字 = 没有字可排，两块预览空白、点下载给中文提示、不出纸），
      //   文案跟着改准（顺手去掉对 meta.total 的依赖）。
      : '自定义选字：还没有选字 —— 一个字都没选就没有字可排（不会出纸），下面是选字面板'
  }
  return '一级 ' + l1Count + ' 字 + 二级 ' + l2Count + ' 字 + 基础字符 ' + baseCount +
    ' = 常用 ' + commonCount + ' 字／' + commonPages + ' 页'
})

// 排列方式：默认**按使用频率** —— 最常用的字排在最前，前 2000 字覆盖日常语料 97.13%（约 15 页）、
// 前 6500 字覆盖 99.99%（约 48 页），频序本身也把同偏旁的字打散了（笔画序会让同偏旁的字挨在一起，很疲劳）。
// 「笔画序」= 《通用规范汉字表》的官方字序（说明第八条：遵循《GB 13000.1 字符集汉字字序（笔画序）规范》）。
// 两种顺序都能被识别 —— 页脚的**本页校验码按实际字序算**（每一页各自一个指纹），换顺序不影响识别
// （换了顺序就是另一份纸：旧纸的字位与新字序对不上，页级校验会当场发现）。
// **2026-10-16**：选了「单页试打」时这一项**置灰**（`orderDisabled`）—— 试打页是一页固定顺序的名句，
//   按频序/笔画序重排没有意义；置灰而不是"可选但无效"，避免让人以为"点了没反应"。
const orderMode = computed({
  get: () => store.ui.orderMode,
  set: (value) => store.setOrderMode(value)
})
const orderDisabled = computed(() => scope.value === 'single')
const orderHint = computed(() => {
  if (orderDisabled.value) return '单页试打按名句本身的顺序排（这一项对试打页不适用）'
  if (orderMode.value === 'rank') {
    return '最常用的字在最前（前 2000 字覆盖语料 ' + CHAR_RANK_META.cumAt2000 + '%，约 ' +
      Math.ceil(2000 / LAYOUT.perPage) + ' 页即可日常使用）'
  }
  return '《通用规范汉字表》的官方字序'
})

// 实际要排的字：**统一走 lib/templateScope.js 的 `charsForScope()`**（2026-10-16 抽出去：
//   那是"档位 × 排列方式 → 一份确定字序"的唯一出口，抽到零依赖模块后单测能直接钉住它 ——
//   试打档从"频序前 136 字"换成"一页名句"这种改动，今后不会再出现"只有组件改了口径、测试看不见"。）
function charsForScope() {
  return charsForScopeLib(scope.value, orderMode.value, store.charsForTemplate)
}

function setMessage(text, type) {
  message.value = text
  messageType.value = type || 'info'
}

// 2026-10-11（决策 五-10）：「清空项目」入口已去掉，原来这里读 store.ui.resetNotice 显示清空结果的那段
// watch 一并在去掉（第 1 步不再需要承接别的组件送来的消息）。

// 参考字字体固定用内置楷体（理由见上面那段注释：它是认字定序的比对基准）
async function resolveFont() {
  return { bytes: await loadBuiltinFont(), label: BUILTIN_FONT_LABEL }
}

// 档位的中文名（写进字序文件、也在界面上显示）；custom 不在预置档位表里，单独给一句
function scopeLabelOf(key) {
  if (key === 'custom') return '自定义选字'
  const preset = scopePreset(key)
  return preset ? preset.label : key
}

// 生成"当前设置下的模板 PDF"（试打是 1 页字表 + 自检页；正式范围是全部页 + 自检页）。
// 生成模板与刷新预览共用这一份，保证"预览的就是要下载的那份内容"
async function buildCurrentPdf(onStep) {
  const font = await resolveFont()
  const chars = charsForScope()
  // 护栏：字序为空时**不许**往下走 —— buildTemplatePdf 对空数组会退回"全量"（那是库层的默认口径），
  //   而"自定义选字里一个字都没选"绝不等于"出全量纸"（2026-10-16 口径）。调用方要先给中文提示。
  if (!chars.length) {
    const err = new Error('还没有选字：请先在下面「自定义选字」里挑几个字，或把「写哪些字」换成别的档位')
    err.code = 'NO_CHARS'
    throw err
  }
  progress.value = { done: 0, total: Math.ceil(chars.length / LAYOUT.perPage) }
  const out = await buildTemplatePdf({
    chars,
    fontBytes: font.bytes,
    onProgress: onStep || ((done, total) => { progress.value = { done, total } })
  })
  return { out, font, chars }
}

// 自定义档一个字都没选时的**常驻提示**（2026-10-16 用户反馈修）：
//   原来只有"点下载"那一下才写一条消息，而消息行是"上一次操作的结果"、切档位时没人清它 ——
//   于是切到别的档位之后那句"还没有选字…"还挂在那儿（用户实测报上来的）。
//   现在把它做成**派生态**：条件成立就出现、不成立就消失（切档位 / 选字都会立刻跟着变），
//   点下载时仍然照旧给一次明确反馈（护栏抛 NO_CHARS，见 buildCurrentPdf 与 generatePack）。
const noChars = computed(() => scope.value === 'custom' && charsForScope().length === 0)

// 预览：防抖 300ms —— 连续切换范围 / 排列方式时不至于每点一下都重算一遍
let previewTimer = null
function schedulePreview() {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(() => { refreshPreview() }, 300)
}
// 换设置（档位 / 排列方式 / 选字数）→ 回到第 1 页，两块各出"当前页"。
// **在跑也要接住**：跑的过程中又改了设置，就在这一轮结束后用最新状态再跑一次 ——
//   原来这里是把新请求直接丢掉（`if (previewBusy) return`），于是在途的旧生成照样落地，
//   界面停在上一次设置的结果上（"清空选字 → 立刻切单页试打 → 看到的还是全量第一页"就是这么来的）。
async function refreshPreview() {
  if (previewPending) {
    previewQueued = true
    return
  }
  previewPending = true
  try {
    do {
      previewQueued = false
      previewPage.value = 1
      samplePage.value = 1
      await generatePreviewPage()
      await generateSamplePage()
    } while (previewQueued)
  } finally {
    previewPending = false
  }
}
// 翻页：只重出那一块的那一页（两块各自独立翻页，页码一一对应）
function onPreviewPageChange(n) {
  previewPage.value = n
  generatePreviewPage()
}
function onSamplePageChange(n) {
  samplePage.value = n
  generateSamplePage()
}
onBeforeUnmount(() => { clearTimeout(previewTimer) })
// 影响版面的输入一变就重出预览；打开这一步时先出一次（用户不用先点按钮才能看到东西）。
// **同时清掉上一次操作的结论**（2026-10-16 用户反馈修）：消息行是"那一次点击的结果"——
//   换了档位 / 改了选字之后它还原样挂着，就会出现"切到别的档位了、那句'还没有选字…'还在"。
//   「最近产物」那一行（lastResult）是另一套数据、照旧留着（它说的是已经下到手的那份 zip）。
watch([scope, orderMode, () => store.selectedCount], () => {
  if (message.value) setMessage('', 'info')
  schedulePreview()
})
onMounted(() => { schedulePreview() })

// 生成这一轮的**模板压缩包**（决策 一-17）：模板 PDF + 空白更正册 + 完整说明 + 字序文件，
// 套一层带日期的文件夹打进 zip；单页试打与正式范围走同一条路（用户口径：试打也出压缩包）。
// 顺序上先出模板（最慢、最要紧），再出更正册、取说明、写字序文件，最后一次性打包。
async function generatePack() {
  if (busy.value) return
  busy.value = true
  lastResult.value = null
  try {
    const stamp = dateStamp()
    const names = templatePackNames(stamp, { correctionPages: CORRECTION_BOOK_PAGES })
    setMessage('正在读取字体、生成模板 PDF…', 'info')
    const { out, font, chars } = await buildCurrentPdf()
    setMessage('正在生成空白更正册（' + CORRECTION_BOOK_PAGES + ' 页）…', 'info')
    progress.value = { done: 0, total: CORRECTION_BOOK_PAGES }
    const book = await buildCorrectionBookPdf({
      pageCount: CORRECTION_BOOK_PAGES,
      fontBytes: font.bytes,
      onProgress: (done, total) => { progress.value = { done, total } }
    })
    // 《使用说明》取不到**不算致命**：模板与字序才是这一步的核心产物 —— 少一件就在消息里说清，
    // 不能让"说明没取到"把整包纸挡下来（说明另有入口：每一步标题行的「查看完整说明」）
    setMessage('正在打包…', 'info')
    const guideHtml = await loadGuideHtml().catch(() => null)
    const order = buildOrderFile({
      chars,
      scope: scope.value,
      scopeLabel: scopeLabelOf(scope.value),
      order: orderMode.value,
      orderLabel: orderModeLabel(orderMode.value),
      perPage: LAYOUT.perPage
    })
    const packed = await packTemplateZip({
      templateBytes: out.bytes,
      correctionBytes: book.bytes,
      guideHtml: guideHtml || '',
      orderFile: order,
      stamp,
      correctionPages: CORRECTION_BOOK_PAGES
    })
    // **第 1 步不记批次**（决策 五-9 ⑩）：模板只是"一张纸"，不再产生项目数据；这里只留一笔
    // "生成过模板"的元信息 —— 它既是进度判据（flow.js 的 templatePages），也是"最近产物"的来源。
    // 这一页写了哪些字、该按什么字序对应，第 2 步读包里的字序文件就知道（没有文件时才认参考字）。
    store.setTemplateGenerated({
      sheetPages: out.sheetPages,
      charCount: chars.length,
      order: orderMode.value,
      scope: scope.value,
      fileName: packed.names.zip
    })
    downloadBytes(packed.bytes, packed.names.zip, 'application/zip')
    // 下载用的是**整份**（与预览无关）：这里不再把它塞给预览 —— 预览是"按需单页"，
    // 塞整份进去既白占内存，又会让"这一份里只有一页"的约定失效（翻页语义跟着变）。
    lastResult.value = {
      zip: packed.names.zip,
      folder: packed.names.folder,
      bytes: packed.bytes.length,
      sheetPages: out.sheetPages,
      selfCheck: out.selfCheck,
      correctionPages: book.pageCount,
      charCount: order.charCount,
      font: font.label,
      withGuide: !!guideHtml
    }
    const mb = (packed.bytes.length / 1024 / 1024).toFixed(2)
    setMessage(
      '模板压缩包已生成并开始下载：' + packed.names.zip + '（' + mb + ' MB）。解压得到文件夹「' +
        packed.names.folder + '」，里面有模板 ' + out.sheetPages + ' 字表页' +
        (out.selfCheck ? ' + 1 页自检' : '') + '、更正册 ' + book.pageCount + ' 页、字序文件' +
        (guideHtml ? '与完整说明' : '（完整说明这次没取到，包内少了它，不影响打印）') +
        '。参考字用' + font.label + '；打印前先用尺子量自检页上的 1cm 方框。',
      guideHtml ? 'done' : 'info'
    )
  } catch (e) {
    // NO_CHARS 不是故障、是"还差一步操作"：直接用它的中文提示（不加"生成失败："前缀）
    const noChars = !!(e && e.code === 'NO_CHARS')
    setMessage(noChars ? e.message : '生成失败：' + (e && e.message ? e.message : e), noChars ? 'info' : 'error')
  } finally {
    busy.value = false
    progress.value = { done: 0, total: 0 }
  }
}

// 原「生成更正册（空白 5 页）」独立按钮已去掉（决策 一-17 ⑤）：它现在是模板压缩包里的第二件，
// 页数固定为 CORRECTION_BOOK_PAGES，随包一起出 —— 用户不必再单独下一次、也不必自己对上两份纸。

</script>

<template>
  <div class="step-body">
    <!-- 写哪些字：**一组三选**（2026-10-07 把原来的「选字」与「生成范围」两组单选合并成这一组；
         2026-10-08 换官方字表后第二项由「全量字表（6919 字）」改为「常用 6500 字」，全量走自定义选字里的
         「全选全部」—— 口径见《决策记录》三-1、八-1；右侧问号是来源核对 + 官方说明节选，口径说明在本步末尾） -->
    <div class="panel-row">
      <div class="panel-field">
        <span class="field-label">写哪些字</span>
        <label class="radio"><input v-model="scope" type="radio" value="single" :disabled="busy" />单页试打</label>
        <label class="radio"><input v-model="scope" type="radio" value="common" :disabled="busy" />常用 6500 字</label>
        <label class="radio"><input v-model="scope" type="radio" value="custom" :disabled="busy" />自定义选字</label>
        <span class="help-holder">
          <button
            class="help-button"
            type="button"
            data-role="charset-help"
            :aria-expanded="standardHelpOpen ? 'true' : 'false'"
            aria-label="字表按什么标准收字"
            @click="toggleStandardHelp"
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.3" />
              <path d="M6.1 6.2a1.9 1.9 0 0 1 3.7.6c0 1.1-1.8 1.2-1.8 2.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
              <circle cx="8" cy="11.4" r="0.8" fill="currentColor" />
            </svg>
          </button>
          <div v-if="standardHelpOpen" class="help-popover" data-role="charset-help-popover" :style="standardHelpStyle" role="dialog" aria-label="字表标准与收字口径">
            <!-- 来源与核对放最上面（用户 2026-10-08 要求）：先交代"这批字是哪来的、怎么核过的"，再给官方说明 -->
            <div class="help-source">
              <p class="help-title">来源与核对</p>
              <ul class="help-notes">
                <li v-for="(line, i) in CHARSET_STANDARD_SOURCES" :key="i">{{ line }}</li>
              </ul>
              <p>{{ CHARSET_SCOPE_LINE }}</p>
            </div>
            <!-- 官方说明只给节选（第二至第八条，用户 2026-10-08 要求）：第一条讲制定目的、第九条讲附表、
                 第十条讲后续调整，都不涉及"收哪些字、怎么分级" -->
            <p class="help-title">{{ CHARSET_STANDARD_TITLE }}官方说明节选</p>
            <!-- 列表只留圆点、不显示条号（用户 2026-10-08 要求）；条号仍留在数据里（note.no）备查 -->
            <ul class="help-notes">
              <li v-for="note in CHARSET_STANDARD_NOTES" :key="note.no">{{ note.text }}</li>
            </ul>
            <button class="text" type="button" @click="standardHelpOpen = false">关闭</button>
          </div>
        </span>
        <span class="panel-hint" data-role="scope-hint">{{ scopeHint }}</span>
      </div>
    </div>
    <SelectionPanel v-if="pickerOpen" nested />

    <div class="panel-row" data-role="order-mode-row">
      <div class="panel-field">
        <span class="field-label">排列方式</span>
        <!-- 选了「单页试打」时这一项置灰（2026-10-16 用户口径）：试打页是一页固定顺序的名句，
             按频序 / 笔画序重排没有意义；置灰并在下面的说明里写明"试打按名句本身的顺序" -->
        <label class="radio"><input v-model="orderMode" type="radio" value="rank" :disabled="busy || orderDisabled" />按使用频率</label>
        <label class="radio"><input v-model="orderMode" type="radio" value="charset" :disabled="busy || orderDisabled" />笔画序</label>
        <span class="panel-hint" data-role="order-hint">{{ orderHint }}</span>
      </div>
    </div>

    <!-- 2026-10-15 用户口径：**去掉「参考字体」这一整行**（"内置楷体…固定用它 —— 识别时靠认出纸面上印的
         参考字…"）—— 参考字用什么字体是程序的内部选择，写在界面上只是给用户多一段要读的字；
         为什么不能换、认字定序的道理在《使用说明》里（决策 一-15：正文只有一份）。
         注：`BUILTIN_FONT_LABEL` 仍被 `resolveFont()` 用作返回值的标签，import 保留 -->

    <!-- 预览：真实 PDF 渲染（与点「生成模板 PDF」得到的内容完全一致）。
         原来这里有一行「打印预览」标签 + 一段说明（左边是模板、右边是「书写示意」、示意只看不打印……）——
         2026-10-08 按用户要求收进《使用说明》：界面上每多一段长文，真正的操作按钮就更难找。
         「更新预览」按钮改由 Teleport 送到步骤标题行（「查看完整说明」左边），见下面的 Teleport -->
    <Teleport to="#step-head-actions">
      <button class="text" type="button" :disabled="previewBusy || busy" @click="refreshPreview">
        {{ previewBusy ? '正在生成预览…' : '更新预览' }}
      </button>
    </Teleport>
    <!-- 两块预览并排：左边是**真会打印出来的模板**，右边是"照着写好的样子"（书写示意）。
         版式都由 LAYOUT 统一控制，两边逐格对应；窄窗口自动改为上下堆叠（style.css 的 .preview-pair） -->
    <div class="preview-pair">
      <PdfPreview
        :bytes="previewBytes"
        :loading="previewBusy"
        :page-no="previewPage"
        :page-count="previewPages"
        :max-width="640"
        :page-ratio="pageRatio"
        title="模板预览（与实际打印逐格一致，最后一页是打印自检页）"
        empty-text="还没有可预览的字：换个档位，或在下面「自定义选字」里挑几个字"
        @page-change="onPreviewPageChange"
      />
      <PdfPreview
        :bytes="sampleBytes"
        :loading="sampleBusy"
        :page-no="samplePage"
        :page-count="samplePages"
        :max-width="640"
        :page-ratio="pageRatio"
        title="书写示意（按悠哉字体示意书写格式）"
        empty-text="书写示意还没生成出来"
        @page-change="onSamplePageChange"
      />    </div>
    <p v-if="sampleNote" class="panel-message error">{{ sampleNote }}</p>

    <div class="panel-actions">
      <button class="primary" data-role="generate-pack" :disabled="busy" @click="generatePack">生成并下载模板压缩包</button>
      <span v-if="busy && progress.total" class="panel-hint">进度 {{ progress.done }} / {{ progress.total }} 页</span>
      <!-- 自定义档一个字都没选：按钮旁常驻一行说明（切档位 / 选字都会立刻跟着变，见 noChars 的注释） -->
      <span v-if="noChars" class="panel-hint" data-role="template-nochars">
        还没有选字：在下面挑几个字，或把「写哪些字」换成别的档位
      </span>
    </div>

    <!-- data-role：给自动化测试一个稳定锚点（本步还有一条"书写示意失败"的消息，同样用 .panel-message） -->
    <p v-if="message" class="panel-message" :class="messageType" data-role="template-message">{{ message }}</p>
    <p v-if="lastResult" class="panel-hint" data-role="template-result">
      最近产物：{{ lastResult.zip }} —— 解压得到「{{ lastResult.folder }}」文件夹：模板 {{ lastResult.sheetPages }} 字表页<span
        v-if="lastResult.selfCheck"
      > + 1 自检页</span>、更正册 {{ lastResult.correctionPages }} 页、字序文件（{{ lastResult.charCount }} 字）<span
        v-if="lastResult.withGuide"
      >、完整说明</span>；共 {{ (lastResult.bytes / 1024 / 1024).toFixed(2) }} MB，参考字字体：{{ lastResult.font }}
    </p>

    <!-- 纯说明类长文（打印设置 / 书写要求 / 扫描设置）已整合进《使用说明》单文件页（决策 一-15）：
         界面这里只留"这一步马上要用的几句"，正文只有一份，改口径时不会两处各说各话。
         2026-10-11 三步流程（决策 八-15 ②）：原「手写与扫描」不再占一步，它的要点并进这一段 ——
         它是纸面动作、本来就只有几句说明，单独占一步只会让流程看起来更长 -->
    <p class="panel-hint">
      <strong>打印</strong>：彩色喷墨、<strong>打印质量选「高」</strong>、<strong>实际大小 / 100%</strong>、<strong>不勾「无边距」</strong>；先打最后一页自检页量一下 1cm 方框。<br />
      <strong>书写</strong>：0.5mm 黑色中性笔，<strong>居中书写、别出格</strong> —— 笔画多的字写到刚刚触到格子边，笔画少的字居中写小些；不描不改；
      写错的字用红笔<strong>把这一格的参考字圈起来</strong>，要重写的字写到更正册上。<br />
      <strong>扫描</strong>：<strong>彩色 300dpi、照片模式</strong>，一页一个文件；如用手机扫描 App（如扫描全能王），选<strong>「智能高清」（默认档）</strong>。
      <!-- 2026-10-16 用户要求：原来这里那句「没写的字会回退、不必写完也能用」（data-role="fallback-hint"）
           整句去掉 —— 它的"Word 里显示成方框"与实测不符（Word 也会回退成系统字体），而且这一步下方
           该只留"打印 / 书写 / 扫描"三句马上要用的操作提示；缺字与分批的口径只在《使用说明》里讲 -->
    </p>
  </div>
</template>
