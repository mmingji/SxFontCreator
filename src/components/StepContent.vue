<script setup>
// 步骤内容（向导的一步）：给"功能还没接入"的步骤一个把话说清楚的位置，而不是留空白页让用户猜。
// 为什么放在单独组件里：App.vue 只负责"向导骨架 + 步骤切换"，每一步的内容各自成文件，接入一步换一个文件即可。
// 功能接入顺序（见《待办与风险清单》与提交历史）：手写与扫描（本步即说明，无需代码）→ 上传识别 → 更正核对 →
//   生成字体 → 下载安装。
defineProps({
  // 来自 src/lib/flow.js 的步骤对象：{ key, label, hint, implemented, status, note }
  step: { type: Object, required: true }
})
</script>

<template>
  <div class="step-body">
    <p class="panel-hint">{{ step.hint }}</p>

    <!-- 手写与扫描：这一步不需要软件操作，关键是照着第 1 步打印出来的纸写、再按 300dpi 彩色扫描 -->
    <template v-if="step.key === 'write'">
      <ol class="plain-list">
        <li>用第 1 步生成的模板打印（<strong>实际大小 / 100%</strong>、不勾「无边距」），先量最后一页自检页的 1cm 方框确认尺寸。</li>
        <li>用 0.5mm 黑色中性笔写字，<strong>居中写满格子、笔画贴到格子边但不要写出格</strong>，不描不改、一笔写成。</li>
        <li>写错的字用<strong>红笔圈掉</strong>（圈画在参考字或格子上都行），需要重写的字写到更正册上：按被圈字的顺序从第 1 格起，一格一个字。</li>
        <li>全部写完后按 <strong>300dpi、彩色、照片模式</strong>扫描；一页一个文件，文件名随意（页序由页脚编码自动识别）。</li>
        <li>纸面别翘边、折叠或受潮 —— 非平面变形任何透视校正都救不回来。</li>
      </ol>
      <p class="panel-hint">
        写完之后，回到第 1 步下方的说明再核对一次扫描设置（色彩模式、锐化、去网纹那些开关），再进入下一步上传。
      </p>
    </template>

    <template v-else-if="!step.implemented">
      <p class="step-note">{{ step.note }}</p>
      <p class="panel-hint">
        这一步的界面会在后续轮次接入本会话的同一套流程里（上传 → 预处理 → 切格 → 提取 → 红圈识别 → 更正核对 → 字体合成 → 下载 zip）。
        现在可以先在第 1 步把模板打出来、按上面的要求写与扫描。
      </p>
    </template>

    <template v-else>
      <p class="panel-hint">这一步的内容已就绪。</p>
    </template>
  </div>
</template>
