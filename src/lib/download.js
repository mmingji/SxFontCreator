// 浏览器内下载（一份实现，避免每个面板各写一遍）
// 为什么用原生 Blob + a[download]：不引 file-saver（决策 六-6 的依赖分层判据）。
export function downloadBytes(bytes, filename, mime = 'application/octet-stream') {
  const blob = new Blob([bytes], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 交给浏览器读完再回收
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

export function downloadText(text, filename, mime = 'text/plain;charset=utf-8') {
  downloadBytes(new TextEncoder().encode(text), filename, mime)
}
