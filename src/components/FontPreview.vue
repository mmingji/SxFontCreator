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
  SAMPLE_SENTENCE,
  analyzePreviewText,
  defaultPreviewText,
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
const emit = defineEmits(['request-bytes'])

const size = ref(PREVIEW_SIZES[1])
const text = ref(defaultPreviewText(props.coveredChars))
const touched = ref(false) // 用户改过文本之后，不再自动重填默认内容
const fontState = ref('idle') // idle 没有字节 / loading 注册中 / ready 可用 / error 失败
const fontNote = ref('')
const registeredFamily = ref('')

const analysis = computed(() => analyzePreviewText(text.value, props.coveredChars))
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
function fillSample() {
  touched.value = true
  text.value = SAMPLE_SENTENCE
}
function clearText() {
  touched.value = true
  text.value = ''
}
</script>

<template>
  <div class="font-preview">
    <p class="panel-hint">
      下面这块用的是<strong>刚生成的字体字节</strong>，直接注册在网页里 —— <strong>不用先装到系统</strong>就能看效果。
      预览里未收录的字会回退成系统字体；装进 Word 后，这些字可能显示成方框。
    </p>

    <div v-if="!bytes" class="panel-actions">
      <button type="button" class="primary" :disabled="loading" @click="emit('request-bytes')">加载预览</button>
      <span class="panel-hint">
        {{ loading ? loadingText : '内存里没有字体字节（刷新过页面了）：点这里会用已落盘的笔迹掩膜重建一次，全量约 30 秒。' }}
      </span>
    </div>

    <template v-else>
      <label class="field-label" for="font-preview-text">预览文本（输入什么就实时显示什么）</label>
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
        <button type="button" class="text" @click="fillSample">换一句常用话</button>
        <button type="button" class="text" @click="clearText">清空</button>
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

      <p class="panel-hint">
        收录情况：这套字体共收录 <strong>{{ coveredChars.length }}</strong> 个字；
        上面这段文字里命中 <strong>{{ analysis.coveredCount }}</strong> 个、未收录 <strong>{{ analysis.missingCount }}</strong> 个{{ analysis.missing.length ? '（去重后 ' + analysis.missing.length + ' 个）' : '' }}。
      </p>
      <p v-if="analysis.missing.length" class="font-preview-missing">
        未收录的字：
        <span v-for="ch in analysis.missing" :key="ch" class="font-preview-char missing">{{ ch }}</span>
        <br />
        这些字在浏览器与 PS 里会回退成系统字体，在 Word 里可能显示成方框 —— 想要完整可用，建议把这些字补写进下一批。
      </p>
      <p v-if="fontNote" class="panel-message error">{{ fontNote }}</p>
      <p v-else-if="fontState === 'loading'" class="panel-hint">正在把这套字体注册进页面…</p>
    </template>
  </div>
</template>
