<script setup>
// 应用骨架（阶段一步骤 1.1；2026-10-04 按用户要求改成**向导式**：一次只显示一步）
// 职责：顶栏（品牌 + 字体族名）+ 向导步骤条 + 当前步骤的内容 + 上一步 / 下一步 + 运行环境自检。
// 步骤与状态：全部来自 src/lib/flow.js 的 buildFlowState()（纯逻辑、可在 Node 里断言）——
//   界面不维护第二份状态机，步骤条上的"已完成 / 当前 / 未开始 / 待接入"都是算出来的。
// 内容按需加载：模板步骤依赖 pdf-lib + fontkit + pdf.js（构建后是独立 chunk），静态引入会让首屏一起下载
//   （实测冷启动白屏 3.5 秒里一大半是它），所以第 1 步用 defineAsyncComponent 懒加载。
import { computed, defineAsyncComponent, h, ref } from 'vue'
import { useProjectStore } from './store/project.js'
import { getCharsetMeta } from './lib/charset.js'
import { buildFlowState, flowSummary, stepIndex, stepNavigation } from './lib/flow.js'
import { glyphStoreStats } from './lib/glyphStore.js'
import StepContent from './components/StepContent.vue'
import GuideLink from './components/GuideLink.vue'
import ProjectBackup from './components/ProjectBackup.vue'

// 第 1 步「选字与出模板」按需加载（pdf-lib + fontkit + pdf.js）
const StepLoading = {
  render: () => h('section', { class: 'step-body' }, [
    h('p', { class: 'panel-hint' }, '正在加载模板面板（首次需要准备 PDF 组件与字体，约 1 秒）…')
  ])
}
const TemplatePreview = defineAsyncComponent({
  loader: () => import('./components/TemplatePreview.vue'),
  loadingComponent: StepLoading,
  delay: 120,
  timeout: 60000
})
// 第 3 步「上传识别」同样按需加载：它依赖四个识别模块（预处理 / 切格 / 红圈 / 提取），首屏用不到
const ScanUpload = defineAsyncComponent({
  loader: () => import('./components/ScanUpload.vue'),
  loadingComponent: StepLoading,
  delay: 120,
  timeout: 60000
})
// 第 4 步「更正核对」也按需加载（用到识别记录与格子拼图）
const CorrectionConfirm = defineAsyncComponent({
  loader: () => import('./components/CorrectionConfirm.vue'),
  loadingComponent: StepLoading,
  delay: 120,
  timeout: 60000
})
// 第 5 步「生成字体」与第 6 步「下载安装」：字体合成要 potrace + fonteditor，打包要 jszip，都按需加载
const BuildFont = defineAsyncComponent({
  loader: () => import('./components/BuildFont.vue'),
  loadingComponent: StepLoading,
  delay: 120,
  timeout: 60000
})
const ResultDownload = defineAsyncComponent({
  loader: () => import('./components/ResultDownload.vue'),
  loadingComponent: StepLoading,
  delay: 120,
  timeout: 60000
})

const store = useProjectStore()
const charset = getCharsetMeta() // 内置字表的真实规模，供自检展示

// 流程进度快照：全部来自真实数据（批次 / 识别结果 / 更正确认 / 字体产物），六个步骤的状态与
// "下一步能不能走"都由 lib/flow.js 按它推导 —— 界面不维护第二份状态机
const scanStats = computed(() => store.scanGlyphStats)
const progress = computed(() => ({
  batchCount: store.batches.length,
  activeBatchCount: store.activeBatches.length,
  uploadedPages: scanStats.value.pagesUsable,
  glyphCount: scanStats.value.written,
  // 有被红笔圈掉的字时，必须先在第 4 步确认更正对应，才允许生成字体（决策 一-7 的最后一道闸）
  needsCorrection: (store.correction.circled || []).length > 0,
  correctionConfirmed: store.correction.confirmed,
  fontBuilt: store.font.built,
  // "下载安装"这一步：字体一旦生成，产物就在手上了（下载随时可做），所以**以 fontBuilt 为准**。
  // 原来这里数的是"下载过字体 zip"，随字段改名一并订正 —— 它混用了"项目包备份"那个字段，
  // 而项目包备份是另一件事（决策 五-3 的提醒），不该决定这一步的状态
  exported: store.font.built === true
}))
const flow = computed(() => buildFlowState(progress.value))
// 打开页面时停在"第一个还没做完的步骤"（用户 2026-10-04 的界面形态要求：向导式）
const currentKey = ref(flow.value.currentKey)
const currentStep = computed(() => flow.value.steps[stepIndex(currentKey.value)])
const nav = computed(() => stepNavigation(flow.value, currentKey.value))

