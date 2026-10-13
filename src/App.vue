<script setup>
// 应用骨架（阶段一步骤 1.1；2026-10-04 按用户要求改成**向导式**：一次只显示一步）
// 职责：顶栏（品牌 + 查看完整说明）+ 三张步骤卡片 + 当前步骤的内容。
// 导航只有这三张卡片一条路（2026-10-08 去掉步骤卡底部的「上一步 / 下一步」栏；
//   2026-10-12 按决策 八-16 ① 把步骤条改成**三张样式一致、都能直接点进**的卡片：
//   去掉"制作流程"标题与"已完成 X / 3 步 · 当前：…"那行，也去掉"完成 / 当前 / 进不去"的区别）。
// 每张卡片上的进度条由 lib/flow.js 的 stepCardList() 算出来（"有多少可做、已经做了多少"与完成判据同源）。
// 内容按需加载：模板步骤依赖 pdf-lib + fontkit + pdf.js（构建后是独立 chunk），静态引入会让首屏一起下载
//   （实测冷启动白屏 3.5 秒里一大半是它），所以第 1 步用 defineAsyncComponent 懒加载。
import { computed, defineAsyncComponent, h, ref } from 'vue'
import { useProjectStore } from './store/project.js'
import { stepCardList, stepIndex } from './lib/flow.js'
import { checkBrowserSupport } from './lib/browserSupport.js'
import GuideLink from './components/GuideLink.vue'

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
// 第 2 步「识别」按需加载：它依赖四个识别模块（预处理 / 切格 / 红圈 / 提取）+ 参考字读取，
// 首屏用不到。更正核对（原独立的第 4 步）现在也挂在这一步里（决策 八-15 ④）
const ScanUpload = defineAsyncComponent({
  loader: () => import('./components/ScanUpload.vue'),
  loadingComponent: StepLoading,
  delay: 120,
  timeout: 60000
})
// 第 3 步「生成」按需加载：字体合成要 potrace + fonteditor，下载打包与网页预览要 jszip + FontFace。
// 2026-10-11 三步流程：原第 5、6 步（生成字体 / 下载安装）已并成这一个组件（决策 八-15 ①）
const BuildFont = defineAsyncComponent({
  loader: () => import('./components/BuildFont.vue'),
  loadingComponent: StepLoading,
  delay: 120,
  timeout: 60000
})

const store = useProjectStore()

// 流程进度快照：全部来自真实数据（模板元信息 / 识别结果 / 更正确认 / 字体产物），
// 卡片上的进度条与"每一步做完了没有"都由 lib/flow.js 按它推导 —— 界面不维护第二份状态机
const scanStats = computed(() => store.scanGlyphStats)
// 手上这份纸一共几页：纸面上的页号是最直接的事实。
// 为什么不拿 store.template.charCount 折算：第 1 步那份元信息说的是"模板排了多少字"，
//   而识别时往往只扫其中一部分页 —— 拿它当分母会显示成"已识别 1 / 共 61 页"，与用户手上的纸对不上。
const sheetPageCount = computed(() => {
  let max = 0
  for (const page of store.scan.pages) {
    if (page.ok && page.pageNumber && page.pageNumber > max) max = page.pageNumber
  }
  return max
})
const progress = computed(() => ({
  // 生成过模板（第 1 步的完成判据）——2026-10-11 起不再看批次：第 1 步不记批次了，
  // 改读 store.template 那笔元信息（决策 五-9 的收尾）
  templatePages: store.template && store.template.sheetPages ? store.template.sheetPages : 0,
  templateChars: store.template && store.template.charCount ? store.template.charCount : 0,
  uploadedPages: scanStats.value.pagesUsable,
  sheetPages: sheetPageCount.value,
  glyphCount: scanStats.value.written,
  fontCoverage: store.font.built && store.font.coverage ? store.font.coverage.total : 0,
  // 有被红笔圈掉的字时，必须先确认更正对应，才允许生成字体（决策 一-7 的最后一道闸）
  needsCorrection: (store.correction.circled || []).length > 0,
  correctionConfirmed: store.correction.confirmed,
  // "生成"这一步以**字体已生成**为准：产物一旦生成，下载随时可做（决策 五-7 的同一口径）
  fontBuilt: store.font.built === true
}))
// 三张步骤卡片（标签 / 一句话说明 / 进度）：**样式一致、都能直接点进**（决策 八-16 ①），
// 不再有"完成 / 当前 / 进不去"的区别，也没有阻止理由 —— 每一步的页内自己负责说清"现在能做什么、还缺什么"
const cardState = computed(() => stepCardList(progress.value))
const cards = computed(() => cardState.value.cards)
// 打开页面时落在"第一个还没做完的步骤"（用户 2026-10-04 的向导口径）；之后由用户点卡片切换
const currentKey = ref(cardState.value.currentKey)
const currentStep = computed(() => cards.value[stepIndex(currentKey.value)])

