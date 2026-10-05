<script setup>
// 第 4 步：更正核对（阶段一「界面串联」B3b；规则见《决策记录》一-7、二-13）
// 职责：把「第 k 个被圈字 ↔ 更正册第 m 格」并排摆出来，允许**改派 / 删除 / 补录**，确认后交给字体构建。
// 为什么必须有这一步：红圈识别与顺序配对都只是初值 —— 配对错一个字，整套字体就有一个字对错人。
//   界面确认是最后一道闸（决策 一-7）。
// 数据来源：识别页记录在 store.scan.pages；配对初值由 lib/scanFlow.pairCorrections 算（纯逻辑、有测试）；
//   字形缩略图从 lib/scanCache 的"格子拼图"里按格裁（与第 3 步同一套精灵图做法，不额外占内存）。
import { computed, onMounted, ref } from 'vue'
import { useProjectStore } from '../store/project.js'
import { buildFinalGlyphPlan, pairCorrections } from '../lib/scanFlow.js'
import { getPageCache } from '../lib/scanCache.js'
import { LAYOUT } from '../lib/layout.js'

const store = useProjectStore()
const images = ref({}) // fileIndex → { sheet }
const message = ref('')
const messageType = ref('info')
const initialStats = ref(null) // 配对初值的统计（用于提示"改动过没有"）

const pages = computed(() => store.scan.pages)
const mainPages = computed(() => pages.value.filter((p) => p.ok && p.kind !== 'correction'))
const correctionPages = computed(() => pages.value.filter((p) => p.ok && p.kind === 'correction'))
const hasCorrectionBook = computed(() => correctionPages.value.length > 0)

// 更正册的格（连续格号 → 页 / 格 / 判定），供候选下拉与"这一格有没有笔迹"判断
const correctionCellMap = computed(() => {
  const map = new Map()
  const pageIndex = new Map()
  for (const p of correctionPages.value) pageIndex.set(p.pageNumber, p.fileIndex)
  for (const p of correctionPages.value) {
    for (const c of p.cells || []) {
      const contiguous = (p.pageNumber - 1) * LAYOUT.perPage + c.index + 1 // 与 correctionMapper.continuousIndex 同口径（1 起）
      map.set(contiguous, { contiguous, pageNumber: p.pageNumber, cellIndex: c.index, fileIndex: p.fileIndex, verdict: c.verdict })
    }
  }
  return map
})
const inkedCells = computed(() => [...correctionCellMap.value.values()].filter((c) => c.verdict !== 'empty'))

// 主区页的 fileIndex 反查（缩略图要用）
const mainFileIndex = computed(() => {
  const map = new Map()
  for (const p of mainPages.value) map.set(p.pageNumber, p.fileIndex)
  return map
})

// 生效清单：被圈字逐行 + 初值配对 + 用户调整（overrides）
const rows = computed(() => {
  const circled = store.correction.circled || []
  const initial = store.correction.pairs || []
  const overrides = store.correction.overrides || {}
  const usedBy = new Map()
  const list = circled.map((item, k) => {
    const base = initial.find((p) => p.order === k) || null
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, String(k))
    const assigned = hasOverride ? overrides[String(k)] : (base ? base.correctContinuousIndex : null)
    const cell = assigned !== null && assigned !== undefined ? correctionCellMap.value.get(assigned) : null
    if (assigned !== null && assigned !== undefined) usedBy.set(assigned, k)
    return {
      order: k,
      mainChar: item.char,
      mainCellIndex: item.mainCellIndex,
      mainPageNumber: item.pageNumber,
      assigned: assigned === undefined ? null : assigned,
      source: hasOverride ? (assigned === null ? 'removed' : 'manual') : (base ? base.source : 'blank'),
      cell
    }
  })
  return { list, usedBy }
})

const effectivePairs = computed(() => rows.value.list
  .filter((r) => r.assigned !== null && r.cell && r.cell.verdict !== 'empty')
  .map((r) => ({
    order: r.order,
    mainCellIndex: r.mainCellIndex,
    mainPageNumber: r.mainPageNumber,
    mainChar: r.mainChar,
    correctContinuousIndex: r.assigned,
    correctPageNumber: r.cell.pageNumber,
    correctCellIndex: r.cell.cellIndex,
    source: r.source === 'replacement' ? 'replacement' : (r.source === 'manual' ? 'manual' : 'main')
  })))

// 字体构建的输入计划：主区字形 + 更正覆盖（决策 一-7 的"保留主区原字形"在这里体现）
const plan = computed(() => buildFinalGlyphPlan(pages.value, {
  pairs: effectivePairs.value,
  circled: store.correction.circled || []
}))

