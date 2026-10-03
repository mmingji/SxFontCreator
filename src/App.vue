<script setup>
// 应用骨架（阶段一步骤 1.1）：顶栏（品牌 + 字体族名）+ 制作流程 + 运行环境自检。
// 本步只打通"界面骨架 + 本地持久化"这一条链路；字表、模板 PDF、切格、识别等模块按后续步骤接入。
import { computed, defineAsyncComponent, h, ref } from 'vue'
import { useProjectStore } from './store/project.js'
import { getCharsetMeta } from './lib/charset.js'
import SelectionPanel from './components/SelectionPanel.vue'

// 模板面板按需加载：它依赖 pdf-lib + fontkit（实测 dev 模式下 2.3MB、构建后仍占大头），
// 静态引入会让首屏一起下载 —— 实测冷启动白屏 3.5 秒里有一大半是它。
// 拆成异步组件后，首屏只加载骨架；用户第一次看到模板面板时再加载（有 loading 提示）。
const PanelLoading = {
  render: () => h('section', { class: 'card' }, [
    h('h2', null, '模板与更正册'),
    h('p', { class: 'hint' }, '正在加载模板面板（首次需要准备 PDF 组件与字体，约 1 秒）…')
  ])
}
const TemplatePreview = defineAsyncComponent({
  loader: () => import('./components/TemplatePreview.vue'),
  loadingComponent: PanelLoading,
  delay: 120,
  timeout: 60000
})

const store = useProjectStore()
const charset = getCharsetMeta() // 内置字表的真实规模，供自检展示

// 流程步骤：与《需求与技术方案》三、完整用户流程一致；尚未接入模块，当前停在第 1 步
const STEPS = [
  { key: 'charset', label: '选字' },
  { key: 'template', label: '出模板' },
  { key: 'write', label: '手写与扫描' },
  { key: 'scan', label: '上传识别' },
  { key: 'correct', label: '确认更正' },
  { key: 'build', label: '生成字体' },
  { key: 'download', label: '下载安装' }
]
const currentStep = 0

// 字体族名改动 → 标记未落盘 + 延迟落盘（300ms）：避免每敲一个字就写一次 IndexedDB
// markDirty 的意义：防抖等待期间若用户直接刷新/关页，pagehide 兜底要靠它判断"确实有改动没存"
let saveTimer = null
function onFamilyNameInput(event) {
  store.meta.familyName = event.target.value
  store.markDirty()
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    store.persist()
  }, 300)
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

// 保存状态与快照恢复：**只在异常时提示**。
// 原来底部状态栏常驻一句"数据保存在本机浏览器里，未做任何上传"，属于噪音，已随状态栏一并去掉；
// 但"保存失败"与"上次改动没写完、已从快照恢复"这两种情况必须让用户知道，否则数据出了问题无感知 ——
// 所以它们改成按需出现的提示条（见模板里的 .notice），平时不占位置。
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
      <label class="field">
        <span class="field-label">字体族名</span>
        <input
          type="text"
          :value="store.meta.familyName"
          placeholder="SxFontCreator"
          @input="onFamilyNameInput"
        />
      </label>
    </header>

    <!-- 异常提示条：只在「保存失败」或「上次改动没写完、已从快照恢复」时出现，平时不占位置。
         原来这两条信息挂在底部状态栏里常驻显示，随状态栏一并去掉了 —— 但数据异常必须让用户看见 -->
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
      <section class="card">
        <h2>制作流程</h2>
        <ol class="steps">
          <li
            v-for="(step, index) in STEPS"
            :key="step.key"
            :class="{ current: index === currentStep }"
          >
            <span class="step-index">{{ index + 1 }}</span>
            <span class="step-label">{{ step.label }}</span>
          </li>
        </ol>
        <p class="hint">
          当前停留在第 1 步：选字、出模板都已接入 —— 可以先按频次分级挑字（或直接打全量 6919 字），
          生成模板 PDF 打印手写；扫描回传、识别与字体合成按后续步骤接入。
        </p>
      </section>

      <SelectionPanel />

      <TemplatePreview />

      <section class="card">
        <h2>运行环境自检</h2>
        <ul class="checklist">
          <li v-for="check in checks" :key="check.label">
            <span class="check-name">{{ check.label }}</span>
            <span class="check-value" :class="check.ok ? 'ok' : 'warn'">{{ check.text }}</span>
          </li>
        </ul>
        <p class="hint">
          数据只保存在本机浏览器里：复制程序目录不会带走数据，换电脑或换浏览器前必须先用「导出项目包」备份
          （导出与导入入口在阶段三接入）。
        </p>
      </section>
    </main>
  </div>
</template>
