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
import { loadProject, saveProject, getStorageState } from '../lib/persist.js'
import { getAllChars } from '../lib/charset.js'
import { normalizeSelection } from '../lib/frequency.js'
import { computeBatchCode } from '../lib/batchCode.js'

// 默认字体族名：产品命名（决策记录 七-1）。名称表其余字段在阶段三接入时补默认值。
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
    meta: { familyName: DEFAULT_FAMILY_NAME },
    glyphs: {},
    template: {},
    // 选字：standard 是频次标准（gb2312 | tonggui），chars 是选中的字（**按字表顺序**的字符串）。
    // 用字符串而不是数组：6919 字的数组拖进 Pinia 响应式开销大，字符串轻、天然有序、易于比对（八-6）
    selection: { standard: 'gb2312', chars: '' },
    // 批次列表（八-6、八-9、八-10）。每个批次记：
    //   chars     —— 该批选字（按全量字表位置排序，保证字序可复现）；空串表示全量
    //   standard  —— 生成时用的频次标准（只作记录，不影响字序）
    //   pageCount —— 该批模板的字表页数
    //   batchCode —— 12 位校验码，与印在页脚的高 12 位一致（八-10）
    //   status    —— active 可上传 / void 已作废（选字一改即作废，不再接受上传，除非用户显式勾选）
    //   printed   —— 是否已生成过模板（"未写"这一态的判据之一，八-8）
    //   uploads   —— 已绑定的扫描件（八-7：上传时手选批次；阶段一后半接入）
    batches: [],
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
    // 最近一个仍可上传的批次（将来的上传界面默认选它）
    latestActiveBatch: (state) => {
      for (let i = state.batches.length - 1; i >= 0; i--) {
        if (state.batches[i].status === 'active') return state.batches[i]
      }
      return null
    }
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
        if (data.selection && typeof data.selection === 'object') Object.assign(this.selection, data.selection)
        if (Array.isArray(data.batches)) this.batches = data.batches
      }
      this.loadSource = source
      this.storage = await getStorageState()
    },

    // 标记"有未落盘的改动"：输入类操作在防抖等待期间调用，供 pagehide 兜底判断
    markDirty() {
      this.dirty = true
    },

    // 落盘：写 IndexedDB（唯一真相）；返回是否成功
    async persist() {
      this.saveState = 'saving'
      const res = await saveProject({
        rev: this.rev,
        meta: this.meta,
        glyphs: this.glyphs,
        template: this.template,
        selection: this.selection,
        batches: this.batches
      })
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

    // 切换频次标准（只影响界面怎么分类展示，不改已选的字）
    setStandard(standard) {
      if (this.selection.standard === standard) return
      this.selection.standard = standard
      this.markDirty()
      schedulePersist(this)
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
     * @returns {object} 新建的批次
     */
    addBatch({ pageCount, chars } = {}) {
      const list = chars === undefined ? this.charsForTemplate : chars
      const batch = {
        id: 'b' + (this.batches.length + 1) + '-' + Date.now().toString(36),
        chars: list,
        charCount: list.length,
        standard: this.selection.standard,
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
    }
  }
})
