<script setup>
// 选字面板（阶段一「选字」步骤，决策记录 八-1 ~ 八-6）
// 职责：按频次分级缩小范围 → 检索或用字网格挑字 → 得到一份"要写的字"清单，交给模板生成。
// 数据来源：分级数据来自 lib/frequency.js（两套标准：GB2312 与《通用规范汉字表》2013）；
//   已选清单存在 store.selection，模板生成时按它排版（空 = 全量）。
// 界面形态（八-4）：左侧分类树 + 上方检索框 + 中间字网格 + 右侧已选清单；
//   分类节点的「全选本类 / 取消本类」**必须二次确认**（一次点击可能加入 3755 个字）。
// 为什么分页：最大一类 3755 字，一次性渲染几千个节点会让切换明显卡顿；每页 340 字（约一屏多）。
import { computed, ref, watch } from 'vue'
import { useProjectStore } from '../store/project.js'
import { FREQUENCY_SETS, getFrequencySet, getLevelChars, searchChars } from '../lib/frequency.js'

// nested：作为「选字与出模板」步骤的下级出现（用户 2026-10-04 拍板的两级结构）——
// 下级形态用更轻的边框与 h3 标题，避免与步骤卡片抢层级
defineProps({ nested: { type: Boolean, default: false } })

const store = useProjectStore()
const PAGE_SIZE = 340

const query = ref('')
const page = ref(0)
const activeLevelKey = ref(getFrequencySet(store.selection.standard).levels[0].key)
const message = ref('')
const messageType = ref('info') // info | warn | done

const activeSet = computed(() => getFrequencySet(store.selection.standard))
const selectedSet = computed(() => new Set(Array.from(store.selection.chars)))

// 每个分类的"已选 / 总数"：分类树上要直接看出来还差多少没写
const treeNodes = computed(() =>
  activeSet.value.levels.map((level) => {
    let selected = 0
    for (const ch of level.chars) if (selectedSet.value.has(ch)) selected++
    return { key: level.key, label: level.label, note: level.note, count: level.count, selected }
  })
)

// 当前展示的字：检索优先，否则看选中的分类
const listing = computed(() => {
  const q = query.value.trim()
  if (q) return searchChars(q)
  if (!activeLevelKey.value) return []
  return getLevelChars(store.selection.standard, activeLevelKey.value)
})
const totalPages = computed(() => Math.max(1, Math.ceil(listing.value.length / PAGE_SIZE)))
const pageChars = computed(() => listing.value.slice(page.value * PAGE_SIZE, (page.value + 1) * PAGE_SIZE))

// 切换标准或分类、改检索词时回到第一页（否则会停在越界的页码上）
watch([() => store.selection.standard, activeLevelKey, query], () => {
  page.value = 0
})
// 换标准后原来的分类 key 不存在了，回到新标准的第一类
watch(
  () => store.selection.standard,
  (standard) => {
    activeLevelKey.value = getFrequencySet(standard).levels[0].key
  }
)

const activeLevel = computed(() => activeSet.value.levels.find((level) => level.key === activeLevelKey.value) || null)

function setMessage(text, type) {
  message.value = text
  messageType.value = type || 'info'
}

// 选字一改，已打印的模板随即失效；把作废情况明确说出来（八-9 要求"必须提示"）
function reportChange(result, what) {
  if (!result.changed) {
    setMessage(what + '：没有变化', 'info')
    return
  }
  const voidNote = result.voided ? '；已作废 ' + result.voided + ' 个批次，原模板需要重印重写' : ''
  setMessage(what + '：当前已选 ' + result.count + ' 字' + voidNote, result.voided ? 'warn' : 'done')
}

function onToggleChar(char) {
  // **先读"点之前"是否已选，再 toggle**：两个实参的求值顺序是从左到右，若把 store.toggleChar(char) 写在前面，
  // 后面的 selectedSet 已经是"点完"的新状态 —— 消息文案会正好说反（实测：加入却显示"取消"）
  const wasSelected = selectedSet.value.has(char)
  reportChange(store.toggleChar(char), (wasSelected ? '取消「' : '加入「') + char + '」')
}

function onLevelAll(select) {
  const level = activeLevel.value
  if (!level) return
  const action = select ? '全选' : '取消'
  // 二次确认：一次点击可能加入或移除几千个字（八-4）
  if (!window.confirm('确认要' + action + '「' + level.label + '」的 ' + level.count + ' 个字吗？')) return
  reportChange(store.setLevelSelected(Array.from(level.chars), select), action + '「' + level.label + '」')
}

function onAddSearchResults() {
  const hits = searchChars(query.value)
  if (!hits.length) {
    setMessage('检索框里没有字表内的字', 'info')
    return
  }
  const merged = new Set([...Array.from(store.selection.chars), ...hits])
  reportChange(store.setSelection([...merged]), '把检索到的 ' + hits.length + ' 个字加入已选')
}

function onClearAll() {
  if (!store.selectedCount) {
    setMessage('还没有选字', 'info')
    return
  }
  if (!window.confirm('确认清空已选的 ' + store.selectedCount + ' 个字吗？（清空后出模板等于全量 6919 字）')) return
  reportChange(store.setSelection(''), '清空已选')
}

// 已选清单：按分类给出分布，让用户知道"哪些类还没写"
const selectedStats = computed(() => {
  const stats = []
  for (const level of activeSet.value.levels) {
    let count = 0
    for (const ch of level.chars) if (selectedSet.value.has(ch)) count++
    if (count) stats.push({ key: level.key, label: level.label, count })
  }
  return stats
})

const pageCount = computed(() => Math.max(1, Math.ceil(store.charsForTemplate.length / 136)))
</script>

