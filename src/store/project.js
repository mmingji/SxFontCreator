// 项目状态（Pinia）：本项目只支持一套字体（决策记录 五-1），因此状态就是"当前项目"本身。
// 数据结构（也是「导出项目包」的内容，决策记录 五-2）：
//   meta      —— 字体名称表字段（族名、子族名、版本、设计者、版权、许可…），全部有默认值（四-1）
//   glyphs    —— 字形数据：码位 → 轮廓（阶段一后续步骤填充）
//   template  —— 模板配置：字表顺序、版面参数（阶段一步骤 1.3 填充）
//   selection —— 当前选字：用哪套频次标准、选了哪些字（决策 八-1、八-2）
//   batches   —— 批次列表：一次「生成模板 → 打印 → 手写 → 扫描 → 识别」的过程（八-6）
//   rev       —— 版本号，由 persist 递增；用来判断 IndexedDB 与 localStorage 快照哪份更新（五-4）
// 数据来源与去向：启动时从 persist 读（IndexedDB 是唯一真相，快照只作异常关闭后的恢复），改动后写回。
import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { loadProject, saveProject, getStorageState } from '../lib/persist.js'
import { getAllChars } from '../lib/charset.js'
import { normalizeSelection } from '../lib/frequency.js'
import { computeBatchCode } from '../lib/batchCode.js'
import { collectGlyphStats } from '../lib/scanMeta.js'
import { toggleSnapshotExcluded } from '../lib/glyphCheckup.js'

// 默认字体族名：产品命名（决策记录 七-1）。名称表字段自 1.9 起已全部有默认值（决策 四-1），
// 界面上在第 5 步「生成字体」里改（顶栏原来那个族名输入框已去掉，一处填写）
const DEFAULT_FAMILY_NAME = 'SxFontCreator'

// 落盘防抖：连续点字、连续切换分类时不至于每次都写一遍 IndexedDB
let persistTimer = null
function schedulePersist(store) {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => store.persist(), 400)
}

