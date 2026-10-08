# SxFontCreator 手写字体制作器

打印模板 → 照着格子手写 → 扫描回传 → 全自动切格提取手写字形 → 生成个人手写体字体（TTF / woff / woff2）。
纯前端、零后端、离线可用；**数据只保存在本机浏览器里**。

## 当前进度

**阶段一最小闭环已全部打通（2026-10-05）**：步骤 1.1~1.10 与界面串联 B1 / B2 / B3 全部完成 —— **字表 8274 字（《通用规范汉字表》8105 + 基础字符 169，2026-10-08 换官方口径）**、模板与更正册 PDF、扫描件预处理、**自动切格**、**字形提取**、**红圈识别**、**更正对应**、**矢量化与字体合成**、**打包下载**；六步向导每一步都已落地（① 选字与出模板 ② 手写与扫描 ③ 上传识别 ④ 更正核对 ⑤ 生成字体 ⑥ 下载安装），步骤条上不再有"待接入"标记。全链路已在真实手写样本上跑通（三份手写件 + 一份更正册共 79 个字形，样张 `docs/samples/font-montage.png` 与测试字体 `docs/samples/SxFontCreator-sample.ttf`）；生成的字体已按 Windows 认中文字体的要求补齐 OS/2 字段并**装机复测通过**（Word 里中文正常应用手写体，《决策记录》四-5）。

模板默认**按使用频率**排列（最常用的字在最前，约 15 页即可日常使用，八-11），第 1 步的选字是「单页试打 / **常用 6500 字**（一级 3500 + 二级 3000 + 基础字符 169 = 6669 字，约 50 页）/ 自定义选字（想要全量 8274 字 ≈ 61 页就打「**全选全部**」）」三选一，字网格与模板的排序两处联动、统一叫「按使用频率 / **笔画序**」，并可一键「全选本页」；第 1 步能同时看到**模板第一页的真实预览**与**书写示意**（后者只看不打印，一-14），「写哪些字」旁边的问号里是《通用规范汉字表》官方说明全文十条与来源声明。《使用说明》已整合成**单文件** `public/使用说明.html`（六节，可离线看，`npm run guide` 生成，一-15）；界面文案与信息密度收敛过两轮，底部常驻信息已整体移除。

**已落地的阶段三功能**：3.2 字形体检 + 2.4 单字剔除（第 5 步三栏清单，只提示、不改字形，四-9）、2.4 单页重传（第 3 步页级结果逐行「重传这一页」，原地覆盖，八-14）、3.3 交付形态定案为 **`file://` 版**（`npm run build` 后**双击 `dist/index.html` 即用**；`npm run pack` 出可分发的 zip，16.7MB → 8.5MB，六-4；`file://` 下的能力实测见清单 **三-8**）、3.4 浏览器兼容（Chrome / Edge **90 以上**，六-10）、3.5 项目包导出 / 导入（顶栏「项目备份」，五-6；只支持一套字体、切换前必须导出见 五-1 / **五-2**，提醒节点见 **五-3**）、3.6 字形总览图导出（一行 25 字，全量 8274 字 → 331 行 **740 × 10764**，四-10）、3.7 批次管理（第 3 步批次选择旁，可作废、只删已作废的，八-13）。第 6 步另有**网页字体预览**（`FontFace` 当场注册，不装机也能看，四-8）。

**已知待改进**：同等字号下手写体观感比系统字体偏小 —— 已按《待办与风险清单》一-5 把书写格映射上限 **900 → 1000**（字面率 100%）、越界判据改为"书写格映射出来的设计框"，纸面与界面文案定为"**居中书写,别出格**"（一-13），同一批笔迹的字面高度中位 **0.734em → 0.815em**（宋体 0.910em）；**逐字按字面框规整已于 2026-10-07 放弃**（任何"统一字面大小"的做法都要缩放轮廓、必然改动手写笔画的粗细，四-7），这一档改由 3.2 的**字形体检告警**处理（越界 / 偏小 / 笔画过细，只提示、不改字形）。

## 开发命令

