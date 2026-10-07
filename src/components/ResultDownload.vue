<script setup>
// 第 6 步：下载安装（阶段一步骤 1.10）
// 职责：① 打包 zip（字体 TTF/woff/woff2 + font.css + 使用说明.txt + 可双击的样张预览页）
//   ② 也能单独下载 TTF 与 CSS ③ 安装与使用说明（Word / PS / 网页）④ 备份提醒（决策 五-3）。
// 打包来源：优先用内存里刚生成的字体字节；**刷新后内存里没有就当场重建一次**（不是静默失败，界面给进度）。
// 网页预览（FontPreview）：用同一份字节，不装机也能看效果（决策 四-8）—— 放在下载按钮**上方**，
//   让用户先确认观感、再决定拿走；刷新后内存里没有字节时不自动重建，由用户点「加载预览」触发。
import { computed, onMounted, ref } from 'vue'
import { useProjectStore } from '../store/project.js'
import { buildFontFromPlan, getLastBuild } from '../lib/buildFont.js'
import { buildGuideText, buildPreviewHtml, packFontZip } from '../lib/fontPack.js'
import { downloadBytes, downloadText } from '../lib/download.js'
import { buildFinalGlyphPlan } from '../lib/scanFlow.js'
import FontPreview from './FontPreview.vue'

const store = useProjectStore()
const busy = ref(false)
const stage = ref('')
const progress = ref({ done: 0, total: 0 })
const message = ref('')
const messageType = ref('info')

const font = computed(() => store.font)
const ready = computed(() => font.value.built)
const plan = computed(() => buildFinalGlyphPlan(store.scan.pages, {
  pairs: store.correction.pairs || [],
  circled: store.correction.circled || []
}))

function setMessage(text, type) {
  message.value = text
  messageType.value = type || 'info'
}

// 预览可用的字体字节：内存里刚生成的产物（`buildFont` 的模块级暂存）。
// 为什么用 ref 而不是直接用 getLastBuild()：那份暂存不在响应式系统里，改了界面不会重渲染。
const previewBytes = ref(null)
function syncPreviewBytes() {
  const b = getLastBuild()
  previewBytes.value = b && b.ttf ? b.ttf : null
}
onMounted(syncPreviewBytes)

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

// 取产物字节：内存里有就用，没有就重建
async function ensureBuild() {
  const existing = getLastBuild()
  if (existing && existing.ttf) return existing
  setMessage('内存里没有字体字节（刷新过页面），正在用落盘的掩膜重建一次…', 'info')
  busy.value = true
  progress.value = { done: 0, total: plan.value.items.length }
  try {
    const rebuilt = await buildFontFromPlan({
      items: plan.value.items,
      meta: { ...store.meta },
      batchId: store.scan.batchId,
      woff2WasmUrl: './woff2.wasm',
      onStage: (t) => { stage.value = t },
      onProgress: (done, total) => { progress.value = { done, total } }
    })
    store.setFontResult({
      fileName: rebuilt.fileName,
      familyName: rebuilt.familyName,
      sizes: {
        ttf: rebuilt.ttf.byteLength,
        woff: rebuilt.woff ? rebuilt.woff.byteLength : 0,
        woff2: rebuilt.woff2 ? rebuilt.woff2.byteLength : 0
      },
      stats: rebuilt.stats,
      coverage: {
        total: rebuilt.mapping.length,
        fromCorrection: plan.value.items.filter((i) => i.source === 'correction').length,
        chars: rebuilt.mapping.map((m) => m.char)
      },
      skipped: rebuilt.skipped.length,
      missing: rebuilt.missing.length
    })
    syncPreviewBytes() // 重建出来的字节同时交给网页预览用
    return rebuilt
  } finally {
    busy.value = false
    stage.value = ''
    progress.value = { done: 0, total: 0 }
  }
}

// 覆盖情况与缺字说明（使用说明与预览页共用）
function coverageInfo(extra = {}) {
  const suspectNote = store.scanGlyphStats.suspect
    ? '这批里有 ' + store.scanGlyphStats.suspect + ' 个字形被判为可疑（偏淡或写得太小），可以回第 3 步的格级视图逐格看。'
    : ''
  return {
    total: font.value.coverage ? font.value.coverage.total : 0,
    fromCorrection: font.value.coverage ? font.value.coverage.fromCorrection : 0,
    chars: font.value.coverage ? font.value.coverage.chars : [],
    suspectNote,
    missingNote: extra.missingNote || '',
    ...extra
  }
}

async function downloadZip() {
  if (busy.value) return
  try {
    const built = await ensureBuild()
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
    // 注：字体 zip 与"项目包"是两件事 —— 字体 zip 是交付物，项目包是数据备份；
    // 所以这里**不**标记"项目已备份"（备份提醒由决策 五-3 的两个节点负责，按钮在提醒条上）
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
</script>

<template>
  <div class="step-body">
    <p v-if="!ready" class="panel-hint">
      还没有生成字体：先回到第 5 步点「生成字体」。
    </p>

    <template v-else>
      <p class="panel-hint">
        zip 内容：<strong>{{ font.fileName }}.ttf / .woff / .woff2</strong>、<strong>font.css</strong>、
        <strong>使用说明.txt</strong>、<strong>preview.html</strong>（双击就能看样张）；
        字体族名 <strong>{{ font.familyName }}</strong>，收录 {{ font.coverage.total }} 个字。
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
        <button class="primary" :disabled="busy" @click="downloadZip">下载 zip（推荐）</button>
        <button class="text" :disabled="busy" @click="downloadSingle('ttf')">只下载 TTF</button>
        <button class="text" :disabled="busy" @click="downloadSingle('css')">只下载 font.css</button>
        <button class="text" :disabled="busy" @click="downloadSingle('guide')">只下载使用说明.txt</button>
        <button class="text" :disabled="busy" @click="downloadSingle('preview')">只下载 preview.html</button>
        <span v-if="busy" class="panel-hint">{{ stage }}（{{ progress.done }} / {{ progress.total }} 个字形）</span>
      </div>
      <p v-if="message" class="panel-message" :class="messageType">{{ message }}</p>

      <p class="panel-hint">
        <strong>怎么装</strong>：Windows 右键 <code>{{ font.fileName }}.ttf</code> → 「为所有用户安装」（或复制到 <code>C:\Windows\Fonts</code>）；
        macOS 双击 → 「安装字体」。<strong>装完请重启 Word / PS</strong> —— 它们只在启动时读一次字体列表。
      </p>
      <p class="panel-hint">
        <strong>怎么用</strong>：Word 里在字体列表选「{{ font.familyName }}」；网页里把 font.css 与字体文件放同一目录，
        然后 <code>font-family: "{{ font.familyName }}";</code>。
        <strong>没写的字</strong>在 Word 里会显示成方框、在 PS 里可能回退到别的字体 —— 想要一套完整可用的字体，建议先把常用字补齐。
      </p>
      <p v-if="font.projectExportedAt" class="step-note">
        已经导出过项目包了。提醒一次：数据只在本机浏览器里 —— 又写了新的字之后，记得再导出一份。
        <button type="button" class="text" @click="store.openBackup()">打开项目备份</button>
      </p>
      <p v-else-if="store.backupReminder" class="step-note backup-reminder" data-role="backup-reminder">
        字体已经拿到手了，但<strong>项目还没备份</strong>：换了电脑或清了浏览器数据，这些字形就没了 ——
        <button type="button" class="text" @click="store.openBackup()">立即导出项目包</button>
      </p>
    </template>
  </div>
</template>
