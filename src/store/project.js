// 项目状态（Pinia）：本项目只支持一套字体（决策记录 五-1），因此状态就是"当前项目"本身。
// 数据结构（也是「导出项目包」的内容，决策记录 五-2）：
//   meta      —— 字体名称表字段（族名、子族名、版本、设计者、版权、许可…），全部有默认值（四-1）
//   glyphs    —— 字形数据：码位 → 轮廓（阶段一后续步骤填充）
//   template  —— 模板配置：排列方式、版面参数（阶段一步骤 1.3 填充）
//   selection —— 当前选字：用哪套频次标准、选了哪些字（决策 八-1、八-2）
//   batches   —— 批次列表：一次「生成模板 → 打印 → 手写 → 扫描 → 识别」的过程（八-6）
//   rev       —— 版本号，由 persist 递增；用来判断 IndexedDB 与 localStorage 快照哪份更新（五-4）
// 数据来源与去向：启动时从 persist 读（IndexedDB 是唯一真相，快照只作异常关闭后的恢复），改动后写回。
import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { loadProject, saveProject, getStorageState, clearStorage } from '../lib/persist.js'
import { getAllChars, countChars } from '../lib/charset.js'
import { normalizeSelection } from '../lib/frequency.js'
import { computeBatchCode } from '../lib/batchCode.js'
import { collectGlyphStats } from '../lib/scanMeta.js'
import { toggleSnapshotExcluded } from '../lib/glyphCheckup.js'

