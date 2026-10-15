// 识别是否正在进行 —— 跨组件共享的**内存态**（不落盘）。
//
// 为什么要单独一个模块：第 3 步的「生成字体」在**识别进行中必须不可点**（2026-10-15 用户口径：
//   "识别还在进行中，第三步的生成字体按钮应该不可点击才对"）—— 识别结果正在一页页进来，
//   此刻生成字体等于拿半份原料去做字体（而且生成完还得再生成一次）。
// 为什么不用 store 里的字段：store 是**要落盘**的，识别中途刷新会把这个 `true` 一起写进去，
//   刷新后按钮就永久禁用了。放模块级 ref 最简单也最安全：刷新即回到"没在跑"（事实也是如此）。
import { ref } from 'vue'

export const scanRunning = ref(false)

export function setScanRunning(value) {
  scanRunning.value = !!value
}
