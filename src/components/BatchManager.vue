<script setup>
// 批次管理（第 3 步「上传识别」里的入口 + 弹窗）：《待办与风险清单》一-6，口径见《决策记录》八-11。
// 职责：把批次一次列全（字数 / 页数 / 排列方式 / 校验码 / 生成与作废时间 / 已落盘字形），
//   并提供两个动作 —— 「作废」（仍有效的批次）与「删除」（只对已作废的开放）。
// 2026-10-11 起：批次退成**内部容器**（决策 五-9 ⑤），界面上不再让用户"选批次"（第 3 步自己复用/补一个），
//   这个弹窗只剩"看全 + 清理"的用途 —— 旧批次的字形分片还在库里，得能一次看全、能删干净。
// 为什么删除只对已作废开放：批次对应的纸可能还在用户手上，直接删掉会让那批纸彻底失去上传资格；
//   先作废再删，是一条"明确放弃"的路径（作废语义沿用八-9）。
// 为什么删除要连字形分片一起删：分片键按「批次 + 页序」命名（二-16），批次记录没了就再也找不到它们 ——
//   留着既占空间也没法再管理；确认条里会把要删掉的字形数与体积写清楚。
// 为什么确认用**行内确认条**而不是 window.confirm：原生弹窗会阻塞页面、自动化测试点不到它
//   （headless 下 confirm 默认被拒绝，流程会静默走另一条分支），而且它写不下"会删掉多少字形"这类关键信息。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useProjectStore } from '../store/project.js'
import { clearGlyphs, listGlyphPages } from '../lib/glyphStore.js'
import { formatTime } from '../lib/projectPack.js'

const store = useProjectStore()
const open = computed(() => store.ui.batchManagerOpen)

// 已落盘的字形分片：数据源是 IndexedDB（不是界面状态）—— 刷新过、或刚在别处识别完，这里都算得准
const pages = ref([])
const busy = ref(false)
const confirming = ref(null) // { id, action: 'void' | 'delete' }：当前确认条挂在哪一批的哪个动作上
const message = ref('')
const messageType = ref('info')

function setMessage(text, type) {
  message.value = text || ''
  messageType.value = type || 'info'
}

// 每批已落盘的字形（页数 / 字数 / 体积），按 batchId 归组
const glyphByBatch = computed(() => {
  const map = {}
  for (const p of pages.value) {
    const item = map[p.batchId] || (map[p.batchId] = { pages: 0, glyphs: 0, bytes: 0 })
    item.pages += 1
    item.glyphs += p.count
    item.bytes += p.bytes
  }
  return map
})

// 最新的批次排在最前（与第 3 步的批次下拉同一顺序），"第 N 批"仍按创建顺序编号
const rows = computed(() => store.batches.map((batch, index) => ({
  batch,
  no: index + 1,
  glyphs: glyphByBatch.value[batch.id] || { pages: 0, glyphs: 0, bytes: 0 }
})).reverse())

const mb = (bytes) => (bytes / 1048576).toFixed(1)
const isActive = (batch) => batch.status !== 'void'

async function refreshPages() {
  pages.value = await listGlyphPages().catch(() => [])
}

function openPanel() {
  store.openBatchManager()
  setMessage('')
  confirming.value = null
  refreshPages() // 打开时重数一遍：可能刚识别完新的一页
}
function close() {
  if (busy.value) return
  store.closeBatchManager()
  confirming.value = null
}
function onKeydown(e) {
  if (e.key === 'Escape' && open.value) close()
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))

function ask(batch, action) {
  setMessage('')
  confirming.value = { id: batch.id, action }
}

// 手动作废：与"改选字自动作废"是同一种状态，只是由人明确发起（那批纸不打算用了）
function doVoid(batch) {
  const ok = store.voidBatch(batch.id, '在批次管理里手动作废')
  confirming.value = null
  setMessage(ok
    ? '已作废这一批（' + batch.charCount + ' 字 / ' + batch.pageCount + ' 页）：它不再接受上传，其它批次不受影响；确认不用了可以在这里删掉它'
    : '这一批已经是作废状态', ok ? 'done' : 'info')
}

