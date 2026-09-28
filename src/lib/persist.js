// 项目数据持久化：IndexedDB 为主存储（容量大，容纳数千字形数据），localStorage 作快照兜底
// 背景（沿用参考项目 sn-font-manager 的实测结论）：localStorage 约 5MB 上限，字形数据一多就
// setItem 抛 QuotaExceededError，数据存不进 → 刷新即丢；IndexedDB 容量远超（通常数百 MB 级）。
// 兼容：旧数据只存在 localStorage 时仍可读出；新数据双写（IDB 完整 + LS 快照，LS 超限时忽略）。
//
// 本文件在本项目里的键名与参考项目不同（避免两套程序在同一浏览器里互相覆盖数据）：
//   localStorage 键 snfont.project.v1  → sxfont.project.v1
//   数据库名     snfont-db              → sxfont-db
// 项目数据的结构见 store/project.js 顶部注释。

const STORAGE_KEY = 'sxfont.project.v1'
const DB_NAME = 'sxfont-db'
const DB_STORE = 'projects'
const DB_KEY = 'sxfont.project.v1'

let idbPromise = null
// 惰性打开 IndexedDB（首次调用才建库，避免不支持的环境直接报错）
function openDb() {
  if (idbPromise) return idbPromise
  idbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      // 浏览器不支持或处于隐私模式：交由调用方回退到 localStorage 快照
      reject(new Error('indexedDB 不可用'))
      return
    }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE) // 不设 keyPath，用 put(value, key)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      // 打开失败：重置缓存，下次调用可重试（否则会永久卡在 rejected promise 上）
      idbPromise = null
      reject(req.error || new Error('indexedDB 打开失败'))
    }
  })
  return idbPromise
}

// IndexedDB 是否可用：供界面自检展示（不可用时功能退化为 localStorage 快照）
export async function isIdbAvailable() {
  try {
    await openDb()
    return true
  } catch {
    return false
  }
}

// 从 IndexedDB 读取项目；无数据或失败返回 null
export async function loadProjectFromIdb() {
  try {
    const db = await openDb()
    return await new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readonly')
      const req = tx.objectStore(DB_STORE).get(DB_KEY)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

// 从 localStorage 同步读取（快速路径 / 兼容旧数据；新建项目时为空）
export function loadProject() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    // 只认本项目的结构：至少带 meta（字体名称表字段）；脏数据一律当没读到
    if (data && typeof data === 'object' && data.meta) return data
    return null
  } catch {
    return null
  }
}

// localStorage 里是否已有快照：供界面自检展示
export function hasSnapshot() {
  try {
    return localStorage.getItem(STORAGE_KEY) != null
  } catch {
    return false
  }
}

// 保存项目：主写 IndexedDB，快照写 localStorage（LS 超限时静默忽略）
// 返回 Promise<boolean>：IndexedDB 写入成功即为 true（localStorage 失败不算失败）
// 写队列串行化：连续多次 persist 排队执行，避免并发事务交错，也让"最后一次保存"有完整的
// 事务完成时机（调用方可 await 后确认落盘）。
let saveQueue = Promise.resolve()
export function saveProject(project) {
  // Pinia state 里是响应式 Proxy，含内部引用；IDB put 要求可结构化克隆的值，
  // 直接存 Proxy 会抛 DataCloneError。先 JSON 往返转成纯数据再写（顺带排除 undefined/函数字段）。
  const clean = JSON.parse(JSON.stringify(project))
  latestSnapshot = clean // 记录最新数据，供刷新前 pagehide 同步兜底
  const run = saveQueue.then(() => doSave(clean))
  saveQueue = run.catch(() => {}) // 队列自身不因某次失败中断
  return run
}

async function doSave(clean) {
  let idbOk = false
  try {
    const db = await openDb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite')
      tx.objectStore(DB_STORE).put(clean, DB_KEY)
      tx.oncomplete = () => {
        idbOk = true
        resolve()
      }
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 写入失败'))
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 写入中止'))
    })
  } catch (e) {
    console.error('IndexedDB 保存失败', e)
  }
  // localStorage 快照尽力写；超限静默（IDB 已保底）
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean))
  } catch {
    /* 快照超限可忽略：IndexedDB 已保存完整数据 */
  }
  return idbOk
}

// 刷新 / 关闭页面前同步兜底：把队列里最新一次待写数据同步写进 localStorage 快照
// （IndexedDB 是异步的，可能来不及完成；LS 同步写入保证刷新后至少有快照可恢复）
let latestSnapshot = null
export function flushPendingSnapshot() {
  if (latestSnapshot == null) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(latestSnapshot))
  } catch {
    /* 超限可忽略 */
  }
}
