// 识别这一步的输入准备（决策 二-18）：从"一个目录"里挑出图片与字序文件。
//
// 为什么单独成模块：目录选择给回来的是一份**扁平的文件清单**（`<input webkitdirectory>` 的 files），
//   而"哪些算图片、按什么顺序排、哪份是字序文件、子文件夹里的算不算"全是判据，放在组件里既难读也难测。
//   这里只做纯逻辑（零浏览器 API，除了最后那个读文件的函数用 `File.text()`），可在 Node 侧直接断言。
//
// 目录读取的两种入口（决策 六-13：主路走 `showDirectoryPicker`，`webkitdirectory` 只作退路）：
//   · `showDirectoryPicker`：走系统原生目录对话框，拿到**目录句柄**，本模块的 collectDirectoryFiles
//     负责把句柄读成文件清单（只认根层，子目录只计数）；
//   · `<input webkitdirectory>`：扁平的 files + `File.webkitRelativePath`（形如 `扫描件/第1页.jpg`）。
//   两条路最后都汇进同一个 pickScanInputs —— 下游（识别）不必知道自己是从哪条路来的。
import { ORDER_FILE_EXTENSIONS, orderFilePriority, parseOrderFile } from './orderFile.js'

// 认哪些扩展名（决策 二-18 ②）。刻意不含 .gif / .tif：前者动画帧没有意义，后者本项目链路的
// 解码与预处理都没验过 —— 宁可"没被当成图片、在界面上说出来"，也不要悄悄产出一堆失败页。
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp']

/** 取文件名主干之后的扩展名（小写，含点）；没有扩展名返回空串 */
export function fileExtension(name) {
  const s = String(name || '')
  const i = s.lastIndexOf('.')
  return i <= 0 ? '' : s.slice(i).toLowerCase()
}

export function isImageName(name) {
  return IMAGE_EXTENSIONS.indexOf(fileExtension(name)) >= 0
}

/** 是不是当前的固定名字序文件（`字序.sxorder`；Windows 上文件名不区分大小写，这里也不区分） */
export function isOrderFileName(name) {
  return orderFilePriority(name) === 0
}

/** 相对路径的目录段：`扫描件/第1页.jpg` → `扫描件`；`扫描件/旧的/第1页.jpg` → `扫描件`；没有相对路径 → 空串 */
export function folderSegment(relativePath) {
  const s = String(relativePath || '')
  const i = s.indexOf('/')
  return i < 0 ? '' : s.slice(0, i)
}

/**
 * 这个文件是不是**目录根层**的。
 * 注意 `webkitRelativePath` 的形态：根层文件是 `目录名/文件名`（两段），子目录里的才是三段以上 ——
 *   **不能拿"含不含斜杠"当判据**（根层也含），这条踩过：写成含斜杠即忽略时，整目录的文件会被全部忽略。
 * 没有相对路径的（自动化测试喂进来的文件、或个别浏览器）按根层处理。
 */
export function isRootLevel(relativePath) {
  const s = String(relativePath || '')
  if (!s) return true
  return s.split('/').length <= 2
}

/**
 * 文件名自然序：把数字段按**数值**比，其余按字符比。
 * 为什么不能直接字典序：`第10页.jpg` 会排在 `第2页.jpg` 前面 —— 识别结果的页序会整体错位，
 *   而页序错位在成品里表现为"某些字对错了人"，事后很难查（决策 二-18 ②）。
 */
export function naturalCompare(a, b) {
  const ax = String(a || '').match(/(\d+|\D+)/g) || []
  const bx = String(b || '').match(/(\d+|\D+)/g) || []
  const n = Math.min(ax.length, bx.length)
  for (let i = 0; i < n; i++) {
    const aNum = /^\d+$/.test(ax[i])
    const bNum = /^\d+$/.test(bx[i])
    if (aNum && bNum) {
      const d = Number(ax[i]) - Number(bx[i])
      if (d !== 0) return d
    } else if (ax[i] !== bx[i]) {
      return ax[i] < bx[i] ? -1 : 1
    }
  }
  return ax.length - bx.length
}

/**
 * 一个目录句柄 → 本轮要用的文件清单（决策 六-13 的主路：`showDirectoryPicker`）。
 * 为什么要有它：目录句柄**没有**"一次拿到全部文件"的接口，只能一个个 entry 迭代 —— 而且这段是
 *   async 的（每读一个 entry 都要 await）。放在这里而不是组件里，一是可测（冒烟注入一个假句柄就能跑），
 *   二是"读到什么程度算完"这件事与 pickScanInputs 的判据是同一件事，两处分开写必然走样。
 *
 * 三条口径与 二-18 ② 完全一致：
 *   · **只取根层的文件**；子目录整个不进去（只数一遍里面的文件个数，供界面报"忽略了子文件夹里的 N 个文件"）；
 *   · 顺序不在这里定 —— 交给 pickScanInputs 按文件名自然序排（它也要给 webkitdirectory 那条路排序）；
 *   · 文件类型不筛（图片 / json / 其它都收），筛选同样归 pickScanInputs。
 * @param {FileSystemDirectoryHandle} dirHandle
 * @returns {Promise<{files:Array, folderName:string, skippedSubdirs:number, subdirFiles:number}>}
 */