export const useProjectStore = defineStore('project', {
  state: () => ({
    rev: 0,
    // 字体名称表字段（决策 四-1：**全部给默认值**，零配置也能导出可用字体；想改的在第 5 步页面上改）
    meta: {
      familyName: DEFAULT_FAMILY_NAME,
      fullName: '我的手写体 SxFontCreator',
      version: '1.0',
      designer: '',
      copyright: '',
      licence: '',
      licenceUrl: '',
      description: ''
    },
    glyphs: {},
    template: {},
    // 选字：chars 是选中的字（**按字表顺序**的字符串）。
    // 用字符串而不是数组：6919 字的数组拖进 Pinia 响应式开销大，字符串轻、天然有序、易于比对（八-6）
    // 2026-10-07 修订（决策 八-2）：频次标准只留 GB2312 一套，原来的 `standard` 字段随之去掉
    selection: { chars: '' },
    // 批次列表（八-6、八-9、八-10）。每个批次记：
    //   chars     —— 该批选字（按全量字表位置排序，保证字序可复现）；空串表示全量
    //   pageCount —— 该批模板的字表页数
    //   batchCode —— 12 位校验码，与印在页脚的高 12 位一致（八-10）
    //   status    —— active 可上传 / void 已作废（选字一改即作废，不再接受上传，除非用户显式勾选）
    //   printed   —— 是否已生成过模板（"未写"这一态的判据之一，八-8）
    //   uploads   —— 已绑定的扫描件（八-7：上传时手选批次；阶段一后半接入）
    batches: [],
    // 扫描识别（阶段一「界面串联」B2）：只存**轻量记录**，掩膜与缩略图在 lib/scanCache.js 的内存缓存里
    //   batchId         —— 这批扫描件所属批次（决策 八-7：上传时手选）
    //   batchConfirmed  —— 是否显式确认"这批扫描件属于该批次"（决策 二-7：页脚读不出时批次码失效，必须显式确认）
    //   allowVoidBatch  —— 明知是作废批次仍要继续（决策 八-10 的"禁传"要留一个显式放行口）
    //   pages           —— 每页的轻量记录（页码 / 校验码 / 计数 / 每格判定，不含掩膜与图）
    //   orderOverrides  —— 用户手选的页序 `{ [fileIndex]: pageNumber }`（只对页脚读不出的页有效）
    //   chars           —— 这一批的字序（识别时按它把"页内格号"映射成字）
    //   summary         —— 最近一次批次汇总判定（轻量：problems / ok / message）
    scan: {
      batchId: null,
      batchConfirmed: false,
      allowVoidBatch: false,
      pages: [],
      orderOverrides: {},
      chars: '',
      summary: null,
      lastRunAt: null
    },
    // 更正核对（阶段一步骤 1.8 的界面产物，决策 一-7 与 二-13）
    //   pairs / unmatched / discarded / extra —— **生效清单**（已经应用过用户调整）
    //   overrides  —— `{ [order]: 连续格号 | null }`（null = 删掉这一对，该字保留主区原字形）
    //   circled    —— 被圈字清单，顺序即"从左到右、从上到下"
    //   confirmed  —— 用户确认过；**未确认不允许进入字体构建**（界面确认是最后一道闸）
    correction: {
      pairs: [],
      unmatched: [],
      discarded: [],
      extra: [],
      messages: [],
      stats: null,
      circled: [],
      overrides: {},
      confirmed: false,
      updatedAt: null
    },
    // 人工修正（决策 八-8 的"已剔除"三态之一，2026-10-07 随 3.2 字形体检落地）：
    //   excluded —— `{ [字]: { at, reason } }` 被**人工剔除**的字：不进字体、也不计入收录数。
    //   为什么按"字"而不是按"格"：一个字只该有一个字形，用户想剔的是这个字，重扫之后仍然作数
    //   （要收回就点"恢复"）。它与字形数据分开放，改一次只写几十字节。
    excluded: {},
    // 字体产物（步骤 1.9 / 1.10）：只存**元信息**，不存字节（TTF 能由字形重算，全量约 30 秒；
    // 再存一份只会让体积翻倍。字节暂存在 lib/buildFont.js 的内存里，刷新后按需重建）
    font: {
      built: false,
      fileName: null,
      familyName: null,
      sizes: null, // { ttf, woff, woff2 }
      stats: null, // 构建统计（字形数 / 跳过的 / 被裁的 / 半角数）
      coverage: null, // { total, fromCorrection, chars }
      skipped: 0,
      missing: 0,
      builtAt: null,
      // 最近一次字形体检的快照（见 lib/glyphCheckup.buildCheckupSnapshot）：只留界面要显示的字段，
      // 全量约 6919 条 × 少量字段。**改了名称表 / 剔除某个字就把 built 清掉**，界面据此提示"要重新生成"
      checkup: null,
      // 体检之后又改过东西（剔除字形、改名称表）→ 快照已经与当前状态不一致，界面要提示"点生成字体重新生成"。
      // 为什么不复用 `built`：`built=false` 只说明"产物需要重建"，而空库时它本来就是 false —— 用它当"快照过期"
      // 会让界面在剔除一个字之后**整块体检面板消失**（实测踩到：剔除后看不到清单、也没法恢复）
      checkupStale: false,
      // 项目包导出时间（决策 五-3 的两个提醒节点以此为判据；原字段名 exportedAt 语义含糊，
      // 容易被读成"下载过字体 zip"—— 而它一直是"备份提醒用"的那一个，2026-10-07 随 3.5 一并改名）
      projectExportedAt: null
    },
    // 界面开关（不进"数据"的范畴，但也要能在组件之间共享）：
    //   backupOpen —— 顶栏「项目备份」弹窗是否打开。放在 store 里是为了让**第 3 / 第 5 步的提醒条**
    //   也能打开同一个弹窗，而不必把事件从页面根部一层层传下来
    ui: { backupOpen: false },
    storage: { idb: false, idbRev: null, snapshotRev: null },
    saveState: 'idle', // idle | saving | saved | failed —— 状态栏文案的数据源
    dirty: false, // 有改动还没落盘：关页兜底只在这种情况下才写快照
    loadSource: 'new' // new | idb | snapshot-newer | snapshot-only —— 本次数据从哪读来的
  }),

  getters: {
    // 上次关闭前有改动没写完、已从快照恢复：界面要提示一句，否则用户不知道"这次打开的数据是哪来的"
    recoveredFromSnapshot: (state) => state.loadSource === 'snapshot-newer' || state.loadSource === 'snapshot-only',
    selectedCount: (state) => state.selection.chars.length,
    // 出模板时要排的字：没选字就是全量（默认体验：零配置也能直接打全量模板）
    charsForTemplate: (state) => (state.selection.chars.length ? state.selection.chars : getAllChars().join('')),
    activeBatches: (state) => state.batches.filter((batch) => batch.status === 'active'),
    // 最近一个仍可上传的批次（上传界面默认选它）
    latestActiveBatch: (state) => {
      for (let i = state.batches.length - 1; i >= 0; i--) {
        if (state.batches[i].status === 'active') return state.batches[i]
      }
      return null
    },
    // 这批扫描件所属的批次（决策 八-7）
    scanBatch: (state) => state.batches.find((item) => item.id === state.scan.batchId) || null,
    // 所选批次是不是已作废（八-10 的"禁传"要留一个显式放行口）
    scanBatchIsVoid: (state) => {
      const batch = state.batches.find((item) => item.id === state.scan.batchId)
      return !!batch && batch.status === 'void'
    },
    // 这批识别结果能拿出多少字形（页数 / 写了多少格 / 可疑多少 / 被圈多少 / 去重字数）
    scanGlyphStats: (state) => collectGlyphStats(state.scan.pages),
    // 要提醒"导出项目包备份"（决策 五-3：只在**识别完成**与**字体生成后**两个节点各提醒一次，
    // 不做"距上次导出已过 N 天""有未导出的改动"这类常驻计数）。
    // 判据：有可用识别结果、或已生成字体；且这次会话里还没导出过项目包
    backupReminder: (state) => {
      const hasScan = collectGlyphStats(state.scan.pages).pagesUsable > 0
      const hasFont = state.font.built === true
      return (hasScan || hasFont) && !state.font.projectExportedAt
    },
    // 被剔除的字（数组形式，界面与构建都要用）
    excludedChars: (state) => Object.keys(state.excluded || {}),
    excludedCount: (state) => Object.keys(state.excluded || {}).length
  },

  actions: {
    // 读本地数据：IndexedDB 优先，读不到或快照更新才走快照恢复（具体规则见 lib/persist.js）
    async load() {
      const { data, source } = await loadProject()
      if (data) {
        this.rev = Number(data.rev) || 0
        if (data.meta && typeof data.meta === 'object') Object.assign(this.meta, data.meta)
        if (data.glyphs && typeof data.glyphs === 'object') this.glyphs = data.glyphs
        if (data.template && typeof data.template === 'object') this.template = data.template
        // 只取 chars：2026-10-07 之前的项目对象里还有 selection.standard（频次标准，决策 八-2 已修订为
        // 只留 GB2312），那是个老字段，直接忽略 —— 免得它又被写回落盘数据里
        if (data.selection && typeof data.selection === 'object') {
          this.selection.chars = typeof data.selection.chars === 'string' ? data.selection.chars : ''
        }
        if (Array.isArray(data.batches)) this.batches = data.batches
        // 人工剔除记录（八-8）：读旧项目对象时没有这个字段，缺省为空对象即可
        if (data.excluded && typeof data.excluded === 'object' && !Array.isArray(data.excluded)) this.excluded = data.excluded
        if (data.scan && typeof data.scan === 'object') Object.assign(this.scan, data.scan)
        if (data.correction && typeof data.correction === 'object') Object.assign(this.correction, data.correction)
        if (data.font && typeof data.font === 'object') Object.assign(this.font, data.font)
      }
      this.loadSource = source
      this.storage = await getStorageState()
    },

    // 标记"有未落盘的改动"：输入类操作在防抖等待期间调用，供 pagehide 兜底判断
    markDirty() {
      this.dirty = true
    },

    // 组装"要落盘的整份项目数据"：正常落盘（persist）与关页兜底快照（main.js 的 pagehide）**共用这一处**。
    // 为什么要抽出来：两处各写一份字段清单必然走样 —— 2026-10-07 实测抓到 pagehide 那份只带了
    //   `rev / meta / template`，于是"改完选字立刻刷新"兜底写出的快照里 selection 是空的，
    //   下次启动按"快照 rev 更大"恢复后，选字被清成 0 字（冒烟的三处诊断数据钉住了这条）。
    projectData() {
      return {
        rev: this.rev,
        meta: this.meta,
        glyphs: this.glyphs,
        template: this.template,
        selection: this.selection,
        batches: this.batches,
        scan: this.scan,
        correction: this.correction,
        excluded: this.excluded,
        font: this.font
      }
    },

    // 落盘：写 IndexedDB（唯一真相）；返回是否成功
    async persist() {
      this.saveState = 'saving'
      const res = await saveProject(this.projectData())
      if (res.ok) {
        this.rev = res.rev
        this.dirty = false
        this.saveState = 'saved'
        this.loadSource = 'idb' // 已经写进真相，恢复提示可以撤掉了
      } else {
        this.dirty = true
        this.saveState = 'failed'
      }
      this.storage = await getStorageState()
      return res.ok
    },

    /**
     * 设置选字（顺带做三件事：过滤字表外的字符、按字表顺序排序、去重 —— 决策 八-6）
     * 字序一变，已打印的模板随即失效，因此**已有批次立即作废**（八-9）
     * @param {string|string[]} chars
     * @returns {{changed: boolean, count: number, voided: number}}
     */
    setSelection(chars) {
      const next = normalizeSelection(chars).join('')
      if (next === this.selection.chars) return { changed: false, count: next.length, voided: 0 }
      this.selection.chars = next
      const voided = this.voidActiveBatches('选字清单已改动')
      this.markDirty()
      schedulePersist(this)
      return { changed: true, count: next.length, voided }
    },

    // 单个字加入 / 移除（字网格上点一下）
    toggleChar(char) {
      const current = this.selection.chars
      const next = current.includes(char) ? current.split(char).join('') : current + char
      return this.setSelection(next)
    },

    // 一个分类整体加入 / 移除（界面上的"全选本类 / 取消本类"，必须二次确认）
    setLevelSelected(levelChars, selected) {
      const current = new Set(Array.from(this.selection.chars))
      for (const ch of levelChars) {
        if (selected) current.add(ch)
        else current.delete(ch)
      }
      return this.setSelection([...current])
    },

    /**
     * 新建批次（八-6）：把"这次要写的字"固化下来，并算出它的 12 位校验码
     * @param {object} info
     * @param {number} info.pageCount 该批模板的字表页数
     * @param {string} [info.chars] 指定字序（默认取当前选字；空选字 = 全量）
     * @param {string} [info.order] 排列方式：'rank' 按使用频率 / 'charset' 字表顺序（八-6 的修订）
     * @returns {object} 新建的批次
     */
    addBatch({ pageCount, chars, order } = {}) {
      const list = chars === undefined ? this.charsForTemplate : chars
      const batch = {
        id: 'b' + (this.batches.length + 1) + '-' + Date.now().toString(36),
        chars: list,
        charCount: list.length,
        // 排列方式要留痕：同一批重新生成模板时必须用同一种顺序，否则字序变了、校验码也变，已打印的纸作废
        order: order || 'charset',
        pageCount: pageCount || Math.max(1, Math.ceil(list.length / 136)),
        batchCode: computeBatchCode(list),
        createdAt: new Date().toISOString(),
        status: 'active',
        printed: true,
        uploads: []
      }
      this.batches.push(batch)
      this.markDirty()
      schedulePersist(this)
      return batch
    },

    // 作废一个批次（八-9）：作废后不再接受上传，除非用户显式勾选"我知道这是作废模板"
    voidBatch(id, reason) {
      const batch = this.batches.find((item) => item.id === id)
      if (!batch || batch.status === 'void') return false
      batch.status = 'void'
      batch.voidReason = reason || ''
      batch.voidedAt = new Date().toISOString()
      this.markDirty()
      schedulePersist(this)
      return true
    },

    // 把所有仍有效的批次标记作废（选字一改就调用）
    voidActiveBatches(reason) {
      let count = 0
      for (const batch of this.batches) {
        if (batch.status === 'active') {
          batch.status = 'void'
          batch.voidReason = reason || ''
          batch.voidedAt = new Date().toISOString()
          count++
        }
      }
      return count
    },

    // ── 扫描识别（阶段一「界面串联」B2）────────────────────────────────────
    // 选批次（决策 八-7：上传时手选）：换批次要把"已确认"与"作废放行"一起复位 ——
    // 这两个勾选是针对上一批扫描件的确认，换批次后必须重新确认，不能沿用
    setScanBatch(batchId) {
      if (this.scan.batchId === batchId) return
      this.scan.batchId = batchId || null
      this.scan.batchConfirmed = false
      this.scan.allowVoidBatch = false
      this.markDirty()
      schedulePersist(this)
    },

    // 显式确认"这批扫描件属于所选批次"（决策 二-7：页脚读不出时批次码失效，只能靠这一步）
    setScanBatchConfirmed(confirmed) {
      this.scan.batchConfirmed = !!confirmed
      this.markDirty()
      schedulePersist(this)
    },

    // 明知是作废批次仍要继续（决策 八-10 的显式放行口）
    setScanAllowVoid(allow) {
      this.scan.allowVoidBatch = !!allow
      this.markDirty()
      schedulePersist(this)
    },

    // 开始一轮识别：清掉上一轮的结果与手选页序，记下这一批的字序（识别时按它把格号映射成字）
    beginScanRun({ batchId, chars }) {
      if (batchId) this.scan.batchId = batchId
      this.scan.pages = []
      this.scan.summary = null
      this.scan.orderOverrides = {}
      this.scan.chars = typeof chars === 'string' ? chars : ''
      this.scan.lastRunAt = null
      this.markDirty()
      schedulePersist(this)
    },

    // 逐页追加（界面要边跑边显示；每页一次，靠防抖合并落盘，不会写出 51 次）
    appendScanPage(record) {
      this.scan.pages = [...this.scan.pages, record]
      this.markDirty()
      schedulePersist(this)
    },

    // 一轮识别结束：写入批次汇总判定（整批判定与收批闸门都在界面上算，这里只存结果）
    finishScanRun({ summary }) {
      this.scan.summary = summary || null
      this.scan.lastRunAt = new Date().toISOString()
      this.markDirty()
      schedulePersist(this)
    },

    // 用户手选页序（决策 二-7）：只对页脚读不出的页有效，重排后字与汇总判定都由组件算好再写回来
    setScanPageOrder({ overrides, pages, summary }) {
      this.scan.orderOverrides = overrides || {}
      this.scan.pages = Array.isArray(pages) ? pages : this.scan.pages
      if (summary) this.scan.summary = summary
      this.markDirty()
      schedulePersist(this)
    },

    // 清掉识别结果（重新上传前调用；内存缓存由组件一并清）
    clearScan() {
      this.scan.pages = []
      this.scan.summary = null
      this.scan.chars = ''
      this.scan.orderOverrides = {}
      this.scan.batchConfirmed = false
      this.scan.lastRunAt = null
      // 识别结果一清，之前的配对与确认就都失效了（配对依赖被圈字清单）
      this.correction = {
        pairs: [], unmatched: [], discarded: [], extra: [], messages: [], stats: null,
        circled: [], overrides: {}, confirmed: false, updatedAt: null
      }
      this.markDirty()
      schedulePersist(this)
    },

    // ── 更正核对（步骤 1.8 的界面）────────────────────────────────────────
    // 写入配对初值（由 lib/scanFlow.pairCorrections 从识别结果算出来）。
    // **会把 confirmed 复位**：配对一变，之前的确认就不作数了（否则可能拿旧确认去构建字体）
    setCorrectionResult({ pairs, unmatched, discarded, extra, messages, stats, circled }) {
      this.correction.pairs = pairs || []
      this.correction.unmatched = unmatched || []
      this.correction.discarded = discarded || []
      this.correction.extra = extra || []
      this.correction.messages = messages || []
      this.correction.stats = stats || null
      this.correction.circled = circled || []
      this.correction.overrides = {}
      this.correction.confirmed = false
      this.correction.updatedAt = new Date().toISOString()
      this.markDirty()
      schedulePersist(this)
    },

    // 用户调整（改派 / 删除 / 补录）：把生效清单与调整记录一起写回
    setCorrectionOverrides({ overrides, pairs, unmatched }) {
      this.correction.overrides = overrides || {}
      if (Array.isArray(pairs)) this.correction.pairs = pairs
      if (Array.isArray(unmatched)) this.correction.unmatched = unmatched
      this.correction.confirmed = false
      this.markDirty()
      schedulePersist(this)
    },

    // 确认这份更正对应（未确认不允许进入字体构建）
    setCorrectionConfirmed(confirmed) {
      this.correction.confirmed = !!confirmed
      if (confirmed) this.correction.updatedAt = new Date().toISOString()
      this.markDirty()
      schedulePersist(this)
    },

    clearCorrection() {
      this.correction = {
        pairs: [], unmatched: [], discarded: [], extra: [], messages: [], stats: null,
        circled: [], overrides: {}, confirmed: false, updatedAt: null
      }
      this.markDirty()
      schedulePersist(this)
    },

    // ── 字体产物（步骤 1.9 / 1.10）与字形体检（阶段三 3.2）──────────────────
    // 改名称表字段（第 5 步的表单）：改了就把"已构建"标记清掉 —— 否则界面会显示上一次的产物，
    // 而产物里的 name 表其实还是旧值（字体字节在内存里，重建只需点一下按钮）
    setFontMeta(patch) {
      Object.assign(this.meta, patch || {})
      if (this.font.built) {
        this.font.built = false
        this.font.builtAt = null
      }
      if (this.font.checkup) this.font.checkupStale = true
      this.markDirty()
      schedulePersist(this)
    },

    // 构建成功：写入产物元信息与体检快照（字节留在内存里，见 lib/buildFont.js）
    setFontResult({ fileName, familyName, sizes, stats, coverage, skipped, missing, checkup }) {
      this.font.built = true
      this.font.fileName = fileName
      this.font.familyName = familyName
      this.font.sizes = sizes || null
      this.font.stats = stats || null
      this.font.coverage = coverage || null
      this.font.skipped = skipped || 0
      this.font.missing = missing || 0
      this.font.checkup = checkup || null
      this.font.checkupStale = false
      this.font.builtAt = new Date().toISOString()
      this.font.projectExportedAt = null
      this.markDirty()
      schedulePersist(this)
    },

    // ── 人工剔除（决策 八-8 的"已剔除"，清单 一-8）────────────────────────
    /**
     * 剔除 / 恢复一个字（第 5 步体检清单里的按钮）。
     * 剔除后这个字**不进字体、也不计入收录数**；恢复即回到正常。
     * 剔除会清掉"已构建"标记 —— 产物里还留着那个字形，不重新生成就与界面说的不一致。
     */
    setGlyphExcluded(char, excluded, reason) {
      if (!char) return false
      const next = { ...(this.excluded || {}) }
      if (excluded) next[char] = { at: new Date().toISOString(), reason: reason || '人工剔除' }
      else delete next[char]
      this.excluded = next
      // 体检快照是"生成字体"那一次的产物，剔除只是翻一个状态位：**就地更新它**，
      // 让清单立刻正确（重新跑一遍体检要几秒，没必要）。
      // `toRaw` 是必需的：传进 computed 的数组会被 Vue 包成 Proxy，直接存回 state 会让
      // 落盘时的 JSON 往返与响应式系统互相缠住（实测：恢复剔除后页面直接崩）
      this.font.checkup = toggleSnapshotExcluded(toRaw(this.font.checkup), char, excluded)
      if (this.font.built) {
        this.font.built = false
        this.font.builtAt = null
      }
      if (this.font.checkup) this.font.checkupStale = true
      this.markDirty()
      schedulePersist(this)
      return true
    },

    // 清除全部剔除记录（第 5 步的「全部恢复」）
    clearExcluded() {
      const was = Object.keys(this.excluded || {})
      this.excluded = {}
      for (const char of was) this.font.checkup = toggleSnapshotExcluded(toRaw(this.font.checkup), char, false)
      if (this.font.built) {
        this.font.built = false
        this.font.builtAt = null
      }
      if (this.font.checkup) this.font.checkupStale = true
      this.markDirty()
      schedulePersist(this)
    },

    clearFont() {
      this.font = {
        built: false, fileName: null, familyName: null, sizes: null, stats: null,
        coverage: null, skipped: 0, missing: 0, builtAt: null, checkup: null, checkupStale: false,
        projectExportedAt: null
      }
      this.markDirty()
      schedulePersist(this)
    },

    // 项目备份弹窗（顶部入口与两处提醒条共用同一个弹窗）──────────────────
    openBackup() {
      this.ui.backupOpen = true
    },
    closeBackup() {
      this.ui.backupOpen = false
    },

    // 导出过项目包（决策 五-3：识别完成与字体生成后各提醒一次，导出过就不再提醒）
    markProjectExported() {
      this.font.projectExportedAt = new Date().toISOString()
      this.markDirty()
      schedulePersist(this)
    },

    /**
     * 导入项目包：把读出来并校验过的数据整份替换进来（决策 五-6）。
     * 只在这里改 store 的状态，**落盘由调用方先做完**（字形分片 + 项目数据）—— 顺序反了会出现
     * "界面显示新项目、落盘里还是旧项目"，下次启动又变回去。
     */
    applyImportedProject(data) {
      this.rev = Number(data.rev) || this.rev
      this.meta = { ...this.meta, ...(data.meta || {}) }
      this.template = data.template && typeof data.template === 'object' ? data.template : {}
      this.selection = { chars: data.selection && typeof data.selection.chars === 'string' ? data.selection.chars : '' }
      this.batches = Array.isArray(data.batches) ? data.batches : []
      this.excluded = data.excluded && typeof data.excluded === 'object' && !Array.isArray(data.excluded)
        ? data.excluded
        : {}
      this.scan = {
        batchId: null, batchConfirmed: false, allowVoidBatch: false, pages: [],
        orderOverrides: {}, chars: '', summary: null, lastRunAt: null,
        ...(data.scan || {})
      }
      this.correction = {
        pairs: [], unmatched: [], discarded: [], extra: [], messages: [], stats: null,
        circled: [], overrides: {}, confirmed: false, updatedAt: null,
        ...(data.correction || {})
      }
      // 字体字节不在包里（决策 五-5：只存元信息、字节按需重建），所以"已构建"标记一律清掉 ——
      // 否则界面会显示上一次的产物信息，而内存里根本没有那份字节。
      // 注意 `built: false` 必须写在展开**之后**：写在前面会被包里的 true 覆盖（这是个真实踩点）
      this.font = {
        built: false, fileName: null, familyName: null, sizes: null, stats: null,
        coverage: null, skipped: 0, missing: 0, builtAt: null, checkup: null, projectExportedAt: null,
        ...(data.font || {}),
        built: false
      }
      this.glyphs = {}
      // 刚导入的这一份就是盘上的真相，不该再被当成"有未落盘改动"（否则关页兜底会写一份多余的快照）
      this.dirty = false
      this.loadSource = 'idb'
    }
  }
})
