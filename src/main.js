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
// **内容必须是整份项目数据**（store.projectData()）：曾经这里手写了 `{ rev, meta, template }`，
//   漏掉 selection / batches / scan / correction / font —— 于是"改完选字立刻刷新"会把选字丢成空
//   （2026-10-07 冒烟的三处诊断数据抓到）。字段清单只留在 store 那一处。
window.addEventListener('pagehide', () => {
  if (!store.dirty) return
  markPendingSnapshot(store.projectData())
})

// 首屏加载层（写在 index.html 里，纯 HTML + CSS）：挂在 Vue 挂载完成后移除。
// 为什么要有它：JS（含 pdf-lib 等依赖）下载执行期间页面本来是白屏，实测冷启动约 3.5 秒；
// 加载层不依赖任何 JS，所以在最早期就能显示，用户看到的是"正在加载"而不是空白。
function dismissBootLayer() {
  const boot = document.getElementById('boot')
  if (!boot) return
  boot.classList.add('boot-done')
  // 淡出 300ms 后再删，避免动画被截断
  setTimeout(() => boot.remove(), 400)
}

// 先读盘再挂载：避免界面先渲染默认族名、随后被读出的数据覆盖（会闪一下）
// load() 内部已吞掉存储异常，这里的 catch 只兜底未预料的错误，保证界面一定能起来
// 另加 6 秒超时兜底：万一 IndexedDB 卡住（隐私模式、存储损坏），也要让用户进得去界面，而不是对着加载动画干等
const loadOrTimeout = Promise.race([
  store.load().catch((e) => console.error('读取本机数据失败，按新项目启动', e)),
  new Promise((resolve) => setTimeout(() => {
    console.warn('读取本机数据超过 6 秒未返回，先进入界面（数据可能未恢复）')
    resolve('timeout')
  }, 6000))
])

loadOrTimeout.finally(() => {
  app.mount('#app')
  dismissBootLayer()
})
