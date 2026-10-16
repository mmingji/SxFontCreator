// 「单页试打」那一页写什么（零依赖纯数据）
//
// 由来（2026-10-16 用户口径：**提高观感**）：原来试打页排的是"频序前 136 字"—— 一页互不相干的常用字，
//   写起来像抄字帖、也没有成品感。改成**一篇短文**：写一遍既能确认版式与打印设置，又像写了一页作品；
//   而且这些字会直接进字体，试打出来的字体立刻能打出一句完整的话。
// 选文标准（三条，缺一不可）：
//   ① **每个字与标点都在字表 8274 内**（硬约束：印在 PDF 上的字符必须在表内，否则印成方块，决策 一-4 (a)）；
//   ② **一页放得下**（≤ 136 格 —— 超一页就与"单页试打"这个名字不符了）；
//   ③ **尽量用常用字**（落在频序前面，试打出的字形更"能用"）且**读起来有味道**（这是本次改动的出发点）。
// 现选：《岳阳楼记》名句段（范仲淹）68 字符 = 汉字 58 + 标点 10，一页；汉字 **83% 落在频序前 1000**、
//   且**没有一个字频序在 2000 之后**（同一批候选里数据最好的那一档，见《提交历史》第 140 条）。
// 与「字体预览」的关系：第 3 步「换一句常用话」随机的就是**这一段里的句子**（同一个出处，改一处两处都变）。
// 不强制铺满 136 格（用户明确）：少于 136 字时后面的格子留空即可，模板本来就允许末页不满。

/** 单页试打的正文（含标点，68 字符） */
export const SINGLE_PAGE_TEXT =
  '不以物喜，不以己悲。居庙堂之高则忧其民，处江湖之远则忧其君。是进亦忧，退亦忧。然则何时而乐耶？其必曰：先天下之忧而忧，后天下之乐而乐乎！'

/** 这段文字的出处（只用于注释与文档，**不上界面** —— 界面里不出现书名章节这类描述，通用约定） */
export const SINGLE_PAGE_SOURCE = '《岳阳楼记》名句段（范仲淹）'

/**
 * 按**句末标点**切句（。？！保留在句尾）：给第 3 步「换一句常用话」当句库用。
 * 为什么按句末切而不是按逗号切：逗号切出来是半句（"不以物喜"），读着别扭；按句末切每一句都完整。
 */
export function splitSentences(text = SINGLE_PAGE_TEXT) {
  const out = []
  let buf = ''
  for (const ch of String(text)) {
    buf += ch
    if (ch === '。' || ch === '？' || ch === '！') {
      out.push(buf)
      buf = ''
    }
  }
  if (buf) out.push(buf)
  return out
}

/** 这段文字里的句子（模块级算一次；5 句） */
export const SINGLE_PAGE_SENTENCES = splitSentences(SINGLE_PAGE_TEXT)

/**
 * 随机取一句（「换一句常用话」用）。
 * 传入上一句时**避开它**（点一下还是同一句，用户会以为按钮坏了）；只有一句时原样返回。
 * @param {string} [current] 当前这一句
 * @returns {string}
 */
export function pickSinglePageSentence(current) {
  const list = SINGLE_PAGE_SENTENCES
  if (list.length <= 1) return list[0] || ''
  const rest = list.filter((s) => s !== current)
  return rest[Math.floor(Math.random() * rest.length)]
}

/** 这段文字的字符数（按**码点**算：字表里有扩展 B 区汉字，用 .length 会多算） */
export function singlePageCharCount() {
  return Array.from(SINGLE_PAGE_TEXT).length
}
