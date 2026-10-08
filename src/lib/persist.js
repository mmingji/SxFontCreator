// 项目数据持久化（职责）：把"当前项目"安全地存进本机，并在下次打开时读回来。
//
// 存储分层（这是重构后的关键约定，**不要再往两边都写**）：
//   IndexedDB   —— **唯一真相**：项目元信息与字形数据都只写这里（容量大，数千字形也放得下）
//   localStorage —— **只读快照**：只在 IndexedDB 写成功之后落一份，带同一个 rev（版本号）；
//                    快照只存元信息与进度，**不存字形数据**（localStorage 约 5MB 上限，
//                    8274 个字形轮廓放不下，硬塞只会得到一个"写失败但不报错"的假兜底）
//
// 为什么这么改（踩过的真实缺陷）：旧实现两边都写、读取时"IndexedDB 优先"，于是
//   改完立刻刷新 → pagehide 把新数据同步写进 localStorage，而 IndexedDB 事务还没跑完
//   → 下次启动读 IndexedDB 拿到的是旧值，用户最后一次改动凭空消失（界面显示过新值，重开变回旧值）。
//   现在读取时按 rev 取大者：快照 rev 更大 = 上次没写完就被关掉 → 用快照恢复，并立即固化回 IndexedDB。
//
// 数据来源与去向：数据由 store/project.js 提供；本模块不解释字段含义，只负责存取与版本对齐。

const SNAPSHOT_KEY = 'sxfont.snapshot.v1'
// 旧键 'sxfont.project.v1' 是"双写时代"的第二份真相，已废弃且不再读取（当前没有真实项目数据，
// 不做迁移；若将来发现用户机器上有旧数据需要救，再补一次性升级逻辑）
const DB_NAME = 'sxfont-db'
const DB_STORE = 'projects'
const DB_KEY = 'sxfont.project.v1'
// 导入项目包之前、把"当前这份"另存到同一个对象仓的这个键下（**不覆盖真相键**）：
// 万一用户选错了包，至少还有一条能捞回来的路（决策 五-6）。只留最近一次，不做历史版本。
export const BACKUP_KEY = 'sxfont.backup.before-import.v1'

// 字形数据（掩膜）另存分片键：`sxfont.glyphs.v1.<批次>.<页序>`（见 lib/glyphStore.js）。
// 为什么不塞进上面那个项目对象：字形量大（全量约 6900 格），而 persist 每次改动都会重写整份对象，
// 塞进去会让"改一个族名"也写十几 MB；分片之后小改动只写元信息。

let idbPromise = null
// 惰性打开 IndexedDB（首次调用才建库，避免不支持的环境直接报错）
function openDb() {
  if (idbPromise) return idbPromise
  idbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
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

// IndexedDB 是否可用：供界面自检展示（不可用时只剩快照可读，写入会明确失败）
export async function isIdbAvailable() {
  try {
    await openDb()
    return true
  } catch {
    return false
  }
}

// 给别的模块（lib/glyphStore.js）复用同一个库与对象仓，避免第二份打开逻辑：
// 两个模块各开各的会多一份连接与升级竞态，得不偿失
export async function openProjectDb() {
  return { db: await openDb(), store: DB_STORE }
}

// 从 IndexedDB 读项目；无数据或失败返回 null
async function readFromIdb() {
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

// 读快照：无数据、损坏、缺 meta 一律当没有（快照坏了不影响 IndexedDB 里的真相）
function readSnapshot() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || !data.meta) return null
    return data
  } catch {
    return null
  }
}

// 写快照：只读副本，去掉字形数据；返回是否写入成功（失败可忽略，IndexedDB 才是真相）
function writeSnapshot(data) {
  try {
    const copy = { ...data }
    delete copy.glyphs
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(copy))
    return true
  } catch {
    return false
  }
}

// 写 IndexedDB（唯一真相）。返回是否成功；失败由调用方决定怎么提示用户
async function writeToIdb(data) {
  try {
    const db = await openDb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite')
      tx.objectStore(DB_STORE).put(data, DB_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 写入失败'))
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 写入中止'))
    })
    return true
  } catch (e) {
    console.error('IndexedDB 保存失败', e)
    return false
  }
}