export async function collectDirectoryFiles(dirHandle) {
  if (!dirHandle || typeof dirHandle.values !== 'function') {
    throw new Error('目录句柄不可用（没有读到目录内容）')
  }
  const files = []
  let subdirFiles = 0
  let skippedSubdirs = 0
  for await (const entry of dirHandle.values()) {
    if (!entry) continue
    if (entry.kind === 'directory') {
      skippedSubdirs++
      subdirFiles += await countFilesIn(entry, 3)
      continue
    }
    // 只处理普通文件：`getFile()` 在某些浏览器上对特殊条目会抛，抛了就当它不存在（不因为一个坏条目放弃整个目录）
    if (typeof entry.getFile !== 'function') continue
    try {
      const file = await entry.getFile()
      // 补一个 webkitRelativePath：pickScanInputs 靠它取"目录名"、判"是不是根层"。
      // 句柄这条路本来就知道层级（根层的文件名前面只有目录名），补上之后两条入口的输入形状就一致了，
      // pickScanInputs 不必知道自己被哪条路调用（File 对象允许挂自定义属性，结构化克隆会丢掉它，但这里不需要克隆）
      try {
        Object.defineProperty(file, 'webkitRelativePath', {
          value: (dirHandle.name || '') + '/' + file.name,
          configurable: true,
          enumerable: false
        })
      } catch (e) { /* 个别环境不允许改 File：那就在 pickScanInputs 里按"没有相对路径 = 根层"处理 */ }
      files.push(file)
    } catch (e) {
      // 单个文件读不到（权限 / 已删除）：静默跳过，界面上的"共 N 个文件"会如实少一个
    }
  }
  return {
    files,
    folderName: dirHandle.name || '',
    skippedSubdirs,
    subdirFiles
  }
}

/** 递归数一个子目录里有几个文件（**只为报数**，深度上限防病态目录；数不出来就返回 0） */
async function countFilesIn(dirHandle, depth) {
  if (depth <= 0 || !dirHandle || typeof dirHandle.values !== 'function') return 0
  let n = 0
  try {
    for await (const entry of dirHandle.values()) {
      if (!entry) continue
      if (entry.kind === 'directory') n += await countFilesIn(entry, depth - 1)
      else n++
    }
  } catch (e) {
    return n
  }
  return n
}

/**
 * 从目录选择给回来的文件清单里挑出这一轮要用的东西。
 * 判据（决策 二-18 ②）：
 *   · **只认目录根下那一层** —— 落进子目录的一律忽略并计数（判据见 isRootLevel），
 *     避免把"另存一份的旧纸"混进来（连同它那份旧的字序文件）；
 *   · 图片按扩展名取，**按文件名自然序**排；
 *   · 字序文件候选 = 根层里扩展名为 `.sxorder` 或 `.json` 的文件，**按 orderFilePriority 排序**：
 *     当前的固定名 `字序.sxorder` 最先，其次是别的 `.sxorder`，再次是旧固定名 `字序.json`、
 *     最后是别的 `.json`（旧包与用户自己改名的副本都要能读，真伪由文件里的 format 标记判定，一-18 ④）。
 * @param {File[]|ArrayLike} fileList 目录选择的 files
 * @returns {{images:Array, orderCandidates:Array, ignoredSubdir:number, ignoredOther:number, folderName:string, total:number}}
 */
export function pickScanInputs(fileList) {
  const all = Array.from(fileList || [])
  const images = []
  const orderCandidates = []
  let ignoredSubdir = 0
  let ignoredOther = 0
  let folderName = ''
  for (const file of all) {
    const rel = typeof file.webkitRelativePath === 'string' ? file.webkitRelativePath : ''
    if (!folderName) folderName = folderSegment(rel)
    if (!isRootLevel(rel)) {
      ignoredSubdir++
      continue
    }
    if (isImageName(file.name)) images.push(file)
    else if (ORDER_FILE_EXTENSIONS.indexOf(fileExtension(file.name)) >= 0) orderCandidates.push(file)
    else ignoredOther++
  }
  images.sort((a, b) => naturalCompare(a.name, b.name))
  orderCandidates.sort((a, b) => {
    const pa = orderFilePriority(a.name)
    const pb = orderFilePriority(b.name)
    if (pa !== pb) return pa - pb
    return naturalCompare(a.name, b.name)
  })
  return { images, orderCandidates, ignoredSubdir, ignoredOther, folderName, total: all.length }
}

/**
 * 读一个文件并按字序文件解析。
 * @returns {Promise<{ok:boolean, reason:string, fileName:string, file:object|null}>}
 */
export async function readOrderFileFrom(file, options = {}) {
  const name = file && file.name ? file.name : ''
  let text = ''
  try {
    text = await file.text()
  } catch (e) {
    return { ok: false, reason: '读不出来（' + (e && e.message ? e.message : e) + '）', fileName: name, file: null }
  }
  const parsed = parseOrderFile(text, options)
  return { ok: parsed.ok, reason: parsed.reason, fileName: name, file: parsed.file }
}

/**
 * 在候选里找**第一份能用**的字序文件（固定名优先由 pickScanInputs 排好序）。
 * 一份都没有 / 全都不合格式时同样返回结果对象 —— 调用方据此走"认参考字定字序"的退路（决策 一-18 ⑤）。
 * @returns {Promise<{ok:boolean, reason:string, fileName:string, file:object|null, tried:string[]}>}
 */
export async function findOrderFile(candidates, options = {}) {
  const list = Array.from(candidates || [])
  const tried = []
  for (const file of list) {
    const res = await readOrderFileFrom(file, options)
    if (res.ok) return { ...res, tried }
    tried.push((file.name || '（无名文件）') + '：' + res.reason)
  }
  return {
    ok: false,
    reason: list.length ? '目录里没有能用的字序文件（' + tried.join('；') + '）' : '',
    fileName: '',
    file: null,
    tried
  }
}
