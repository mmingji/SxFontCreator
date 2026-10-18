<script setup>
// 模板 PDF 预览（阶段一「界面串联」：出模板这一步要能先看到第一页长什么样）
// 职责：把**真实生成的模板 PDF** 用 pdf.js 渲染到画布上，可翻页（第 1 页 / 自检页 / 任意页）。
// 为什么渲染真实 PDF 而不自绘缩略图：自绘等于让版面有两份实现（PDF 一份、画布一份），
//   LAYOUT 一改就会悄悄跑偏；pdf.js 渲染的是同一份字节，"预览与打印不一致"这类问题不存在。
// 依赖：pdfjs-dist 是运行时依赖（2026-10-04 由 devDependencies 移入），这里**动态 import** ——
//   首屏与其它步骤都不会加载它，构建产物里它是独立 chunk。
// **为什么用 legacy 构建**（2026-10-08，实施计划 3.4）：pdf.js 的现代构建直接调用
//   `Promise.withResolvers`（Chrome 119）与 `structuredClone`（Chrome 98）且没有回退 ——
//   在旧浏览器（含 Win7 能装的最后一版 Chrome/Edge 109）上会直接抛 TypeError。
//   `pdfjs-dist/legacy/build/` 是官方为老环境准备的转译版（自带这些 API 的降级实现），
//   体积只多约 0.1MB（0.49 + 1.26MB vs 0.44 + 1.21MB）。换成 legacy 后，"Chrome / Edge 90 以上"
//   这条口径才真正成立；`test/browser-support.mjs` 会扫产物，防止以后有人改回现代构建。
// 生命周期上踩过两个坑（都写在这里，别再踩）：
//   ① **销毁要用"加载任务"，不是文档对象** —— pdf.js v6 的 `PDFDocumentProxy` 上没有 `destroy()`，
//      destroy 在 `getDocument()` 返回的 loadingTask 上；写成 `doc.destroy()` 会抛 TypeError 被 catch 吞掉，
//      结果是文档与 worker 从来没释放（每改一次设置就漏一个）；
//   ② **旧文档要等新文档就绪后再销毁**，且每次换字节都用一个 token 作废在途的那一轮 ——
//      否则会出现"上一轮把新一轮的渲染任务取消掉"的竞态，界面停在"正在渲染预览…"。
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { loadPdfjs } from '../lib/pdfjsLoader.js'

const props = defineProps({
  // 模板 PDF 的字节（Uint8Array）；为空时显示占位提示
  // **2026-10-16 起：约定传"只含当前这一页"的 PDF**（按需生成，见 TemplatePreview 的说明）——
  //   传整份也能用（渲染文档的第 pageNo 页），两种输入都对。
  bytes: { type: Object, default: null },
  // 调用方是否正在生成 PDF（生成期间显示"正在生成预览"而不是"还没有预览"）
  loading: { type: Boolean, default: false },
  // **当前页号与总页数由调用方给**（2026-10-16 改受控分页）：按需生成时"这一份 PDF 只有 1 页"，
  //   页数不能再从文档里数 —— 总页数由调用方按字序算出来（模板 = 字表页 + 自检页、示意 = 字表页）。
  pageNo: { type: Number, default: 1 },
  pageCount: { type: Number, default: 0 },
  // 预览画布的最大宽度（px）；实际按容器宽度自适应，超过这个值就居中留白
  maxWidth: { type: Number, default: 900 },
  // 标题：第 1 步并排两块预览（模板 / 书写示意），各自要写清自己是什么
  title: { type: String, default: '模板预览（第 1 页与实际打印完全一致）' },
  // 没有字节时的占位文案（如书写示意还没生成出来）
  emptyText: { type: String, default: '' },
  // 纸张宽高比（宽 ÷ 高）：**首次**加载（还没有渲染过任何一页）时用它按容器宽度推算灰底板高度。
  // 默认 A4 横向 = 297 / 210，与本项目模板 PDF 的页面一致；调用方从 LAYOUT 传（版式参数只有那一个出处）。
  pageRatio: { type: Number, default: 297 / 210 }
})
// 翻页交给调用方（它才知道"第 N 页要什么"）：本组件只负责"渲染这一页的字节"
const emit = defineEmits(['page-change'])

const canvasRef = ref(null)
// 画布的父容器：渲染宽度以它为基准（**不要拿外层卡片量** —— 卡片含 8px 内边距，算出来的画布会比容器宽 16px，
// 逼出 body 的横向滚动条，就绪态因而比非就绪态高出约 15px）
const bodyRef = ref(null)
const status = ref('idle') // idle | rendering | ready | error
const errorText = ref('')
// 页号与页数都是**调用方给的**（见 props 说明）；这里只保留一个"文档里有几页"用于渲染时的自我校验
const docPageCount = ref(0)

// ── 非就绪态（生成中 / 空态 / 失败）的灰底板高度 ─────────────────────────────
// **必须与成品画布一样高**（2026-10-18 用户要求）：原来非就绪态画布是 display:none、body 只剩
//   `min-height: 120px`，而成品约 450px —— "载入完成"那一下卡片猛长一截，下面的内容整体往下跳。
// 高度取两个来源，优先级从高到低：
//   ① **上一次渲染成功的画布高度** —— 那就是成品的实际高度。画布尺寸只在渲染时设置（窗口缩放不会改它），
//      所以这个记录值与画布永远一致，翻页 / 换档位时按它撑住即可。
//   ② **还没有渲染过任何一页**（打开这一步的第一次加载）时，按容器宽度与纸张宽高比推算 ——
//      与 renderPage 算缩放用的是同一个宽度口径，误差只在取整那一像素上。
const placeholderHeight = ref(0)