<template>
  <section class="card" :class="{ nested }">
    <h2 v-if="!nested">选字</h2>
    <h3 v-else>自定义选字</h3>

    <div class="panel-row">
      <div class="panel-field">
        <span class="field-label">频次标准</span>
        <label v-for="item in FREQUENCY_SETS" :key="item.key" class="radio">
          <input
            type="radio"
            :value="item.key"
            :checked="store.selection.standard === item.key"
            @change="store.setStandard(item.key)"
          />{{ item.label }}
        </label>
        <span class="panel-hint">{{ activeSet.note }}</span>
      </div>
    </div>

    <div class="panel-row">
      <div class="panel-field">
        <span class="field-label">检索</span>
        <input
          v-model="query"
          type="text"
          class="search-input"
          placeholder="输入汉字，或直接粘贴一整段（如：我们你好世界）"
        />
        <button :disabled="!query.trim()" @click="onAddSearchResults">把检索到的字全部加入</button>
        <span v-if="query.trim()" class="panel-hint">
          命中 {{ listing.length }} 个字（只认字表内的字；半角数字与字母也在字表里）
        </span>
      </div>
    </div>

    <div class="select-layout">
      <aside class="select-tree">
        <p class="tree-title">分类</p>
        <ul>
          <li v-for="node in treeNodes" :key="node.key" :class="{ active: node.key === activeLevelKey && !query.trim() }">
            <button class="tree-node" @click="activeLevelKey = node.key; query = ''">
              <span class="tree-label">{{ node.label }}</span>
              <span class="tree-count">{{ node.selected }} / {{ node.count }}</span>
            </button>
          </li>
        </ul>
        <div class="tree-actions">
          <button :disabled="!activeLevel" @click="onLevelAll(true)">全选本类</button>
          <button :disabled="!activeLevel" @click="onLevelAll(false)">取消本类</button>
        </div>
      </aside>

      <div class="select-grid-wrap">
        <div class="grid-head">
          <span class="panel-hint">
            <template v-if="query.trim()">检索结果 {{ listing.length }} 字</template>
            <template v-else-if="activeLevel">「{{ activeLevel.label }}」共 {{ activeLevel.count }} 字</template>
            <template v-else>请选择左侧分类，或在上方检索</template>
            （第 {{ page }} / {{ totalPages }} 页）
          </span>
          <span class="pager">
            <button :disabled="page <= 0" @click="page--">上一页</button>
            <button :disabled="page >= totalPages - 1" @click="page++">下一页</button>
          </span>
        </div>
        <div class="char-grid">
          <button
            v-for="ch in pageChars"
            :key="ch"
            class="char-cell"
            :class="{ picked: selectedSet.has(ch) }"
            :title="selectedSet.has(ch) ? '点击移除' : '点击加入'"
            @click="onToggleChar(ch)"
          >{{ ch }}</button>
        </div>
        <p v-if="!pageChars.length" class="panel-hint">
          这个分类下没有字。换一个分类，或在上方检索框里粘贴想写的字。
        </p>
      </div>

      <aside class="select-picked">
        <p class="tree-title">已选 {{ store.selectedCount }} 字</p>
        <p class="panel-hint">按当前标准分布：</p>
        <ul class="picked-stats">
          <li v-for="item in selectedStats" :key="item.key">
            <span>{{ item.label }}</span><span>{{ item.count }}</span>
          </li>
          <li v-if="!selectedStats.length" class="muted">（未选字时出模板为全量 6919 字）</li>
        </ul>
        <p class="panel-hint">
          出模板将排 {{ store.charsForTemplate.length }} 字 ≈ {{ pageCount }} 页（每页 136 格）。
        </p>
        <button class="clear-button" :disabled="!store.selectedCount" @click="onClearAll">清空已选</button>
      </aside>
    </div>

    <p v-if="message" class="panel-message" :class="messageType">{{ message }}</p>

    <p class="panel-hint">
      字序规则：出模板时按<strong>全量字表的位置顺序</strong>排版（与您点选的先后无关），这样同一份选字每次都排成同一版，
      页码与格位可复现（决策记录 八-6）。改动选字会让已打印的模板作废 —— 界面会提示，识别阶段也会拦下不匹配的扫描件。
    </p>
  </section>
</template>

<style scoped>
.search-input {
  min-width: 320px;
  flex: 1;
}

.select-layout {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr) 200px;
  gap: 12px;
  margin-top: 6px;
}

.tree-title {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--text-2);
}

.select-tree ul,
.picked-stats {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tree-node {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  margin-bottom: 4px;
  padding: 6px 8px;
  font-size: 12px;
  text-align: left;
}

.select-tree li.active .tree-node {
  border-color: var(--primary);
  color: var(--primary-dark);
  background: #eff6ff;
}

.tree-label {
  min-width: 0;
}

.tree-count {
  color: var(--text-2);
  flex: none;
}

.tree-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.tree-actions button {
  font-size: 12px;
}

.select-grid-wrap {
  min-width: 0;
}

.grid-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.pager {
  display: flex;
  gap: 6px;
  flex: none;
}

.pager button {
  font-size: 12px;
  padding: 4px 10px;
}

.char-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(34px, 1fr));
  gap: 4px;
  max-height: 320px;
  overflow-y: auto;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fcfcfe;
}

.char-cell {
  padding: 0;
  height: 34px;
  font-size: 16px;
  line-height: 1;
  border-radius: 6px;
  border-color: transparent;
  background: #fff;
}

.char-cell.picked {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}

.picked-stats li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  border-bottom: 1px dashed var(--border);
}

.picked-stats li.muted {
  color: var(--text-2);
  border-bottom: none;
}

.clear-button {
  width: 100%;
  margin-top: 8px;
  font-size: 12px;
}
</style>