// 默认字体族名：产品命名（决策记录 七-1）。名称表字段自 1.9 起已全部有默认值（决策 四-1），
// 界面上在第 3 步「生成字体」里改（顶栏原来那个族名输入框已去掉，一处填写）
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
    // 字体名称表字段（决策 四-1：**全部给默认值**，零配置也能导出可用字体；想改的在第 3 步页面上改）
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
    // 选字：chars 是选中的字（**按字表字序排列**的字符串，字序 = 官方笔画序）。
    // 用字符串而不是数组：八千多字的数组拖进 Pinia 响应式开销大，字符串轻、天然有序、易于比对（八-6）。
    // 代价：**字数一律要用 countChars 按码点算**（字表里有 196 个扩展 B 区汉字是代理对，.length 会虚高）。
    // 2026-10-08 修订（决策 八-2 重写）：分级改用《通用规范汉字表》规范三级 + 基础字符，
    // 原来的 GB2312 与"频次标准"字段都已删除
    selection: { chars: '' },
    // 批次列表：**内部容器**（决策 五-9 ⑤、六-14）。它只剩一个用途 —— 字形分片的命名空间
    //   （分片键 `sxfont.glyphs.v1.<批次 id>.<页序>`）；字序现在由纸面（字序文件或参考字）决定。
    //   界面上完全看不到它，也没有"作废"这一态（旧模型里批次 = 用户手上的选字计划）。每个批次记：
    //   chars     —— 该批字序（按字表位置排序，保证可复现）；空串表示全部 8274 字
    //   pageCount —— 该批模板的字表页数
    //   batchCode —— 12 位校验码，与印在页脚的高 12 位一致（八-10）
    //   source    —— 谁建的：'template' 第 1 步出模板（历史数据）/ 'auto' 识别时自动补（界面不显示）
    //   label     —— 给内部看的一行说明（同上）
    batches: [],
    // 扫描识别（阶段一「界面串联」B2）：只存**轻量记录**，掩膜与缩略图在 lib/scanCache.js 的内存缓存里
    //   batchId         —— 这批扫描件所属批次（**内部容器**，用户看不到也不用选：进第 2 步时由
    //                      ensureScanBatch() 自动复用最近一个，一个都没有就顺手建一个）
    //   pages           —— 每页的轻量记录（页码 / 校验码 / 计数 / 每格判定，不含掩膜与图）
    //   orderOverrides  —— 用户手选的页序 `{ [fileIndex]: pageNumber }`（只对页脚读不出的页有效）
    //   chars           —— 这一批的字序（识别时按它把"页内格号"映射成字）
    //   summary         —— 最近一次批次汇总判定（轻量：problems / ok / message）
    //   source          —— **这批结果的来源**（2026-10-13 用户口径："没有轮次概念"）：识别那一刻用的是
    //                      哪个文件夹、哪些图片（只存文件名）、字序从哪来。存名字与数量，不存 File 对象
    //                      （浏览器拿不到磁盘路径、也存不下文件句柄）—— 刷新之后界面靠它把"这批结果
    //                      来自哪里"照原样说清，而不是显示成"还没有选文件夹"
    scan: {
      batchId: null,
      pages: [],
      orderOverrides: {},
      chars: '',
      summary: null,
      lastRunAt: null,
      source: null
    },
    // 更正核对（阶段一步骤 1.8 的界面产物，决策 一-7 与 二-13）
    //   pairs / unmatched / discarded / extra —— **生效清单**（已经应用过用户调整）
    //   overrides  —— `{ [order]: 连续格号 | null }`（null = 删掉这一对，该字保留主区原字形）
    //   circled    —— 被圈字清单，顺序即"从左到右、从上到下"
    // 2026-10-13（用户拍板）：原来的 `confirmed` 字段与「确认这份更正对应」按钮一并去掉 ——
    //   **程序按识别结果给出的配对默认生效**，不需要用户点一下确认；要改就在核对表里改派 / 删除，
    //   或点「恢复默认」回到程序的配对。相应地，"未确认不许生成字体"那道闸也取消了。
    correction: {
      pairs: [],
      unmatched: [],
      discarded: [],
      extra: [],
      messages: [],
      stats: null,
      circled: [],
      overrides: {},
      updatedAt: null
    },
    // 人工修正（决策 八-8 的"已剔除"三态之一，2026-10-07 随 3.2 字形体检落地）：
    //   excluded —— `{ [字]: { at, reason } }` 被**人工剔除**的字：不进字体、也不计入收录数。
    //   为什么按"字"而不是按"格"：一个字只该有一个字形，用户想剔的是这个字，重扫之后仍然作数
    //   （要收回就点"恢复"）。它与字形数据分开放，改一次只写几十字节。
    excluded: {},
    // 待重写（决策 八-8 扩充出来的第四种书写状态，2026-10-09 随清单一-12 落地）：
    //   rewrite —— `{ [字]: { at, reason } }` 被**标为待重写**的字：本次不进字体，但记在清单上等重写。
    //   与"剔除"的区别（界面上要说清）：**剔除 = 这个字不要了；待重写 = 先不进字体、以后补上**。
    //   落地路径：重写那几页 → 第 2 步的「重传这一页」原地覆盖（决策 八-14），不需要新机制。
    //   同样按"字"记录（不按格，重扫之后仍作数）；与剔除**互斥** —— 同一个字只能占一种。
    rewrite: {},
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
      // 全量约 8274 条 × 少量字段。**改了名称表 / 剔除某个字就把 built 清掉**，界面据此提示"要重新生成"
      checkup: null,
      // 体检之后又改过东西（剔除字形、改名称表）→ 快照已经与当前状态不一致，界面要提示"点生成字体重新生成"。
      // 为什么不复用 `built`：`built=false` 只说明"产物需要重建"，而空库时它本来就是 false —— 用它当"快照过期"
      // 会让界面在剔除一个字之后**整块体检面板消失**（实测踩到：剔除后看不到清单、也没法恢复）
      checkupStale: false
    },
    // 界面开关（不进"数据"的范畴，但也要能在组件之间共享）：
    //   orderMode —— 模板排列方式：'rank' 按使用频率 / 'charset' 笔画序（官方字表顺序，决策 八-11）。
    //   放进 store 是为了让**选字面板与模板预览两处的单选用同一份状态**（2026-10-08 用户要求联动：
    //   在选字面板切换排序之后，出模板的字序也跟着变，不会出现"看的是一种、排的是另一种"）。
    //   它与 selection 不同 —— 切换它**不改已建批次的字序**（批次自己记了 order）；也不进落盘数据。
    // 2026-10-11（决策 五-10）：原来还有 backupOpen / batchManagerOpen / resetToken / resetNotice
    //   四个字段，随「项目备份」「批次管理」「清空项目」三个入口一起去掉了。
    ui: { orderMode: 'rank' },
    storage: { idb: false, idbRev: null, snapshotRev: null },
    saveState: 'idle', // idle | saving | saved | failed —— 状态栏文案的数据源
    dirty: false, // 有改动还没落盘：关页兜底只在这种情况下才写快照
    loadSource: 'new' // new | idb | snapshot-newer | snapshot-only —— 本次数据从哪读来的
  }),

  getters: {
    // 上次关闭前有改动没写完、已从快照恢复：界面要提示一句，否则用户不知道"这次打开的数据是哪来的"
    recoveredFromSnapshot: (state) => state.loadSource === 'snapshot-newer' || state.loadSource === 'snapshot-only',
    selectedCount: (state) => countChars(state.selection.chars),
    // 出模板时要排的字：没选字就是全量（默认体验：零配置也能直接打全量模板）
    charsForTemplate: (state) => (state.selection.chars.length ? state.selection.chars : getAllChars().join('')),
    // 最近一个批次（识别这一步自动复用它，没有就新建一个；决策 五-9 ⑤）
    latestBatch: (state) => (state.batches.length ? state.batches[state.batches.length - 1] : null),
    // 这批扫描件所属的批次（内部容器，界面不显示）
    scanBatch: (state) => state.batches.find((item) => item.id === state.scan.batchId) || null,
    // 这批识别结果能拿出多少字形（页数 / 写了多少格 / 可疑多少 / 被圈多少 / 去重字数）
    scanGlyphStats: (state) => collectGlyphStats(state.scan.pages),
    // 被剔除的字（数组形式，界面与构建都要用）
    excludedChars: (state) => Object.keys(state.excluded || {}),
    excludedCount: (state) => Object.keys(state.excluded || {}).length,
    // 待重写的字（同上一组：界面要列清单、构建要排除）
    rewriteChars: (state) => Object.keys(state.rewrite || {}),
    rewriteCount: (state) => Object.keys(state.rewrite || {}).length
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
        // 只取 chars：2026-10-07 之前的项目对象里还有 selection.standard（频次标准，决策 八-2 已重写为
        // 规范三级 + 基础字符），那是个老字段，直接忽略 —— 免得它又被写回落盘数据里
        if (data.selection && typeof data.selection === 'object') {
          this.selection.chars = typeof data.selection.chars === 'string' ? data.selection.chars : ''
        }
        if (Array.isArray(data.batches)) this.batches = data.batches
        // 人工剔除记录（八-8）：读旧项目对象时没有这个字段，缺省为空对象即可
        if (data.excluded && typeof data.excluded === 'object' && !Array.isArray(data.excluded)) this.excluded = data.excluded
        // 待重写清单（八-8 扩充）：同样兼容没有这个字段的旧项目
        if (data.rewrite && typeof data.rewrite === 'object' && !Array.isArray(data.rewrite)) this.rewrite = data.rewrite
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
        rewrite: this.rewrite,
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
     * 设置选字（顺带做三件事：过滤字表外的字符、按字表字序（官方笔画序）排序、去重 —— 决策 八-6）
     * 字序一变，已打印的模板随即失效，因此**已有批次立即作废**（八-9）
     * @param {string|string[]} chars
     * @returns {{changed: boolean, count: number, voided: number}}
     */
    setSelection(chars) {
      const next = normalizeSelection(chars).join('')
      if (next === this.selection.chars) return { changed: false, count: countChars(next), voided: 0 }
      this.selection.chars = next
      // 2026-10-11（决策 五-9）：**改选字不再作废批次** —— 批次已退成内部容器，界面上也没有"作废"这个概念了；
      // 留着它会让自动建的批次被作废，而界面上又没有放行入口，用户直接被卡死。voided 保留是为了不动下面的返回值
      const voided = 0
      this.markDirty()
      schedulePersist(this)
      return { changed: true, count: countChars(next), voided }
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
     * @param {string} [info.order] 排列方式：'rank' 按使用频率 / 'charset' 笔画序（八-6 的修订、八-11）
     * @param {string} [info.source] 这一批是谁建的：'template' 第 1 步出模板 / 'auto' 第 2 步自动补
     * @param {string} [info.label] 给内部看的一行说明（**界面不显示**）
     * @returns {object} 新建的批次
     */
    addBatch({ pageCount, chars, order, source, label } = {}) {
      const list = chars === undefined ? this.charsForTemplate : chars
      // 字数与页数都按**码点**算（字表里有 196 个扩展 B 区汉字是代理对，用 .length 会多算）
      const charCount = countChars(list)
      const batch = {
        id: 'b' + (this.batches.length + 1) + '-' + Date.now().toString(36),
        chars: list,
        charCount,
        // 排列方式要留痕：同一批重新生成模板时必须用同一种顺序，否则字序变了、校验码也变，已打印的纸作废
        order: order || 'charset',
        pageCount: pageCount || Math.max(1, Math.ceil(charCount / 136)),
        batchCode: computeBatchCode(list),
        // 来源与说明只作**内部留痕**（界面不显示，随项目包导出/导入）：回头看"这一批是哪来的"时用得上 ——
        // 出模板建的还是扫描时自动补的，决定它能不能代表"用户手上那份纸"
        source: source || 'template',
        label: label || '',
        createdAt: new Date().toISOString()
      }
      this.batches.push(batch)
      this.markDirty()
      schedulePersist(this)
      return batch
    },

    /**
     * 记一笔"已经生成过模板"（决策 五-9 的收尾：第 1 步不再记批次，只留这条元信息）
     * 为什么要它：进度判据里"第 1 步完成 / 能不能进第 2、3 步"原本靠 batchCount，而批次现在只由第 2 步
     *   按需自动建 —— 不换判据的话，生成过模板也进不去下一步（flow.js 的 templatePages 读这里）。
     * 只存元信息、**不存 PDF 字节**：产物按需重建（五-5 的口径）。
     * @param {object} info { sheetPages, charCount, order, scope, fileName }
     */
    setTemplateGenerated(info = {}) {
      this.template = {
        generatedAt: new Date().toISOString(),
        sheetPages: info.sheetPages || 0,
        charCount: info.charCount || 0,
        order: info.order || 'charset',
        scope: info.scope || '',
        fileName: info.fileName || ''
      }
      this.markDirty()
      schedulePersist(this)
    },

    // 2026-10-11（决策 六-14）：原来这里的 voidBatch / voidActiveBatches 随"批次作废"这一态一起去掉了 ——
    // 界面上没有任何放行入口，留着只会把用户卡在第 2 步；新模型里改选字也不会让已打印的纸失效。

    // 2026-10-11（决策 六-14）：removeBatch（连同「批次管理」弹窗的"先作废再删"那条路径）一并去掉 ——
    // 批次对用户不可见之后，"删掉某一批"这个动作没有入口，也没有意义。

    // ── 扫描识别（阶段一「界面串联」B2）────────────────────────────────────
    // **用户不选批次**（2026-10-11 三步流程，决策 五-9 ⑤ / 六-14）：唯一的调用者是 ensureScanBatch()，
    // 它复用最近一个批次、没有就新建一个。原来这里还有"显式确认批次"与"作废批次放行"两个勾选的写口，
    // 随那两个勾选框一起去掉了。
    setScanBatch(batchId) {
      if (this.scan.batchId === batchId) return
      this.scan.batchId = batchId || null
      this.markDirty()
      schedulePersist(this)
    },

    /**
     * 取"这一轮上传识别"要用的批次（2026-10-11 新模型，决策 五-9 ⑤：批次退成内部容器）
     * 规则：有批次就**复用最后一个**；一个都没有就用当前选字新建一个。
     * 为什么要有这一步：新模型下"这批扫描件属于哪个批次"不再由用户回答 —— 纸面上的参考字自己
     *   说得清这一页写了哪些字（认参考字定字序），批次只剩两个用途：字形分片键的命名空间、
     *   以及没有候选库可用时的字序兜底。第 1 步若因改选字把旧批次作废了，这里会自动补一个，用户无感。
     * 幂等：已经指向某个仍有效的批次时再调一次不会新建（返回同一个）。
     * @returns {object} 可用的批次对象（一定非空）
     */
    ensureScanBatch() {
      const last = this.latestBatch
      if (last) {
        this.setScanBatch(last.id)
        return last
      }
      const batch = this.addBatch({
        chars: this.charsForTemplate,
        order: 'charset',
        source: 'auto',
        label: '扫描自动建立'
      })
      this.setScanBatch(batch.id)
      return batch
    },

    /**
     * 逐格复核：把某一格的字改成用户确认的值（第 2 步的逐格复核界面）。
     * 三处必须一起改，少一处界面与产物就会打架：
     *   · pageChars[i]   —— 这一页 136 格的字（界面显示、复核计数用）
     *   · cells[i].char  —— 字形计划（scanMeta.buildFinalGlyphPlan）与统计（collectGlyphStats）读的是它，
     *                       漏掉这一处会导致"界面改了、进字体的还是旧字"
     *   · unsureCells    —— 确认过就从"待确认"里摘掉（复核界面上的浅黄底随之消失）
     * 改的是识别结果本身，所以要落盘：复核是要花时间的，刷新后不能白干。
     * @param {{fileIndex:number, cellIndex:number, char:string|null}} input
     * @returns {boolean} 找到这一页并写入返回 true
     */
    setScanPageChar({ fileIndex, cellIndex, char }) {
      const page = this.scan.pages.find((p) => p.fileIndex === fileIndex)
      if (!page) return false
      const value = char || null
      if (Array.isArray(page.pageChars)) page.pageChars[cellIndex] = value
      const cell = (page.cells || []).find((c) => c.index === cellIndex)
      if (cell) cell.char = value
      if (Array.isArray(page.unsureCells)) page.unsureCells = page.unsureCells.filter((i) => i !== cellIndex)
      this.markDirty()
      schedulePersist(this)
      return true
    },

    // 开始一轮识别：清掉上一轮的结果与手选页序，记下这一批的字序（识别时按它把格号映射成字）
    // 同时记下**这批结果的来源**（文件夹名 / 图片名清单 / 字序文件摘要，见 state 里 scan.source 的注释）：
    // 它是"这次识别用的是哪些文件"的唯一凭据，刷新后界面靠它把来源照原样说清。
    beginScanRun({ batchId, chars, source }) {
      if (batchId) this.scan.batchId = batchId
      this.scan.pages = []
      this.scan.summary = null
      this.scan.orderOverrides = {}
      this.scan.chars = typeof chars === 'string' ? chars : ''
      this.scan.lastRunAt = null
      this.scan.source = source || null
      // 2026-10-13 用户口径：**重新识别要把第 3 步的信息一并清掉**（"回到生成前"）——
      //   整批重新识别会产出全新的字形与产物，旧的尺寸 / 覆盖率 / 体检清单都没意义了，所以直接 `clearFont()`。
      //   （中途版本只置 `built=false` + 把体检快照标成过期，于是第 3 步还挂着上一份体检清单；
      //    与「单页重传」的区别保留在 `replaceScanPage`：那是局部更新，仍保留旧清单、只标"过期"。）
      this.clearFont()
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

    /**
     * 补写「重复页」结论（2026-10-14 修一个真缺陷）。
     * 为什么需要它：去重是在 Worker 的**逐页循环之后**算的，而每页的记录早在逐页那一刻就 post 过来了 ——
     *   `duplicateOf` 不可能出现在那些消息里。不补写的话，界面上的「重复页」标记、可用页数、写出格数、
     *   被圈数、更正配对全都按**未去重**的页算：真机上 12 份同一张纸让"被红笔圈 29 个"、
     *   更正配对里同一个字出现四行、下面一大片"没有对应格"。
     * @param {Array<{fileIndex:number, duplicateOf:number}>} duplicates
     */
    applyScanDuplicates(duplicates) {
      const list = Array.isArray(duplicates) ? duplicates : []
      const adopted = new Map(list.map((d) => [d.fileIndex, d.duplicateOf]))
      // **整体重写**：先清掉所有页的旧标记再按新结论设置 —— 只加不清的话，"补传一张之后不再是重复页"
      //   的那一页会永远挂着旧标记（它就再也算不进统计与配对了）
      this.scan.pages = this.scan.pages.map((p) => {
        const next = { ...p }
        if (adopted.has(p.fileIndex)) next.duplicateOf = adopted.get(p.fileIndex)
        else delete next.duplicateOf
        return next
      })
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

    // 清掉识别结果（第 2 步的「清空结果」按钮用；内存缓存由组件一并清）。
    // **与第 3 步的「清空识别结果」是同一件事**，所以直接走 clearScanResults ——
    // 两处各写一套清理清单必然走样，而"清干净了没有"正是这个功能最容易出错的地方。
    // 差别只在界面文案：第 2 步那一下是为了重跑，第 3 步那一下是为了回到"还没识别"。
    clearScan() {
      // 注意：clearScanResults 会把 scan.batchId 置空（旧批次的字形分片已经没了，留着那个 id 没意义）；
      // 第 2 步再次识别时 store.ensureScanBatch() 会自动补一个（决策 五-9 ⑤ 的既有机制）
      return this.clearScanResults()
    },

    /**
     * 单页重传：用新识别的结果**原地替换**某一页的页记录（清单 一-8）
     * 按 `fileIndex` 定位 —— 字形分片键（`sxfont.glyphs.v1.<批次>.<fileIndex>`）与内存缓存都按它命名，
     * 所以复用原页的 `fileIndex` 就等于"原地覆盖"，页序机制一行都不用改（决策 八-14）。
     * 若结果里没有这一页（fileIndex 对不上，理论上不该发生），则追加一条 —— 重传完结果里反而没有它更糟。
     * 这一页的字形变了，之前生成的产物就不再对应：清掉"已构建"标记并让体检快照过期，
     * 与"剔除一个字"同一个道理（不重新生成就与界面说的不一致）。
     * @returns {{ok: boolean, replaced: boolean}}
     */
    replaceScanPage({ fileIndex, record, summary }) {
      const index = this.scan.pages.findIndex((p) => p.fileIndex === fileIndex)
      const next = [...this.scan.pages]
      if (index >= 0) next[index] = record
      else next.push(record)
      this.scan.pages = next
      if (summary) this.scan.summary = summary
      this.scan.lastRunAt = new Date().toISOString()
      if (this.font.built) {
        this.font.built = false
        this.font.builtAt = null
      }
      if (this.font.checkup) this.font.checkupStale = true
      this.markDirty()
      schedulePersist(this)
      return { ok: true, replaced: index >= 0 }
    },

    // 清掉更正配对（**不动识别结果**）：配对依赖"被圈字清单"，清单一变就必须重新核对。
    // clearScan（整批清空）与"单页重传后发现被圈字变了"共用这一处。
    resetCorrection() {
      this.correction = {
        pairs: [], unmatched: [], discarded: [], extra: [], messages: [], stats: null,
        circled: [], overrides: {}, updatedAt: null
      }
      this.markDirty()
      schedulePersist(this)
    },

    // ── 更正核对（步骤 1.8 的界面）────────────────────────────────────────
    // 写入配对初值（由 lib/scanFlow.pairCorrections 从识别结果算出来）。
    // 同时清掉用户的手动调整：初值一重算，旧的调整就没有依据了（配对整体可能已经变了）。
    // 2026-10-13 起这里没有"确认"这一步 —— 初值**默认生效**，用户改不改都直接用于生成字体。
    setCorrectionResult({ pairs, unmatched, discarded, extra, messages, stats, circled }) {
      this.correction.pairs = pairs || []
      this.correction.unmatched = unmatched || []
      this.correction.discarded = discarded || []
      this.correction.extra = extra || []
      this.correction.messages = messages || []
      this.correction.stats = stats || null
      this.correction.circled = circled || []
      this.correction.overrides = {}
      this.correction.updatedAt = new Date().toISOString()
      this.markDirty()
      schedulePersist(this)
    },

    // 用户调整（改派 / 删除 / 补录）：把生效清单与调整记录一起写回
    setCorrectionOverrides({ overrides, pairs, unmatched }) {
      this.correction.overrides = overrides || {}
      if (Array.isArray(pairs)) this.correction.pairs = pairs
      if (Array.isArray(unmatched)) this.correction.unmatched = unmatched
      this.markDirty()
      schedulePersist(this)
    },

    clearCorrection() {
      this.correction = {
        pairs: [], unmatched: [], discarded: [], extra: [], messages: [], stats: null,
        circled: [], overrides: {}, updatedAt: null
      }
      this.markDirty()
      schedulePersist(this)
    },

    // ── 字体产物（步骤 1.9 / 1.10）与字形体检（阶段三 3.2）──────────────────
    // 改名称表字段（第 3 步的表单）：改了就把"已构建"标记清掉 —— 否则界面会显示上一次的产物，
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
      this.markDirty()
      schedulePersist(this)
    },

    // ── 人工剔除（决策 八-8 的"已剔除"，清单 一-8）────────────────────────
    /**
     * 剔除 / 恢复一个字（第 3 步体检清单里的按钮）。
     * 剔除后这个字**不进字体、也不计入收录数**；恢复即回到正常。
     * 剔除会清掉"已构建"标记 —— 产物里还留着那个字形，不重新生成就与界面说的不一致。
     */
    setGlyphExcluded(char, excluded, reason) {
      if (!char) return false
      const next = { ...(this.excluded || {}) }
      if (excluded) next[char] = { at: new Date().toISOString(), reason: reason || '人工剔除' }
      else delete next[char]
      this.excluded = next
      // 与"待重写"互斥（八-8）：同一个字只能占一种 —— 既然剔除了，就不该再挂在重写清单上
      if (excluded && this.rewrite && this.rewrite[char]) {
        const rest = { ...this.rewrite }
        delete rest[char]
        this.rewrite = rest
      }
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

    // 清除全部剔除记录（第 3 步的「全部恢复」）
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

    // ── 待重写清单（决策 八-8 扩充的第四态，清单一-12）────────────────────
    /**
     * 把一个字标为待重写 / 移出重写清单（第 3 步体检面板里的两个按钮）。
     * **与"剔除"的区别**：剔除是"这个字不要了"；待重写是"这次先不进字体、以后补上"。
     * 两者在构建时的效果一样（都排除），区别在于**有没有一条待办挂在清单上**。
     * 标为待重写时**自动撤销剔除**（同一个字只能占一种状态，见 八-8）。
     * 与剔除同理：改的是状态位，所以要清掉"已构建"标记 —— 产物里还留着那个字形，
     * 不重新生成就与界面说的不一致。
     * @param {string} char
     * @param {boolean} rewrite true = 加入清单 / false = 移出清单（继续采用现有字形）
     * @param {string} [reason] 加入时的原因（一般来自体检：写得太小 / 要重写）
     * @returns {boolean}
     */
    setGlyphRewrite(char, rewrite, reason) {
      if (!char) return false
      const next = { ...(this.rewrite || {}) }
      if (rewrite) {
        next[char] = { at: new Date().toISOString(), reason: reason || '标为待重写' }
        // 互斥：从剔除名单里摘掉（它现在属于"待重写"，不是"不要了"）
        if (this.excluded && this.excluded[char]) {
          const rest = { ...this.excluded }
          delete rest[char]
          this.excluded = rest
          this.font.checkup = toggleSnapshotExcluded(toRaw(this.font.checkup), char, false)
        }
      } else {
        delete next[char]
      }
      this.rewrite = next
      if (this.font.built) {
        this.font.built = false
        this.font.builtAt = null
      }
      if (this.font.checkup) this.font.checkupStale = true
      this.markDirty()
      schedulePersist(this)
      return true
    },

    // 清空整份待重写清单（第 3 步的「全部移出」—— 表示这批字就这样用，不重写了）
    clearRewrite() {
      this.rewrite = {}
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
        coverage: null, skipped: 0, missing: 0, builtAt: null, checkup: null, checkupStale: false
      }
      this.markDirty()
      schedulePersist(this)
    },

    // 2026-10-11（决策 五-10）：原来这里的 resetProject（清空项目）、consumeResetNotice、
    // openBackup / closeBackup（项目备份）、openBatchManager / closeBatchManager（批次管理）、
    // markProjectExported（备份提醒）随那三个入口一起去掉了 —— 项目级动作只剩顶栏的「查看完整说明」。

    // ── 两级清空（2026-10-12 用户拍板，决策 五-11）──────────────────────────
    /**
     * 「清空识别结果」：回到"还没识别"，**模板元信息与名称表保留**。
     * 范围（五-11 ②）：页级记录 + 字形掩膜分片 + 更正配对 + 体检快照 + 剔除与待重写清单。
     * 为什么要连体检快照与字体产物元信息一起清（起因见 五-11 ①）：用户真机上出现"体检信息一直留着、
     *   状态自相矛盾"——光清页记录的话，第 3 步仍显示上一份产物与体检清单，那正是要消灭的现象。
     * **字形分片按全量清**（不带批次）：清空之后旧批次再没有入口可管理，留着就是谁也管不到的孤儿数据。
     * 内存里的缓存（页面缩略图 / 掩膜 / 已构建的字体字节 / 预览字体）由调用组件一并释放 ——
     * store 不认识那些模块级缓存，硬塞进来会让数据层依赖界面层。
     * @returns {{pages:number, excluded:number, rewrite:number, hadFont:boolean}} 清掉了多少（供界面如实汇报）
     */
    clearScanResults() {
      const removed = {
        pages: this.scan.pages.length,
        excluded: Object.keys(this.excluded || {}).length,
        rewrite: Object.keys(this.rewrite || {}).length,
        hadFont: this.font.built === true || !!this.font.checkup
      }
      this.scan.batchId = null
      this.scan.pages = []
      this.scan.summary = null
      this.scan.chars = ''
      this.scan.orderOverrides = {}
      this.scan.lastRunAt = null
      // 来源也跟着清：清空结果之后界面不该再说"这批结果来自文件夹 X"（那批结果已经不在了）
      this.scan.source = null
      this.resetCorrection()
      this.excluded = {}
      this.rewrite = {}
      this.clearFont()
      this.markDirty()
      schedulePersist(this)
      return removed
    },

    /**
     * 「清空全部数据」：等于回到刚打开软件（决策 五-11 ③）—— 上面那些 + 模板元信息 + 名称表复位 + 选字复位。
     * **落盘处理**：删掉 IndexedDB 真相与 localStorage 快照，并且**不再写一份空项目** ——
     *   界面复位后由用户刷新一次，启动时读不到真相、也没有快照，自然得到一份全新的空项目
     *   （这样连 rev 都从 0 重新开始，比"写一份 rev+1 的空项目"更干净；代价是要刷新，界面会明说）。
     * 与 五-8（旧「清空项目」）的口径一致：**顺序不能换** —— 先复位内存、再删盘上那一份。
     * @returns {Promise<{ok:boolean, error?:string}>}
     */
    async clearAllData() {
      this.$reset()
      // $reset 会把批次表也清空 —— 这正是"回到刚打开软件"该有的样子；接下来只处理盘上那一份
      const res = await clearStorage()
      this.dirty = false
      return res
    },

    // 模板排列方式（决策 八-11）：界面选择，不进落盘数据 —— 已建批次各自的 order 字段已经留痕
    setOrderMode(mode) {
      this.ui.orderMode = mode === 'charset' ? 'charset' : 'rank'
    }

    // 2026-10-13：原来这里还有一个 applyImportedProject（导入项目包时整份替换 store 状态）——
    // 项目包功能已随决策 五-10 作废，它**全库零引用**，一并删除。需要时从 git 历史取回。
  }
})
