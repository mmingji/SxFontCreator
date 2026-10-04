# SxFontCreator 手写字体制作器

打印模板 → 照着格子手写 → 扫描回传 → 全自动切格提取手写字形 → 生成个人手写体字体（TTF / woff / woff2）。
纯前端、零后端、离线可用；**数据只保存在本机浏览器里**。

当前进度：阶段一步骤 1.1~1.5 已完成（工程脚手架、6919 字表、模板与更正册 PDF、选字与批次、扫描件预处理、**自动切格**），并已加入**模板排列方式**（默认按使用频率：最常用的字排在最前，约 15 页即可日常使用）—— 界面上可以直接生成并下载模板 PDF / 更正册；扫描件的切格、页序号与批次校验码比对也已跑通（真实手写样本上验证）。

## 开发命令

```
npm install            # 若报 npm 缓存目录权限错误（EPERM），改用：npm install --cache .npm-cache
npm run dev            # 开发服务，浏览器访问 http://localhost:5173
npm run build          # 构建到 dist/
npm run charset        # 重新生成字表（读做字体网 V4.0 的 GBK 字序文件，源文件不入库）
npm run frequency      # 重新生成频次分级数据（GB2312 本地推算 + 通用规范汉字表，源字表不入库）
npm run charrank       # 重新生成频序数据（Jun Da 字频表，源文件是 GBK、缓存于 .font-sources/ 不入库）
npm run font-subset    # 重新生成参考字字体子集（读 .font-sources/ 下的霞鹜文楷，源字体不入库）
npm test               # 全套：字表 + 频次 + 频序 + 选字 + 图像算子 + 扫描预处理 + 切格 + 模板 + 渲染 + 构建 + 冒烟
npm run test:charset   # 只跑字表校验
npm run test:template  # 只跑模板 PDF 校验（版面几何 + 产物读回）
npm run test:render    # 只跑渲染验证（把 PDF 渲染成图做像素断言，并输出图）
npm run test:grid      # 只跑自动切格验证（合成件 + 真实样本夹具，夹具缺失时 SKIP）
npm run test:smoke     # 只跑冒烟验证（需先 build）
```

## 目录结构

| 目录 | 内容 |
| --- | --- |
| `src/lib/` | 图像处理、字体、版面与本地存储相关模块（复用参考项目的部分在文件头注明来源与改动） |
| `src/components/` | 界面组件（`TemplatePreview.vue` 为模板生成面板） |
| `src/store/` | 项目状态（Pinia），也是「导出项目包」的数据结构来源 |
| `src/data/` | 生成的数据：`charset.js`（6919 字表）、`frequency.js`（频次分级）、`charRank.js`（使用频率排序），均由脚本生成、请勿手改 |
| `public/fonts/` | 内置参考字字体子集（3.27MB，只含字表 6919 字）与它的 OFL 许可文本 |
| `scripts/` | 构建期脚本（字表转换、频次分级、频序、参考字字体子集化） |
| `test/` | 分层验证脚本：每轮跑相关脚本、提交前跑全套 |
| `docs/` | 需求、实施计划、决策记录、待办清单、提交历史、样例图 |

## 第三方组件

见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)：内置参考字为霞鹜文楷（OFL-1.1，许可全文在 `public/fonts/OFL.txt`）。

## 文档

- [需求与技术方案](docs/手写字体制作软件-需求与技术方案.md)
- [实施计划](docs/实施计划.md)
- [决策记录](docs/决策记录.md)（本项目专属）
- [待办与风险清单](docs/待办与风险清单.md)
- [提交历史](docs/提交历史.md)

跨项目通用的《决策记录-通用.md》与 `AGENTS.md` 属本地协作文档，**不入库**（见 `.gitignore`）。

文档之间如有冲突，一律以《决策记录》为准。
