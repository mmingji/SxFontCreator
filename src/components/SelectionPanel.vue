<script setup>
// 选字面板（阶段一「选字」步骤，决策记录 八-1 ~ 八-6）
// 职责：按分类缩小范围 → 检索或用字网格挑字 → 得到一份"要写的字"清单，交给模板生成。
// 数据来源：分类数据来自 lib/frequency.js（2026-10-08 换官方口径：规范三级 + 基础字符共四类 ——
//   一级 3500 / 二级 3000 / 三级 1605 / 基础字符 169；原 GB2312 两套分级已删，修订决策 八-2）；
//   已选清单存在 store.selection，模板生成时按它排版（**一个字都没选 = 没有字可排**，
//   2026-10-16 用户口径：不再退回全量 8274 字 —— 那会让"还没选字"看起来像"要打全量"，见 store 的 charsForTemplate）。
// 界面形态（八-4）：左侧分类树 + 上方检索框 + 中间字网格 + 右侧已选清单；
//   分类节点的「全选本类 / 取消本类」与「全选全部」**必须二次确认**（一次点击可能加入几千个字，
//   全选全部是 8274 个 —— 点错一次要按 61 页纸重写）。
// 为什么分页：最大一类 3500 字，一次性渲染几千个节点会让切换明显卡顿；每页 340 字（约一屏多）。
import { computed, ref, watch } from 'vue'
import { useProjectStore } from '../store/project.js'
import { SELECTION_LEVELS, getLevelChars, searchChars } from '../lib/frequency.js'
import { getAllChars, countChars } from '../lib/charset.js'
import { sortByRank } from '../lib/charRank.js'

// nested：作为「选字与出模板」步骤的下级出现（用户 2026-10-04 拍板的两级结构）——
// 下级形态用更轻的边框与 h3 标题，避免与步骤卡片抢层级
defineProps({ nested: { type: Boolean, default: false } })

const store = useProjectStore()
const PAGE_SIZE = 340

const query = ref('')
const page = ref(0)
const activeLevelKey = ref(SELECTION_LEVELS[0].key)
const message = ref('')
const messageType = ref('info') // info | warn | done

// 排序（2026-10-08 用户要求）：与"排列方式"（模板那一块）**共用一份状态** —— 在这里切换之后，
// 出模板的字序也跟着变，不会出现"看的是一种、排的是另一种"。切换它不动已经印出去的纸
const orderMode = computed({
  get: () => store.ui.orderMode,
  set: (value) => store.setOrderMode(value)
})

const selectedSet = computed(() => new Set(Array.from(store.selection.chars)))

// 每个分类的"已选 / 总数"：分类树上要直接看出来还差多少没写
const treeNodes = computed(() =>
  SELECTION_LEVELS.map((level) => {
    let selected = 0
    for (const ch of level.chars) if (selectedSet.value.has(ch)) selected++
    return { key: level.key, label: level.label, note: level.note, count: level.chars.length, selected }
  })
)

// 当前展示的字：检索优先，否则看选中的分类。
// 排序：切到"按使用频率"时本类内按频序排；**未被字频表收录的字排在最后并保持字表顺序** ——
//   全表有 1298 个这样的字（1129 个汉字与全部 169 个基础字符），所以"基础字符"这一类
//   在两种排序下看起来几乎一样，这是预期行为，不是没生效。
// 检索结果不参与排序：决策 八-5 要求按粘贴顺序返回，方便"粘贴一段话照着写"
const listing = computed(() => {
  const q = query.value.trim()
  if (q) return searchChars(q)
  if (!activeLevelKey.value) return []
  const chars = getLevelChars(activeLevelKey.value)
  return orderMode.value === 'rank' ? sortByRank(chars) : chars
})
const totalPages = computed(() => Math.max(1, Math.ceil(listing.value.length / PAGE_SIZE)))
const pageChars = computed(() => listing.value.slice(page.value * PAGE_SIZE, (page.value + 1) * PAGE_SIZE))

// 切换分类、改检索词、换排序时都回到第一页（否则会停在越界的页码上）
watch([activeLevelKey, query, orderMode], () => {
  page.value = 0
})

const activeLevel = computed(() => SELECTION_LEVELS.find((level) => level.key === activeLevelKey.value) || null)

function setMessage(text, type) {
  message.value = text
  messageType.value = type || 'info'
}