```
npm install            # 若报 npm 缓存目录权限错误（EPERM），改用：npm install --cache .npm-cache
npm run dev            # 开发服务，浏览器访问 http://localhost:5173
npm run build          # 构建到 dist/（IIFE 单包 + 按需内联；双击 dist/index.html 即用）
npm run pack           # 构建后打成可分发的 zip（release/SxFontCreator-<版本>-便携版.zip）
npm run charset        # 重新生成字表（源：《通用规范汉字表》官方字表，已入库 scripts/sources/）
npm run charrank       # 重新生成频序数据（源：Jun Da 字频表，缓存在 .font-sources/，不入库）
npm run font-subset    # 重新生成参考字字体子集（源：霞鹜文楷，不入库；产物含 8274 个码位）
npm run handwriting-subset # 重新生成「书写示意」用的手写体子集（源：悠哉字体，不入库）
npm run guide          # 重新生成《使用说明》单文件页（src/lib/guide.js → public/使用说明.html）
npm run inspect:os2    # 字体 OS/2 表体检（量"Word 认不认它当中文字体"，可传系统字体做对照）
npm test               # 全套：下面各脚本依次跑，末尾接 构建 → 分发 zip → file:// 形态实测 → 冒烟（默认以 file:// 打开）
npm run test:charset   # 字表校验
npm run test:flow      # 制作流程的状态推导（向导界面的判断来源）
npm run test:guide     # 《使用说明》校验（内容源结构 + 产物是单文件、六节齐全）
npm run test:browser   # 浏览器兼容（九项能力检测 + polyfill 行为 + 源码/产物静态扫描，纯 Node）
npm run test:template  # 模板 PDF 校验（版面几何 + 产物读回）
npm run test:render    # 渲染验证（把 PDF 渲染成图做像素断言，并输出图）
npm run test:grid      # 自动切格验证（合成件 + 真实样本夹具，夹具缺失时 SKIP）
npm run test:extract   # 字形提取验证（分离参考字与手写笔迹，夹具缺失时 SKIP）
npm run test:marks     # 红圈识别验证（真实红圈件 + 合成件，夹具缺失时 SKIP）
npm run test:scanflow  # 上传识别的编排与收批闸门（纯逻辑 + 真件夹具整条跑）
npm run test:glyphstore # 字形落盘（掩膜 ⇄ PNG 往返无损 + 分片存储，需浏览器）
npm run test:correction # 更正对应验证（纯逻辑 + 真件端到端）
npm run test:fontbuild # 矢量化 + 字体构建（先用 vite 打测试专用 bundle；含"从落盘掩膜构建"）
npm run test:fontpack # 字体打包（zip 内容 / 使用说明 / 预览页，纯 Node）
npm run test:fontpreview # 网页字体预览的纯逻辑（文本拆分 / 收录判定 / 默认文本，纯 Node）
npm run test:projectpack # 项目包导出 / 导入（包结构 / 校验分支 / 往返保真，纯 Node）
npm run test:checkup   # 字形体检（合成掩膜逐条钉住六条阈值 + 几何与构建同源，纯 Node）
npm run test:overview  # 字形总览图（排布计算 / 缩放 / 边界 / 图上文字口径，纯 Node）
npm run test:smoke     # 冒烟验证（需先 build）
npm run test:file      # file:// 形态实测（需先 build；能力探针 + 内联资源按需载入 + 预览渲染）
npm run test:pack      # 分发 zip 校验（需先 build；包内容与 dist 一一对应 / 逐字节一致，纯 Node）
```

## 目录结构

| 目录 | 内容 |
| --- | --- |
| `src/lib/` | 图像处理、字体、版面与本地存储相关模块（复用参考项目的部分在文件头注明来源与改动） |
| `src/components/` | 界面组件：`App.vue`（向导骨架）+ 六个步骤 `TemplatePreview` / `StepContent` / `ScanUpload` / `CorrectionConfirm` / `BuildFont` / `ResultDownload`；另有 `SelectionPanel`（选字）、`PdfPreview`（模板预览）、`BatchManager`（批次管理）、`FontPreview`（网页预览）、`ProjectBackup`（项目备份）、`GuideLink`（说明入口） |
| `src/store/` | 项目状态（Pinia），也是「导出项目包」的数据结构来源（`projectData()` 是落盘的**唯一字段清单**，正常落盘、关页兜底与导出共用） |
| `src/data/` | 生成的数据：`charset.js`（8274 字表 = 官方 8105 + 基础字符 169）、`charRank.js`（使用频率排序），均由脚本生成、请勿手改（选字分级不落数据文件：`src/lib/frequency.js` 按字表位置切片推得规范三级 + 基础字符） |
| `public/fonts/` | 内置字体子集与许可文本：参考字用的霞鹜文楷子集（4.01MB）、「书写示意」用的悠哉字体子集（4.73MB，OFL-1.1），都只含字表 8274 个码位；**产物里这两个 ttf 不再复制**（已内联进 `assets/inline-font-*.js` 按需加载），只有许可文本随产物分发 |
| `scripts/` | 构建期脚本（字表转换、频次分级、频序、字体子集化、`pack-dist.mjs` 分发打包）与只读体检工具 `inspect-font-os2.mjs` |
| `test/` | 分层验证脚本：每轮跑相关脚本、提交前跑全套 |
| `docs/` | 需求、实施计划、决策记录、待办清单、提交历史、样例图 |

## 第三方组件

见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)：内置字体为霞鹜文楷（模板上的参考字，OFL-1.1，许可全文 `public/fonts/OFL.txt`）与悠哉字体 Yozai（「书写示意」的示范字，OFL-1.1，许可全文 `public/fonts/OFL-yozai.txt`）。

## 文档

- [需求与技术方案](docs/手写字体制作软件-需求与技术方案.md)
- [实施计划](docs/实施计划.md)
- [决策记录](docs/决策记录.md)（本项目专属）
- [待办与风险清单](docs/待办与风险清单.md)
- [验收走查清单](docs/验收走查清单.md)（用户侧人工验收：每一步怎么做、期望看到什么、容易踩的坑）
- [提交历史](docs/提交历史.md)

跨项目通用的《决策记录-通用.md》与 `AGENTS.md` 属本地协作文档，**不入库**（见 `.gitignore`）。

文档之间如有冲突，一律以《决策记录》为准。
