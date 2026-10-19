// file:// 形态的内联资源装载器（资源由构建期生成的 `assets/inline-*.js` 提供）
// 背景（《待办与风险清单》三-8 的实测结论）：file:// 下 `fetch` 与 `XMLHttpRequest` 读同目录文件都会被浏览器拦下，
//   所以"本来按 URL 取"的几样东西在交付形态里改成构建期内联成 base64、运行时按需插 `<script>` 取回：
//   ① 两个内置字体子集（参考字 + 书写示意的手写体）；② pdf.js 的 worker（转成 Blob URL 交给 pdf.js）；
//   ③ woff2 编码器的 wasm（转成 data URL 交给 emscripten）；④ 《使用说明》的 HTML（打包进模板压缩包与程序包用）。
// 为什么用普通 `<script>` 而不是 ES module：file:// 下模块脚本被 CORS 拦（origin 为 null），普通脚本不受限制 ——
//   这也正是本项目构建成 IIFE 的原因。
// 为什么按需而不是首屏全量（用户 2026-10-07 拍板）：内联资源合计约 12MB，首屏只该加载 app.js；
//   字体在"真正要用它印模板 / 画示意页"时才载入，worker 在第一次渲染 PDF 时才载入。
// 普通形态（dev 服务器、或任何走 http 的场合）下 `window.__SX_FILE_BUILD__` 不存在 ——
//   各调用方照旧走 fetch / `?url`，本模块不参与，零分支成本。

const SCRIPT_BASE = './assets/inline-'
const pending = new Map()

// 当前是不是内联形态（由 index.html 里的标记决定，构建时注入）
export function hasInlineAssets() {
  return typeof window !== 'undefined' && window.__SX_FILE_BUILD__ === true
}

// 已经载入过的资源（构建期脚本会往 window.__SX_INLINE_ASSETS__ 上挂）
function store() {
  return (typeof window !== 'undefined' && window.__SX_INLINE_ASSETS__) || null
}

// 插一个普通脚本并等它执行完；失败时把待办清掉，方便下次重试
function loadScript(url) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = url
    el.onload = () => resolve()
    el.onerror = () => reject(new Error('内联资源加载失败：' + url))
    document.head.appendChild(el)
  })
}

/**
 * 取一份内联资源（同一份只加载一次）。
 * @param {string} name 资源名（构建期约定：font-lxgw / font-yozai / pdf-worker / woff2-wasm / guide-html）
 * @returns {Promise<string|null>} base64 字符串（guide-html 是原文）；不在内联形态或取不到时返回 null
 */
export async function ensureInlineAsset(name) {
  const s = store()
  if (s && s[name]) return s[name]
  if (!hasInlineAssets()) return null
  if (!pending.has(name)) {
    pending.set(name, loadScript(SCRIPT_BASE + name + '.js').catch((e) => {
      pending.delete(name)
      throw e
    }))
  }
  await pending.get(name)
  const after = store()
  return after ? after[name] || null : null
}

// base64 → 字节：自己解码，不再走 fetch（file:// 下 fetch 同目录文件会被拦，data URL 虽然可用，
// 但几 MB 的字符串走 atob 更直接，也省掉一次编码往返）
export function base64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * 取一份内联资源并解码成字节。
 * @returns {Promise<Uint8Array|null>}
 */
export async function ensureInlineBytes(name) {
  const b64 = await ensureInlineAsset(name)
  return b64 ? base64ToBytes(b64) : null
}

/**
 * 把内联资源变成一个**同源可用**的 URL —— 给那些只接受 URL 的库用（pdf.js 的 `workerSrc` 必须是字符串 URL，
 * 而 file:// 下不能直接指向文件；Blob URL 实测可用，见清单 三-8）。
 * @returns {Promise<string|null>}
 */
export async function ensureInlineBlobUrl(name, type) {
  const bytes = await ensureInlineBytes(name)
  if (!bytes) return null
  return URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }))
}