// 选字一改要提示一句。**不是"作废"，而是"要出新的纸就重新下载一份压缩包"**（2026-10-16 修订）：
//   旧口径写的是"已打印的模板随即失效 / 重印重写"，那是模板与识别脱钩之前的话（口径见《决策记录》五-9）——
//   现在识别端按**纸面上认出来的字**定"这一页写了哪些字"，旧纸与新纸可以混着传，改选字不会让任何纸作废。
// 2026-10-15：批次已彻底删除，所以也不再提"作废了几个批次"。
function reportChange(result, what) {
  if (!result.changed) {
    setMessage(what + '：没有变化', 'info')
    return
  }
  setMessage(what + '：当前已选 ' + result.count + ' 字；要出新的模板就重新下载一份压缩包（新的字序文件也在里面），' +
    '已经写好、准备识别的那批纸照旧能用', 'done')
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
  // 二次确认：一次点击可能加入或移除几千个字（八-4）。
  // 注意 `level.chars.length` 是**数组长度**（按码点算）：字表里有扩展 B 区汉字，字符串的 .length 会虚高
  if (!window.confirm('确认要' + action + '「' + level.label + '」的 ' + level.chars.length + ' 个字吗？')) return
  reportChange(store.setLevelSelected(level.chars, select), action + '「' + level.label + '」')
}

// 全选全部（2026-10-08 新增）：这是"打全量"的入口 —— 第 1 步的第二个档位只到「常用 6500 字」，
// 想做全量 8274 字（61 页）就走这里。与"全选本类"同一规格：**必须二次确认**。
function onSelectAllLevels() {
  const all = getAllChars()
  if (!window.confirm('确认要全选全部 ' + all.length + ' 个字吗？全量约 ' + Math.ceil(all.length / 136) + ' 页，是一次长期工程')) return
  reportChange(store.setLevelSelected(all, true), '全选全部')
}

// 清空已选（一次点掉全部）
function onClearAllLevels() {
  if (!store.selectedCount) {
    setMessage('还没有选字', 'info')
    return
  }
  if (!window.confirm('确认清空已选的 ' + store.selectedCount + ' 个字吗？')) return
  reportChange(store.setSelection(''), '清空已选')
}

