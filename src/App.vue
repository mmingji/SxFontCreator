<script setup>
// 应用骨架（阶段一步骤 1.1；2026-10-04 按用户要求改成**向导式**：一次只显示一步）
// 职责：顶栏（品牌 + 字体族名）+ 向导步骤条 + 当前步骤的内容 + 上一步 / 下一步 + 运行环境自检。
// 步骤与状态：全部来自 src/lib/flow.js 的 buildFlowState()（纯逻辑、可在 Node 里断言）——
//   界面不维护第二份状态机，步骤条上的"已完成 / 当前 / 未开始 / 待接入"都是算出来的。
// 内容按需加载：模板步骤依赖 pdf-lib + fontkit + pdf.js（构建后是独立 chunk），静态引入会让首屏一起下载
//   （实测冷启动白屏 3.5 秒里一大半是它），所以第 1 步用 defineAsyncComponent 懒加载。
import { computed, defineAsyncComponent, h, ref } from 'vue'
import { useProjectStore } from './store/project.js'
import { buildFlowState, flowSummary, stepIndex, stepNavigation } from './lib/flow.js'
import { checkBrowserSupport } from './lib/browserSupport.js'
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

// 运行环境：这三项是后续步骤真实依赖的浏览器能力，缺哪一项哪一步就干不了（单行状态栏按它们渲染）
// （本机字体用于模板 PDF 嵌入参考字，决策记录 一-11；画布 2D 用于切格与笔迹提取；IndexedDB 是数据落盘的唯一真相）
// 判据要与实现一致：界面用的是 <input type="file"> + File.arrayBuffer()，不是 File System Access API
// 更全的能力检测见 lib/browserSupport.js：那份清单只在**缺失时**出一条中文提示条（决策 六-10），
// 不挤进这条单行状态栏 —— 状态栏是"平时就要看到的三项"，提示条是"出问题才出现的"
const browserCheck = checkBrowserSupport()

// 保存状态与快照恢复：**只在异常时提示**（原来底部状态栏常驻一句"数据只在本机"属噪音，已去掉）
const saveFailed = computed(() => store.saveState === 'failed')
const recoverDismissed = ref(false)
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

    <!-- 浏览器能力不够时的提示条（决策 六-10）：说清"缺哪一项、哪一步会干不了、该换什么浏览器" -->
    <div v-if="!browserCheck.ok" class="notice danger" data-role="browser-notice">
      <span>{{ browserCheck.message }}</span>
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
            <!-- 这一步要干什么：紧跟在标题后面（2026-10-07 用户要求），不再放到右上角与说明入口挤在一起 -->
            <span class="step-hint">{{ currentStep.hint }}</span>
          </h2>
          <span class="step-head-right">
            <!-- 步骤级操作位：当前步骤可以把自己的操作按钮 Teleport 到这里（第 1 步的「更新预览」），
                 顺序上排在「查看完整说明」之前 —— 操作在左、说明入口在右（2026-10-08 用户要求） -->
            <span id="step-head-actions"></span>
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
    </main>
  </div>
</template>
