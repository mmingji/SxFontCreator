<script setup>
// 第 3 步：上传识别（阶段一「界面串联」B2）
// 职责：① 选批次 + 显式确认（决策 八-7 / 二-7 / 八-10）
//   ② 多选扫描件 → 串行识别，边跑边显示、可中止（决策 二-1：绝不能整批读进内存）
//   ③ 批次判定与**收批闸门**（单页失败跳过、批次级问题整批拦下）
//   ④ 页级结果（缩略图 / 页号 / 校验码 / 方向纠正 / 写出格数 / 失败原因标红）
//   ⑤ 格级视图（136 格拼图 + 判定覆盖 + 单格放大看笔迹与统计）
//   ⑥ 页脚读不出时手选页序（拖动 + 数字，决策 二-7）
// 数据来源：编排在 lib/scanFlow.js，产物缓存（缩略图 / 掩膜）在 lib/scanCache.js，
//   轻量页记录落盘在 store.scan —— 口径见《决策记录》二-15。
import { computed, onMounted, ref } from 'vue'
import { useProjectStore } from '../store/project.js'
import { applyPageOrder, evaluateScanGate, recognizeBatch, resolveBatchChars } from '../lib/scanFlow.js'
import { clearPageCache, getPageCache, putPageCache } from '../lib/scanCache.js'
import { LAYOUT } from '../lib/layout.js'

const store = useProjectStore()

const files = ref([]) // 用户选的扫描件（File 对象；只在内存里，不上传）
const running = ref(false)
const stage = ref('')
const progress = ref({ done: 0, total: 0 })
const images = ref({}) // fileIndex → { thumb, sheet }（来自内存缓存，用于渲染；不落盘）
const openIndex = ref(null) // 展开格级视图的页
const zoomIndex = ref(null) // 单格放大
const message = ref('')
const messageType = ref('info') // info | error | done
const dragFrom = ref(null)
let cancelled = false

const pages = computed(() => store.scan.pages)
const batch = computed(() => store.scanBatch)
const chars = computed(() => store.scan.chars || resolveBatchChars(batch.value))
const stats = computed(() => store.scanGlyphStats)
// 收批闸门：能不能进下一步（规则在 lib/scanMeta.js，这里只渲染结论）
const gate = computed(() => evaluateScanGate({
  summary: store.scan.summary || { problems: [] },
  pages: pages.value,
  batchConfirmed: store.scan.batchConfirmed,
  batchIsVoid: store.scanBatchIsVoid,
  allowVoidBatch: store.scan.allowVoidBatch
}))
const batchOptions = computed(() => [...store.batches].reverse().map((b, i) => ({
  id: b.id,
  label: '第 ' + (store.batches.length - i) + ' 批 · ' + b.charCount + ' 字 / ' + b.pageCount + ' 页 · 校验码 ' + b.batchCode +
    (b.order === 'rank' ? ' · 按使用频率' : ' · 字表顺序') + (b.status === 'void' ? ' · 已作废' : '')
})))
const batchId = computed({
  get: () => store.scan.batchId,
  set: (v) => store.setScanBatch(v)
})

// 页脚读不出的页才允许手选页序：页脚解出来的页序是权威的（决策 二-7）
function needsManualOrder(page) {
  return !!(page.ok && !page.footerOk)
}
function setMessage(text, type) {
  message.value = text
  messageType.value = type || 'info'
}

onMounted(() => {
  // 默认选最近一个仍有效的批次；界面重挂载时把还活着的内存缓存接回来（缩略图与掩膜不落盘）
  if (!store.scan.batchId && store.latestActiveBatch) store.setScanBatch(store.latestActiveBatch.id)
  const restored = {}
  for (const page of store.scan.pages) {
    const cache = getPageCache(page.fileIndex)
    if (cache) restored[page.fileIndex] = { thumb: cache.thumb, sheet: cache.sheet }
  }
  if (Object.keys(restored).length) images.value = restored
})

function onPickFiles(event) {
  const picked = Array.from(event.target.files || [])
  files.value = picked
  event.target.value = '' // 清空 input，便于再次选择同一批文件
  setMessage(picked.length ? '已选择 ' + picked.length + ' 个文件：点「开始识别」逐页处理（串行，逐页释放内存）' : '', 'info')
}