// 页级全选 / 取消（2026-10-08 用户要求）：只动当前这一页的字（最多 340 个），**不弹确认** ——
// 与"全选本类"（一次 3500 字、必须二次确认）不同，页级误点之后点「取消本页」就回来了
function onSelectPage(select) {
  const chars = pageChars.value
  if (!chars.length) return
  const action = select ? '全选本页' : '取消本页'
  reportChange(store.setLevelSelected(chars, select), action + '（本页 ' + chars.length + ' 字）')
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

// 已选清单：按分类给出分布，让用户知道"哪些类还没写"
const selectedStats = computed(() => {
  const stats = []
  for (const level of SELECTION_LEVELS) {
    let count = 0
    for (const ch of level.chars) if (selectedSet.value.has(ch)) count++
    if (count) stats.push({ key: level.key, label: level.label, count })
  }
  return stats
})

// 出模板的页数：按**码点**数已选字数（countChars）—— store.charsForTemplate 是字符串，
// 直接用 .length 会被扩展 B 区汉字（代理对）多算一个。
// **没选字时是 0 页**（2026-10-16 用户口径：没选字就是没字可排，不再退回全量 8274 字）
const pickedTotal = computed(() => countChars(store.charsForTemplate))
const pageCount = computed(() => (pickedTotal.value ? Math.ceil(pickedTotal.value / 136) : 0))
</script>

<template>
  <section class="card" :class="{ nested }">
    <!-- 嵌在第 1 步「用哪些字 → 自定义选字」下面时**不再重复标题**（上面那组单选已经说明了这是什么）；
         独立使用时（nested 为假）才需要自己的标题 -->
    <h2 v-if="!nested">选字</h2>

    <p class="panel-hint">
      按《通用规范汉字表》分级：一级 3500 / 二级 3000 / 三级 1605，另加基础字符 169（半角 ASCII + 中文标点 + 全角符号）。
      先写「一级常用字 + 基础字符」（约 27 页）就能得到一套日常可用的字体；打全量（8274 字 / 61 页）用下面的「全选全部」。
    </p>

    <div class="panel-row">
      <div class="panel-field">
        <span class="field-label">检索</span>
        <input
          v-model="query"
          type="text"
          class="search-input"
          placeholder="输入汉字，或直接粘贴一整段（如：我们你好世界）"
        />
        <button data-role="add-search-results" :disabled="!query.trim()" @click="onAddSearchResults">把检索到的字全部加入</button>
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
          <!-- 全选全部 = 打全量的入口（第 1 步第二个档位只到「常用 6500 字」，全量 8274 字走这里）；
               点错了要收回：右侧的「清空已选」（或用「取消本类」逐类退） -->
          <button @click="onSelectAllLevels">全选全部</button>
        </div>
      </aside>

      <div class="select-grid-wrap">
        <div class="grid-head">
          <span class="panel-hint">
            <template v-if="query.trim()">检索结果 {{ listing.length }} 字</template>
            <template v-else-if="activeLevel">「{{ activeLevel.label }}」共 {{ activeLevel.chars.length }} 字</template>
            <template v-else>请选择左侧分类，或在上方检索</template>
            （第 {{ page + 1 }} / {{ totalPages }} 页）
          </span>
          <span class="grid-tools">
            <!-- 排序与模板那一块的「排列方式」是同一份状态：在这里切换，出模板的字序也跟着变 -->
            <span class="sort-picker">
              <label class="radio"><input v-model="orderMode" type="radio" value="rank" />按使用频率</label>
              <label class="radio"><input v-model="orderMode" type="radio" value="charset" />笔画序</label>
            </span>
            <span class="pager">
              <button :disabled="!pageChars.length" @click="onSelectPage(true)">全选本页</button>
              <button :disabled="!pageChars.length" @click="onSelectPage(false)">取消本页</button>
              <button :disabled="page <= 0" @click="page--">上一页</button>
              <button :disabled="page >= totalPages - 1" @click="page++">下一页</button>
            </span>
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
          <li v-if="!selectedStats.length" class="muted">（还没选字）</li>
        </ul>
        <p class="panel-hint">
          <template v-if="pickedTotal">出模板将排 {{ pickedTotal }} 字 ≈ {{ pageCount }} 页（每页 136 格）。</template>
          <template v-else>还没选字：挑几个字，或点左边的「全选全部」打全量（8274 字）。</template>
        </p>
        <button class="clear-button" :disabled="!store.selectedCount" @click="onClearAllLevels">清空已选</button>
      </aside>
    </div>

    <p v-if="message" class="panel-message" :class="messageType">{{ message }}</p>

    <p class="panel-hint">
      字序规则：出模板时按<strong>当前排列方式</strong>排版（按使用频率时为频序、笔画序时为《通用规范汉字表》的官方字序），
      与您点选的先后无关 —— 同一份选字每次都排成同一版，页码与格位可复现。
      <strong>改选字不会让已经写好的纸作废</strong>：第 2 步识别是从纸面上认参考字、自己定出这一页写了哪些字，
      所以旧纸与新纸可以混着传；要出新的纸，重新下载一份模板压缩包即可（新的字序文件也在包里）。
    </p>
  </section>
</template>

<style scoped>
.search-input {
  min-width: 320px;
  flex: 1;
}

/* 三块（分类树 / 候选字网格 / 已选清单）用**竖向圆点虚线**分隔（用户 2026-10-08 要求）：
   不用 `border-right: 1px dotted` —— 它在 1 倍缩放下渲染成一串几乎相连的 1px 点，看上去是条浅实线；
   改用**径向渐变画圆点**（直径 2px、纵向间隔 8px、沿 y 轴重复），在 100% 缩放下也能一眼看出是圆点。
   `gap` 设为 0，间距改由各块自己的 padding 撑开 —— 否则"线 + gap"会让线两侧的空白不对称。 */
.select-layout {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr) 200px;
  gap: 0;
  margin-top: 6px;
}

.select-tree,
.select-grid-wrap {
  /* 圆点直径约 3px、纵向间隔 8px、颜色比 --border(#e4e7ee) 深一档 —— 实测 1px 的点在 1 倍缩放下
     几乎看不见（截图核对过），所以用 1.4px 半径 + 4px 宽的 tile */
  background-image: radial-gradient(circle, #b3bbc9 1.4px, transparent 1.4px);
  background-size: 4px 8px;
  background-repeat: repeat-y;
  background-position: right top;
}

.select-tree {
  padding-right: 12px;
}

.select-grid-wrap {
  padding: 0 12px;
}

.select-picked {
  padding-left: 12px;
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
  flex-wrap: wrap;
}

.grid-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}

.sort-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
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