// 用指定 rev 落盘：IndexedDB 成功后才写快照，保证"快照永远不会比真相新"（除非异常关闭，见 markPendingSnapshot）
async function persistWithRev(data, rev) {
  // Pinia state 里是响应式 Proxy，含内部引用；IDB put 要求可结构化克隆的值。
  // 先 JSON 往返转成纯数据再写（顺带排除 undefined/函数字段）。
  const clean = JSON.parse(JSON.stringify(data))
  const next = { ...clean, rev, savedAt: Date.now() }
  const ok = await writeToIdb(next)
  if (ok) writeSnapshot(next)
  return { ok, rev, data: next }
}

// 写队列：连续多次保存串行执行，避免并发事务交错，也让调用方 await 后确认真正落盘
let saveQueue = Promise.resolve()

/**
 * 保存项目：写 IndexedDB（唯一真相），成功后落一份同 rev 的快照
 * @param {object} project 由 store 传入的项目数据（需带当前 rev）
 * @returns {Promise<{ok: boolean, rev: number}>} ok=false 表示 IndexedDB 写入失败（数据仍在内存里）
 */
export function saveProject(project) {
  const currentRev = Number(project && project.rev) || 0
  const run = saveQueue.then(() => persistWithRev(project, currentRev + 1))
  saveQueue = run.catch(() => ({ ok: false, rev: currentRev })) // 队列自身不因某次失败中断
  return run.then((res) => ({ ok: res.ok, rev: res.ok ? res.rev : currentRev }))
}

/**
 * 关页 / 刷新兜底：把内存里最新数据写成 **rev + 1** 的快照，标记为"未固化"。
 * 下次启动时会因为快照 rev 更大而被认定为较新的一份，并被固化回 IndexedDB —— 这正是兜底能生效的原因。
 * 只在"确实有未落盘的改动"时调用（否则每次刷新都会写一份多余的快照，下次启动还会多一次恢复固化）。
 * @param {object} project 内存中的项目数据（含当前 rev）
 */
export function markPendingSnapshot(project) {
  try {
    const clean = JSON.parse(JSON.stringify(project))
    delete clean.glyphs // 快照不存字形数据
    clean.rev = (Number(clean.rev) || 0) + 1
    clean.savedAt = Date.now()
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(clean))
  } catch {
    /* 超限或不可写：忽略，IndexedDB 里的上一次数据仍在 */
  }
}

/**
 * 读取项目：IndexedDB 与快照按 rev 取大者；若采用的那份不是 IndexedDB 里的，立即固化回 IndexedDB。
 * @returns {Promise<{data: object|null, source: 'new'|'idb'|'snapshot-newer'|'snapshot-only'}>}
 *   source 用于界面提示：snapshot-newer = 上次关闭前有改动没写完，已从快照恢复
 */
export async function loadProject() {
  const idb = await readFromIdb()
  const snap = readSnapshot()
  if (!idb && !snap) return { data: null, source: 'new' }

  const idbRev = idb ? Number(idb.rev) || 0 : -1
  const snapRev = snap ? Number(snap.rev) || 0 : -1

  if (snap && snapRev > idbRev) {
    // 快照更新：上次 IndexedDB 没写完就被关掉了 → 用快照恢复（字形数据仍从 IndexedDB 取），并固化回去
    const data = { ...snap, glyphs: (idb && idb.glyphs) || {} }
    await persistWithRev(data, snapRev)
    return { data, source: idb ? 'snapshot-newer' : 'snapshot-only' }
  }
  if (idb) return { data: idb, source: 'idb' }

  // 只有快照（IndexedDB 为空或不可用）：用它，并尝试固化
  const data = { ...snap, glyphs: {} }
  await persistWithRev(data, snapRev)
  return { data, source: 'snapshot-only' }
}

