<script setup>
// 加载动画（同时也是"本产品在做什么"的演示）：四角定位块出现 → 按已知网格切格 → 扫描线逐格识别。
// 现状：**当前没有引用方** —— 界面上的「动画预览」入口已按用户要求随底部状态栏一起去掉。
//   保留它是因为它已经为下一步接好线：
//   ① 将来长任务（切格 / 红圈识别 / 矢量化）的进度提示：传 progress（0~100）时扫描线按进度推进，
//      不再循环演示（清单三-5、三-6 要实测这些耗时，进度提示的粒度由它决定）；
//   ② 若日后想要回"动画预览"，加一行 <BootAnimation /> 即可。
// **两份实现要保持一致**：真正首屏加载时用的是 index.html 里内联的 #boot（必须内联 ——
//   它要在 JS 下载执行之前就显示，否则用户看到的还是白屏）；本组件是 Vue 版。
//   改这里的视觉时记得同步 index.html 的 #boot（网格为四条横线 + 五条竖线，闭合的 3 行 × 4 列）。
// **样式是组件内联的**（本文件底部的 <style>）：`style.css` 里没有 .boot-anim* 规则，
//   这是有意的 —— 它不参与主样式表，也不会因为主样式表清理而被误删；
//   文件名 `boot-anim` / `boot-mark` 与 index.html 的那份**同名同形**，便于对照同步。
const props = defineProps({
  progress: { type: Number, default: null } // null = 循环演示；0~100 = 按进度推进
})
</script>

<template>
  <div class="boot-anim-wrap">
    <svg class="boot-anim" viewBox="0 0 120 80" fill="none" aria-hidden="true">
      <!-- 四角定位块：与真实模板同色 #2E6E7E（中深青） -->
      <rect class="boot-mark" x="1" y="1" width="7" height="7" style="animation-delay: 0s" />
      <rect class="boot-mark" x="112" y="1" width="7" height="7" style="animation-delay: 0.12s" />
      <rect class="boot-mark" x="1" y="72" width="7" height="7" style="animation-delay: 0.24s" />
      <rect class="boot-mark" x="112" y="72" width="7" height="7" style="animation-delay: 0.36s" />
      <!-- 按已知网格切格：**四条横线 + 五条竖线**，围成闭合的 3 行 × 4 列网格
           （横线 14 / 31.3 / 48.7 / 66 等距，与竖线上下端对齐；只画 3 条横线会导致底部不封口）。
           每条带 pathLength="100"：把 96 长的横线与 52 长的竖线归一化到同一尺度，
           否则固定的 dasharray 会让线端残留、横竖线进度不一致（详见 style 里的说明） -->
      <g class="boot-grid">
        <line x1="12" y1="14" x2="108" y2="14" pathLength="100" style="animation-delay: 0s" />
        <line x1="12" y1="31.3" x2="108" y2="31.3" pathLength="100" style="animation-delay: 0.12s" />
        <line x1="12" y1="48.7" x2="108" y2="48.7" pathLength="100" style="animation-delay: 0.24s" />
        <line x1="12" y1="66" x2="108" y2="66" pathLength="100" style="animation-delay: 0.36s" />
        <line x1="12" y1="14" x2="12" y2="66" pathLength="100" style="animation-delay: 0.06s" />
        <line x1="36" y1="14" x2="36" y2="66" pathLength="100" style="animation-delay: 0.18s" />
        <line x1="60" y1="14" x2="60" y2="66" pathLength="100" style="animation-delay: 0.3s" />
        <line x1="84" y1="14" x2="84" y2="66" pathLength="100" style="animation-delay: 0.42s" />
        <line x1="108" y1="14" x2="108" y2="66" pathLength="100" style="animation-delay: 0.54s" />
      </g>
      <!-- 扫描线：逐格识别。传 progress 时按进度定位（0=顶部，100=底部） -->
      <line
        class="boot-scan"
        :class="{ steady: props.progress !== null }"
        x1="12"
        :y1="props.progress === null ? 14 : 14 + 52 * Math.min(100, Math.max(0, props.progress)) / 100"
        x2="108"
        :y2="props.progress === null ? 14 : 14 + 52 * Math.min(100, Math.max(0, props.progress)) / 100"
      />
    </svg>
  </div>
</template>

<style scoped>
.boot-anim {
  width: 240px;
  height: 160px;
}

/* 网格线：按虚线偏移"画"出来，再保持。
   每条线带 pathLength="100"，所以这里的 dasharray / dashoffset 都用 100 这个归一化尺度 ——
   若写死成实际线长（横线 96、竖线 52 各不相同），会出现：保持期横线右端缺一截、
   动画首尾两端残留小段、横竖线进度不一致导致缩回时碎成短段（已逐帧核查确认）。 */
.boot-grid line {
  stroke: #c9cfdb;
  stroke-width: 0.8;
  stroke-dasharray: 100;
  stroke-dashoffset: 100;
  animation: comp-draw 3.6s ease-in-out infinite;
}

.boot-mark {
  fill: #2e6e7e;
  opacity: 0;
  animation: comp-mark 3.6s ease-in-out infinite;
}

.boot-scan {
  stroke: var(--primary);
  stroke-width: 1.4;
  opacity: 0;
  animation: comp-scan 3.6s ease-in-out infinite;
}

/* 进度模式：扫描线常亮、不做位移动画（位置由 progress 决定） */
.boot-scan.steady {
  opacity: 1;
  animation: none;
}

@keyframes comp-mark {
  0%, 8% { opacity: 0; }
  18%, 88% { opacity: 1; }
  96%, 100% { opacity: 0; }
}

@keyframes comp-draw {
  0%, 12% { stroke-dashoffset: 100; }
  38%, 88% { stroke-dashoffset: 0; }
  96%, 100% { stroke-dashoffset: 100; }
}

/* 扫描线位移 52 = 网格高度（y 从 14 到 66）；与 index.html 的 boot-scan 保持一致 */
@keyframes comp-scan {
  0%, 34% { opacity: 0; transform: translateY(0); }
  40% { opacity: 1; }
  78% { opacity: 1; transform: translateY(52px); }
  84%, 100% { opacity: 0; transform: translateY(52px); }
}

@media (prefers-reduced-motion: reduce) {
  .boot-mark, .boot-grid line, .boot-scan {
    animation-duration: 0.01s;
    animation-iteration-count: 1;
  }
}
</style>