// 三张卡片都能直接点进（决策 八-16 ①）
function goto(key) {
  currentKey.value = key
}

// 运行环境：这些是后续步骤真实依赖的浏览器能力（参考字字体用于模板 PDF 嵌参考字，决策 一-11；
// 画布 2D 与 OffscreenCanvas 用于切格与笔迹提取，见 六-15；IndexedDB 是数据落盘的唯一真相）。
// 判据要与实现一致：检测的是真实能力而不是版本号（决策 六-10 ②）。
// 更全的能力检测见 lib/browserSupport.js：那份清单只在**缺失时**出一条中文提示条，
// 平时不占位置（能力清单还会带上「目录选择」这一项，见 六-13 的兼容口径）。
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
      <!-- 顶栏右侧：只挂「查看完整说明」（2026-10-11 三步流程，决策 五-10：去掉「项目备份」与
           「清空项目」两个功能页，说明入口从步骤标题行挪到这里 —— 与当前在第几步无关） -->
      <span class="topbar-actions">
        <GuideLink />
      </span>
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
      <!-- 三张步骤卡片（2026-10-12 决策 八-16 ①）：样式一致、都能直接点进 ——
           没有"已完成 / 当前 / 进不去"的区别，也没有"制作流程"标题与"已完成 X / 3 步"那行汇总。
           每张卡片底部的进度条说明"这一步做到哪儿了"（数据来自 lib/flow.js 的 stepCardList）。
           卡片本体用 li + role="button"：里面要放进度条（button 的内容模型不允许块级元素）。
           `wizard-card` 这个类名**没有对应样式**（样式在 .step-cards / .step-card-nav 上）：
           它只是"导航容器"的结构钩子与冒烟的定位锚点，删之前先改 test/smoke-app.mjs 的 4 处选择器 -->
      <nav class="card wizard-card" aria-label="制作流程">
        <ol class="step-cards">
          <li
            v-for="(card, index) in cards"
            :key="card.key"
            class="step-card-nav"
            :class="{ current: currentKey === card.key }"
            role="button"
            tabindex="0"
            :aria-current="currentKey === card.key ? 'step' : undefined"
            :data-step="card.key"
            @click="goto(card.key)"
            @keydown.enter.prevent="goto(card.key)"
            @keydown.space.prevent="goto(card.key)"
          >
            <div class="step-card-head">
              <span class="step-card-index">{{ index + 1 }}</span>
              <span class="step-card-label">{{ card.label }}</span>
            </div>
            <p class="step-card-hint">{{ card.hint }}</p>
            <div class="step-card-progress" :data-role="'progress-' + card.key">
              <span class="step-bar"><span class="step-bar-fill" :style="{ width: Math.round(card.progress.ratio * 100) + '%' }"></span></span>
              <span class="step-card-progress-label">{{ card.progress.label }}</span>
            </div>
          </li>
        </ol>
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
            <!-- 步骤级操作位：当前步骤可以把自己的操作按钮 Teleport 到这里（第 1 步的「更新预览」）。
                 说明入口（「查看完整说明」）已挪到顶栏（决策 五-10 ①） -->
            <span id="step-head-actions"></span>
          </span>
        </div>

        <!-- 三步流程（决策 八-15）：一次只显示当前这一步的内容 -->
        <TemplatePreview v-if="currentKey === 'template'" />
        <ScanUpload v-else-if="currentKey === 'scan'" />
        <BuildFont v-else-if="currentKey === 'build'" />
      </section>
    </main>
  </div>
</template>
