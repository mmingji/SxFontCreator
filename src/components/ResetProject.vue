<script setup>
// 清空项目（顶栏入口 + 确认弹窗）：口径见《决策记录》**五-8**。
// 职责：把当前项目整份清掉，回到"刚装上软件"的状态 —— 五样一起处理：
//   ① 内存缓存（缩略图 / 拼图 / 掩膜、上一次构建的字体字节、本页注册的预览字体）
//   ② 已落盘的字形分片（`glyphStore`：`sxfont.glyphs.v1.*`）
//   ③ 本机存储里的项目数据（`persist.clearProject`：真相键 + localStorage 快照 + 导入保底键）
//   ④ Pinia 状态复位（`store.resetProject` 的 `$reset()`）
//   ⑤ 落盘一份全新的空项目（rev 从 1 重新数，两边同 rev —— 这一步封死"旧项目复活"）
// **顺序不能换**：①②动的是"别人"（缓存与分片），③把盘上那一份删干净，④才复位内存状态。
//   反过来先复位内存的话，中间那一刻盘上还是旧项目 —— 用户此时刷新就会把旧项目读回来。
// 为什么确认要手输两个字：这是**不可撤销**的操作（通用版决策 四-4：破坏性动作要标红、要不易误触），
//   "行内确认条 + 手输「清空」"两道门槛比一个按钮可靠；不用 window.confirm —— 原生弹窗会阻塞页面、
//   自动化测试点不到，而且写不下"会删掉多少页分片 / 多少字形"这类关键信息（与批次管理同一口径）。
// 为什么弹窗里给「先导出项目包」：清空是数据丢失，导出是唯一的保底（决策 五-2）；
//   按钮点了**先关本窗再开「项目备份」**，不让两层弹窗叠在一起（通用版 四-7）。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useProjectStore } from '../store/project.js'
import { cacheStats, clearPageCache } from '../lib/scanCache.js'
import { clearLastBuild } from '../lib/buildFont.js'
import { releaseAllPreviewFonts } from '../lib/fontPreview.js'
import { clearGlyphs, glyphStoreStats } from '../lib/glyphStore.js'
import { clearProject } from '../lib/persist.js'

const store = useProjectStore()
// 弹窗开关留在组件里（不像「项目备份」那样进 store）：它只有顶栏这一个入口，没有别处要打开它。
// 跨组件的那两件事（把界面推回第 1 步、把结果消息交给第 1 步）才走 store 的 ui.resetToken / resetNotice
const open = ref(false)
const input = ref('')
const busy = ref(false)
const stage = ref('')
const message = ref('')
const messageType = ref('info')

const stats = ref(null) // 落盘字形：页 / 字 / 体积
const memStats = ref(null) // 内存缓存：页 / 掩膜 / 图片字节

// 确认按钮的判据：**严格等于「清空」两个字**（首尾空白容错，别让用户因为多打一个空格卡住）
const canConfirm = computed(() => input.value.trim() === '清空')
const mb = (bytes) => (bytes / 1048576).toFixed(1)

function setMessage(text, type) {
  message.value = text || ''
  messageType.value = type || 'info'
}

// 打开时重数一遍：统计取自 IndexedDB 与内存缓存（不是界面状态），刚识别完 / 刚删过批次都算得准
async function refreshStats() {
  stats.value = await glyphStoreStats().catch(() => null)
  memStats.value = cacheStats()
}

function openPanel() {
  open.value = true
  input.value = ''
  setMessage('')
  refreshStats()
}

/**
 * 关窗。`force` 供清空流程自己用 —— 那一刻 busy 还是 true，普通的 close 会被挡住
 * （口径：清空成功后弹窗自动关闭，而不是让用户自己再点一次「关闭」）。
 */
function close(force) {
  if (busy.value && !force) return
  open.value = false
  input.value = ''
  setMessage('')
}

function onKeydown(e) {
  if (e.key === 'Escape' && open.value && !busy.value) close()
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))

// 保底路径：关本窗、开「项目备份」（用户自己导出，程序不代劳 —— 决策 五-8 写明"不自动导出"）
function exportFirst() {
  close()
  store.openBackup()
}

