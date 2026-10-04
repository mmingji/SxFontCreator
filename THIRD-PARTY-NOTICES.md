# 第三方组件与许可

> 用途：登记参与构建或随产物分发的第三方组件、版本与许可，交付时随附。
> 维护约定：新增或移除依赖时同步本文件；依赖版本以 `package.json` 为准。
> 本项目自身代码的建议许可：MIT（见《实施计划》九、许可合规）。

## 运行时依赖（会打进产物）

| 组件 | 许可 | 用途 |
| --- | --- | --- |
| vue、pinia | MIT | 前端框架与状态管理 |
| pdf-lib | MIT | 生成模板与更正册 PDF（页面尺寸与格子坐标完全可控） |
| @pdf-lib/fontkit | MIT | pdf-lib 嵌入自定义字体（含子集化）所必需 |
| fonteditor-core | MIT | 把提取出的手写字形组装成 TTF / woff / woff2（步骤 1.9 起成为运行时依赖，决策 六-6 的预告兑现） |
| esm-potrace-wasm | **GPL-2.0** | 手写掩膜 → 矢量轮廓（步骤 1.9）。选型见《决策记录》六-7：**自用无分发义务**；对外分发软件本体须随附 GPL 许可文本与源码获取方式 —— **闭源商业分发不适用**，那时改用 `imagetracerjs`（Unlicense）或自研轮廓追踪 |

## 随产物分发的字体数据

| 资源 | 许可 | 说明 |
| --- | --- | --- |
| `public/fonts/lxgw-wenkai-subset.ttf` | **OFL-1.1** | 霞鹜文楷 LXGW WenKai v1.522 Regular 的 6919 字子集，仅用于打印在模板上的参考字；许可全文见 `public/fonts/OFL.txt` |
| `public/fonts/OFL.txt` | OFL-1.1 | 上述字体的许可全文，随字体一并分发（OFL 的硬性要求） |
| `public/woff2.wasm` | **MIT**（Google woff2 / woff2-asm） | woff2 编码器（727KB）：`fonteditor-core` 的 `exports` 字段不允许直接 import 包内的 wasm，故复制到这里按 URL 加载（清单 四-20）。**自用无分发义务**，对外分发时随附其许可声明 |

OFL-1.1 的三条实际约束：① 再分发必须随附许可文本；② 不得单独售卖字体本身；③ 不得使用原作者的保留字体名（Reserved Font Name）另起名分发 —— 本项目未改字体名，子集沿用原 name 表信息。

## 随产物分发的数据表

| 资源 | 许可 | 说明 |
| --- | --- | --- |
| `src/data/charRank.js` | **Jun Da 现代汉语单字频率表（仅研究与教学用途）** | 由 `scripts/build-char-rank.mjs` 生成的**频序字表**（字表 6919 字按使用频率排列），用于界面上的"排列方式：按使用频率"（《决策记录》八-11）。数据来源：Jun Da《Modern Chinese Character Frequency List》，综合语料 1.935 亿字符，站上声明**版权归作者、仅研究与教学用途**；**对外分发软件本体或商业使用需另行取得作者书面许可**，自用不受影响。原始数据表缓存在 `.font-sources/`（不入库）。**退路**：对外分发时改用标 MIT 的 `hanziDB.csv`（同为该表派生，需注明上游来源），或向作者申请许可 |
| `src/data/frequency.js` | 见说明 | 频次分级数据：GB2312 分级由区位码本地推算（无外部数据）；《通用规范汉字表》（2013，国务院公布）为国家公布文件，可自由使用 |
| `src/data/charset.js` | 见说明 | 字表（6919 字）取自做字体网 V4.0 的 GBK 字序文件，仅作字序参考；该源文件不入库，入库的只是转换产物 |

## 开发依赖（不进产物）

| 组件 | 许可 | 用途 |
| --- | --- | --- |
| vite、@vitejs/plugin-vue | MIT | 构建与开发服务器 |
| puppeteer-core | Apache-2.0 | 冒烟与端到端验证（调用本机 Edge / Chrome，不下载浏览器） |
| pdfjs-dist | Apache-2.0 | 渲染级验证：把生成的 PDF 渲染成位图做像素断言 |

## 已定选型、待引入（阶段一后续步骤安装，引入时更新版本号）

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| jszip | MIT | 打包下载（字体 + CSS + 使用说明 + 项目包）。下载动作用原生 `Blob` + `a[download]`，**不引 `file-saver`**（决策记录 六-6） |
