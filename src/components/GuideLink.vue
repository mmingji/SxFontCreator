<script setup>
// 「完整说明」入口（向导每一步都有）：把打印 / 书写 / 扫描 / 上传更正 / 生成安装的说明整合成一份
// **单文件 HTML**（`public/使用说明.html`），新标签页打开即可通读；也可以保存到本地随身带着。
// 内容源是 src/lib/guide.js，由 scripts/build-guide.mjs 生成 —— 界面各步只留一句摘要，正文只有一份。
// 为什么用相对路径 `./使用说明.html`：交付形态还没定（单文件便携版或多文件 + 本地启动脚本），
// 相对路径在 http 与 file:// 下都指向同一目录，不会因为换形态而失效。
import { ref } from 'vue'
import { downloadText } from '../lib/download.js'
import { ensureInlineAsset, hasInlineAssets } from '../lib/inlineAssets.js'

const GUIDE_URL = './使用说明.html'
const note = ref('')

async function saveLocal() {
  note.value = ''
  try {
    // 交付形态（file://）下 fetch 同目录文件会被拦，但《使用说明》的内容在构建时也内联了一份
    let text = null
    if (hasInlineAssets()) {
      try {
        text = await ensureInlineAsset('guide-html')
      } catch (e) {
        text = null
      }
    }
    if (!text) {
      const res = await fetch(GUIDE_URL)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      text = await res.text()
    }
    downloadText(text, 'SxFontCreator-使用说明.html', 'text/html;charset=utf-8')
    note.value = '已保存'
  } catch (e) {
    // 两条路都取不到时给中文提示，引导用浏览器自带另存
    note.value = '保存失败：请在说明页里用浏览器的「另存为」（' + (e && e.message ? e.message : e) + '）'
  }
}
</script>

<template>
  <span class="guide-link">
    <a :href="GUIDE_URL" target="_blank" rel="noopener">查看完整说明</a>
    <button class="text" type="button" @click="saveLocal">保存到本地</button>
    <span v-if="note" class="guide-link-note">{{ note }}</span>
  </span>
</template>
