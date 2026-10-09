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
import { downloadText } from '../lib/download.js'

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
    // excluded：被人工剔除的字不进字体（决策 八-8 的"已剔除"），但它们仍在体检清单里显示为"已剔除"，
    // 好让用户看得到、也能恢复
    const built = await buildFontFromPlan({
      items: plan.value.items,
      meta: { ...store.meta },
      batchId: store.scan.batchId,
      // 排除两类字（八-8）：**已剔除**（这个字不要了）与**待重写**（先不进字体、以后补上）——
      // 构建时一视同仁地排除，区别只在清单与提示上（收录数说明会分别写出来）
      excluded: [...store.excludedChars, ...store.rewriteChars],
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
      missing: built.missing.length,
      checkup: built.checkup
    })
    // 体检清单默认只列"要重写的"，没有要重写的就展开"留意"那一栏（一屏给到最有用的信息）
    showNote.value = !(built.checkup && built.checkup.summary && built.checkup.summary.rewrite > 0)
    const secs = ((performance.now() - t0) / 1000).toFixed(1)
    const kb = (n) => (n / 1024).toFixed(1) + 'KB'
    const ck = built.checkup && built.checkup.summary
    const checkNote = ck ? '；字形体检：' + (ck.rewrite ? ck.rewrite + ' 个建议重写' : '没有要重写的') +
      (store.excludedCount ? '、已剔除 ' + store.excludedCount + ' 个' : '') : ''
    setMessage('字体已生成：' + chars.length + ' 个字形，TTF ' + kb(built.ttf.byteLength) +
      (built.woff2 ? '、woff2 ' + kb(built.woff2.byteLength) : '（woff2 不可用，已跳过）') +
      '；用时 ' + secs + ' 秒' + checkNote +
      (suspect ? '；这批里有 ' + suspect + ' 个可疑字形（偏淡或写得太小），去看看第 3 步的格级视图' : ''), 'done')
  } catch (e) {
    setMessage('生成失败：' + (e && e.message ? e.message : e), 'error')
  } finally {
    busy.value = false
    stage.value = ''
    progress.value = { done: 0, total: 0 }
  }
}

// ── 字形体检清单（决策 四-7 的替代手段：只提示、不改字形；八-8 的"已剔除 / 待重写"在这里处置）──
const checkup = computed(() => store.font.checkup)
const LIST_LIMIT = 40 // 一屏最多列这么多条：全量下可能有几百个字要重写，全铺出来反而看不出重点
const showNote = ref(true) // "只是留意"那一栏是否展开
// 已在重写清单里的字：查的是 **store 的状态**、不是体检快照里的字段 —— 标了 / 移出之后
// computed 立刻重算，不必重跑体检（体检要几秒）
const rewriteSet = computed(() => new Set(store.rewriteChars))
// 体检判"建议重写"、但还没被标进清单、也没被剔除的字（可一键加入重写清单）
const rewriteList = computed(() => ((checkup.value && checkup.value.glyphs) || [])
  .filter((g) => g.needsRewrite && !g.excluded && !rewriteSet.value.has(g.char)))
// 两栏都要排掉"已经进了重写清单"的字（否则同一个字会在原栏与重写清单里各出现一次）——
// 这条是冒烟抓出来的真实缺陷：当初只给"建议重写"加了过滤、漏了"只是留意"
const noteList = computed(() => ((checkup.value && checkup.value.glyphs) || [])
  .filter((g) => !g.needsRewrite && !g.excluded && !rewriteSet.value.has(g.char) && (g.messages || []).length))
