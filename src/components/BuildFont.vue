<script setup>
// 第 5 步：生成字体（阶段一「界面串联」B3c）
// 职责：① 名称表字段（决策 四-1：默认值齐全、可在这里改）② 显示"将要生成哪些字形"的字形计划
//   ③ 点一下开始「位图追踪 → 组装 TTF / woff / woff2」，进度按字走（全量约 30 秒）
//   ④ 给出产物信息（体积 / 字形数 / 覆盖字数 / 跳过与缺原料的字形）。
// 原料来源：优先内存缓存（刚识别完），刷新过页面就从**落盘的掩膜**读回（决策 二-16）——
//   所以"关掉浏览器再回来"也能直接生成字体，不必重扫。
// 产物字节暂存在内存（lib/buildFont.js），下载步骤按需打包；只把元信息落盘。
import { computed, ref } from 'vue'
import { useProjectStore } from '../store/project.js'
import { buildFinalGlyphPlan } from '../lib/scanFlow.js'
import { buildFontFromPlan, getLastBuild } from '../lib/buildFont.js'

const store = useProjectStore()
const busy = ref(false)
const stage = ref('')
const progress = ref({ done: 0, total: 0 })
const message = ref('')
const messageType = ref('info')

const pages = computed(() => store.scan.pages)
const hasResult = computed(() => pages.value.some((p) => p.ok))
const needsCorrection = computed(() => (store.correction.circled || []).length > 0)
// 字形计划（与第 4 步同一份纯逻辑）：主区字形 + 更正册覆盖
const plan = computed(() => buildFinalGlyphPlan(pages.value, {
  pairs: store.correction.pairs || [],
  circled: store.correction.circled || []
}))
const canBuild = computed(() => hasResult.value && plan.value.items.length > 0 && (!needsCorrection.value || store.correction.confirmed))

const META_FIELDS = [
  { key: 'familyName', label: '字体族名', placeholder: 'SxFontCreator', hint: '在 Word / PS 的字体列表里显示的名字' },
  { key: 'fullName', label: '全名', placeholder: '我的手写体 SxFontCreator', hint: '显示在字体详情的完整名称' },
  { key: 'version', label: '版本', placeholder: '1.0', hint: '只写数字与点，例如 1.0' },
  { key: 'designer', label: '设计者', placeholder: '（可留空）', hint: '会写进字体的设计者字段' },
  { key: 'copyright', label: '版权', placeholder: '（留空则自动生成一行）', hint: '' },
  { key: 'licence', label: '许可', placeholder: '（可留空）', hint: '例如：仅限个人使用，请勿分发' },
  { key: 'licenceUrl', label: '许可链接', placeholder: '（可留空）', hint: '' },
  { key: 'description', label: '说明', placeholder: '（可留空）', hint: '' }
]

function setMessage(text, type) {
  message.value = text
  messageType.value = type || 'info'
}

function onMetaChange(key, value) {
  store.setFontMeta({ [key]: value })
  setMessage('已保存名称表字段；改了名称要重新点一次「生成字体」（产物里的 name 表才会跟着变）', 'info')
}