async function start() {
  if (running.value) return
  if (!store.scan.batchId) {
    setMessage('请先选择这批扫描件属于哪个批次（第 1 步生成模板时记下的那个批次）', 'error')
    return
  }
  if (!files.value.length) {
    setMessage('还没有选择扫描件', 'error')
    return
  }
  if (store.scanBatchIsVoid && !store.scan.allowVoidBatch) {
    setMessage('所选批次已作废（改过选字就会作废）：请重新生成模板、重印重写，或勾选"我知道这是作废模板"再继续', 'error')
    return
  }
  running.value = true
  cancelled = false
  openIndex.value = null
  zoomIndex.value = null
  images.value = {}
  clearPageCache()
  store.beginScanRun({ batchId: store.scan.batchId, chars: resolveBatchChars(batch.value) })
  progress.value = { done: 0, total: files.value.length }
  setMessage('正在识别…（单页约 1~2 秒，51 页约 85 秒；中途可以点「中止」，已识别的页会保留）', 'info')
  const t0 = performance.now()
  try {
    const res = await recognizeBatch(files.value, {
      batch: batch.value,
      onStage: (text) => { stage.value = text },
      shouldStop: () => cancelled,
      onPage: (record, index, total, cache) => {
        putPageCache(index, cache)
        images.value = { ...images.value, [index]: { thumb: cache.thumb, sheet: cache.sheet } }
        store.appendScanPage(record)
        progress.value = { done: index + 1, total }
      }
    })
    store.finishScanRun({ summary: res.summary })
    const secs = ((performance.now() - t0) / 1000).toFixed(1)
    setMessage(
      (res.stopped ? '已中止：' : '识别完成：') + res.pages.length + ' 页，用时 ' + secs + ' 秒；' +
        (res.summary.ok ? '这一批可以继续' : '这一批被拦下（见下面的原因）'),
      res.summary.ok ? 'done' : 'error'
    )
  } catch (e) {
    setMessage('识别失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    running.value = false
    stage.value = ''
  }
}

function stop() {
  cancelled = true
  setMessage('已请求中止：当前这一页处理完就停（已识别的页会保留）', 'info')
}

function clearAll() {
  if (running.value) return
  files.value = []
  images.value = {}
  openIndex.value = null
  zoomIndex.value = null
  clearPageCache()
  store.clearScan()
  setMessage('已清空识别结果与内存缓存', 'info')
}

// ── 手选页序（决策 二-7）：改数字或拖动都能改 ────────────────────────────
function applyOrder(overrides, note) {
  const next = applyPageOrder(pages.value, overrides, chars.value, {
    sheetPages: batch.value ? batch.value.pageCount : undefined,
    expectedBatchCode: batch.value ? batch.value.batchCode : undefined
  })
  store.setScanPageOrder({ overrides, pages: next.pages, summary: next.summary })
  if (note) setMessage(note, 'info')
}
function onOrderInput(page, value) {
  const n = Number(value)
  if (!n || n < 1) {
    setMessage('页号要填 1 以上的整数', 'error')
    return
  }
  const overrides = { ...store.scan.orderOverrides, [page.fileIndex]: n }
  applyOrder(overrides, '已把 ' + page.fileName + ' 的页序手选为第 ' + n + ' 页；识别结果（笔迹）不变，只是"这一页对应哪些字"跟着改')
}
function onDragStart(page) {
  if (!needsManualOrder(page)) return
  dragFrom.value = page.fileIndex
}
function onDropPage(target) {
  const from = dragFrom.value
  dragFrom.value = null
  if (from === null || from === target.fileIndex) return
  const source = pages.value.find((p) => p.fileIndex === from)
  if (!source || !needsManualOrder(source) || !needsManualOrder(target)) {
    setMessage('页脚读出页序的页不能拖动改序（页脚是权威的）；只有页脚读不出的页才需要手选', 'error')
    return
  }
  // 交换两页的页序（都还没手选时用"文件顺序"作为初始值）
  const overrides = { ...store.scan.orderOverrides }
  const a = source.pageNumber || source.fileIndex + 1
  const b = target.pageNumber || target.fileIndex + 1
  overrides[source.fileIndex] = b
  overrides[target.fileIndex] = a
  applyOrder(overrides, '已交换两页的页序：' + source.fileName + ' → 第 ' + b + ' 页，' + target.fileName + ' → 第 ' + a + ' 页')
}

// ── 格级视图 ─────────────────────────────────────────────────────────────
function togglePage(page) {
  if (!page.ok) return
  openIndex.value = openIndex.value === page.fileIndex ? null : page.fileIndex
  zoomIndex.value = null
}
const COLS = LAYOUT.cols
const ROWS = LAYOUT.rows
function cellStyle(cell) {
  const col = cell.index % COLS
  const row = Math.floor(cell.index / COLS)
  return {
    left: (col / COLS) * 100 + '%',
    top: (row / ROWS) * 100 + '%',
    width: 100 / COLS + '%',
    height: 100 / ROWS + '%'
  }
}
function cellClass(cell) {
  return [
    'verdict-' + cell.verdict,
    { marked: cell.marked, uncertain: cell.uncertain, zoomed: zoomIndex.value === cell.index }
  ]
}
function cellTitle(cell) {
  return '第 ' + cell.index + ' 格' + (cell.char ? '「' + cell.char + '」' : '') +
    '：' + (cell.verdict === 'empty' ? '没写' : (cell.verdict === 'suspect' ? '可疑（偏淡或太小）' : '有笔迹')) +
    '，墨迹 ' + cell.inkPixels + ' 像素' +
    (cell.marked ? '，被红笔圈掉' : '') +
    (cell.uncertain ? '，红圈压在两格之间、归属待确认' : '')
}
const zoomCell = computed(() => {
  const page = pages.value.find((p) => p.fileIndex === openIndex.value)
  if (!page || zoomIndex.value === null) return null
  const cell = (page.cells || []).find((c) => c.index === zoomIndex.value) || null
  return cell ? { page, cell } : null
})
// 用格子拼图做"精灵图"放大单格：background-size 放大 17×8 倍、再按格号取偏移（不额外占内存）
const zoomStyle = computed(() => {
  if (!zoomCell.value) return {}
  const sheet = images.value[zoomCell.value.page.fileIndex]
  const col = zoomCell.value.cell.index % COLS
  const row = Math.floor(zoomCell.value.cell.index / COLS)
  return {
    backgroundImage: sheet && sheet.sheet ? 'url(' + sheet.sheet + ')' : 'none',
    backgroundSize: COLS * 100 + '% ' + ROWS * 100 + '%',
    backgroundPosition: (col / (COLS - 1)) * 100 + '% ' + (row / (ROWS - 1)) * 100 + '%'
  }
})
const zoomIsMarkedLabel = computed(() => {
  const z = zoomCell.value
  if (!z) return ''
  const c = z.cell
  const parts = []
  parts.push(c.verdict === 'empty' ? '这一格没写' : (c.verdict === 'suspect' ? '有笔迹但可疑（偏淡或写得太小）' : '有笔迹'))
  parts.push('墨迹 ' + c.inkPixels + ' 像素' + (c.inkPixelsOutside ? '（其中 ' + c.inkPixelsOutside + ' 在书写格之外）' : ''))
  if (c.redPixelsRemoved) parts.push('已剔除红圈像素 ' + c.redPixelsRemoved + ' 个')
  if (c.marked) parts.push('被红笔圈掉（这个字会用更正册上的字形覆盖）')
  if (c.uncertain) parts.push('红圈压在两格之间，归属待确认（建议优先核对）')
  const ov = c.overflow || {}
  const out = (ov.top || 0) + (ov.left || 0) + (ov.bottom || 0) + (ov.right || 0)
  if (out) parts.push('笔画越出书写格：上 ' + (ov.top || 0) + ' / 左 ' + (ov.left || 0) + ' / 下 ' + (ov.bottom || 0) + ' / 右 ' + (ov.right || 0) + ' 像素')
  return parts.join('；')
})
</script>

<template>
  <div class="step-body">
    <!-- ① 批次与确认 -->
    <div class="panel-row">
      <div class="panel-field">
        <span class="field-label">批次</span>
        <select v-model="batchId" class="scan-select" :disabled="running">
          <option :value="null">请选择这批扫描件属于哪个批次</option>
          <option v-for="item in batchOptions" :key="item.id" :value="item.id">{{ item.label }}</option>
        </select>
        <span v-if="batch" class="panel-hint">
          这一批要写 {{ batch.charCount }} 字 / {{ batch.pageCount }} 页；上传后按它的字序把"页内格号"还原成字
        </span>
        <span v-else class="panel-hint">还没有批次：先回到第 1 步「选字与出模板」生成并打印模板</span>
      </div>
    </div>

    <div class="panel-row">
      <div class="panel-field">
        <label class="radio">
          <input
            type="checkbox"
            :checked="store.scan.batchConfirmed"
            :disabled="running"
            @change="store.setScanBatchConfirmed($event.target.checked)"
          />确认这批扫描件属于所选批次
        </label>
        <label v-if="store.scanBatchIsVoid" class="radio">
          <input
            type="checkbox"
            :checked="store.scan.allowVoidBatch"
            :disabled="running"
            @change="store.setScanAllowVoid($event.target.checked)"
          />我知道这是作废模板
        </label>
        <span class="panel-hint">
          页脚能读出页序与批次码时会自动核对；页脚读不出的页要靠手选页序 —— 那时批次码也失效了，所以必须在这里显式确认
        </span>
      </div>
    </div>

    <!-- ② 文件与进度 -->
    <div class="panel-row">
      <div class="panel-field">
        <label class="file-button">
          选择扫描件
          <input type="file" multiple accept="image/*" :disabled="running" @change="onPickFiles" />
        </label>
        <button class="primary" :disabled="running || !files.length || !store.scan.batchId" @click="start">开始识别</button>
        <button v-if="running" type="button" @click="stop">中止</button>
        <button class="text" type="button" :disabled="running || !pages.length" @click="clearAll">清空结果</button>
        <span class="panel-hint">
          {{ files.length }} 个文件<span v-if="running">；{{ stage }}（{{ progress.done }} / {{ progress.total }} 页）</span>
        </span>
      </div>
    </div>
    <p v-if="message" class="panel-message" :class="messageType">{{ message }}</p>

    <!-- ③ 批次判定与收批闸门 -->
    <div v-if="pages.length" class="scan-summary">
      <p class="panel-hint">
        这批共 {{ pages.length }} 页：可用 {{ gate.usablePages }} 页<span v-if="gate.skipped.length">、跳过 {{ gate.skipped.length }} 页</span>；
        写出 {{ stats.written }} 格（可疑 {{ stats.suspect }}），被红笔圈 {{ stats.marked }} 个，去重后 {{ stats.uniqueChars }} 个字
      </p>
      <ul v-if="gate.blockers.length" class="scan-problems">
        <li v-for="(text, i) in gate.blockers" :key="'b' + i" class="error">拦下：{{ text }}</li>
      </ul>
      <ul v-if="gate.skipped.length" class="scan-problems">
        <li v-for="item in gate.skipped" :key="'s' + item.fileIndex" class="warn">
          跳过：第 {{ item.fileIndex + 1 }} 个文件{{ item.fileName ? '（' + item.fileName + '）' : '' }} —— {{ item.reason }}
        </li>
      </ul>
      <ul v-if="gate.notes.length" class="scan-problems">
        <li v-for="(text, i) in gate.notes" :key="'n' + i" class="info">{{ text }}</li>
      </ul>
      <p v-if="gate.canProceed" class="panel-message done">
        这一批可以继续：点向导下面的「下一步」进入更正核对（只有被红笔圈掉的字才需要更正册）
      </p>
    </div>

    <!-- ④ 页级结果 + ⑤ 格级视图 -->
    <div v-if="pages.length" class="scan-pages">
      <div
        v-for="page in pages"
        :key="page.fileIndex"
        class="scan-page-row"
        :class="{ failed: !page.ok, active: openIndex === page.fileIndex }"
        :data-file-index="page.fileIndex"
        :data-page-number="page.pageNumber === null ? '' : page.pageNumber"
        :data-ok="page.ok ? '1' : '0'"
      >
        <span
          class="scan-page-handle"
          :class="{ draggable: needsManualOrder(page) }"
          :draggable="needsManualOrder(page)"
          title="页脚读不出的页可以拖到另一页上交换页序"
          @dragstart="onDragStart(page)"
          @dragover.prevent
          @drop="onDropPage(page)"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M6 3h4M6 8h4M6 13h4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </span>
        <img
          v-if="images[page.fileIndex] && images[page.fileIndex].thumb"
          class="scan-page-thumb"
          :src="images[page.fileIndex].thumb"
          alt="页面缩略图"
        />
        <span v-else class="scan-page-thumb empty">无缩略图</span>

        <div class="scan-page-info">
          <span class="scan-page-name">{{ page.fileName }}</span>
          <span class="scan-page-meta">
            页号：
            <template v-if="page.footerOk">第 {{ page.pageNumber }} 页（页脚读出）</template>
            <template v-else-if="page.pageNumber">第 {{ page.pageNumber }} 页（手选）</template>
            <template v-else>待手选</template>
            <template v-if="page.footerOk">
              · 校验码 {{ page.batchCode }}
              <span :class="page.batchMatch === false ? 'error' : 'ok'">{{ page.batchMatch === false ? '（与所选批次不符）' : '（与所选批次一致）' }}</span>
            </template>
            <template v-if="page.orientation && page.orientation.corrected"> · 已自动转正 {{ page.orientation.turns * 90 }} 度</template>
            <template v-if="page.cornerMaxError !== null"> · 四角误差 {{ page.cornerMaxError }} 像素</template>
          </span>
          <span v-if="page.ok" class="scan-page-stats">
            写出 {{ page.counts.written }} 格（可疑 {{ page.counts.suspect }}）· 被圈 {{ page.counts.marked }} 个<span
              v-if="page.counts.uncertain"
            > · 归属待确认 {{ page.counts.uncertain }}</span>
          </span>
          <span v-else class="scan-page-stats error">{{ page.reason }}</span>
          <span v-if="needsManualOrder(page)" class="scan-order">
            手选页序
            <input
              type="number"
              min="1"
              :max="batch ? batch.pageCount : 999"
              :value="page.pageNumber || ''"
              :disabled="running"
              @change="onOrderInput(page, $event.target.value)"
            />
          </span>
        </div>

        <button class="text" type="button" :disabled="!page.ok" @click="togglePage(page)">
          {{ openIndex === page.fileIndex ? '收起格子' : '看格子' }}
        </button>

        <!-- 格级视图：136 格拼图 + 判定覆盖层；点单格放大 -->
        <div v-if="openIndex === page.fileIndex" class="scan-cell-grid">
          <div v-if="!images[page.fileIndex] || !images[page.fileIndex].sheet" class="panel-hint">
            格子缩略图不可用（刷新页面后内存缓存会清空）—— 重新点「开始识别」跑一遍就能看到
          </div>
          <div v-else class="scan-grid-wrap">
            <img class="scan-grid-sheet" :src="images[page.fileIndex].sheet" alt="136 格缩略图" />
            <span
              v-for="cell in page.cells"
              :key="cell.index"
              class="scan-cell"
              :class="cellClass(cell)"
              :style="cellStyle(cell)"
              :data-index="cell.index"
              :data-verdict="cell.verdict"
              :data-marked="cell.marked ? '1' : '0'"
              :title="cellTitle(cell)"
              @click="zoomIndex = cell.index"
            ></span>
          </div>
          <p class="panel-hint">
            蓝框 = 有笔迹、橙框 = 可疑（偏淡或太小）、红框 = 被红笔圈掉、黄虚线 = 圈压在两格之间（归属待确认）；点任意一格看放大与统计
          </p>

          <div v-if="zoomCell" class="scan-cell-zoom">
            <div class="scan-cell-zoom-img" :style="zoomStyle"></div>
            <div class="scan-cell-zoom-info">
              <strong>第 {{ zoomCell.cell.index }} 格{{ zoomCell.cell.char ? '「' + zoomCell.cell.char + '」' : '' }}</strong>
              <p class="panel-hint">{{ zoomIsMarkedLabel }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <p v-if="!pages.length && !running" class="panel-hint">
      选好批次与扫描件后点「开始识别」：程序会逐页做「预处理 → 切格（方向不对会自动转正）→ 红圈识别 → 字形提取」，
      并把每页的页序、写出格数与可疑格报给你；红笔圈掉的字会单独列出来，留到下一步核对。
    </p>
  </div>
</template>
