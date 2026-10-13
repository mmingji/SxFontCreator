<script setup>
// 第 1 步：选字与出模板（阶段一步骤 1.3 的界面；2026-10-04 按用户要求改造成向导的第一步）
// 职责：① 选**写哪些字**（**一组三选**：单页试打 / 常用 6500 字 / 自定义选字，2026-10-07 由原来的
//      「选字 + 生成范围」两组单选合并而来；2026-10-08 换官方字表后第二项由"全量字表"改为"常用 6500 字"）
//   ② 选排列方式与参考字体
//   ③ **先看到模板第一页的真实预览**（pdf.js 渲染真实 PDF）④ 生成模板 PDF / 更正册并下载。
// 版面：由 templatePdf.js 的 LAYOUT 统一控制（A4 横向、每页 136 格，见《决策记录》一-3、一-4）。
// 数据来源：字表来自 src/lib/charset.js（8274 字 = 官方 8105 + 基础字符 169，决策 三-1、八-1、八-2）；
//   字体来自 referenceFont.js（内置子集或本机字体）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { LAYOUT, buildTemplatePdf, buildCorrectionBookPdf, buildSamplePagePdf } from '../lib/templatePdf.js'
import { getAllChars, getCharsetMeta } from '../lib/charset.js'
import { CHAR_RANK_META, getRankOrder, sortByRank } from '../lib/charRank.js'
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
import { orderModeLabel, scopePreset } from '../lib/templateScope.js'
import { useProjectStore } from '../store/project.js'
import SelectionPanel from './SelectionPanel.vue'
import PdfPreview from './PdfPreview.vue'

const store = useProjectStore()
const meta = getCharsetMeta()
// 字表构成的几个数字**全部从字表分级算出来**，不硬编码 —— 改字表时口径说明自动跟着变。
// 「常用 6500 字」档 = 一级 3500 + 二级 3000 + 基础字符 169 = 6669 字；
// 全量（8274 字）走「自定义选字」里的「全选全部」。
const l1Count = getLevelChars('l1').length
const l2Count = getLevelChars('l2').length
const baseCount = getLevelChars('base').length
const commonCount = l1Count + l2Count + baseCount
const commonPages = Math.ceil(commonCount / LAYOUT.perPage)

// 写哪些字出模板：**一组三选**（2026-10-07 用户要求把原来的「选字 + 生成范围」两组单选合并成一组）。
//   single —— 单页试打：只出第 1 页（前 136 字）+ 自检页，先确认版式与打印设置
//   common —— 常用 6500 字：一级 + 二级 + 基础字符全出（按当前排列方式）
//   custom —— 自定义选字：展开下面的选字面板，按已选的字出；一个字都没选时与"全量"（8274 字）等价
// 默认单页试打（用户 2026-10-04 拍板）：先打一页确认版式，再打正式的。
// 正式范围（常用 6500 字 / 自定义选字）出模板时会记一个批次，单页试打不记。
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

// 预览：存的是**真实生成的模板 PDF 字节**（与点「生成模板 PDF」得到的是同一份内容），
// 交给 PdfPreview 用 pdf.js 渲染第 1 页 —— 用户下单前就能看到"打出来长什么样"
const previewBytes = ref(null)
const previewBusy = ref(false)

// 书写示意（用户 2026-10-07 要求，原名"填写示意"、2026-10-08 按用户要求改名）：与模板**同版式**的一页，
// 但每个书写格里已经用工整手写体写好了那个字，让用户一眼看到"这个格子应该写成什么样"
// （口径见《决策记录》一-13：笔画多的字撑满格、天生小的字居中写小）。
// 三点约束：① **页数与当前范围一致**（2026-10-08 由"只出第 1 页"改成跟着范围逐页生成、可翻页，见一-14 ②）；
//   ② **不进正式模板 PDF**（它是给人看的示范，不是打印件，也不画定位块与页脚编码）；
//   ③ 参考字用当前选的字体，示范字固定用内置手写体子集（悠哉字体，OFL-1.1）。
const sampleBytes = ref(null)
const sampleBusy = ref(false)
const sampleNote = ref('')
// 手写体子集 3.84MB：一个会话只 fetch 一次，之后所有示意页复用同一份字节
let handwritingFont = null
async function resolveHandwritingFont() {
  if (!handwritingFont) handwritingFont = await loadHandwritingFont()
  return handwritingFont
}
async function refreshSample(fontBytes, chars) {
  sampleBusy.value = true
  try {
    const sampleFont = await resolveHandwritingFont()
    // **不截断**：示意页与模板同页数（2026-10-07 用户拍板），全量时是 51 页，预览可以翻页看
    const out = await buildSamplePagePdf({
      chars,
      fontBytes,
      sampleFontBytes: sampleFont
    })
    sampleBytes.value = out.bytes
    sampleNote.value = ''
  } catch (e) {
    // 示意页失败不影响模板预览与生成：只在这一块显示中文原因
    sampleNote.value = '书写示意生成失败：' + (e && e.message ? e.message : e)
  } finally {
    sampleBusy.value = false
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
    return '单页试打：只生成第 1 页（前 ' + LAYOUT.perPage + ' 字）+ 打印自检页，先确认版式与打印设置'
  }
  if (scope.value === 'custom') {
    return store.selectedCount
      ? '自定义选字：已选 ' + store.selectedCount + ' 字 ≈ ' + Math.ceil(store.selectedCount / LAYOUT.perPage) + ' 页'
      : '自定义选字：还没有选字 —— 一个字都没选时按全部 ' + meta.total + ' 字出（等于「全选全部」），下面是选字面板'
  }
  return '一级 ' + l1Count + ' 字 + 二级 ' + l2Count + ' 字 + 基础字符 ' + baseCount +
    ' = 常用 ' + commonCount + ' 字／' + commonPages + ' 页'
})

