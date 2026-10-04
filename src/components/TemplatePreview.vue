<script setup>
// 模板与更正册生成面板（阶段一步骤 1.3）
// 职责：选参考字字体来源 → 生成模板 / 更正册 PDF → 交给浏览器下载
// 数据来源：字表来自 src/lib/charset.js（6919 字，顺序即模板字序）；字体来自 referenceFont.js
// 版面：由 templatePdf.js 的 LAYOUT 统一控制（A4 横向、每页 136 格，见《决策记录》一-3、一-4）
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { LAYOUT, buildTemplatePdf, buildCorrectionBookPdf } from '../lib/templatePdf.js'
import { getAllChars, getCharsetMeta } from '../lib/charset.js'
import { CHAR_RANK_META, getRankOrder, sortByRank } from '../lib/charRank.js'
import { BUILTIN_FONT_LABEL, loadBuiltinFont, loadFontFromFile } from '../lib/referenceFont.js'
import { useProjectStore } from '../store/project.js'

const store = useProjectStore()
const meta = getCharsetMeta()
const totalPages = Math.ceil(meta.total / LAYOUT.perPage)

// 字形测试页的 12 个字：覆盖"极简 → 极繁、方框 → 凹形 → 多部件"，专测清单三-2 的细笔画分辨率
// 与决策 二-2 里"口形被误判成红圈"的样本；已逐个核对都在字表内（字表外的字会印成方块）
const TEST_PAGE_CHARS = ['一', '十', '口', '日', '国', '永', '凹', '凸', '瓣', '囊', '霸', '懿']

// 范围：单页试打（先确认版式与打印设置）/ 当前选字 / 全量；有选字时默认按选字出
const scope = ref(store.selectedCount ? 'selection' : 'full')
// 字体来源：内置子集 / 用户选的本机字体
const fontSource = ref('builtin')
const localFontName = ref('')
// 本机字体的规整结果：{ bytes, format, label, note }（ttc 会被提取出单个字体、woff 会解包，见 lib/fontFormat.js）
let localFont = null

const busy = ref(false)
const message = ref('')
const messageType = ref('info') // info | error | done
const progress = ref({ done: 0, total: 0 })
const lastResult = ref(null) // { name, pages, bytes }

// 「本机字体怎么选」的浮窗：这段说明较长（Windows 字体目录带「系统」属性、两条绕开办法、macOS 目录），
// 常驻会把面板撑长，所以收进问号按钮后面，点击展开；点击别处或按 Esc 收起。
const fontHelpOpen = ref(false)
// 浮窗位置在打开时按按钮位置算，并夹进视口：实测固定的 left / right 都不行 ——
// 1180px 视口下向左展开会把文字裁在视口外（左边缘到 -53px），900px 视口下向右展开又顶出右边界。
const fontHelpStyle = ref({ left: '0px', top: 'calc(100% + 8px)' })
function toggleFontHelp(e) {
  if (fontHelpOpen.value) {
    fontHelpOpen.value = false
    return
  }
  const holder = e.currentTarget.closest('.font-help')
  const btnRect = e.currentTarget.getBoundingClientRect()
  const holderRect = holder.getBoundingClientRect()
  const width = Math.min(560, window.innerWidth - 48)
  const minLeft = 12 - holderRect.left
  const maxLeft = window.innerWidth - width - 12 - holderRect.left
  // 相对 .font-help 的偏移，三级优先：① 右对齐到按钮右边缘（浮窗贴问号左下）② 放不下就左对齐到按钮
  // ③ 仍放不下（窄窗口）再夹进视口 —— 这样 1180px 下浮窗正好落在问号下方，900px 下贴着右边界也不溢出
  let left = btnRect.right - holderRect.left - width
  if (left < minLeft) left = btnRect.left - holderRect.left
  left = Math.max(minLeft, Math.min(maxLeft, left))
  fontHelpStyle.value = { left: Math.round(left) + 'px', top: 'calc(100% + 8px)', width: Math.round(width) + 'px' }
  fontHelpOpen.value = true
}
function onDocumentClick(e) {
  // 点在任何 .font-help 区域（问号或浮窗）内都不关闭 —— 否则"点问号展开"会被同一次冒泡立刻收掉
  if (!e.target || !e.target.closest || !e.target.closest('.font-help')) fontHelpOpen.value = false
}
function onDocumentKeydown(e) {
  if (e.key === 'Escape') fontHelpOpen.value = false
}
onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onDocumentKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onDocumentKeydown)
})