// 清空量（在动手之前取好）：弹窗里要给"会删掉什么"，清空之后已经没有数据可数了
function snapshotBefore() {
  const g = stats.value || { pages: 0, glyphs: 0, bytes: 0 }
  return {
    shards: g.pages,
    glyphs: g.glyphs,
    bytes: g.bytes,
    cachePages: memStats.value ? memStats.value.pages : 0,
    cacheMasks: memStats.value ? memStats.value.masks : 0,
    batches: store.batches.length,
    scanPages: store.scan.pages.length,
    chars: store.selectedCount,
    excluded: store.excludedCount,
    fontBuilt: store.font.built === true
  }
}

// 落在第 1 步的结果消息：清掉了多少 + 一句必须重复的物理事实（file:// 共用同一份存储）
function buildNotice(before, removedShards) {
  const bits = []
  bits.push('删掉 ' + removedShards + ' 页字形分片 / ' + before.glyphs + ' 个字形（释放 ' + mb(before.bytes) + 'MB）')
  if (before.cachePages) bits.push('内存里的 ' + before.cachePages + ' 页缩略图与 ' + before.cacheMasks + ' 张掩膜')
  if (before.batches) bits.push('批次 ' + before.batches + ' 个')
  if (before.scanPages) bits.push('识别记录 ' + before.scanPages + ' 页')
  if (before.chars) bits.push('已选 ' + before.chars + ' 字')
  if (before.excluded) bits.push('剔除记录 ' + before.excluded + ' 条')
  if (before.fontBuilt) bits.push('字体产物（要重新生成）')
  return '已清空项目，回到刚装上软件的状态：' + bits.join('、') +
    '；界面已回到第 1 步。数据只在本机浏览器里 —— file:// 下所有解压出来的副本共用同一份存储，这次清空对它们同样生效。'
}

async function doReset() {
  if (busy.value || !canConfirm.value) return
  busy.value = true
  const before = snapshotBefore()
  try {
    // ① 内存缓存：三处都要清 —— 缩略图与掩膜、上一次构建的字体字节、注册进页面的预览字体
    //    （FontFace 一旦注册就常驻并持有整份字节，见 lib/fontPreview.js 的登记表）
    stage.value = '正在清空内存缓存…'
    clearPageCache()
    clearLastBuild()
    releaseAllPreviewFonts()

    // ② 已落盘的字形分片（删除量在动手之前就数好了）
    stage.value = '正在删除已落盘的字形分片…'
    const cleared = await clearGlyphs()
    if (!cleared.ok) throw new Error(cleared.error || '字形分片删除失败')

    // ③ 本机存储：真相键 + localStorage 快照 + 导入保底键（少删快照就会让旧项目在下次启动复活）
    stage.value = '正在删除本机存储里的项目数据…'
    const wiped = await clearProject()
    if (!wiped.ok) throw new Error(wiped.error || '本机存储里的项目数据删除失败')

    // ④⑤ 复位内存状态 + 落盘一份全新的空项目（rev 从 1 重新数）
    stage.value = '正在复位界面状态…'
    const res = await store.resetProject(buildNotice(before, cleared.removed))
    if (!res.ok) throw new Error('新项目写入失败（浏览器可能禁用了本地存储）')
    close(true) // 成功后弹窗自动关闭
    input.value = ''
  } catch (e) {
    // 失败一律说清到哪一步为止、当前项目可能是什么状态（沿用 二-6：静默拿错数据比拒绝处理糟得多）
    setMessage('清空失败：' + (e && e.message ? e.message : e) +
      '（已删掉的部分不会自动恢复；当前项目可能停在"半清空"状态，建议再点一次清空，或导入一份项目包）', 'error')
  } finally {
    busy.value = false
    stage.value = ''
  }
}
</script>