// 排列方式：默认**按使用频率** —— 最常用的字排在最前，前 2000 字覆盖日常语料 97.13%（约 15 页）、
// 前 6500 字覆盖 99.99%（约 48 页），频序本身也把同偏旁的字打散了（笔画序会让同偏旁的字挨在一起，很疲劳）。
// 「笔画序」= 《通用规范汉字表》的官方字序（说明第八条：遵循《GB 13000.1 字符集汉字字序（笔画序）规范》）。
// 两种顺序都能被识别 —— 批次记的是实际字序，页脚校验码也按字序算（决策 八-6、八-10），换顺序不影响比对。
const orderMode = computed({
  get: () => store.ui.orderMode,
  set: (value) => store.setOrderMode(value)
})
const orderHint = computed(() => {
  if (orderMode.value === 'rank') {
    return '最常用的字在最前（前 2000 字覆盖语料 ' + CHAR_RANK_META.cumAt2000 + '%，约 ' +
      Math.ceil(2000 / LAYOUT.perPage) + ' 页即可日常使用）'
  }
  return '《通用规范汉字表》的官方字序'
})

// 实际要排的字：先按"排列方式"定全序，再按上面三选一取子集
// （单页试打取前 136 字 —— 频序下就是最常用的 136 字；常用 6500 字取一级 + 二级 + 基础字符；
//  自定义选字取已选的字，一个字都没选时按全量 8274 字）
function charsForScope() {
  const wantRank = orderMode.value === 'rank'
  const base = wantRank ? getRankOrder() : getAllChars()
  if (scope.value === 'single') return base.slice(0, LAYOUT.perPage)
  if (scope.value === 'common') {
    const picked = [...getLevelChars('l1'), ...getLevelChars('l2'), ...getLevelChars('base')]
    return wantRank ? sortByRank(picked) : picked
  }
  if (scope.value === 'custom') {
    const picked = Array.from(store.charsForTemplate)
    if (!picked.length) return base
    return wantRank ? sortByRank(picked) : picked
  }
  return base
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
  progress.value = { done: 0, total: Math.ceil(chars.length / LAYOUT.perPage) }
  const out = await buildTemplatePdf({
    chars,
    fontBytes: font.bytes,
    onProgress: onStep || ((done, total) => { progress.value = { done, total } })
  })
  return { out, font, chars }
}

