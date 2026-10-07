<script setup>
// 项目备份（顶栏入口 + 导出 / 导入弹窗）：阶段三步骤 3.5，口径见《决策记录》五-1 ~ 五-3、五-6。
// 职责：① 导出：把项目元信息 + 字形掩膜分片打成一个 zip 下载（`lib/projectPack.js`）
//   ② 导入：先读包并**给出内容预览**，用户确认后才整份替换（覆盖当前项目）
//   ③ 也是第 3 步与第 5 步那两条"建议导出备份"提醒的目的地（决策 五-3）
// 为什么弹窗状态放在 store 的 ui 段：第 3 / 第 5 步的提醒条也要能打开它，不想把事件从页面根部层层传下来。
// 为什么导入后**整页重载**：内存缓存（缩略图 / 掩膜）本就随刷新清空、可从落盘掩膜重建；
//   重载能保证界面上只剩"导入后"这一份数据，不会出现半旧半新（决策 五-6）。
import { computed, markRaw, onMounted, onUnmounted, ref } from 'vue'
import { useProjectStore } from '../store/project.js'
import { clearGlyphs, glyphStoreStats, listGlyphPages, readGlyphShard, writeGlyphShard } from '../lib/glyphStore.js'
import { replaceProject, stashCurrentProject } from '../lib/persist.js'
import { formatTime, inspectProjectPack, packProjectZip, summarizeProjectPack } from '../lib/projectPack.js'
import { downloadBytes } from '../lib/download.js'

/* global __APP_VERSION__ */ // 由 vite.config.js 的 define 注入（package.json 的 version）

const store = useProjectStore()
const open = computed(() => store.ui.backupOpen)

const stats = ref(null) // 落盘字形的统计（页 / 字 / 体积）
const busy = ref(false)
const stage = ref('')
const percent = ref(0)
const message = ref('')
const messageType = ref('info') // info | error | done

// 导入的两步：先 inspect（只读、不动数据），再 confirm（覆盖）
const picked = ref(null) // { name, size }
const inspected = ref(null)
const preview = computed(() => (inspected.value ? summarizeProjectPack(inspected.value) : null))
const lastExport = computed(() => formatTime(store.font.projectExportedAt))

function setMessage(text, type) {
  message.value = text
  messageType.value = type || 'info'
}

async function refreshStats() {
  stats.value = await glyphStoreStats().catch(() => null)
}

onMounted(refreshStats)
// 弹窗打开时刷一次（可能刚识别完新的一批）
function onKeydown(e) {
  if (e.key === 'Escape' && open.value && !busy.value) close()
}
// 焦点落到弹窗之外（比如被 Tab 出去、或点了浏览器地址栏再点回来）时自动收起 ——
// 否则遮罩留在页面上挡住操作，而用户看不出该怎么关（与 PdfPreview 的"点任意处关闭"同一套思路）
function onFocusIn(e) {
  if (!open.value || busy.value) return
  const el = e.target
  if (el && el.closest && el.closest('.backup-modal')) return
  close()
}
onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  document.addEventListener('focusin', onFocusIn)
})
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('focusin', onFocusIn)
})

function openPanel() {
  store.openBackup()
  setMessage('')
  inspected.value = null
  picked.value = null
  refreshStats()
}
function close() {
  store.closeBackup()
}

