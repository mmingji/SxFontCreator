<script setup>
// 模板 PDF 预览（阶段一「界面串联」：出模板这一步要能先看到第一页长什么样）
// 职责：把**真实生成的模板 PDF** 用 pdf.js 渲染到画布上，可翻页（第 1 页 / 自检页 / 任意页）。
// 为什么渲染真实 PDF 而不自绘缩略图：自绘等于让版面有两份实现（PDF 一份、画布一份），
//   LAYOUT 一改就会悄悄跑偏；pdf.js 渲染的是同一份字节，"预览与打印不一致"这类问题不存在。
// 依赖：pdfjs-dist 是运行时依赖（2026-10-04 由 devDependencies 移入），这里**动态 import** ——
//   首屏与其它步骤都不会加载它，构建产物里它是独立 chunk。
// 生命周期上踩过两个坑（都写在这里，别再踩）：
//   ① **销毁要用"加载任务"，不是文档对象** —— pdf.js v6 的 `PDFDocumentProxy` 上没有 `destroy()`，
//      destroy 在 `getDocument()` 返回的 loadingTask 上；写成 `doc.destroy()` 会抛 TypeError 被 catch 吞掉，
//      结果是文档与 worker 从来没释放（每改一次设置就漏一个）；
//   ② **旧文档要等新文档就绪后再销毁**，且每次换字节都用一个 token 作废在途的那一轮 ——
//      否则会出现"上一轮把新一轮的渲染任务取消掉"的竞态，界面停在"正在渲染预览…"。
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { ensureInlineBlobUrl, hasInlineAssets } from '../lib/inlineAssets.js'

const props = defineProps({
  // 模板 PDF 的字节（Uint8Array）；为空时显示占位提示
  bytes: { type: Object, default: null },
  // 调用方是否正在生成 PDF（生成期间显示"正在生成预览"而不是"还没有预览"）
  loading: { type: Boolean, default: false },
  // 预览画布的最大宽度（px）；实际按容器宽度自适应，超过这个值就居中留白
  maxWidth: { type: Number, default: 900 },
  // 标题：第 1 步并排两块预览（模板 / 填写示意），各自要写清自己是什么
  title: { type: String, default: '模板预览（第 1 页与实际打印完全一致）' },
  // 没有字节时的占位文案（如填写示意还没生成出来）
  emptyText: { type: String, default: '' }
})

const canvasRef = ref(null)
const wrapRef = ref(null)
const pageNo = ref(1)
const pageCount = ref(0)
const status = ref('idle') // idle | rendering | ready | error
const errorText = ref('')

// pdf.js 的模块与 worker 只加载一次（多次 import 同一模块不会重复下载）
let pdfjsPromise = null
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist')
      // worker 的来源分两种形态（决策 六-4 的交付形态是 file:// 版）：
      //   ① 内联形态（交付产物）：worker 的字节被构建期内联，这里转成 **Blob URL** ——
      //      file:// 下 `new Worker('./assets/pdf.worker.min.mjs')` 会被浏览器拦下
      //      （实测报 `cannot be accessed from origin 'null'`，清单 三-8），而 Blob URL 可用；
      //      pdf.js 只要求 workerSrc 是**字符串 URL**，所以这条路成立。
      //   ② 普通形态（dev 服务器）：走 vite 的 ?url，它把 worker 作为独立资源发出来，不拖慢首屏。
      let workerSrc = null
      if (hasInlineAssets()) {
        try {
          workerSrc = await ensureInlineBlobUrl('pdf-worker', 'text/javascript')
        } catch (e) {
          workerSrc = null // 取不到就退回 ?url；两条都不行时 pdf.js 自己会报错，界面有中文兜底
        }
      }
      if (!workerSrc) {
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
        workerSrc = worker.default
      }
      pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
      return pdfjs
    })()
  }
  return pdfjsPromise
}

const docRef = shallowRef(null) // shallowRef：pdf.js 的文档对象很大，不要被 Vue 递归代理
let loadingTask = null // getDocument 返回的加载任务（销毁走它，见文件头 ①）
let renderTask = null
// 每次"换字节"都递增：异步流程回到 await 之后要先核对它，避免过期的那一轮把新状态覆盖掉
let openToken = 0

function cancelRender() {
  if (renderTask) {
    try {
      renderTask.cancel()
    } catch {
      // 渲染任务已经结束或已被取消，忽略
    }
    renderTask = null
  }
}