const excludedList = computed(() => ((checkup.value && checkup.value.glyphs) || []).filter((g) => g.excluded))
// 重写清单的内容：从体检快照里补出"第几页第几格、为什么"，快照里没有的字（比如换过一批扫描件）就只显示字
const onRewriteList = computed(() => store.rewriteChars.map((char) => {
  const g = ((checkup.value && checkup.value.glyphs) || []).find((x) => x.char === char)
  return {
    char,
    pageNumber: g ? g.pageNumber : null,
    cellIndex: g ? g.cellIndex : null,
    messages: (g && g.messages) || [],
    reason: (store.rewrite[char] && store.rewrite[char].reason) || '标为待重写'
  }
}))
const listSlice = (list) => list.slice(0, LIST_LIMIT)

function excludeGlyph(char) {
  store.setGlyphExcluded(char, true, '字形体检里剔除')
  setMessage('已剔除「' + char + '」：它不进字体，也不计入收录数；下次点「生成字体」生效（要收回就点「恢复」）', 'info')
}
function restoreGlyph(char) {
  store.setGlyphExcluded(char, false)
  setMessage('已恢复「' + char + '」：下次点「生成字体」时它重新进字体', 'info')
}
function restoreAll() {
  const n = store.excludedCount
  store.clearExcluded()
  setMessage(n ? '已恢复全部 ' + n + ' 个被剔除的字；下次点「生成字体」生效' : '没有被剔除的字', 'info')
}

// ── 待重写清单（八-8 的第四态，清单一-12）：与"剔除"的区别必须在文案里说清 ──────────
// 剔除 = 这个字不要了；待重写 = 这次先不进字体、以后补上（清单会一直记着，直到你移出）
function markRewrite(char, reason) {
  store.setGlyphRewrite(char, true, reason)
  setMessage('已把「' + char + '」放进重写清单：它这次不进字体；重写那几页后用第 3 步的「重传这一页」覆盖，再回来重新生成', 'info')
}
function unmarkRewrite(char) {
  store.setGlyphRewrite(char, false)
  setMessage('已把「' + char + '」移出重写清单：下次点「生成字体」时继续采用现有字形', 'info')
}
function clearRewriteAll() {
  const n = store.rewriteCount
  store.clearRewrite()
  setMessage(n ? '已移出全部 ' + n + ' 个待重写的字（都继续采用现有字形）' : '重写清单本来就是空的', 'info')
}
/**
 * 导出重写清单（按页归组）：拿着它去重写那几页 —— 重写后走第 3 步的「重传这一页」（决策 八-14），
 * 不需要额外的模板或册子（这也是决策 一-6 ①「按清单动态生成更正册」不做之后留下的路径）。
 */
function exportRewriteList() {
  const rows = onRewriteList.value
  if (!rows.length) return
  const byPage = new Map()
  for (const r of rows) {
    const key = r.pageNumber === null ? 0 : r.pageNumber
    if (!byPage.has(key)) byPage.set(key, [])
    byPage.get(key).push(r)
  }
  const lines = []
  lines.push('SxFontCreator 重写清单')
  lines.push('生成时间：' + new Date().toLocaleString('zh-CN'))
  lines.push('待重写 ' + rows.length + ' 个字 —— 它们这次没有进字体。')
  lines.push('')
  lines.push('怎么用：按下表的页号回去重写那几页（写法见《使用说明》「二、书写」）；')
  lines.push('写完后到第 3 步找到那一页，点「重传这一页」覆盖识别结果，再回第 5 步点「生成字体」。')
  lines.push('')
  for (const [page, list] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push((page ? '第 ' + page + ' 页' : '页号未知') + '（' + list.length + ' 个字）')
    for (const r of list) {
      // 格号取 1 起（与更正册上印的格号、人的数法一致）
      const where = r.cellIndex === null ? '' : ' 第 ' + (r.cellIndex + 1) + ' 格'
      const why = (r.messages && r.messages.length) ? '：' + r.messages.join('；') : ''
      lines.push('  ' + r.char + where + why)
    }
    lines.push('')
  }
  lines.push('（每格序号从 1 起：一页 136 格，从左到右、从上到下。）')
  downloadText(lines.join('\n'), '重写清单-' + new Date().toISOString().slice(0, 10) + '.txt', 'text/plain;charset=utf-8')
  setMessage('已导出重写清单：' + rows.length + ' 个字，按页归组', 'done')
}