/**
 * 整份替换项目（导入项目包时用，决策 五-6）：
 *   ① rev 取 **max(当前 rev, 包内 rev) + 1** —— 直接用包内 rev 会有两个坑：包来自另一台机器时
 *      它的 rev 可能比本机大得多（此后每次保存都从一个大数往上爬），或比本机小（旧快照反而"更新"而翻盘）；
 *   ② IndexedDB 与 localStorage 快照**同时**写同一个新 rev —— 否则下一步启动时按"rev 取大者"恢复，
 *      旧快照会把刚导入的数据盖回去。
 * 写失败返回 ok=false，调用方**不要**再往下走（这时打开着的还是原来那份数据）。
 * @param {object} data 导入进来的项目数据（含 meta / selection / batches / scan / correction …）
 * @returns {Promise<{ok:boolean, rev:number}>}
 */
export async function replaceProject(data) {
  const current = await readFromIdb()
  const currentRev = current ? Number(current.rev) || 0 : 0
  const incomingRev = Number(data && data.rev) || 0
  const rev = Math.max(currentRev, incomingRev) + 1
  const res = await persistWithRev({ ...data, rev }, rev)
  return { ok: res.ok, rev }
}

/**
 * 导入前的保底：把当前这份项目数据另存一份（同一个对象仓的另一个键，**不动真相键**）。
 * 为什么要有：导入是**不可撤销**的整份替换，用户有可能选错包；有一条"最近被替换掉的那份"，
 * 出事时至少能人工捞回来。它不参与正常读取，因此不影响启动链路。
 * @returns {Promise<{ok:boolean}>}
 */
export async function stashCurrentProject(data) {
  try {
    const clean = JSON.parse(JSON.stringify(data))
    const record = { ...clean, stashedAt: Date.now() }
    const db = await openDb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite')
      tx.objectStore(DB_STORE).put(record, BACKUP_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('保底写入失败'))
    })
    return { ok: true }
  } catch (e) {
    console.error('导入前的保底快照写入失败', e)
    return { ok: false }
  }
}

/**
 * 清空本机存着的这一份项目（「清空项目」用，决策 五-8）：三个键**全删**。
 * 为什么一个都不能少：
 *   ① **真相键** —— 不删的话 IndexedDB 里还是旧项目；
 *   ② **localStorage 快照** —— 这一条最容易漏，也最要命：读取规则是"**rev 取大者**"（五-4），
 *      只删真相键的话，rev 更大的旧快照会在下次启动时被当成"较新的一份"恢复并固化回 IndexedDB，
 *      旧项目当场复活（冒烟里"清空 → 刷新 → 仍为空"这条就是钉它的）；
 *   ③ **导入保底键** —— 导入项目包时另存的那一份（五-6），它没有界面入口，
 *      留着就等于"清空"之后库里还藏着一份旧项目。
 * 调用时机：它是"先删干净、再写一份新的空项目"里的第一步，**必须在 store 复位之前**调用
 * （顺序见五-8 的五段式；反过来的话，中间那一刻盘上是空的而内存里还是旧数据）。
 * @returns {Promise<{ok:boolean, removed:{project:boolean, snapshot:boolean, backup:boolean}, error?:string}>}
 *   removed 的语义是"这一步已执行"，不区分那个键原本在不在（删不存在的键在 IndexedDB 里也算成功）
 */
export async function clearProject() {
  const removed = { project: false, snapshot: false, backup: false }
  try {
    const db = await openDb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite')
      const store = tx.objectStore(DB_STORE)
      store.delete(DB_KEY)
      store.delete(BACKUP_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 删除失败'))
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 删除中止'))
    })
    removed.project = true
    removed.backup = true
  } catch (e) {
    // 删不掉就明确失败：界面据此给中文原因，**不要**再往下复位界面（否则界面空了、盘上还留着旧项目）
    return { ok: false, removed, error: e && e.message ? e.message : String(e) }
  }
  try {
    localStorage.removeItem(SNAPSHOT_KEY)
    removed.snapshot = true
  } catch (e) {
    return { ok: false, removed, error: e && e.message ? e.message : String(e) }
  }
  return { ok: true, removed }
}

// 存储状态（供界面自检展示）：两边各自的 rev，用于一眼看出是否对齐
export async function getStorageState() {
  const idbOk = await isIdbAvailable()
  const idbData = idbOk ? await readFromIdb() : null
  const snap = readSnapshot()
  return {
    idb: idbOk,
    idbRev: idbData ? Number(idbData.rev) || 0 : null,
    snapshotRev: snap ? Number(snap.rev) || 0 : null
  }
}