async function build() {
  if (busy.value) return
  if (!canBuild.value) {
    setMessage(needsCorrection.value && !store.correction.confirmed
      ? '主区有被红笔圈掉的字：请先回到第 4 步确认更正对应（确认后才能生成字体）'
      : '还没有可用的字形：请先在第 3 步上传并识别扫描件', 'error')
    return
  }
  busy.value = true
  progress.value = { done: 0, total: plan.value.items.length }
  const t0 = performance.now()
  try {
    setMessage('正在准备字形原料…', 'info')
    const built = await buildFontFromPlan({
      items: plan.value.items,
      meta: { ...store.meta },
      batchId: store.scan.batchId,
      woff2WasmUrl: './woff2.wasm',
      onStage: (text) => stage.value = text,
      onProgress: (done, total) => { progress.value = { done, total } }
    })
    // 覆盖清单：这一套字体到底收了哪些字（preview.html 与使用说明都要用）
    const chars = built.mapping.map((m) => m.char)
    const fromCorrection = plan.value.items.filter((i) => i.source === 'correction').length
    const suspect = store.scanGlyphStats.suspect
    store.setFontResult({
      fileName: built.fileName,
      familyName: built.familyName,
      sizes: {
        ttf: built.ttf.byteLength,
        woff: built.woff ? built.woff.byteLength : 0,
        woff2: built.woff2 ? built.woff2.byteLength : 0
      },
      stats: built.stats,
      coverage: { total: chars.length, fromCorrection, chars },
      skipped: built.skipped.length,
      missing: built.missing.length
    })
    const secs = ((performance.now() - t0) / 1000).toFixed(1)
    const kb = (n) => (n / 1024).toFixed(1) + 'KB'
    setMessage('字体已生成：' + chars.length + ' 个字形，TTF ' + kb(built.ttf.byteLength) +
      (built.woff2 ? '、woff2 ' + kb(built.woff2.byteLength) : '（woff2 不可用，已跳过）') +
      '；用时 ' + secs + ' 秒' + (suspect ? '；这批里有 ' + suspect + ' 个可疑字形（偏淡或写得太小），去看看第 3 步的格级视图' : ''), 'done')
  } catch (e) {
    setMessage('生成失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    busy.value = false
    stage.value = ''
    progress.value = { done: 0, total: 0 }
  }
}

// 决策 五-3：在"识别完成 / 字体生成后"各提醒一次导出项目包备份（不做常驻计数与"距上次导出 N 天"）。
// 判据在 store 的 backupReminder：有可用识别结果或已生成字体，且这次会话里还没导出过项目包。
// 提醒条上的按钮与顶栏「项目备份」开的是同一个弹窗（store.ui.backupOpen）。
const hasMemoryBuild = computed(() => !!getLastBuild())
</script>

<template>
  <div class="step-body">
    <p v-if="!hasResult" class="panel-hint">
      还没有识别结果：先在第 3 步上传并识别扫描件，第 4 步确认更正对应，再回来生成字体。
    </p>

    <template v-else>
      <p class="panel-hint">
        字形计划：<strong>{{ plan.items.length }}</strong> 个字形（主区 {{ plan.items.length - plan.replaced }} 个，
        更正册覆盖 <strong>{{ plan.replaced }}</strong> 个）；
        这批共写出 {{ store.scanGlyphStats.written }} 格、可疑 {{ store.scanGlyphStats.suspect }} 个。
        <span v-for="(p, i) in plan.problems" :key="'p' + i">{{ p }} </span>
      </p>
      <p v-if="needsCorrection && !store.correction.confirmed" class="step-note">
        主区有 {{ (store.correction.circled || []).length }} 个被红笔圈掉的字，**还没确认更正对应** ——
        请先回到第 4 步核对并确认，否则生成出来的字体里这些字仍是写错的那个。
      </p>

      <div class="panel-row">
        <div class="panel-field meta-grid">
          <label v-for="field in META_FIELDS" :key="field.key" class="meta-field">
            <span class="field-label">{{ field.label }}</span>
            <input
              type="text"
              :value="store.meta[field.key]"
              :placeholder="field.placeholder"
              :disabled="busy"
              @change="onMetaChange(field.key, $event.target.value)"
            />
            <span v-if="field.hint" class="panel-hint">{{ field.hint }}</span>
          </label>
        </div>
      </div>

      <div class="panel-actions">
        <button class="primary" :disabled="busy || !canBuild" @click="build">生成字体</button>
        <span v-if="busy" class="panel-hint">{{ stage }}（{{ progress.done }} / {{ progress.total }} 个字形）</span>
      </div>
      <p v-if="message" class="panel-message" :class="messageType">{{ message }}</p>

      <div v-if="store.font.built" class="scan-summary">
        <p class="panel-hint">
          产物：<strong>{{ store.font.fileName }}.ttf</strong>
          （TTF {{ (store.font.sizes.ttf / 1024).toFixed(1) }}KB<span v-if="store.font.sizes.woff2">、woff2 {{ (store.font.sizes.woff2 / 1024).toFixed(1) }}KB</span>）；
          收录 <strong>{{ store.font.coverage.total }}</strong> 个字，其中 {{ store.font.coverage.fromCorrection }} 个来自更正册；
          跳过 {{ store.font.skipped }} 个<span v-if="store.font.missing">、缺原料 {{ store.font.missing }} 个</span>
        </p>
        <p v-if="!hasMemoryBuild" class="panel-hint">
          字体字节在刷新后不在内存里了 —— 下载时会在打包步骤自动重建一次（约 30 秒），不用重扫。
        </p>
        <p class="panel-hint">下一步「下载安装」里可以下载 zip（字体 + CSS + 使用说明 + 可双击的样张预览页）。</p>
      </div>

      <p v-if="store.font.built && store.backupReminder" class="step-note backup-reminder" data-role="backup-reminder">
        字体已经生成，但<strong>项目还没备份</strong>：数据只在本机浏览器里，清缓存或换电脑就没了 ——
        建议现在导出一次项目包（含名称表、批次、进度与全部字形）。
        <button type="button" class="text" @click="store.openBackup()">立即导出项目包</button>
      </p>
    </template>
  </div>
</template>