// ── 导出 ────────────────────────────────────────────────────────────────
// 包内文件夹名带日期时间。程序不去追问"系统里是否已有同名文件"（`file://` 下问不到下载目录），
// 所以重名交给解压时处理：同一分钟内导两次会得到同名 zip，浏览器会自动加 (1) 后缀。
async function doExport() {
  if (busy.value) return
  busy.value = true
  percent.value = 0
  setMessage('正在准备导出…', 'info')
  try {
    const pages = await listGlyphPages()
    const res = await packProjectZip({
      data: store.projectData(),
      pages,
      readShard: readGlyphShard,
      appVersion: __APP_VERSION__,
      onProgress: (p, text) => { percent.value = p; if (text) stage.value = text }
    })
    downloadBytes(res.bytes, res.fileName, 'application/zip')
    store.markProjectExported()
    setMessage('已导出 ' + res.fileName + '（' + (res.bytes.byteLength / 1048576).toFixed(1) + 'MB；' +
      res.glyphCount + ' 个字形 / ' + res.shardCount + ' 个分片' +
      (res.skipped ? '；有 ' + res.skipped + ' 个分片读不出来，已跳过' : '') + '）。' +
      '请把这个 zip 放到安全的地方 —— 它就是这个项目的全部。', 'done')
    refreshStats()
  } catch (e) {
    setMessage('导出失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    busy.value = false
    stage.value = ''
    percent.value = 0
  }
}

// ── 导入 ────────────────────────────────────────────────────────────────
async function onPickFile(event) {
  const file = (event.target.files || [])[0]
  event.target.value = '' // 清空，便于再次选同一个文件
  inspected.value = null
  picked.value = null
  if (!file) return
  picked.value = { name: file.name, size: file.size }
  busy.value = true
  percent.value = 0
  setMessage('正在读取并校验项目包…', 'info')
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const res = await inspectProjectPack(bytes, (text, p) => { stage.value = text; percent.value = p })
    if (!res.ok) {
      setMessage('这个包不能用：' + res.problems.join('；') + '（当前项目没有被改动）', 'error')
      return
    }
    // `markRaw`：读出来的分片是几十 MB 的字符串数组，一旦进 Vue 的响应式系统就会被递归代理
    // （内存翻倍，而且导入时写不进 IndexedDB —— 结构化克隆不接受 Proxy，实测报 "could not be cloned"）；
    // 这些数据全程只读，不需要响应式
    inspected.value = markRaw(res)
    setMessage('包读出来了：下面是要导入的内容，确认无误再点「确认导入并覆盖当前项目」。', 'info')
  } catch (e) {
    setMessage('读取失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    busy.value = false
    stage.value = ''
    percent.value = 0
  }
}

async function doImport() {
  if (busy.value || !inspected.value || !inspected.value.ok) return
  busy.value = true
  percent.value = 0
  try {
    // ① 先把"当前这份"另存一份（万一选错包还能人工捞回来）
    stage.value = '正在保存当前项目的保底副本…'
    await stashCurrentProject(store.projectData())
    // ② 清掉现有字形分片：导入是整份替换，旧字形若留着，页记录与掩膜就会新旧混装
    stage.value = '正在清理当前字形…'
    await clearGlyphs()
    // ③ 逐片写回（分片间让出主线程，弹窗才不会卡住）
    const list = inspected.value.shards
    for (let i = 0; i < list.length; i++) {
      const res = await writeGlyphShard(list[i].key, list[i].record)
      if (!res.ok) throw new Error('第 ' + (i + 1) + ' 个字形分片写入失败：' + res.error)
      stage.value = '正在写回字形分片…（' + (i + 1) + ' / ' + list.length + '）'
      percent.value = 5 + Math.round(((i + 1) / Math.max(1, list.length)) * 85)
      await new Promise((r) => setTimeout(r)) // 让出一帧，进度条能刷新
    }
    // ④ 项目数据整份替换（IndexedDB + 快照同时写，rev 取两者较大者 + 1）
    stage.value = '正在写回项目数据…'
    percent.value = 95
    const replaced = await replaceProject(inspected.value.data)
    if (!replaced.ok) throw new Error('项目数据写入失败（浏览器可能禁用了本地存储）')
    store.applyImportedProject({ ...inspected.value.data, rev: replaced.rev })
    percent.value = 100
    setMessage('导入完成：' + preview.value.familyName + '（' + inspected.value.glyphCount + ' 个字形）。' +
      '正在重新加载页面…', 'done')
    // 留在地址上的标记：重载后界面仍是原来那一步，没有任何"刚刚导入成功"的痕迹，
    // 加一个 hash 至少让用户（与自动化测试）能确认"这次加载就是导入后的那一次"
    location.hash = 'imported=' + Date.now()
    location.reload()
  } catch (e) {
    setMessage('导入失败：' + (e && e.message ? e.message : e) + '（当前项目里已写入的部分可能需要重新导入一次）', 'error')
    busy.value = false
    stage.value = ''
    percent.value = 0
  }
}

function cancelPick() {
  picked.value = null
  inspected.value = null
  setMessage('')
}
</script>

<template>
  <div class="backup-entry">
    <button type="button" class="text backup-button" @click="openPanel">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3v12M7.5 10.5L12 15l4.5-4.5" />
        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </svg>
      项目备份
    </button>

    <!-- 弹窗：fixed 定位、不占页面布局，因此不会影响第 1 步里的元素定位断言 -->
    <div v-if="open" class="backup-overlay" @click.self="!busy && close()">
      <div class="backup-modal" role="dialog" aria-label="项目备份">
        <div class="backup-head">
          <h3>项目备份（导出 / 导入项目包）</h3>
          <button type="button" class="text" :disabled="busy" @click="close">关闭</button>
        </div>

        <p class="panel-hint">
          数据只在本机浏览器里 —— 复制程序目录、把程序发给别人都不会带走它。
          <strong>换电脑、重装系统、清理浏览器数据之前，请先导出一份项目包。</strong>
        </p>

        <!-- 导出 -->
        <div class="backup-block">
          <h4>导出项目包</h4>
          <p class="panel-hint">
            包内是 <code>project.json</code>（名称表 / 批次 / 进度 / 更正记录）、<code>glyphs/</code>
            （字形掩膜，PNG 无损）与一份 <code>说明.txt</code>；<strong>不含扫描件原图</strong>
            （识别时原图读完即释放，从不落盘 —— 原图请自己留一份）。
          </p>
          <p v-if="stats" class="panel-hint">
            当前项目：字形 <strong>{{ stats.glyphs }}</strong> 个字 / {{ stats.pages }} 个分片 /
            {{ (stats.bytes / 1048576).toFixed(1) }}MB；上次导出：{{ lastExport }}
          </p>
          <p v-else class="panel-hint">还没有落盘的字形（先在第 3 步识别扫描件）。</p>
          <div class="panel-actions">
            <button type="button" class="primary" :disabled="busy" @click="doExport">导出项目包</button>
            <span v-if="busy && stage" class="panel-hint">{{ stage }}（{{ percent }}%）</span>
          </div>
        </div>

        <!-- 导入 -->
        <div class="backup-block">
          <h4>导入项目包</h4>
          <p class="panel-hint">
            导入会 <strong>整份替换</strong> 当前项目（选字 / 批次 / 识别结果 / 字形都会被包里的内容覆盖）。
            选好文件后**先给你看包里有什么**，确认之后才真的覆盖。
          </p>
          <div class="panel-actions">
            <label class="file-button" :class="{ disabled: busy }">
              选择项目包 zip
              <input type="file" accept=".zip,application/zip" :disabled="busy" @change="onPickFile" />
            </label>
            <span v-if="picked" class="panel-hint">{{ picked.name }}（{{ (picked.size / 1048576).toFixed(1) }}MB）</span>
          </div>

          <div v-if="preview" class="backup-preview" data-role="import-preview">
            <p class="panel-hint"><strong>这个包里是：</strong></p>
            <ul class="checklist">
              <li v-for="(line, i) in preview.lines" :key="'l' + i">
                <span class="check-name">{{ line }}</span>
              </li>
            </ul>
            <p class="panel-hint">
              覆盖后当前项目<strong>无法撤销</strong>（程序会另存一份"被替换掉的这一份"在浏览器里，
              但它没有界面入口）。确认是这个包，再点下面的按钮。
            </p>
            <div class="panel-actions">
              <button type="button" class="primary" :disabled="busy" @click="doImport">确认导入并覆盖当前项目</button>
              <button type="button" class="text" :disabled="busy" @click="cancelPick">取消</button>
              <span v-if="busy && stage" class="panel-hint">{{ stage }}（{{ percent }}%）</span>
            </div>
          </div>
        </div>

        <p v-if="message" class="panel-message" :class="messageType">{{ message }}</p>
      </div>
    </div>
  </div>
</template>
