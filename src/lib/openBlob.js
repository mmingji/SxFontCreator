// 在新标签页里打开一份**本机生成**的内容（图片 / HTML）—— 第 3 步的「查看字形总览」「查看网页预览」用。
//
// 为什么不用下载：用户要的是"点开就看"（看完关掉即可），不是往下载目录里堆文件。
// 两条路，按可靠度依次试：
//   ① `window.open(blobURL)` —— 最干净（地址栏是 blob:），但要求浏览器允许**从当前页面导航到 blob:**；
//      本项目的交付形态是 `file://`（origin 为 null），有的版本会拒绝这一步，所以必须有退路；
//   ② 退路：开一个空白标签页，把内容写进去（图片用 `<img src=blobURL>`、HTML 直接 document.write）——
//      观感一样，只是地址栏显示 about:blank。
// 返回 false 只有一种情形：**弹窗被浏览器拦了** —— 调用方据此给中文提示（让用户允许本页打开弹窗）。
export function openBlobInNewTab(blob, options = {}) {
  const title = options.title || ''
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const url = URL.createObjectURL(blob)
  // 一分钟后再释放：太早会打断新标签页里图片的加载，太晚则白占内存
  const release = () => setTimeout(() => { try { URL.revokeObjectURL(url) } catch (e) { /* 已经释放过 */ } }, 60000)

  let win = null
  try { win = window.open(url, '_blank') } catch (e) { win = null }
  if (win) {
    release()
    return true
  }

  // 退路：空白页 + 写入内容
  win = window.open('', '_blank')
  if (!win) {
    try { URL.revokeObjectURL(url) } catch (e) { /* 忽略 */ }
    return false
  }
  const doc = win.document
  const isImage = typeof blob.type === 'string' && blob.type.indexOf('image/') === 0
  if (isImage) {
    doc.write('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + escapeHtml(title) +
      '</title><style>html,body{margin:0;background:#fff}img{display:block;max-width:none}</style></head>' +
      '<body><img src="' + url + '" alt="' + escapeHtml(title) + '"></body></html>')
    doc.close()
    release()
    return true
  }
  // HTML：直接把文本写进去（样式与字体都内联在页面里，离线可用）
  blob.text()
    .then((html) => { doc.write(html); doc.close() })
    .catch(() => { doc.write('<!doctype html><meta charset="utf-8"><p>内容打开失败：读不出生成的页面内容。</p>'); doc.close() })
  release()
  return true
}