const scopeHint = computed(() => {
  if (scope.value === 'single') {
    return '单页试打：只生成第 1 页（前 ' + LAYOUT.perPage + ' 字），先打印确认版式与打印设置'
  }
  if (scope.value === 'selection') {
    return store.selectedCount
      ? '当前选字：' + store.selectedCount + ' 字 ≈ ' + Math.ceil(store.selectedCount / LAYOUT.perPage) + ' 页'
      : '还没有选字 —— 请先在上面「选字」面板里挑字；不选字时按全量出'
  }
  return '全量：' + meta.total + ' 字／' + totalPages + ' 页'
})

// 排列方式（2026-10-04 按用户要求加）：默认**按使用频率** —— 最常用的字排在最前，
// 前 2000 字覆盖日常语料 97.1%（约 15 页），整套 51 页里前 28 页就够日常使用；
// 频序本身也把同偏旁的字打散了（拼音字序会让同偏旁的字挨在一起，一页写下来很疲劳）。
// 「字表顺序」保留给想跟做字体网 V4.0 模板对齐的人；两种顺序都能被识别 —— 批次记的是实际字序，
// 页脚校验码也是按字序算的（决策 八-6、八-10），所以换顺序不会影响"扫描件与批次匹配"的判定。
const orderMode = ref('rank')
const orderHint = computed(() => {
  if (orderMode.value === 'rank') {
    return '按使用频率：最常用的字在最前（前 2000 字覆盖语料 ' + CHAR_RANK_META.cumAt2000 + '%，约 ' +
      Math.ceil(2000 / LAYOUT.perPage) + ' 页即可日常使用）；' + CHAR_RANK_META.missing +
      ' 个未被字频表收录的字（部首、超纲字与符号）排在最后'
  }
  return '字表顺序（拼音）：与做字体网 V4.0 模板一致，同偏旁的字容易挨在一起'
})

// 实际要排的字：先按"排列方式"定全序，再按范围取子集
// （试打取前 136 字 —— 频序下就是最常用的 136 字；选字取当前选字；全量取全部）
function charsForScope() {
  const base = orderMode.value === 'rank' ? getRankOrder() : getAllChars()
  if (scope.value === 'single') return base.slice(0, LAYOUT.perPage)
  if (scope.value === 'selection') {
    const picked = Array.from(store.charsForTemplate)
    if (!picked.length) return base
    return orderMode.value === 'rank' ? sortByRank(picked) : picked
  }
  return base
}

function setMessage(text, type) {
  message.value = text
  messageType.value = type || 'info'
}

async function pickLocalFont(event) {
  const file = event.target.files && event.target.files[0]
  if (!file) return
  try {
    localFont = await loadFontFromFile(file)
    localFontName.value = file.name
    fontSource.value = 'local'
    // note 说明"格式被怎么处理了"（如从字体集合里取用了第几个），有就带上
    const note = localFont.note ? '，' + localFont.note : ''
    setMessage('已选用本机字体：' + file.name + '（' + localFont.label + note + '；只在本机内存中使用）', 'info')
  } catch (e) {
    localFont = null
    localFontName.value = ''
    fontSource.value = 'builtin'
    setMessage(e.message, 'error')
  } finally {
    // 清空 input，便于再次选择同一个文件
    event.target.value = ''
  }
}

