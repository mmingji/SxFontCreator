import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'
import { useProjectStore } from './store/project.js'
import { flushPendingSnapshot } from './lib/persist.js'

const app = createApp(App)
app.use(createPinia())

// 刷新 / 关闭页面前，把队列中最新一次待写数据同步写进 localStorage 快照
// （IndexedDB 异步可能来不及完成，同步写 LS 保证刷新后至少有快照可恢复）
window.addEventListener('pagehide', flushPendingSnapshot)

// 先读盘再挂载：避免界面先渲染默认族名、随后被读出的数据覆盖（会闪一下）
// load() 内部已吞掉存储异常，这里的 catch 只兜底未预料的错误，保证界面一定能起来
const store = useProjectStore()
store
  .load()
  .catch((e) => console.error('读取本机数据失败，按新项目启动', e))
  .finally(() => app.mount('#app'))