// 删除：先清这一批的字形分片，再删批次记录 —— 顺序反了会留下孤儿分片（批次没了就再也找不到它们）
async function doDelete(batch) {
  if (busy.value) return
  const glyphs = glyphByBatch.value[batch.id] || { pages: 0, glyphs: 0, bytes: 0 }
  busy.value = true
  setMessage('正在删除这一批的字形…', 'info')
  try {
    const cleared = glyphs.pages ? await clearGlyphs({ batchId: batch.id }) : { ok: true, removed: 0 }
    if (!cleared.ok) throw new Error(cleared.error || '字形清理失败')
    const res = store.removeBatch(batch.id)
    if (!res.ok) {
      throw new Error(res.reason === 'active' ? '这一批还没作废，不能删除' : '这一批已经不在了（可能刚被删过）')
    }
    confirming.value = null
    await refreshPages()
    setMessage('已删除这一批（' + batch.charCount + ' 字 / ' + batch.pageCount + ' 页）' +
      (cleared.removed ? '，连同 ' + cleared.removed + ' 页分片 / ' + glyphs.glyphs + ' 个字形（释放 ' + mb(glyphs.bytes) + 'MB）' : '') +
      (res.clearedScanBatch ? '；它本来是第 3 步「上传识别」正在用的批次，那边已自动改用另一个可用批次（没有就新建一个）' : ''), 'done')
  } catch (e) {
    setMessage('删除失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <span class="batch-entry">
    <button type="button" class="text batch-button" @click="openPanel">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 6h11M9 12h11M9 18h11" />
        <path d="M4 6h.01M4 12h.01M4 18h.01" />
      </svg>
      批次管理
      <span v-if="store.batches.length" class="batch-count">{{ store.batches.length }}</span>
    </button>

    <!-- 弹窗：fixed 定位、不占页面布局，因此不会影响第 3 步里已有的元素定位断言 -->
    <div v-if="open" class="backup-overlay" @click.self="close">
      <div class="backup-modal batch-modal" role="dialog" aria-label="批次管理">
        <div class="backup-head">
          <h3>批次管理</h3>
          <button type="button" class="text" data-role="batch-close" :disabled="busy" @click="close">关闭</button>
        </div>

        <p class="panel-hint">
          每生成一次模板就是一个<strong>批次</strong>：它记着"这批纸要写哪些字、按什么顺序"。
          <strong>改过选字，旧批次会自动作废</strong>（字序一变，页脚的批次校验码就对不上，那批纸不能再上传）；
          作废的批次会一直留着，确认不用了就在这里删掉。
        </p>

        <p v-if="!rows.length" class="panel-hint" data-role="batch-empty">
          还没有批次：先回到第 1 步「选字与出模板」生成一份模板。
        </p>

        <ul v-else class="batch-list" data-role="batch-list">
          <li
            v-for="row in rows"
            :key="row.batch.id"
            class="batch-item"
            :class="{ void: !isActive(row.batch) }"
            :data-batch-id="row.batch.id"
          >
            <div class="batch-line">
              <span class="batch-no">第 {{ row.no }} 批</span>
              <span class="batch-state" :class="isActive(row.batch) ? 'active' : 'void'">{{ isActive(row.batch) ? '仍有效' : '已作废' }}</span>
              <span class="batch-main">
                {{ row.batch.charCount }} 字 / {{ row.batch.pageCount }} 页 ·
                {{ row.batch.order === 'rank' ? '按使用频率' : '笔画序' }} · 校验码 {{ row.batch.batchCode }}
              </span>
            </div>
            <div class="batch-line sub">
              <span>生成于 {{ formatTime(row.batch.createdAt) }}</span>
              <span v-if="!isActive(row.batch)">
                作废于 {{ formatTime(row.batch.voidedAt) }}<template v-if="row.batch.voidReason">（{{ row.batch.voidReason }}）</template>
              </span>
              <span>
                已落盘字形：{{ row.glyphs.pages }} 页 / {{ row.glyphs.glyphs }} 个字<template v-if="row.glyphs.bytes">（{{ mb(row.glyphs.bytes) }}MB）</template>
              </span>
            </div>

            <div class="batch-actions">
              <template v-if="confirming && confirming.id === row.batch.id">
                <span class="batch-confirm">
                  <template v-if="confirming.action === 'delete'">
                    删除后无法撤销：这一批的记录、以及它已落盘的
                    {{ row.glyphs.pages }} 页 / {{ row.glyphs.glyphs }} 个字形<template v-if="row.glyphs.bytes">（{{ mb(row.glyphs.bytes) }}MB）</template>
                    会一起删掉。确定吗？
                  </template>
                  <template v-else>
                    作废后这一批不再接受上传（已识别的结果与已落盘的字形都还在）。确定吗？
                  </template>
                </span>
                <button
                  type="button"
                  class="primary"
                  :disabled="busy"
                  @click="confirming.action === 'delete' ? doDelete(row.batch) : doVoid(row.batch)"
                >确定{{ confirming.action === 'delete' ? '删除' : '作废' }}</button>
                <button type="button" class="text" :disabled="busy" @click="confirming = null">取消</button>
              </template>
              <template v-else>
                <button
                  v-if="isActive(row.batch)"
                  type="button"
                  class="text"
                  data-role="batch-void"
                  @click="ask(row.batch, 'void')"
                >作废这一批</button>
                <button
                  v-else
                  type="button"
                  class="text danger"
                  data-role="batch-delete"
                  :disabled="busy"
                  @click="ask(row.batch, 'delete')"
                >删除这一批</button>
              </template>
            </div>
          </li>
        </ul>

        <p v-if="message" class="panel-message" :class="messageType" data-role="batch-message">{{ message }}</p>
      </div>
    </div>
  </span>
</template>