// 预览：防抖 300ms —— 连续切换范围 / 排列方式时不至于每点一下都重算一遍整份 PDF
let previewTimer = null
function schedulePreview() {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(() => { refreshPreview() }, 300)
}
async function refreshPreview() {
  if (previewBusy.value) return
  previewBusy.value = true
  try {
    const { out, font, chars } = await buildCurrentPdf()
    previewBytes.value = out.bytes
    // 书写示意跟在模板预览之后生成：**同一批字、同一个参考字字体**（换本机字体时两块一起变），
    // 页数与模板一致（2026-10-07 用户拍板），所以全量时这里会多花约 1 秒生成 51 页
    await refreshSample(font.bytes, chars)
  } catch (e) {
    setMessage('预览生成失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    previewBusy.value = false
    progress.value = { done: 0, total: 0 }
  }
}
onBeforeUnmount(() => { clearTimeout(previewTimer) })
// 影响版面的输入一变就重出预览；打开这一步时先出一次（用户不用先点按钮才能看到东西）
watch([scope, orderMode, () => store.selectedCount], () => { schedulePreview() })
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
      perPage: LAYOUT.perPage,
      batchCode: out.batchCode
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
    // 下载用的就是刚生成的那份模板，顺手把它给预览，省一次重算
    previewBytes.value = out.bytes
    lastResult.value = {
      zip: packed.names.zip,
      folder: packed.names.folder,
      bytes: packed.bytes.length,
      sheetPages: out.sheetPages,
      selfCheck: out.selfCheck,
      correctionPages: book.pageCount,
      charCount: order.charCount,
      batchCode: out.batchCode,
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
    setMessage('生成失败：' + (e && e.message ? e.message : e), 'error')
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
        <span class="panel-hint">{{ scopeHint }}</span>
      </div>
    </div>
    <SelectionPanel v-if="pickerOpen" nested />

    <div class="panel-row" data-role="order-mode-row">
      <div class="panel-field">
        <span class="field-label">排列方式</span>
        <label class="radio"><input v-model="orderMode" type="radio" value="rank" :disabled="busy" />按使用频率</label>
        <label class="radio"><input v-model="orderMode" type="radio" value="charset" :disabled="busy" />笔画序</label>
        <span class="panel-hint">{{ orderHint }}</span>
      </div>
    </div>

    <div class="panel-row">
      <div class="panel-field">
        <span class="field-label">参考字体</span>
        <span class="panel-hint" data-role="ref-font-note">{{ BUILTIN_FONT_LABEL }}，固定用它 —— 识别时靠认出纸面上印的参考字，才能判断这一页写了哪些字。</span>
      </div>
    </div>

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
        :max-width="640"
        title="模板预览（与实际打印逐格一致，最后一页是打印自检页）"
      />
      <PdfPreview
        :bytes="sampleBytes"
        :loading="sampleBusy"
        :max-width="640"
        title="书写示意（按悠哉字体示意书写格式）"
        empty-text="书写示意还没生成出来"
      />    </div>
    <p v-if="sampleNote" class="panel-message error">{{ sampleNote }}</p>

    <div class="panel-actions">
      <button class="primary" data-role="generate-pack" :disabled="busy" @click="generatePack">生成并下载模板压缩包</button>
      <span v-if="busy && progress.total" class="panel-hint">进度 {{ progress.done }} / {{ progress.total }} 页</span>
    </div>

    <!-- data-role：给自动化测试一个稳定锚点（本步还有一条"书写示意失败"的消息，同样用 .panel-message） -->
    <p v-if="message" class="panel-message" :class="messageType" data-role="template-message">{{ message }}</p>
    <p v-if="lastResult" class="panel-hint" data-role="template-result">
      最近产物：{{ lastResult.zip }} —— 解压得到「{{ lastResult.folder }}」文件夹：模板 {{ lastResult.sheetPages }} 字表页<span
        v-if="lastResult.selfCheck"
      > + 1 自检页</span>、更正册 {{ lastResult.correctionPages }} 页、字序文件（{{ lastResult.charCount }} 字 · 校验码 {{ lastResult.batchCode }}）<span
        v-if="lastResult.withGuide"
      >、完整说明</span>；共 {{ (lastResult.bytes / 1024 / 1024).toFixed(2) }} MB，参考字字体：{{ lastResult.font }}
    </p>

    <!-- 纯说明类长文（打印设置 / 书写要求 / 扫描设置）已整合进《使用说明》单文件页（决策 一-15）：
         界面这里只留"这一步马上要用的几句"，正文只有一份，改口径时不会两处各说各话。
         2026-10-11 三步流程（决策 八-15 ②）：原「手写与扫描」不再占一步，它的要点并进这一段 ——
         它是纸面动作、本来就只有几句说明，单独占一步只会让流程看起来更长 -->
    <p class="panel-hint">
      <strong>打印</strong>：彩色喷墨、<strong>实际大小 / 100%</strong>、<strong>不勾「无边距」</strong>；先打最后一页自检页量一下 1cm 方框。<br />
      <strong>书写</strong>：0.5mm 黑色中性笔，<strong>居中书写、别出格</strong> —— 笔画多的字写到刚刚触到格子边，笔画少的字居中写小些；不描不改；
      写错的字用红笔<strong>把这一格的参考字圈起来</strong>，要重写的字写到更正册上。<br />
      <strong>扫描</strong>：<strong>彩色 300dpi、照片模式</strong>，一页一个文件；手机 App 选<strong>「智能高清」（默认档）</strong>。<br />
      <!-- 「写哪些字」下面那段"没写的字会回退、不必写完也能用"按用户要求插在这个位置：
           扫描那一句之后、"完整说明见…"之前；随选择变化的"这次排哪些字、多少页"仍留在上面那一组里 -->
      <span data-role="fallback-hint">没写的字不会进字体：Word 里显示成方框、浏览器与 PS 里回退成系统字体，<strong>已写的字不受影响</strong> —— 不必一次写完。</span>
    </p>
  </div>
</template>
