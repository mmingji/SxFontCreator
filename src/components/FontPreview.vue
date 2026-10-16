<script setup>
// 第 3 步「网页字体预览」：不装机也能看这套手写体长什么样（决策 四-8）
// 职责：
//   ① 把生成好的字体字节用 FontFace（浏览器字体接口）**动态注册**进当前页面；
//   ② 输入文本 → 实时预览，并把**这套字体没收录的字**标出来 —— 它们在浏览器 / PS 里会回退成系统字体、
//      在 Word 里会显示成方框（清单 三-4 的装机实测结论），不标出来用户会以为预览就是装完的样子；
//   ③ 三档字号（24 / 36 / 56 像素）：小字看字距与整体匀称，大字看笔画细节。
// 字节从哪来（父组件传入）：优先内存里刚生成的产物；刷新过页面后内存里没有 —— 那时**不自动重建**，
//   而是显示「加载预览」按钮，点了才用落盘的掩膜重建（全量约 30 秒，不能让人一进这一步就莫名等）。
// 为什么不用 <style> 里的 @font-face 指向文件：字体是用户现场生成的，没有可指向的 URL，
//   只能把字节直接交给 FontFace（这也是 file:// 下唯一可行的路径 —— 那里的 fetch 会被浏览器拦下）。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  PREVIEW_FALLBACK_STACK,
  PREVIEW_SIZES,
  analyzePreviewText,
  defaultPreviewText,
  pickSampleSentence,
  previewFontFamily,
  registerPreviewFont
} from '../lib/fontPreview.js'

const props = defineProps({
  bytes: { type: Object, default: null }, // 字体字节（Uint8Array）；没有则为 null
  coveredChars: { type: Array, default: () => [] }, // 这套字体收录的字（store.font.coverage.chars）
  familyName: { type: String, default: '' }, // 字体族名，只用于文案
  loading: { type: Boolean, default: false }, // 正在重建字节（父组件在跑）
  loadingText: { type: String, default: '' } // 重建阶段文案 + 进度
})
// request-bytes：预览区要重建字节（父组件跑）；
// fill-template：把"未收录的那几个字"交给父组件去出一张补写模板（2026-10-15 用户口径）
const emit = defineEmits(['request-bytes', 'coverage', 'fill-template'])

const size = ref(PREVIEW_SIZES[1])
const text = ref(defaultPreviewText(props.coveredChars))
const touched = ref(false) // 用户改过文本之后，不再自动重填默认内容
const fontState = ref('idle') // idle 没有字节 / loading 注册中 / ready 可用 / error 失败
const fontNote = ref('')
const registeredFamily = ref('')

const analysis = computed(() => analyzePreviewText(text.value, props.coveredChars))
// 收录情况上报给父组件（2026-10-14 用户口径：那句话显示在「生成结果」标题后）——
// "未收录几个"取决于当前预览文本，只有这里算得出来；文本一变就重报一次
watch(analysis, () => {
  emit('coverage', { total: props.coveredChars.length, missing: analysis.value.missingCount })
}, { immediate: true })
const previewStyle = computed(() => ({
  // 未收录的字靠字体栈自动回退：显式给出系统中文字体，让"回退的字"一眼看得出不是这套手写体
  fontFamily: (fontState.value === 'ready' && registeredFamily.value)
    ? '"' + registeredFamily.value + '", ' + PREVIEW_FALLBACK_STACK
    : PREVIEW_FALLBACK_STACK,
  fontSize: size.value + 'px'
}))

// FontFace 注册：字节一变就重新注册（先注销旧的，避免同名族累积）。
// 竞态：注册是异步的，其间字节可能又变了 —— 用 token 作废在途的那一次，
//   否则后完成的旧注册会顶掉新注册（界面显示的还是上一份字体）。
let handle = null
let token = 0
async function applyFont() {
  const my = ++token
  if (handle) {
    handle.release()
    handle = null
  }
  registeredFamily.value = ''
  if (!props.bytes) {
    fontState.value = 'idle'
    fontNote.value = ''
    return
  }
  fontState.value = 'loading'
  fontNote.value = ''
  try {
    const h = await registerPreviewFont(props.bytes, previewFontFamily(props.familyName, my))
    if (my !== token) {
      h.release()
      return
    }
    handle = h
    registeredFamily.value = h.family
    fontState.value = 'ready'
  } catch (e) {
    if (my !== token) return
    fontState.value = 'error'
    fontNote.value = '预览字体加载失败：' + (e && e.message ? e.message : e)
  }
}
watch(() => props.bytes, applyFont, { immediate: true })

// 收录清单变过（重新生成字体）而用户还没动过文本框时，重填默认内容
watch(() => props.coveredChars, (list) => {
  if (!touched.value) text.value = defaultPreviewText(list)
}, { immediate: true })