<template>
  <span class="backup-entry">
    <button type="button" class="text backup-button" data-role="reset-project" @click="openPanel">
      <!-- 图标用线性单色 SVG（规约：不用 emoji 与字符图标） -->
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 7h16" />
        <path d="M9.5 7V4.5h5V7" />
        <path d="M6.5 7l1 12.5h9L17.5 7" />
        <path d="M10.5 11v5.5M13.5 11v5.5" />
      </svg>
      清空项目
    </button>

    <!-- 弹窗：fixed 定位、不占页面布局，因此不会影响第 1 步里的元素定位断言 -->
    <div v-if="open" class="backup-overlay" @click.self="!busy && close()">
      <div class="backup-modal" role="dialog" aria-label="清空项目" data-role="reset-modal">
        <div class="backup-head">
          <h3>清空项目（回到刚装上软件的状态）</h3>
          <button type="button" class="text" data-role="reset-close" :disabled="busy" @click="close">关闭</button>
        </div>

        <p class="panel-hint">
          清空会删掉当前项目的<strong>全部内容</strong>：选字、批次、识别结果、更正记录、字形与字体产物，
          名称表也复位（族名回 SxFontCreator、版本回 1.0）。<strong>清空后无法恢复。</strong>
        </p>

        <div class="backup-block">
          <h4>会删掉什么</h4>
          <!-- 每行用一个 span 包住整句：`.checklist li` 是两端对齐的 flex（左右分列用在"名称 ↔ 数量"那种表上），
               不包的话裸文本与 <strong> 会各成一个 flex 项、被推到两端，数字与文字脱节 -->
          <ul class="checklist" data-role="reset-scope">
            <li v-if="stats"><span>已落盘的字形：<strong>{{ stats.glyphs }}</strong> 个字 / {{ stats.pages }} 个分片（{{ mb(stats.bytes) }}MB）</span></li>
            <li v-else><span>已落盘的字形：暂无（先在第 3 步识别扫描件）</span></li>
            <li>
              <span>
                内存里这次会话的产物：{{ memStats && memStats.pages ? memStats.pages + ' 页缩略图 / ' + memStats.masks + ' 张笔迹掩膜' : '暂无' }}，
                以及第 6 步注册进页面的预览字体
              </span>
            </li>
            <li><span>项目数据：批次 <strong>{{ store.batches.length }}</strong> 个、识别记录 {{ store.scan.pages.length }} 页、已选 {{ store.selectedCount }} 字、剔除记录 {{ store.excludedCount }} 条</span></li>
            <li><span>字体产物：{{ store.font.built ? '已生成（' + (store.font.fileName || '') + '，清空后要重新生成）' : '暂无' }}</span></li>
          </ul>
          <p class="panel-hint">
            数据只在本机浏览器里 —— <strong>复制程序目录、把程序发给别人都不会带走它</strong>；
            而 <code>file://</code> 下<strong>所有解压出来的副本共用同一份存储</strong>，
            所以这次清空对它们同样生效。<strong>扫描件原图本来就不落盘</strong>，不在清空范围内。
          </p>
        </div>

        <div class="backup-block">
          <h4>确认清空</h4>
          <p class="panel-hint">
            如果这份项目还要留，先点下面的「先导出项目包」存一份 zip，再回来清空。
            确认无误后，输入 <strong>清空</strong> 两个字 —— 输入不匹配时「确定清空」不可点。
          </p>
          <label class="field-label" for="reset-confirm-input">输入「清空」两个字</label>
          <input
            id="reset-confirm-input"
            v-model="input"
            class="reset-input"
            type="text"
            autocomplete="off"
            placeholder="清空"
            :disabled="busy"
            data-role="reset-input"
          />
          <p v-if="input && !canConfirm" class="panel-message error" data-role="reset-input-hint">
            输入不匹配：要输入「清空」这两个字才能确认
          </p>
          <div class="panel-actions">
            <button type="button" class="primary danger" :disabled="busy || !canConfirm" data-role="reset-confirm" @click="doReset">
              确定清空
            </button>
            <button type="button" class="text" :disabled="busy" data-role="reset-cancel" @click="close">取消</button>
            <button type="button" class="text" data-role="reset-export-first" :disabled="busy" @click="exportFirst">先导出项目包</button>
            <span v-if="busy && stage" class="panel-hint">{{ stage }}</span>
          </div>
        </div>

        <p v-if="message" class="panel-message" :class="messageType" data-role="reset-message">{{ message }}</p>
      </div>
    </div>
  </span>
</template>
