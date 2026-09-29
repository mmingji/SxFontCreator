<script setup>
// 模板与更正册生成面板（阶段一步骤 1.3）
// 职责：选参考字字体来源 → 生成模板 / 更正册 PDF → 交给浏览器下载
// 数据来源：字表来自 src/lib/charset.js（6919 字，顺序即模板字序）；字体来自 referenceFont.js
// 版面：由 templatePdf.js 的 LAYOUT 统一控制（A4 横向、每页 136 格，见《决策记录》一-3、一-4）
import { computed, ref } from 'vue'
import { LAYOUT, buildTemplatePdf, buildCorrectionBookPdf } from '../lib/templatePdf.js'
import { getAllChars, getCharsetMeta } from '../lib/charset.js'
import { BUILTIN_FONT_LABEL, loadBuiltinFont, loadFontFromFile } from '../lib/referenceFont.js'

const meta = getCharsetMeta()
const totalPages = Math.ceil(meta.total / LAYOUT.perPage)

// 范围：单页试打（先确认版式与打印设置）或全量
const scope = ref('single')
// 字体来源：内置子集 / 用户选的本机 ttf
const fontSource = ref('builtin')
const localFontName = ref('')
let localFontBytes = null

const busy = ref(false)
const message = ref('')
const messageType = ref('info') // info | error | done
const progress = ref({ done: 0, total: 0 })
const lastResult = ref(null) // { name, pages, bytes }

const scopeHint = computed(() =>
  scope.value === 'single'
    ? '单页试打：只生成第 1 页（前 ' + LAYOUT.perPage + ' 字），先打印确认版式与打印设置'
    : '全量：' + meta.total + ' 字／' + totalPages + ' 页'
)

function setMessage(text, type) {
  message.value = text
  messageType.value = type || 'info'
}

async function pickLocalFont(event) {
  const file = event.target.files && event.target.files[0]
  if (!file) return
  try {
    localFontBytes = await loadFontFromFile(file)
    localFontName.value = file.name
    fontSource.value = 'local'
    setMessage('已选用本机字体：' + file.name + '（只在本机内存中使用）', 'info')
  } catch (e) {
    localFontBytes = null
    localFontName.value = ''
    fontSource.value = 'builtin'
    setMessage(e.message, 'error')
  } finally {
    // 清空 input，便于再次选择同一个文件
    event.target.value = ''
  }
}

async function resolveFont() {
  if (fontSource.value === 'local' && localFontBytes) {
    return { bytes: localFontBytes, label: '本机字体（' + localFontName.value + '）' }
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
    const chars = scope.value === 'single' ? getAllChars().slice(0, LAYOUT.perPage) : getAllChars()
    progress.value = { done: 0, total: Math.ceil(chars.length / LAYOUT.perPage) }
    setMessage('正在生成模板 PDF…', 'info')
    const out = await buildTemplatePdf({
      chars,
      fontBytes: font.bytes,
      onProgress: (done, total) => {
        progress.value = { done, total }
      }
    })
    const name = 'SxFontCreator-模板-' + (scope.value === 'single' ? '试打1页' : out.sheetPages + '页') + '.pdf'
    download(out.bytes, name)
    lastResult.value = { name, pages: out.pageCount, sheetPages: out.sheetPages, bytes: out.bytes.length, font: font.label, batchCode: out.batchCode }
    const mb = (out.bytes.length / 1024 / 1024).toFixed(2)
    const selfNote = out.selfCheck ? '；最后 1 页是打印自检页，先用尺子量 1cm 方框再开始手写' : ''
    setMessage(
      '模板已生成并开始下载：' + out.sheetPages + ' 字表页' + (out.selfCheck ? ' + 1 页自检' : '') +
        '（' + mb + ' MB），参考字用' + font.label + '，批次校验码 ' + out.batchCode + selfNote,
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
    <h2>模板与更正册</h2>
    <div class="panel-row">
      <div class="panel-field">
        <span class="field-label">生成范围</span>
        <label class="radio"><input v-model="scope" type="radio" value="single" :disabled="busy" />单页试打</label>
        <label class="radio"><input v-model="scope" type="radio" value="full" :disabled="busy" />全量</label>
        <span class="panel-hint">{{ scopeHint }}</span>
      </div>
    </div>

    <div class="panel-row">
      <div class="panel-field">
        <span class="field-label">参考字字体</span>
        <label class="radio"><input v-model="fontSource" type="radio" value="builtin" :disabled="busy" />{{ BUILTIN_FONT_LABEL }}</label>
        <label class="radio"><input v-model="fontSource" type="radio" value="local" :disabled="busy || !localFontBytes" />本机 ttf{{ localFontName ? '（' + localFontName + '）' : '' }}</label>
        <label class="file-button">
          选择本机字体
          <input type="file" accept=".ttf,font/ttf" :disabled="busy" @change="pickLocalFont" />
        </label>
      </div>
    </div>

    <div class="panel-actions">
      <button class="primary" :disabled="busy" @click="generateTemplate">生成模板 PDF</button>
      <button :disabled="busy" @click="generateCorrectionBook">生成更正册（空白 5 页）</button>
      <span v-if="busy && progress.total" class="panel-hint">进度 {{ progress.done }} / {{ progress.total }} 页</span>
    </div>

    <p v-if="message" class="panel-message" :class="messageType">{{ message }}</p>
    <p v-if="lastResult" class="panel-hint">
      最近产物：{{ lastResult.name }}（{{ lastResult.sheetPages }} 字表页<span v-if="lastResult.pages > lastResult.sheetPages"> + 1 自检页</span>，{{ (lastResult.bytes / 1024 / 1024).toFixed(2) }} MB，参考字字体：{{ lastResult.font }}，批次校验码 {{ lastResult.batchCode }}）
    </p>

    <p class="panel-hint">
      打印要求：彩色喷墨打印机、按「实际大小 / 100%」打印（不要选「适合页面」）；黑白激光打印会把灰格线打成黑色，混进字形。
      每格 1cm×1cm 是实际尺寸；<strong>先打最后一页自检页</strong>，用尺子量方框是否为 1cm，确认后再打印全部。
    </p>

    <p class="panel-hint">
      批次校验码印在每页页脚（20 个小方块）：它由这一批要写的字算出来，扫描识别时用来确认「这批纸和当前的选字清单是不是同一批」。
      重新选了字之后必须重新生成模板，旧模板印出来的纸会被判为不匹配。
    </p>
  </section>
</template>