const unmatchedRows = computed(() => rows.value.list.filter((r) => r.assigned === null || !r.cell || r.cell.verdict === 'empty'))
const extraCells = computed(() => {
  const used = new Set(rows.value.list.map((r) => r.assigned).filter((v) => v !== null))
  return inkedCells.value.filter((c) => !used.has(c.contiguous) && c.contiguous > rows.value.list.length)
})

function setMessage(text, type) {
  message.value = text
  messageType.value = type || 'info'
}

// 首次进入（或被圈清单变了）时算一次配对初值；**用户调整过就不覆盖**
function ensurePairing(force) {
  const signature = (store.correction.circled || []).map((c) => c.pageNumber + ':' + c.mainCellIndex).join(',')
  const current = (pages.value.some((p) => p.kind === 'correction') ? 'book:' : 'nobook:') + signature
  if (!force && initialStats.value && initialStats.value.signature === current) return
  if (!force && Object.keys(store.correction.overrides || {}).length) return
  const mapped = pairCorrections(pages.value)
  store.setCorrectionResult({
    pairs: mapped.pairs,
    unmatched: mapped.unmatched,
    discarded: mapped.discarded,
    extra: mapped.extra,
    messages: mapped.messages,
    stats: mapped.stats,
    circled: mapped.circled
  })
  initialStats.value = { signature: current, stats: mapped.stats }
}

onMounted(() => {
  const restored = {}
  for (const page of pages.value) {
    const cache = getPageCache(page.fileIndex)
    if (cache) restored[page.fileIndex] = { sheet: cache.sheet }
  }
  images.value = restored
  if (store.scan.pages.length) ensurePairing(false)
  else setMessage('还没有识别结果：先回到第 3 步上传扫描件并识别', 'error')
})

function applyOverride(order, value) {
  const overrides = { ...(store.correction.overrides || {}) }
  if (value === null) overrides[String(order)] = null
  else overrides[String(order)] = value
  const next = rows.value.list.map((r) => {
    if (r.order !== order) return r
    const assigned = value
    const cell = assigned === null ? null : correctionCellMap.value.get(assigned)
    return { ...r, assigned, cell, source: value === null ? 'removed' : 'manual' }
  })
  const pairs = next
    .filter((r) => r.assigned !== null && r.cell && r.cell.verdict !== 'empty')
    .map((r) => ({
      order: r.order,
      mainCellIndex: r.mainCellIndex,
      mainPageNumber: r.mainPageNumber,
      mainChar: r.mainChar,
      correctContinuousIndex: r.assigned,
      correctPageNumber: r.cell.pageNumber,
      correctCellIndex: r.cell.cellIndex,
      source: r.source === 'manual' ? 'manual' : (r.source === 'replacement' ? 'replacement' : 'main')
    }))
  store.setCorrectionOverrides({ overrides, pairs, unmatched: [] })
  setMessage(value === null
    ? '已删除这一对：「' + (next.find((r) => r.order === order) || {}).mainChar + '」将保留主区原字形'
    : '已把「' + (next.find((r) => r.order === order) || {}).mainChar + '」改派到更正册第 ' + value + ' 格', 'info')
}

function confirmAll() {
  store.setCorrectionConfirmed(true)
  setMessage('已确认这份更正对应：' + effectivePairs.value.length + ' 个字用更正册字形，' +
    ((store.correction.circled || []).length - effectivePairs.value.length) + ' 个被圈的字保留主区原字形', 'done')
}

// 精灵图：从"格子拼图"里裁出某一格（与第 3 步单格放大同一套做法）
function cellThumbStyle(fileIndex, cellIndex) {
  const sheet = images.value[fileIndex]
  if (!sheet || !sheet.sheet) return {}
  const col = cellIndex % LAYOUT.cols
  const row = Math.floor(cellIndex / LAYOUT.cols)
  return {
    backgroundImage: 'url(' + sheet.sheet + ')',
    backgroundSize: LAYOUT.cols * 100 + '% ' + LAYOUT.rows * 100 + '%',
    backgroundPosition: (col / (LAYOUT.cols - 1)) * 100 + '% ' + (row / (LAYOUT.rows - 1)) * 100 + '%'
  }
}
</script>

