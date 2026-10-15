// 扫描件目录句柄的持久化（2026-10-14 用户拍板）。
//
// 要解决的事：刷新页面之后点「重新识别」，程序**应当直接对上次选的那个文件夹再识别一次**，
//   而不是提示"刷新之后要重选一次文件夹"。原来做不到，是因为目录句柄只活在内存里，刷新即失。
//
// 为什么能存：`FileSystemDirectoryHandle` 是结构化克隆对象，可以直接放进本机存储（IndexedDB）。
//   本机已在 `file://`（交付形态）下实测过同一条机制：句柄写入 / 读回正常（见《待办与风险清单》三-17）。
//
// 权限口径（必须与浏览器一致，别绕）：刷新后句柄的读取权限回到 `prompt`，而 `requestPermission()`
//   **只能在用户手势里调用** —— 点「重新识别」正是那个手势。拿不回权限时不静默、也不假装成功：
//   调用方拿到 false 就明确提示"请点「重选文件夹」再选一次"。
//
// 全部接口都**不抛异常**（返回 false / null）：这件能力是"省一次点击"，它坏了不该把识别流程带崩 ——
//   退路（重选文件夹）永远在。
const DB_NAME = 'sxfont.dir.v1'
const STORE = 'handles'
const KEY = 'scanDir'

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('这台浏览器没有本机存储（IndexedDB）'))
      return
    }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('打不开本机存储'))
  })
}

function run(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const store = tx.objectStore(STORE)
    let out
    try {
      out = fn(store)
    } catch (e) {
      db.close()
      reject(e)
      return
    }
    tx.oncomplete = () => { db.close(); resolve(out && out.result !== undefined ? out.result : out) }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('本机存储读写失败')) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error('本机存储读写被中止')) }
  }))
}

/**
 * 记下这次选的文件夹句柄（供刷新后再识别用）。
 * @returns {Promise<boolean>} 存下了就是 true；浏览器不支持序列化句柄时是 false（不抛）
 */
export async function saveScanDirHandle(handle) {
  if (!handle) return false
  try {
    await run('readwrite', (store) => { store.put(handle, KEY) })
    return true
  } catch (e) {
    // 常见原因：这个浏览器 / 这个来源（file:// 的 origin 为 null）不允许序列化句柄。
    // 不影响任何功能，只是刷新之后要重新选一次文件夹 —— 由调用方给提示，这里不打扰用户。
    return false
  }
}

/** 读回上次记下的句柄；没有 / 读不了都给 null */
export async function loadScanDirHandle() {
  try {
    const handle = await run('readonly', (store) => store.get(KEY))
    return handle && typeof handle.values === 'function' ? handle : null
  } catch (e) {
    return null
  }
}

/** 清掉记下的句柄（「清空全部数据」时用：那份数据都要删了，留着文件名没意义） */
export async function clearScanDirHandle() {
  try {
    await run('readwrite', (store) => { store.delete(KEY) })
    return true
  } catch (e) {
    return false
  }
}

/**
 * 拿回读取权限（**必须在用户手势里调**）。已经是 granted 就直接返回 true；
 * 否则申请一次 —— 用户点了"拒绝"就返回 false，由调用方给中文提示。
 * 老浏览器没有这两个方法时返回 false（退化成"重选文件夹"）。
 */
export async function requestScanDirPermission(handle) {
  if (!handle) return false
  try {
    if (typeof handle.queryPermission === 'function') {
      const q = await handle.queryPermission({ mode: 'read' })
      if (q === 'granted') return true
    }
    if (typeof handle.requestPermission !== 'function') return false
    const r = await handle.requestPermission({ mode: 'read' })
    return r === 'granted'
  } catch (e) {
    return false
  }
}
