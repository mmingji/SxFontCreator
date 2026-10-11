<script setup>
// 步骤内容（向导的一步）：给"功能还没接入"的步骤一个把话说清楚的位置，而不是留空白页让用户猜。
// 2026-10-11 三步流程（决策 八-15）：原「手写与扫描」不再占一步（要点并进第 1 步末尾的说明段），
// 所以这里不再有它的分支；三步的功能都已接入，本组件只在**兜底**时渲染（步骤表将来加新步骤时用得上）。
defineProps({
  // 来自 src/lib/flow.js 的步骤对象：{ key, label, hint, implemented, status, note }
  step: { type: Object, required: true }
})
</script>

<template>
  <div class="step-body">
    <p class="panel-hint">{{ step.hint }}</p>

    <template v-if="!step.implemented">
      <p class="step-note">{{ step.note }}</p>
      <p class="panel-hint">
        这一步的界面会在后续轮次接入（出模板 → 识别 → 生成），现在可以先在第 1 步把模板打出来、按说明写与扫描。
      </p>
    </template>

    <template v-else>
      <p class="panel-hint">这一步的内容已就绪。</p>
    </template>
  </div>
</template>