<template>
  <div class="step-body">
    <p v-if="message" class="panel-message" :class="messageType">{{ message }}</p>

    <div v-if="!pages.length" class="panel-hint">
      这一步需要先在第 3 步上传并识别扫描件（主区写了字的页，以及用红笔圈掉错字的那几页）。
    </div>

    <template v-else>
      <p class="panel-hint">
        主区被红笔圈掉 <strong>{{ (store.correction.circled || []).length }}</strong> 个字；
        更正册 <strong>{{ correctionPages.length }}</strong> 页<span v-if="!hasCorrectionBook">（还没上传更正册）</span>；
        当前有 <strong>{{ effectivePairs.length }}</strong> 个字会用更正册的字形，
        <strong>{{ (store.correction.circled || []).length - effectivePairs.length }}</strong> 个被圈的字保留主区原字形。
      </p>

      <p v-if="!hasCorrectionBook && (store.correction.circled || []).length" class="step-note">
        主区有被圈掉的字，但没上传更正册：这些字会保留主区原字形（写错的那个）。
        要更正的话，回第 3 步把更正册（空白 5 页那张，页脚校验码 0）一起上传识别。
      </p>

      <ul v-if="(store.correction.messages || []).length" class="scan-problems">
        <li v-for="(m, i) in store.correction.messages" :key="i" :class="m.level === 'warn' ? 'warn' : 'info'">{{ m.text }}</li>
      </ul>

      <!-- 并排核对表 -->
      <div v-if="rows.list.length" class="corr-table">
        <div class="corr-head">
          <span>#</span><span>主区（写错的字）</span><span>更正册（重写的字）</span><span>操作</span>
        </div>
        <div
          v-for="row in rows.list"
          :key="row.order"
          class="corr-row"
          :class="{ replaced: row.assigned !== null && row.cell, removed: row.assigned === null }"
          :data-order="row.order"
          :data-char="row.mainChar || ''"
          :data-assigned="row.assigned === null ? '' : row.assigned"
        >
          <span class="corr-index">{{ row.order + 1 }}</span>
          <span class="corr-side">
            <span class="corr-thumb" :style="cellThumbStyle(mainFileIndex.get(row.mainPageNumber), row.mainCellIndex)"></span>
            <span class="corr-text">
              「{{ row.mainChar }}」<br />
              第 {{ row.mainPageNumber }} 页 · 第 {{ row.mainCellIndex }} 格
            </span>
          </span>
          <span class="corr-side">
            <template v-if="row.assigned !== null && row.cell && row.cell.verdict !== 'empty'">
              <span class="corr-thumb" :style="cellThumbStyle(row.cell.fileIndex, row.cell.cellIndex)"></span>
              <span class="corr-text">
                第 {{ row.assigned }} 格（第 {{ row.cell.pageNumber }} 页 · 第 {{ row.cell.cellIndex }} 格）<br />
                <span class="corr-tag">{{ row.source === 'replacement' ? '补写' : (row.source === 'manual' ? '手动指定' : '顺序配对') }}</span>
              </span>
            </template>
            <template v-else>
              <span class="corr-thumb empty"></span>
              <span class="corr-text">
                没有对应格<br />
                <span class="corr-tag muted">保留主区原字形</span>
              </span>
            </template>
          </span>
          <span class="corr-actions">
            <select
              :value="row.assigned === null ? '' : String(row.assigned)"
              @change="applyOverride(row.order, $event.target.value === '' ? null : Number($event.target.value))"
            >
              <option value="">（不更正 · 保留主区原字形）</option>
              <option
                v-for="cell in inkedCells"
                :key="cell.contiguous"
                :value="String(cell.contiguous)"
                :disabled="rows.usedBy.has(cell.contiguous) && rows.usedBy.get(cell.contiguous) !== row.order"
              >
                更正册第 {{ cell.contiguous }} 格{{ rows.usedBy.has(cell.contiguous) && rows.usedBy.get(cell.contiguous) !== row.order ? '（已用于第 ' + (rows.usedBy.get(cell.contiguous) + 1) + ' 个字）' : '' }}
              </option>
            </select>
            <button v-if="row.assigned !== null" class="text" type="button" @click="applyOverride(row.order, null)">删除这一对</button>
          </span>
        </div>
      </div>
      <p v-else class="panel-hint">主区没有检测到被红笔圈掉的字：这份更正册暂时没有可对应的对象。</p>

      <p v-if="extraCells.length" class="panel-hint">
        更正册上还有 {{ extraCells.length }} 个多写的格没配上（{{ extraCells.map((c) => '第 ' + c.contiguous + ' 格').join('、') }}）——
        可以把上面的某一对改派到这些格，或确认是写多了。
      </p>

      <p class="panel-hint">
        字形计划：主区 <strong>{{ plan.items.length }}</strong> 个字形，其中 <strong>{{ plan.replaced }}</strong> 个来自更正册。
        <span v-for="(p, i) in plan.problems" :key="'p' + i">{{ p }}</span>
      </p>

      <div class="panel-actions">
        <button class="primary" :disabled="!rows.list.length && !plan.items.length" @click="confirmAll">
          {{ store.correction.confirmed ? '重新确认（已确认过）' : '确认这份更正对应' }}
        </button>
        <button class="text" type="button" @click="ensurePairing(true)">按识别结果重算配对</button>
        <span v-if="store.correction.confirmed" class="panel-message done">已确认，可以进入下一步生成字体</span>
      </div>
    </template>
  </div>
</template>