// 步骤条可点：已完成的步骤允许回看，可行的步骤允许直接进入；不可行的点了给中文原因（不做静默失败）
const blockedReason = ref('')
function goto(key) {
  const step = flow.value.steps[stepIndex(key)]
  if (step.done || step.available || step.status === 'current') {
    currentKey.value = key
    blockedReason.value = ''
  } else {
    blockedReason.value = '「' + step.label + '」暂时进不去：' + step.reason
  }
}
function goNext() {
  if (nav.value.canNext) {
    currentKey.value = nav.value.nextKey
    blockedReason.value = ''
  } else if (nav.value.nextReason) {
    blockedReason.value = nav.value.nextReason
  }
}
function goPrev() {
  if (nav.value.canPrev) {
    currentKey.value = nav.value.prevKey
    blockedReason.value = ''
  }
}

// 环境自检：这几项是后续步骤真实依赖的浏览器能力，检测结果决定后续步骤能否开工
// （本机字体用于模板 PDF 嵌入参考字，决策记录 一-11；画布 2D 用于切格与笔迹提取）
// 判据要与实现一致：界面用的是 <input type="file"> + File.arrayBuffer()，不是 File System Access API
const fontPickerSupported =
  typeof window !== 'undefined' && typeof File !== 'undefined' && typeof File.prototype.arrayBuffer === 'function'
const canvas2dSupported = (() => {
  try {
    return !!document.createElement('canvas').getContext('2d')
  } catch {
    return false
  }
})()

const checks = computed(() => [
  {
    label: '内置字表（' + charset.source + '）',
    ok: charset.total === 6919 && charset.han === 6812,
    text: charset.total + ' 字（汉字 ' + charset.han + ' + 符号 ' + charset.symbol + '）'
  },
  {
    label: '本地数据库（IndexedDB）',
    ok: store.storage.idb,
    text: store.storage.idb ? '可用' : '不可用，已退到本地快照'
  },
  {
    label: '本机字体文件读取（供模板嵌入参考字）',
    ok: fontPickerSupported,
    text: fontPickerSupported ? '支持' : '不支持，将只用内置字体'
  },
  {
    label: '画布 2D（切格与笔迹提取用）',
    ok: canvas2dSupported,
    text: canvas2dSupported ? '可用' : '不可用'
  }
])

// 保存状态与快照恢复：**只在异常时提示**（原来底部状态栏常驻一句"数据只在本机"属噪音，已去掉）
const saveFailed = computed(() => store.saveState === 'failed')
const recoverDismissed = ref(false)