// 剔除了字、或改了名称表之后，之前那份体检快照就与当前状态不一致了（store 会置 checkupStale）
const staleAfterExclude = computed(() => !!checkup.value && store.font.checkupStale)

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
        <p class="panel-hint">第 6 步「下载安装」里可以下载 zip（字体 + CSS + 使用说明 + 可双击的样张预览页）。</p>
      </div>

      <p v-if="store.font.built && store.backupReminder" class="step-note backup-reminder" data-role="backup-reminder">
        字体已经生成，但<strong>项目还没备份</strong>：数据只在本机浏览器里，清缓存或换电脑就没了 ——
        建议现在导出一次项目包（含名称表、批次、进度与全部字形）。
        <button type="button" class="text" @click="store.openBackup()">立即导出项目包</button>
      </p>

    </template>

    <!-- 字形体检（阶段三 3.2，决策 四-7）：只提示、不改字形；处置手段是"剔除"或"重写那一格"。
         放在 `v-else` **之外**：剔除一个字之后 `store.font.built` 会被清掉（提示"要重新生成"），
         如果它在里面，面板会跟着整块消失 —— 那样就看不清单、也没法恢复（实测踩到） -->
    <div v-if="checkup" class="card nested" data-role="glyph-checkup">
      <div class="panel-head">
        <h3>字形体检</h3>
        <span class="panel-hint">只提示、不改字形 —— 字形大小与笔画粗细取决于你的书写</span>
      </div>
      <p class="panel-hint">{{ checkup.summary.message }}</p>
      <p v-if="staleAfterExclude" class="step-note" data-role="checkup-stale">
        体检之后你剔除过字形（或改过名称表）—— 现在显示的是上一次生成时的清单，
        点上面的「生成字体」重新生成一次即生效。
      </p>

      <div v-if="rewriteList.length" class="checkup-group">
        <p class="panel-hint">
          <strong>建议重写（{{ rewriteList.length }}）</strong>：成字后这些字会明显偏小或不成形。
          <strong>加入重写清单</strong> = 这次先不进字体、以后重写补上；<strong>剔除</strong> = 这个字不要了。
        </p>
        <ul class="checkup-list" data-role="rewrite-list">
          <li v-for="g in listSlice(rewriteList)" :key="'r' + g.char">
            <span class="checkup-char">{{ g.char }}</span>
            <span class="checkup-where">第 {{ g.pageNumber }} 页 · 第 {{ g.cellIndex }} 格</span>
            <span class="checkup-msgs">{{ (g.messages || []).join('；') }}</span>
            <button type="button" class="text" :disabled="busy" data-role="mark-rewrite" @click="markRewrite(g.char, (g.messages || []).join('；'))">加入重写清单</button>
            <button type="button" class="text" :disabled="busy" @click="excludeGlyph(g.char)">剔除这个字</button>
          </li>
        </ul>
        <p v-if="rewriteList.length > LIST_LIMIT" class="panel-hint">
          还有 {{ rewriteList.length - LIST_LIMIT }} 个字没列出来（一屏只列前 {{ LIST_LIMIT }} 个）
        </p>
      </div>
      <p v-else-if="checkup.summary.rewrite === 0" class="panel-message done">
        没有需要重写的字形 —— 这一批可以直接生成字体。
      </p>

      <!-- 重写清单（八-8 第四态，清单一-12）：与上面"建议重写"分开列 ——
           上面那份是**体检建议**（还没决定），这份是**已经决定要重写**的，它们本次不进字体，
           清单一直挂着直到被移出（"移出清单（继续采用）"= 就用现在这个字形，不再等重写） -->
      <div v-if="onRewriteList.length" class="checkup-group" data-role="rewrite-plan">
        <p class="panel-hint">
          <strong>重写清单（{{ onRewriteList.length }}）</strong>：这些字这次不进字体。
          重写完那几页后，用第 3 步的「重传这一页」覆盖，再回这里点「生成字体」。
          <button type="button" class="text" :disabled="busy" data-role="rewrite-export" @click="exportRewriteList">导出重写清单</button>
          <button type="button" class="text" :disabled="busy" data-role="rewrite-clear" @click="clearRewriteAll">全部移出</button>
        </p>
        <ul class="checkup-list" data-role="rewrite-plan-list">
          <li v-for="r in listSlice(onRewriteList)" :key="'w' + r.char">
            <span class="checkup-char">{{ r.char }}</span>
            <span class="checkup-where">{{ r.pageNumber === null ? '页号未知' : '第 ' + r.pageNumber + ' 页 · 第 ' + r.cellIndex + ' 格' }}</span>
            <span class="checkup-msgs">{{ r.messages.length ? r.messages.join('；') : r.reason }}</span>
            <button type="button" class="text" :disabled="busy" data-role="unmark-rewrite" @click="unmarkRewrite(r.char)">移出清单（继续采用）</button>
          </li>
        </ul>
        <p v-if="onRewriteList.length > LIST_LIMIT" class="panel-hint">
          还有 {{ onRewriteList.length - LIST_LIMIT }} 个字没列出来（一屏只列前 {{ LIST_LIMIT }} 个）
        </p>
      </div>

      <div v-if="noteList.length" class="checkup-group">
        <p class="panel-hint">
          <strong>只是留意（{{ noteList.length }}）</strong>：不影响成字，看一眼就行
          <button type="button" class="text" @click="showNote = !showNote">{{ showNote ? '收起' : '展开' }}</button>
        </p>
        <ul v-if="showNote" class="checkup-list" data-role="note-list">
          <li v-for="g in listSlice(noteList)" :key="'n' + g.char">
            <span class="checkup-char">{{ g.char }}</span>
            <span class="checkup-where">第 {{ g.pageNumber }} 页 · 第 {{ g.cellIndex }} 格</span>
            <span class="checkup-msgs">{{ (g.messages || []).join('；') }}</span>
            <!-- 两个动作与「建议重写」那栏保持一致：想重写的字不一定都落在"建议重写"里 -->
            <button type="button" class="text" :disabled="busy" data-role="mark-rewrite" @click="markRewrite(g.char, (g.messages || []).join('；'))">加入重写清单</button>
            <button type="button" class="text" :disabled="busy" @click="excludeGlyph(g.char)">剔除这个字</button>
          </li>
        </ul>
        <p v-if="showNote && noteList.length > LIST_LIMIT" class="panel-hint">
          还有 {{ noteList.length - LIST_LIMIT }} 个字没列出来
        </p>
      </div>

      <div v-if="excludedList.length" class="checkup-group">
        <p class="panel-hint">
          <strong>已剔除（{{ excludedList.length }}）</strong>：这些字不进字体、也不计入收录数
          <button type="button" class="text" :disabled="busy" @click="restoreAll">全部恢复</button>
        </p>
        <ul class="checkup-list" data-role="excluded-list">
          <li v-for="g in listSlice(excludedList)" :key="'x' + g.char">
            <span class="checkup-char">{{ g.char }}</span>
            <span class="checkup-msgs">{{ (g.messages || []).join('；') }}</span>
            <button type="button" class="text" :disabled="busy" @click="restoreGlyph(g.char)">恢复</button>
          </li>
        </ul>
        <p class="panel-hint">
          剔除只影响<strong>这一次生成</strong>的字库：想真正补上，还是重写那一格、重新扫这一页（或用更正册覆盖）。
          重新识别之后，剔除记录仍会保留（可在上面「全部恢复」）。
        </p>
      </div>
    </div>
  </div>
</template>