onBeforeUnmount(() => {
  token++
  if (handle) {
    handle.release()
    handle = null
  }
})

function fillCovered() {
  touched.value = true
  text.value = defaultPreviewText(props.coveredChars)
}
// 「随机一句话」（2026-10-16 用户口径，原文案「换一句常用话」）：从**单页试打那篇短文**里随机取一句，
// 并避开当前这一句（点一下还是同一句，用户会以为按钮坏了）
function fillSample() {
  touched.value = true
  text.value = pickSampleSentence(text.value)
}
function clearText() {
  touched.value = true
  text.value = ''
}
</script>

<template>
  <div class="font-preview">
    <!-- 标题行（2026-10-15 用户口径）：左边「字体预览」四个字，**后面紧跟生成结论**（"字体已生成：…"），
         最右边由父组件塞进来的动作（查看字形总览 / 查看网页预览 / 下载 zip，最后那个是主按钮）——
         这一块现在**同时承担「生成结果」**（那个独立框已并入这里） -->
    <div class="panel-head">
      <h3>字体预览</h3>
      <slot name="head-note" />
      <span class="panel-head-actions"><slot name="head-actions" /></span>
    </div>

    <div v-if="!bytes" class="panel-actions">
      <button type="button" class="text accent" :disabled="loading" @click="emit('request-bytes')">加载预览</button>
      <span class="panel-hint">
        {{ loading ? loadingText : '内存里没有字体字节（刷新过页面了）：点这里会用已落盘的笔迹掩膜重建一次，全量约 30 秒。' }}
      </span>
    </div>

    <template v-else>
      <textarea
        id="font-preview-text"
        v-model="text"
        class="font-preview-input"
        rows="3"
        placeholder="在这里输入要预览的文字"
        @input="touched = true"
      ></textarea>

      <div class="font-preview-toolbar">
        <span class="font-preview-sizes">
          <button
            v-for="s in PREVIEW_SIZES"
            :key="s"
            type="button"
            :class="{ active: size === s }"
            @click="size = s"
          >{{ s }} 像素</button>
        </span>
        <button type="button" class="text" @click="fillCovered">填入收录的字</button>
        <!-- 「随机一句话」（2026-10-16 用户口径：原文案「换一句常用话」改成这个）——
             随机取的是**单页试打那篇短文里的句子**（`lib/singlePageText.js`），不是另一套陌生句子：
             用户一眼能认出"这些字就是我刚写的那一页上的" -->
        <button type="button" class="text" @click="fillSample">随机一句话</button>
        <button type="button" class="text" @click="clearText">清空</button>
        <!-- 工具条**最右侧**：查看字形总览 / 查看网页预览（2026-10-15 用户口径：从标题行挪到这里，
             与"看预览"这一组操作放在一起；下载 zip 仍留在标题行最右） -->
        <span class="font-preview-toolbar-actions"><slot name="toolbar-actions" /></span>
      </div>

      <div class="font-preview-lines" :style="previewStyle" data-preview="lines">
        <p v-for="(line, li) in analysis.lines" :key="li" class="font-preview-line">
          <span
            v-for="(cell, ci) in line"
            :key="li + '-' + ci"
            class="font-preview-char"
            :class="{ missing: cell.missing }"
          >{{ cell.blank ? ' ' : cell.char }}</span>
        </p>
        <p v-if="!analysis.total" class="panel-hint">上面输入框里还没有文字。</p>
      </div>

      <!-- 2026-10-13 用户口径：原来这里还有一段"收录情况：…"——已挪到标题行（紧跟"字体预览"），
           这里只留"未收录的字"的清单（哪些字没收录才是要看的） -->
      <p v-if="analysis.missing.length" class="font-preview-missing">
        未收录的字：
        <span v-for="ch in analysis.missing" :key="ch" class="font-preview-char missing">{{ ch }}</span>
        <!-- 缺的字**就地**给一条出路（2026-10-15 用户口径）：按这几个字印一张补写模板，
             写完后用第 2 步的「补传扫描件」丢回来即可（与重写模板同一条路径） -->
        <button
          type="button"
          class="text font-preview-fill"
          data-role="fill-template"
          :disabled="loading"
          @click="emit('fill-template', analysis.missing)"
        >生成补写模板</button>
        <br />
        这些字在浏览器与 PS 里会回退成系统字体，在 Word 里可能显示成方框 —— 想要完整可用，
        可以点「生成补写模板」把缺的这几个字补写进来（也可以补写进下一批）。
      </p>
      <p v-if="fontNote" class="panel-message error">{{ fontNote }}</p>
      <p v-else-if="fontState === 'loading'" class="panel-hint">正在把这套字体注册进页面…</p>
    </template>
  </div>
</template>
