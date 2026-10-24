# SxFontCreator 手写字体制作器

中文 ｜ [English](README.en.md)

[![License: GPL-2.0](https://img.shields.io/badge/License-GPL--2.0-blue.svg)](LICENSE)
[![Vue 3](https://img.shields.io/badge/Vue-3-42b883.svg)](https://vuejs.org/)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF.svg)](https://vitejs.dev/)
[![Offline](https://img.shields.io/badge/offline-file%3A%2F%2F-success.svg)](https://github.com/mmingji/SxFontCreator)
[![Version](https://img.shields.io/badge/version-0.1.0-informational.svg)](package.json)

> 仓库：https://github.com/mmingji/SxFontCreator ｜ 许可：GPL-2.0（见 [LICENSE](LICENSE)）

**手写体 / 手写字体制作器 HandWrite FontCreator**：自定义模板 / 可全量可随便一段话 → 纸笔手写 / 支持多轮更正 → 扫描识别 / 参数可调 → 自动切格提取字形并生成个人手写体字体（TTF / woff2）。无需网络、无需任何配置、开箱即用。

纯前端、零后端、离线可用；**数据只保存在本机浏览器里** —— 清理浏览器数据、换电脑或换浏览器都会没有，那时把扫描件文件夹重指一次、重跑一遍识别即可（识别是确定性的）；**扫描件原图程序不留，请自己留一份**。

本文件只做**入口索引**：怎么跑、目录在哪。开发文档（决策记录、实施计划、提交历史等）不随仓库提供。

> **给用户看的那份完整说明是《使用说明》**（单一内容源 `src/lib/guide.js` → `npm run guide` → `public/使用说明.html`，随后进程序包与模板压缩包）—— 它讲"这是什么、三步怎么用、数据在哪、参考与借鉴了哪些、第三方许可是什么"。

## 界面

| 第 1 步 选模板 | 第 2 步 识别与看格子 | 第 3 步 生成与预览 |
| --- | --- | --- |
| ![第 1 步：选模板](screenshots/step-1-template.jpg) | ![第 2 步：识别与看格子](screenshots/step-2-recognize-cell-zoom.jpg) | ![第 3 步：生成与预览](screenshots/step-3-generate-preview.jpg) |

## 怎么跑起来

完整命令见 `package.json`，下面是常用的几条：

```
npm install          # 若报 npm 缓存目录权限错误（EPERM），改用：npm install --cache .npm-cache
npm run dev          # 开发服务：http://localhost:5173（跑 dev 时不要把 TEMP 设到项目内）
npm run build        # 构建到 dist/；产物**双击 dist/index.html 即用**（file:// 形态，不需要本地服务）
npm run pack         # 构建并打出可分发的 zip（release/SxFontCreator-<版本>-便携版.zip）
npm run guide        # 重新生成《使用说明》单文件页（public/使用说明.html）
```

构建前把 `TEMP` 设到一个可写目录（本机 `%TEMP%` 删除受限时会中断构建）、**跑 dev 时不要设**。

## 目录速查

| 目录 | 内容 |
| --- | --- |
| `src/lib/` | 图像处理、字体、版面、识别与本地存储等模块（每个文件头写职责与数据来源） |
| `src/workers/` | 识别链路的 Web Worker（预处理 / 切格 / 认参考字 / 提取跑在后台线程；客户端封装在 `lib/scanWorkerClient.js`） |
| `src/components/` | 界面组件：向导骨架 `App.vue` + 三个步骤组件（选模板 / 识别 / 生成）+ 各步的下级面板与弹窗 |
| `src/store/` | 项目状态（Pinia）；`projectData()` 是落盘的**唯一字段清单** |
| `src/data/` | 脚本生成的数据（字表、频序），**请勿手改** |
| `public/` | 内置字体子集与许可文本、《使用说明》单文件页、woff2 的 wasm |
| `scripts/` | 构建期脚本（字表 / 频序 / 字体子集 / 分发打包）与只读体检工具 |
| `screenshots/` | README 里的三张界面截图 |

## 第三方组件

见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)：内置字体为霞鹜文楷（模板上的参考字，OFL-1.1，许可全文 `public/fonts/OFL.txt`）与悠哉字体 Yozai（「书写示意」的示范字，OFL-1.1，许可全文 `public/fonts/OFL-yozai.txt`）。

## 许可

本项目代码以 **GNU General Public License v2.0** 发布（全文见 [LICENSE](LICENSE)；随程序分发的同一份全文在 `public/LICENSE-GPL-2.0.txt`，会进 `dist/` 与便携版 zip）。

- 第三方组件与数据的许可逐项列在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。其中 `esm-potrace-wasm`（potrace 的 WASM 封装）是 **GPL-2.0**：本仓库公开源码即满足其源码获取要求；对外分发构建产物（`dist/` 或便携版 zip）时随附 GPL 全文与源码地址即可。
- 生成的手写字体（TTF / woff / woff2）是你自己笔迹的产物，**不受本项目 GPL 约束**，可以自由使用与分发。
- `src/data/charRank.js` 的频序数据来自 Jun Da 的 *Modern Chinese Character Frequency List*，**仅用于研究与教学用途、非商业**；商业使用需取得作者书面许可（替代方案见 THIRD-PARTY-NOTICES.md）。
- 只在自己机器上使用、或把生成的字体发给别人，都不触发 GPL 的分发义务。