// 按容器宽度推算成品高度（给"第一次加载"用；写法与 renderPage 里的 scale 计算保持一致）
function measurePlaceholder() {
  const body = bodyRef.value
  const width = Math.min(props.maxWidth, (body && body.clientWidth) || props.maxWidth)
  return Math.round(width / (props.pageRatio > 0 ? props.pageRatio : 297 / 210))
}

onMounted(() => {
  if (!placeholderHeight.value) placeholderHeight.value = measurePlaceholder()
})

// pdf.js 的模块加载与 worker 落位抽在 lib/pdfjsLoader.js —— 那里是"pdf.js 怎么用"的唯一出处
// （file:// 下 worker 只能走 Blob URL、必须用 legacy 构建、销毁要走加载任务这三条坑都记在它的文件头）

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
  docPageCount.value = 0
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
    docPageCount.value = doc.numPages
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

// 要渲染**文档里的第几页**：约定传"只含当前页"的 PDF 时它恒为 1；传整份时它就是调用方要的那一页。
// 用 clamp 保证越界不抛（按需生成刚切档位时，外部页号可能短暂大于文档页数）。
function renderPageNo() {
  const total = docPageCount.value || 1
  return Math.min(Math.max(1, Math.round(props.pageNo || 1)), total)
}

async function renderPage(token) {
  const doc = docRef.value
  const canvas = canvasRef.value
  if (!doc || !canvas) return
  if (token !== undefined && token !== openToken) return
  status.value = 'rendering'
  try {
    cancelRender()
    const page = await doc.getPage(renderPageNo())
    if (token !== undefined && token !== openToken) return
    // 按容器宽度（不超过 maxWidth）算缩放：A4 横向 842pt 宽，容器 900px 时约 1.07 倍
    const base = page.getViewport({ scale: 1 })
    const containerWidth = Math.min(props.maxWidth, (bodyRef.value && bodyRef.value.clientWidth) || props.maxWidth)
    const scale = containerWidth / base.width
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
    const viewport = page.getViewport({ scale })
    canvas.width = Math.max(1, Math.round(viewport.width * dpr))
    canvas.height = Math.max(1, Math.round(viewport.height * dpr))
    canvas.style.width = Math.round(viewport.width) + 'px'
    canvas.style.height = Math.round(viewport.height) + 'px'
    // 记下成品高度：非就绪态按它撑住灰底板（见 placeholderHeight 的说明）
    placeholderHeight.value = Math.round(viewport.height)
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

// 翻页**只发意图**（2026-10-16 改受控分页）：要哪一页由调用方决定并生成，本组件不自己加页码
function goto(delta) {
  const next = props.pageNo + delta
  const total = Math.max(1, props.pageCount || 1)
  if (next < 1 || next > total) return
  emit('page-change', next)
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
    const page = await doc.getPage(renderPageNo())
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
// 页号一变就重渲染：按需生成时新字节与页号会一起更新（先拿到新字节、再渲染那一页）
watch(() => props.pageNo, () => { renderPage(); if (zoomOpen.value) renderZoom() })
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
  <div class="pdf-preview" :data-pages="pageCount" :data-page-no="pageNo" :data-status="status">
    <div class="pdf-preview-head">
      <span class="pdf-preview-title">{{ title }}</span>
      <!-- 翻页条**常驻渲染**（单页时按钮禁用）：页数是测试与排障都要看的量，不给它加 v-if。
           页号与总页数都由调用方给（按需生成时这一份 PDF 只有一页，数不出来总页数） -->
      <span class="pdf-preview-pager">
        <button class="text" type="button" :disabled="pageNo <= 1 || status === 'rendering'" @click="goto(-1)">上一页</button>
        <span class="pdf-preview-page">第 {{ pageNo }} / {{ pageCount || 1 }} 页</span>
        <button class="text" type="button" :disabled="pageNo >= pageCount || status === 'rendering'" @click="goto(1)">下一页</button>
      </span>
    </div>
    <!-- 灰底板高度恒等于成品画布（见 placeholderHeight 的说明）：生成中 / 空态 / 失败都不跳高 -->
    <div ref="bodyRef" class="pdf-preview-body" :style="placeholderHeight ? { minHeight: placeholderHeight + 'px' } : null">
      <canvas ref="canvasRef" class="pdf-preview-canvas" :class="{ hidden: status !== 'ready' }" @click="openZoom"></canvas>
      <p v-if="status === 'idle'" class="pdf-preview-empty">
        {{ loading ? '正在生成，稍后显示预览…' : (emptyText || '还没有预览：先在下面点「生成模板 PDF」或「更新预览」') }}
      </p>
      <p v-else-if="status === 'rendering' && !pageCount" class="pdf-preview-empty">正在渲染预览…</p>
      <p v-else-if="status === 'error'" class="pdf-preview-empty error">{{ errorText }}</p>
      <!-- 原来这里有一行"点图可放大看细节"：2026-10-07 用户要求去掉（两块预览各挂一句太吵）。
           点击放大的能力本身保留（画布仍可点开整屏），关闭方式写在放大层的提示里 -->
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
