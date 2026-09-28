import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'
import { useProjectStore } from './store/project.js'
import { markPendingSnapshot } from './lib/persist.js'

const app = createApp(App)
app.use(createPinia())

const store = useProjectStore()

// 刷新 / 关闭页面前：只有"确实有改动还没落盘"时才写一份 rev+1 的快照。
// 下次启动时它会被判定为较新的一份并被固化回 IndexedDB（机制见 lib/persist.js 顶部说明）。
// 无条件写快照会让每次刷新都留一份多余副本，下次打开还会多走一次恢复流程。
window.addEventListener('pagehide', () => {
  if (!store.dirty) return
  markPendingSnapshot({ rev: store.rev, meta: store.meta, template: store.template })
})

// 先读盘再挂载：避免界面先渲染默认族名、随后被读出的数据覆盖（会闪一下）
// load() 内部已吞掉存储异常，这里的 catch 只兜底未预料的错误，保证界面一定能起来
store
  .load()
  .catch((e) => console.error('读取本机数据失败，按新项目启动', e))
  .finally(() => app.mount('#app'))
