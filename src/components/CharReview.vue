<script setup>
// 逐格复核（第 2 步「上传识别」的下级界面）：2026-10-11 新模型（决策 五-9 ③）
// 什么时候用：这一页**没能靠纸面上的参考字认出整页字序**（多半是自定义选字的纸 —— 它的字序是某个
//   全序的子序列，不是连续的一段），于是退到"逐格识别 + 页脚页号"，认不准的格交人过一眼。
// 界面口径（与纸面版式一致）：17 列 × 8 行 = 136 格，每格显示认出来的字（没认出来显示「？」）；
//   认不准的格加浅黄底（与页级行里的"需要确认 K 格"是同一批格）。
// 操作：点某一格 → 底部一条固定区给出该格的候选字（最多 5 个，来自纸面参考字的匹配结果）+
//   一个手输框；选中或输入后写回**识别结果本身**（store.setScanPageChar：pageChars / cells / unsureCells
//   三处一起改）—— 复核要花时间，刷新后不能白干。
// 为什么写回走 store 而不是直接改 props：page 是 store 里的那个对象，直接改也能"看着对"，
//   但不会落盘、也不会同步到字形计划读的 cells[i].char（漏了它就会出现"界面改了、进字体的还是旧字"）。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useProjectStore } from '../store/project.js'
import { LAYOUT } from '../lib/layout.js'

const props = defineProps({
  page: { type: Object, required: true },
  open: { type: Boolean, default: false }
})
const emit = defineEmits(['close'])

const store = useProjectStore()
const selected = ref(null) // 当前正在确认的格号（0 起；null = 还没点）
const manual = ref('') // 手输框里的内容

const perPage = LAYOUT.perPage

// 每一格要显示的东西：字（认不出为 null）、是不是"认不准"、是不是"还没认出来"
const cells = computed(() => {
  const chars = props.page.pageChars || []
  const unsure = new Set(props.page.unsureCells || [])
  const out = []
  for (let i = 0; i < perPage; i++) {
    out.push({ index: i, char: chars[i] || null, unsure: unsure.has(i) })
  }
  return out
})

// 已确认 = 已经认出/填上字的格数；待确认 = 认不准的格 ∪ 还没认出来的格（两者会重叠，按格号去重）
const confirmedCount = computed(() => cells.value.filter((c) => c.char).length)
const pendingCells = computed(() => cells.value.filter((c) => c.unsure || !c.char))
const candidates = computed(() => {
  if (selected.value === null) return []
  const all = props.page.charCandidates || []
  return (all[selected.value] || []).filter(Boolean).slice(0, 5)
})
const selectedCell = computed(() => (selected.value === null ? null : cells.value[selected.value]))
// 手输只取**第一个字**（扩展 B 区汉字是代理对，不能按 UTF-16 码元切，所以用 Array.from）
const manualChar = computed(() => Array.from(manual.value.trim())[0] || '')

function pick(index) {
  selected.value = index
  manual.value = ''
}

function write(char) {
  if (selected.value === null || !char) return
  const page = props.page
  store.setScanPageChar({ fileIndex: page.fileIndex, cellIndex: selected.value, char })
  manual.value = ''
}

function applyManual() {
  write(manualChar.value)
}

function onKeydown(e) {
  if (e.key === 'Escape' && props.open) emit('close')
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div v-if="open" class="backup-overlay" @click.self="emit('close')">
    <div class="backup-modal char-review-modal" role="dialog" aria-label="逐格确认" data-role="char-review">
      <div class="backup-head">
        <h3>
          逐格确认
          <span class="char-review-sub">{{ page.fileName }}<template v-if="page.pageNumber"> · 第 {{ page.pageNumber }} 页</template></span>
        </h3>
        <button type="button" class="text" data-role="review-close" @click="emit('close')">关闭</button>
      </div>

      <p class="panel-hint">
        这一页没能从纸面上的参考字确定整页字序，下面是<strong>逐格认出来</strong>的字：<strong>浅黄底</strong>的格是认不准的。
        点一下那一格，从候选里挑一个，或直接手输正确的字（对着纸上那 136 格的位置看）。
      </p>
      <p class="char-review-count" data-role="review-count">
        已确认 <strong>{{ confirmedCount }}</strong> / {{ perPage }}<span v-if="pendingCells.length">，还有 {{ pendingCells.length }} 格待确认</span>
      </p>

      <div class="char-review-grid" :style="{ gridTemplateColumns: 'repeat(' + LAYOUT.cols + ', 1fr)' }">
        <button
          v-for="cell in cells"
          :key="cell.index"
          type="button"
          class="char-review-cell"
          :class="{ unsure: cell.unsure, blank: !cell.char, picked: cell.index === selected }"
          :data-index="cell.index"
          :data-unsure="cell.unsure ? '1' : '0'"
          :title="'第 ' + cell.index + ' 格' + (cell.char ? '：' + cell.char : '：还没认出来') + (cell.unsure ? '（认不准，建议核对）' : '')"
          @click="pick(cell.index)"
        >{{ cell.char || '？' }}</button>
      </div>

      <!-- 底部固定区：当前格的候选 + 手输。候选来自纸面参考字的匹配结果（最多 5 个，按相似度排） -->
      <div class="char-review-bar" data-role="review-bar">
        <template v-if="!selectedCell">
          <span class="panel-hint">点上面任意一格开始确认</span>
        </template>
        <template v-else>
          <span class="char-review-current">
            第 {{ selectedCell.index }} 格：{{ selectedCell.char || '还没认出来' }}
          </span>
          <span class="panel-hint">候选：</span>
          <button
            v-for="(ch, i) in candidates"
            :key="'c' + i"
            type="button"
            class="char-review-cand"
            data-role="review-candidate"
            @click="write(ch)"
          >{{ ch }}</button>
          <span v-if="!candidates.length" class="panel-hint">没有候选，请直接手输</span>
          <label class="char-review-input">
            手输
            <input
              v-model="manual"
              type="text"
              maxlength="4"
              placeholder="输入一个字"
              data-role="review-input"
              @keyup.enter="applyManual"
            />
          </label>
          <button type="button" class="primary" :disabled="!manualChar" data-role="review-apply" @click="applyManual">
            用这个字
          </button>
        </template>
        <!-- 看完这一页就收工：复核结果已经逐格写回识别结果（不必等"全部确认"） -->
        <button type="button" class="primary char-review-done" data-role="review-done" @click="emit('close')">完成</button>
      </div>
    </div>
  </div>
</template>