// 落盘字形（自检区展示）：它是"关掉浏览器不白写"的兑现，也是导入项目包之后**一眼能看出数据回来了**的地方
// （字形分片在 IndexedDB 里，刷新后仍在；不显示的话，导入成功与否要走到第 5 步才知道）
const savedGlyphs = ref(null)
glyphStoreStats().then((s) => { savedGlyphs.value = s }).catch(() => {})
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <!-- 图标用线性单色 SVG（规约：不用 emoji 与字符图标） -->
        <svg class="brand-icon" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="M12 3v18M3 12h18" />
        </svg>
        <div class="brand-text">
          <h1>SxFontCreator</h1>
          <p class="brand-sub">手写字体制作器 · 纯前端 · 离线可用</p>
        </div>
      </div>
      <!-- 顶栏右侧：项目备份（导出 / 导入项目包）。入口放在这里是因为"换电脑前先备份"与当前在第几步无关 -->
      <ProjectBackup />
    </header>

    <!-- 异常提示条：只在「保存失败」或「上次改动没写完、已从快照恢复」时出现，平时不占位置 -->
    <div
      v-if="saveFailed || (store.recoveredFromSnapshot && !recoverDismissed)"
      class="notice"
      :class="saveFailed ? 'danger' : 'info'"
    >
      <span>
        {{ saveFailed
          ? '保存失败：浏览器可能禁用了本地存储，改动仍在当前页面内存中（重新加载会丢失）'
          : '上次关闭前有一次改动没写完，已从本机快照恢复到最新状态' }}
      </span>
      <button v-if="!saveFailed" @click="recoverDismissed = true">知道了</button>
    </div>

    <main class="content">
      <!-- 向导步骤条：一次只显示一步；每步的状态由 buildFlowState() 算出来 -->
      <nav class="card wizard-card">
        <div class="wizard-head">
          <h2>制作流程</h2>
          <span class="panel-hint">{{ flowSummary(flow) }} · 当前：{{ currentStep.label }}</span>
        </div>
        <ol class="wizard-steps">
          <li
            v-for="(step, index) in flow.steps"
            :key="step.key"
            class="wizard-step"
            :class="['status-' + step.status, { clickable: step.done || step.available || step.status === 'current' }]"
          >
            <button type="button" class="wizard-step-button" @click="goto(step.key)">
              <span class="wizard-step-index">
                <svg v-if="step.status === 'done'" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                  <path d="M3 8.4l3.2 3.2L13 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <template v-else>{{ index + 1 }}</template>
              </span>
              <span class="wizard-step-label">{{ step.label }}</span>
              <span v-if="!step.implemented" class="wizard-step-flag">待接入</span>
            </button>
          </li>
        </ol>
        <p v-if="blockedReason" class="panel-message error">{{ blockedReason }}</p>
      </nav>

      <!-- 当前步骤 -->
      <section class="card step-card">
        <div class="step-head">
          <h2>
            <span class="step-number">第 {{ stepIndex(currentKey) + 1 }} 步</span>
            {{ currentStep.label }}
          </h2>
          <span class="step-head-right">
            <span class="panel-hint">{{ currentStep.hint }}</span>
            <!-- 每一步都能打开同一份《使用说明》（单文件 HTML，新标签页）：界面只留摘要，正文只有一份 -->
            <GuideLink />
          </span>
        </div>
        <p v-if="currentStep.note" class="step-note">{{ currentStep.note }}</p>

        <TemplatePreview v-if="currentKey === 'template'" />
        <ScanUpload v-else-if="currentKey === 'upload'" />
        <CorrectionConfirm v-else-if="currentKey === 'correct'" />
        <BuildFont v-else-if="currentKey === 'build'" />
        <ResultDownload v-else-if="currentKey === 'download'" />
        <StepContent v-else :step="currentStep" />

        <div class="step-actions">
          <button type="button" :disabled="!nav.canPrev" @click="goPrev">上一步</button>
          <button type="button" class="primary" :disabled="!nav.canNext" @click="goNext">下一步</button>
          <span v-if="nav.nextReason" class="panel-hint">{{ nav.nextReason }}</span>
        </div>
      </section>

      <section class="card">
        <h2>运行环境自检</h2>
        <ul class="checklist">
          <li v-for="check in checks" :key="check.label">
            <span class="check-name">{{ check.label }}</span>
            <span class="check-value" :class="check.ok ? 'ok' : 'warn'">{{ check.text }}</span>
          </li>
          <li v-if="savedGlyphs && savedGlyphs.glyphs">
            <span class="check-name">已落盘的字形（关掉浏览器也不会丢）</span>
            <span class="check-value ok" data-role="saved-glyphs">
              {{ savedGlyphs.pages }} 页 / {{ savedGlyphs.glyphs }} 个字 / {{ (savedGlyphs.bytes / 1048576).toFixed(1) }}MB
            </span>
          </li>
        </ul>
        <p class="hint">
          数据只保存在本机浏览器里：复制程序目录不会带走数据，换电脑或换浏览器前，请先用右上角的
          <strong>「项目备份」</strong> 导出一份项目包。
        </p>
      </section>
    </main>
  </div>
</template>