// 销毁一个加载任务（连带它的文档与 worker）；失败不抛，避免卸载路径报错
async function disposeTask(task) {
  if (!task) return
  try {
    await task.destroy()
  } catch {
    // 任务已销毁或从未成功创建，忽略
  }
}

async function openDoc() {
  const token = ++openToken
  cancelRender()
  const previousTask = loadingTask
  loadingTask = null
  docRef.value = null
  pageNo.value = 1
  pageCount.value = 0
  if (!props.bytes || !props.bytes.length) {
    status.value = 'idle'
    errorText.value = ''
    await disposeTask(previousTask)
    return
  }
  status.value = 'rendering'
  errorText.value = ''
  let task = null
  try {
    const pdfjs = await loadPdfjs()
    // 必须**传一份新的拷贝**：pdf.js 会把 data 的 ArrayBuffer 转移（detach）给 worker，
    // 直接传原数组会让调用方手里的字节变成 0 长度（踩过一次：预览完再点下载，PDF 是空的）
    task = pdfjs.getDocument({ data: new Uint8Array(props.bytes) })
    loadingTask = task
    const doc = await task.promise
    if (token !== openToken) {
      // 这一轮已经过期（用户又改了设置 / 组件已卸载）：丢掉它，别动新文档
      await disposeTask(task)
      return
    }
    docRef.value = doc
    pageCount.value = doc.numPages
    // 旧任务等新文档就绪之后再销毁（见文件头 ②）
    await disposeTask(previousTask)
    await renderPage(token)
  } catch (e) {
    if (token === openToken) {
      status.value = 'error'
      errorText.value = '预览渲染失败：' + (e && e.message ? e.message : e) +
        '（' + (e && e.name ? e.name : '未知错误') + '）'
    }
    await disposeTask(task)
    if (loadingTask === task) loadingTask = null
  }
}

async function renderPage(token) {
  const doc = docRef.value
  const canvas = canvasRef.value
  if (!doc || !canvas) return
  if (token !== undefined && token !== openToken) return
  status.value = 'rendering'
  try {
    cancelRender()
    const page = await doc.getPage(pageNo.value)
    if (token !== undefined && token !== openToken) return
    // 按容器宽度（不超过 maxWidth）算缩放：A4 横向 842pt 宽，容器 900px 时约 1.07 倍
    const base = page.getViewport({ scale: 1 })
    const containerWidth = Math.min(props.maxWidth, (wrapRef.value && wrapRef.value.clientWidth) || props.maxWidth)
    const scale = containerWidth / base.width
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
    const viewport = page.getViewport({ scale })
    canvas.width = Math.max(1, Math.round(viewport.width * dpr))
    canvas.height = Math.max(1, Math.round(viewport.height * dpr))
    canvas.style.width = Math.round(viewport.width) + 'px'
    canvas.style.height = Math.round(viewport.height) + 'px'
    const ctx = canvas.getContext('2d')
    ctx.save()
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.restore()
    renderTask = page.render({ canvasContext: ctx, viewport, transform: [dpr, 0, 0, dpr, 0, 0] })
    await renderTask.promise
    renderTask = null
    if (token === undefined || token === openToken) status.value = 'ready'
  } catch (e) {
    // 主动取消（快速翻页 / 又换了字节）不是错误，不显示提示；新的一轮会自己把状态写成 ready
    if (e && e.name === 'RenderingCancelledException') return
    if (token === undefined || token === openToken) {
      status.value = 'error'
      errorText.value = '预览渲染失败：' + (e && e.message ? e.message : e)
    }
  }
}

function goto(delta) {
  const next = pageNo.value + delta
  if (next < 1 || next > pageCount.value) return
  pageNo.value = next
}

// ── 点击放大 ───────────────────────────────────────────────────────────────
// 并排两块预览时每块只有约 620px 宽，1cm 的格子缩得很小 —— 点一下放到整屏看细节，
// 关闭方式：点任意处或按 Esc。放大用的是**同一份文档对象**，只是按更大的尺寸重渲染一次
// （不放大像素，避免发虚）。
const zoomOpen = ref(false)
const zoomCanvasRef = ref(null)
let zoomTask = null

async function openZoom() {
  if (status.value !== 'ready' || !docRef.value) return
  zoomOpen.value = true
  await nextTick() // 放大层里的画布要先挂上，才有 ref 可用
  await renderZoom()
}

