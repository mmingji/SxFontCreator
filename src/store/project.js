// 项目状态（Pinia）：本项目只支持一套字体（决策记录 五-1），因此状态就是"当前项目"本身。
// 数据结构（也是将来「导出项目包」的内容，决策记录 五-2）：
//   meta     —— 字体名称表字段（族名、子族名、版本、设计者、版权、许可…），全部有默认值（四-1）
//   glyphs   —— 字形数据：码位 → 轮廓（阶段一后续步骤填充）
//   template —— 模板配置：字表顺序、版面参数（阶段一步骤 1.3 填充）
// 数据来源与去向：启动时从 persist 读（IndexedDB 主存 / localStorage 快照兜底），字段变更后写回。
import { defineStore } from 'pinia'
import { loadProjectFromIdb, loadProject, saveProject, isIdbAvailable, hasSnapshot } from '../lib/persist.js'

// 默认字体族名：产品命名（决策记录 七-1）。名称表其余字段在阶段三接入时补默认值。
const DEFAULT_FAMILY_NAME = 'SxFontCreator'

export const useProjectStore = defineStore('project', {
  state: () => ({
    meta: { familyName: DEFAULT_FAMILY_NAME },
    glyphs: {},
    template: {},
    storage: { idb: false, snapshot: false }, // 本地存储可用性，供环境自检展示
    saveState: 'idle' // idle | saving | saved | failed —— 状态栏文案的数据源
  }),

  actions: {
    // 读本地数据：IndexedDB 优先，读不到再退到 localStorage 快照（两者都没有就是新项目）
    async load() {
      const fromIdb = await loadProjectFromIdb()
      const data = fromIdb || loadProject()
      if (data) {
        if (data.meta && typeof data.meta === 'object') Object.assign(this.meta, data.meta)
        if (data.glyphs && typeof data.glyphs === 'object') this.glyphs = data.glyphs
        if (data.template && typeof data.template === 'object') this.template = data.template
      }
      this.storage = { idb: await isIdbAvailable(), snapshot: hasSnapshot() }
    },

    // 落盘：返回是否写入 IndexedDB 成功（localStorage 快照失败不算失败）
    async persist() {
      this.saveState = 'saving'
      const ok = await saveProject({ meta: this.meta, glyphs: this.glyphs, template: this.template })
      this.saveState = ok ? 'saved' : 'failed'
      return ok
    }
  }
})