async function resolveFont() {
  if (fontSource.value === 'local' && localFont) {
    return { bytes: localFont.bytes, label: '本机字体（' + localFontName.value + '）' }
  }
  return { bytes: await loadBuiltinFont(), label: BUILTIN_FONT_LABEL }
}

function download(bytes, filename) {
  // 用原生 Blob + a[download]，不引额外依赖
  const blob = new Blob([bytes], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 交给浏览器读完再回收
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

async function generateTemplate() {
  if (busy.value) return
  busy.value = true
  progress.value = { done: 0, total: 0 }
  lastResult.value = null
  try {
    setMessage('正在读取字体…', 'info')
    const font = await resolveFont()
    const chars = charsForScope()
    progress.value = { done: 0, total: Math.ceil(chars.length / LAYOUT.perPage) }
    setMessage('正在生成模板 PDF…', 'info')
    const out = await buildTemplatePdf({
      chars,
      fontBytes: font.bytes,
      onProgress: (done, total) => {
        progress.value = { done, total }
      }
    })
    // 单页试打只为确认版式，不记批次（否则批次列表会被试打记录塞满）；
    // 正式出模板则记一个批次：字序 + 页数 + 校验码都要留痕，上传扫描件时按它比对（八-6、八-10）
    let batchNote = ''
    if (scope.value !== 'single') {
      const batch = store.addBatch({ pageCount: out.sheetPages, chars: chars.join(''), order: orderMode.value })
      batchNote = '；已记为批次，校验码 ' + batch.batchCode
    }
    const name = 'SxFontCreator-模板-' + (scope.value === 'single' ? '试打1页' : out.sheetPages + '页') + '.pdf'
    download(out.bytes, name)
    lastResult.value = { name, pages: out.pageCount, sheetPages: out.sheetPages, bytes: out.bytes.length, font: font.label, batchCode: out.batchCode }
    const mb = (out.bytes.length / 1024 / 1024).toFixed(2)
    const selfNote = out.selfCheck ? '；最后 1 页是打印自检页，先用尺子量 1cm 方框再开始手写' : ''
    setMessage(
      '模板已生成并开始下载：' + out.sheetPages + ' 字表页' + (out.selfCheck ? ' + 1 页自检' : '') +
        '（' + mb + ' MB），参考字用' + font.label + '，批次校验码 ' + out.batchCode + batchNote + selfNote,
      'done'
    )
  } catch (e) {
    setMessage('生成失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    busy.value = false
  }
}

// 字形测试页：12 个字，专供打印实测（细笔画是否断续、方框与凹形结构、多笔画是否糊成一团）
// 它不是正式书写页、不记批次，但页脚仍带自己的校验码，便于确认这份 PDF 的身份
async function generateTestPage() {
  if (busy.value) return
  busy.value = true
  progress.value = { done: 0, total: 0 }
  lastResult.value = null
  try {
    setMessage('正在读取字体…', 'info')
    const font = await resolveFont()
    setMessage('正在生成字形测试页…', 'info')
    const out = await buildTemplatePdf({ chars: TEST_PAGE_CHARS, fontBytes: font.bytes })
    const name = 'SxFontCreator-字形测试页-12字.pdf'
    download(out.bytes, name)
    lastResult.value = { name, pages: out.pageCount, sheetPages: out.sheetPages, bytes: out.bytes.length, font: font.label, batchCode: out.batchCode }
    setMessage(
      '字形测试页已生成并开始下载：' + TEST_PAGE_CHARS.join('、') + '，共 ' + out.pageCount +
        ' 页（含自检页），校验码 ' + out.batchCode,
      'done'
    )
  } catch (e) {
    setMessage('生成失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    busy.value = false
  }
}

async function generateCorrectionBook() {
  if (busy.value) return
  busy.value = true
  progress.value = { done: 0, total: 0 }
  try {
    setMessage('正在读取字体…', 'info')
    const font = await resolveFont()
    const bookPages = 5
    progress.value = { done: 0, total: bookPages }
    setMessage('正在生成更正册…', 'info')
    const out = await buildCorrectionBookPdf({
      pageCount: bookPages,
      fontBytes: font.bytes,
      onProgress: (done, total) => {
        progress.value = { done, total }
      }
    })
    const name = 'SxFontCreator-更正册-空白' + bookPages + '页.pdf'
    download(out.bytes, name)
    setMessage('更正册已生成并开始下载：' + out.pageCount + ' 页（空白册，每格带连续格号）', 'done')
  } catch (e) {
    setMessage('生成失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="card">
    <div class="panel-head">
      <h2>模板与更正册</h2>
      <div class="panel-head-actions">
        <button class="text" :disabled="busy" @click="generateTestPage">生成字形测试页（12 字）</button>
        <button class="text" :disabled="busy" @click="generateCorrectionBook">生成更正册（空白 5 页）</button>
      </div>
    </div>
    <div class="panel-row">
      <div class="panel-field">
        <span class="field-label">生成范围</span>
        <label class="radio"><input v-model="scope" type="radio" value="single" :disabled="busy" />单页试打</label>
        <label class="radio"><input v-model="scope" type="radio" value="selection" :disabled="busy" />当前选字</label>
        <label class="radio"><input v-model="scope" type="radio" value="full" :disabled="busy" />全量</label>
        <span class="panel-hint">{{ scopeHint }}</span>
      </div>
    </div>

    <div class="panel-row">
      <div class="panel-field">
        <span class="field-label">排列方式</span>
        <label class="radio"><input v-model="orderMode" type="radio" value="rank" :disabled="busy" />按使用频率</label>
        <label class="radio"><input v-model="orderMode" type="radio" value="charset" :disabled="busy" />字表顺序（拼音）</label>
        <span class="panel-hint">{{ orderHint }}</span>
      </div>
    </div>

    <div class="panel-row">
      <div class="panel-field">
        <span class="field-label">参考字字体</span>
        <label class="radio"><input v-model="fontSource" type="radio" value="builtin" :disabled="busy" />{{ BUILTIN_FONT_LABEL }}</label>
        <label class="radio"><input v-model="fontSource" type="radio" value="local" :disabled="busy || !localFont" />本机字体{{ localFontName ? '（' + localFontName + '）' : '' }}</label>
        <label class="file-button">
          选择本机字体
          <input type="file" accept=".ttf,.otf,.ttc,.woff,font/ttf,font/otf" :disabled="busy" @change="pickLocalFont" />
        </label>
        <span class="font-help">
          <button
            class="help-button"
            type="button"
            :aria-expanded="fontHelpOpen ? 'true' : 'false'"
            aria-label="本机字体怎么选"
            @click="toggleFontHelp"
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.3" />
              <path d="M6.1 6.2a1.9 1.9 0 0 1 3.7.6c0 1.1-1.8 1.2-1.8 2.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
              <circle cx="8" cy="11.4" r="0.8" fill="currentColor" />
            </svg>
          </button>
          <div v-if="fontHelpOpen" class="help-popover" :style="fontHelpStyle" role="dialog" aria-label="本机字体怎么选">
            <p>
              选不到 <code>C:\Windows\Fonts</code>？该目录带「系统」属性，Windows 的文件选择框默认不显示它（目录本身可读，只是被当成受保护的系统项）。
              两个办法：① 在选择框下方的「文件名」输入框里直接粘贴完整路径（例如 <code>C:\Windows\Fonts\simkai.ttf</code>）再回车；
              ② 先在资源管理器里进入该目录，把字体文件复制到桌面，再从这里选。
            </p>
            <p>
              Windows 字体目录为 <code>C:\Windows\Fonts</code>（楷体 <code>simkai.ttf</code>、华文楷体 <code>STKAITI.TTF</code>）；
              macOS 为 <code>/System/Library/Fonts</code>、<code>/Library/Fonts</code> 与 <code>~/Library/Fonts</code>。
            </p>
            <button class="text" type="button" @click="fontHelpOpen = false">关闭</button>
          </div>
        </span>
      </div>
    </div>

    <div class="panel-actions">
      <button class="primary" :disabled="busy" @click="generateTemplate">生成模板 PDF</button>
      <span v-if="busy && progress.total" class="panel-hint">进度 {{ progress.done }} / {{ progress.total }} 页</span>
    </div>

    <p v-if="message" class="panel-message" :class="messageType">{{ message }}</p>
    <p v-if="lastResult" class="panel-hint">
      最近产物：{{ lastResult.name }}（{{ lastResult.sheetPages }} 字表页<span v-if="lastResult.pages > lastResult.sheetPages"> + 1 自检页</span>，{{ (lastResult.bytes / 1024 / 1024).toFixed(2) }} MB，参考字字体：{{ lastResult.font }}，批次校验码 {{ lastResult.batchCode }}）
    </p>

    <p class="panel-hint">
      打印要求：彩色喷墨打印机、按「实际大小 / 100%」打印（不要选「适合页面」）；黑白激光打印会把灰格线打成黑色，混进字形。
      每格 1cm×1cm 是实际尺寸；<strong>先打最后一页自检页</strong>，用尺子量方框是否为 1cm，确认后再打印全部。
      <strong>另外不要勾选「无边框 / 无边距」</strong>：它会让打印机把内容放大到铺满整张纸，格子就不是 1cm 了（打印对话框里的边框选项保持默认即可）。
    </p>

    <p class="panel-hint">
      <strong>书写要求</strong>（模板每页顶部也印了这些要点）：用 0.5mm 黑色中性笔，<strong>居中写满格子</strong>、
      大小匀称；<strong>笔画贴到格子边，但不要写出格</strong>（写小了字会显小 —— 实测同一字号下，写满格子的字面才赶得上系统字体）；
      不描不改、一笔写成；写好的纸别翘边、折叠或受潮 —— 纸张一旦变形，透视校正也救不回来。
    </p>

    <p class="panel-hint">
      <strong>建议用平板扫描仪</strong>（实测设备：EPSON L4266 一体机自带平板扫描，光学 1200×2400dpi，用彩色 300dpi 即可，只用到它约四分之一的能力；
      <strong>色彩模式选「照片 / 彩色照片」，不要选「文档 / 文字文档」</strong> —— 文档模式会自动去底色、拉高对比度，把灰格线、淡参考字与红圈的颜色信息一起改掉，后面的切格与红圈识别都会跟着变差；
      扫描软件里的锐化 / 自动曝光 / 去网纹也建议关掉，避免它改写格线与笔迹的灰度关系）。
      没有扫描仪时也可以用手机拍，但要满足四条：① 打开相机的「文档矫正 / 扫描」模式；② 从正上方拍、尽量对正；
      ③ 让纸占满画面（宽度 70% 以上）—— 否则页脚那排 6pt 小方块会糊在一起，页序与批次校验就读不出来；
      ④ 把纸压平，翘边属于非平面变形，透视校正救不回来。
    </p>

    <p class="panel-hint">
      <strong>用扫描类 App（如扫描全能王）时，务必选保留颜色的模式</strong>：实测「原图 / 增亮 / 增强锐化 / 智能高清 / 去阴影」都能保留红圈的红色，可以用；
      「黑白 / 省墨 / 灰度」会把红色压成灰黑，红圈识别随之明显变差（只能靠后面的人工确认环节逐个核对）。
      原因：红圈识别靠颜色通道差值（红墨水的红通道明显高于绿、蓝通道），一旦转成灰度，这个信息就没有了。
    </p>

    <p class="panel-hint">
      批次校验码印在每页页脚（20 个小方块）：它由这一批要写的字算出来，扫描识别时用来确认「这批纸和当前的选字清单是不是同一批」。
      重新选了字之后必须重新生成模板，旧模板印出来的纸会被判为不匹配。
    </p>
  </section>
</template>