async function renderZoom() {
  const doc = docRef.value
  const canvas = zoomCanvasRef.value
  if (!doc || !canvas) return
  try {
    if (zoomTask) {
      try {
        zoomTask.cancel()
      } catch {
        // 上一轮已结束，忽略
      }
      zoomTask = null
    }
    const page = await doc.getPage(pageNo.value)
    const base = page.getViewport({ scale: 1 })
    // 同时受视口宽与高约束：A4 横向放满宽度会超出屏幕高度，必须一起算
    const maxWidth = Math.min((window.innerWidth || 1280) * 0.94, 1600)
    const maxHeight = (window.innerHeight || 800) * 0.88
    const scale = Math.min(maxWidth / base.width, maxHeight / base.height)
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
    const viewport = page.getViewport({ scale })
    canvas.width = Math.max(1, Math.round(viewport.width * dpr))
    canvas.height = Math.max(1, Math.round(viewport.height * dpr))
    canvas.style.width = Math.round(viewport.width) + 'px'
    canvas.style.height = Math.round(viewport.height) + 'px'
    const ctx = canvas.getContext('2d')
    ctx.save()
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.restore()
    zoomTask = page.render({ canvasContext: ctx, viewport, transform: [dpr, 0, 0, dpr, 0, 0] })
    await zoomTask.promise
    zoomTask = null
  } catch (e) {
    // 放大失败不影响主预览：收起放大层即可（用户还能看小图）
    if (!(e && e.name === 'RenderingCancelledException')) zoomOpen.value = false
  }
}

function onKeydown(e) {
  if (e.key === 'Escape') zoomOpen.value = false
}
watch(zoomOpen, (open) => {
  if (open) document.addEventListener('keydown', onKeydown)
  else document.removeEventListener('keydown', onKeydown)
})

watch(() => props.bytes, () => { openDoc() }, { immediate: true })
watch(pageNo, () => { renderPage(); if (zoomOpen.value) renderZoom() })
onBeforeUnmount(() => {
  openToken++ // 让在途的那一轮作废，别在卸载后再改状态
  cancelRender()
  disposeTask(loadingTask)
  loadingTask = null
  docRef.value = null
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="wrapRef" class="pdf-preview" :data-pages="pageCount" :data-page-no="pageNo" :data-status="status">
    <div class="pdf-preview-head">
      <span class="pdf-preview-title">{{ title }}</span>
      <!-- 翻页条**常驻渲染**（单页时按钮禁用）：页数是测试与排障都要看的量，不给它加 v-if -->
      <span class="pdf-preview-pager">
        <button class="text" type="button" :disabled="pageNo <= 1 || status === 'rendering'" @click="goto(-1)">上一页</button>
        <span class="pdf-preview-page">第 {{ pageNo }} / {{ pageCount || 1 }} 页</span>
        <button class="text" type="button" :disabled="pageNo >= pageCount || status === 'rendering'" @click="goto(1)">下一页</button>
        <span v-if="pageCount > 1" class="pdf-preview-tip">最后一页是打印自检页</span>
      </span>
    </div>
    <div class="pdf-preview-body">
      <canvas ref="canvasRef" class="pdf-preview-canvas" :class="{ hidden: status !== 'ready' }" @click="openZoom"></canvas>
      <p v-if="status === 'idle'" class="pdf-preview-empty">
        {{ loading ? '正在生成，稍后显示预览…' : (emptyText || '还没有预览：先在下面点「生成模板 PDF」或「更新预览」') }}
      </p>
      <p v-else-if="status === 'rendering' && !pageCount" class="pdf-preview-empty">正在渲染预览…</p>
      <p v-else-if="status === 'error'" class="pdf-preview-empty error">{{ errorText }}</p>
      <p v-if="status === 'ready'" class="pdf-preview-zoom-tip">点图可放大看细节</p>
    </div>
    <!-- 点击放大层：整屏看细节，点任意处或按 Esc 关闭（Teleport 到 body，避免被容器裁掉） -->
    <Teleport to="body">
      <div v-if="zoomOpen" class="pdf-zoom" @click="zoomOpen = false">
        <canvas ref="zoomCanvasRef" class="pdf-zoom-canvas"></canvas>
        <p class="pdf-zoom-tip">{{ title }}　第 {{ pageNo }} / {{ pageCount }} 页　—— 点击任意处或按 Esc 关闭</p>
      </div>
    </Teleport>
  </div>
</template>
