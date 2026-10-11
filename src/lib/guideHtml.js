// 《使用说明》单文件 HTML 的取法（一份实现，避免每个用到它的地方各写一遍）
// 两个来源（与 lib/inlineAssets.js 的分工一致）：
//   ① 交付形态（file://）：fetch 读同目录文件会被拦，内容在构建期已内联（`assets/inline-guide-html.js`）；
//   ② dev 服务器 / 任何走 http 的场合：直接 fetch 同目录的 `使用说明.html`。
// 两处调用方：第 1 步把说明打进模板压缩包（决策 一-17）、步骤标题行的「查看完整说明」链接。
import { ensureInlineAsset, hasInlineAssets } from './inlineAssets.js'

export const GUIDE_URL = './使用说明.html'

/**
 * 取《使用说明》HTML 正文。
 * @returns {Promise<string>} 失败时抛中文原因（调用方决定是"整件事失败"还是"少一件、提示一下"）
 */
export async function loadGuideHtml() {
  if (hasInlineAssets()) {
    try {
      const text = await ensureInlineAsset('guide-html')
      if (text) return text
    } catch (e) {
      // 内联资源没载入成功就往下走 fetch 那条路（dev 形态下内联资源本就不存在）
    }
  }
  const res = await fetch(GUIDE_URL)
  if (!res.ok) throw new Error('读取《使用说明》失败（HTTP ' + res.status + '）')
  return await res.text()
}
