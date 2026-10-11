<script setup>
// 「完整说明」入口：把打印 / 书写 / 扫描 / 识别 / 生成安装的说明整合成一份**单文件 HTML**
// （`public/使用说明.html`），新标签页打开即可通读。
// 内容源是 src/lib/guide.js，由 scripts/build-guide.mjs 生成 —— 界面各步只留一句摘要，正文只有一份。
// 2026-10-11（决策 五-10 ④）：去掉「保存到本地」。单文件说明现在随**模板压缩包**一起发到用户手上
//   （决策 一-17），界面上再放一个"另存"入口只是重复；这里只负责"打开来看"。
import { GUIDE_URL } from '../lib/guideHtml.js'
</script>

<template>
  <span class="guide-link">
    <a :href="GUIDE_URL" target="_blank" rel="noopener">查看完整说明</a>
  </span>
</template>
