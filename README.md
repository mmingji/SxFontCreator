# SxFontCreator 手写字体制作器

打印模板 → 照着格子手写 → 扫描回传 → 全自动切格提取手写字形 → 生成个人手写体字体（TTF / woff / woff2）。
纯前端、零后端、离线可用；**数据只保存在本机浏览器里**。

当前进度：阶段一步骤 1.1（工程脚手架）、1.2（6919 字表）、1.3（模板与更正册 PDF）已完成 —— 界面上可以直接生成并下载模板 PDF 与更正册。

## 开发命令

```
npm install            # 若报 npm 缓存目录权限错误（EPERM），改用：npm install --cache .npm-cache
npm run dev            # 开发服务，浏览器访问 http://localhost:5173
npm run build          # 构建到 dist/
npm run charset        # 重新生成字表（读做字体网 V4.0 的 GBK 字序文件，源文件不入库）
npm run font-subset    # 重新生成参考字字体子集（读 .font-sources/ 下的霞鹜文楷，源字体不入库）
npm test               # 全套：字表 + 模板 PDF + 渲染验证 + 构建 + 冒烟
npm run test:charset   # 只跑字表校验
npm run test:template  # 只跑模板 PDF 校验（版面几何 + 产物读回）
npm run test:render    # 只跑渲染验证（把 PDF 渲染成图做像素断言，并输出图）
npm run test:smoke     # 只跑冒烟验证（需先 build）
```

## 目录结构

| 目录 | 内容 |
| --- | --- |
| `src/lib/` | 图像处理、字体、版面与本地存储相关模块（复用参考项目的部分在文件头注明来源与改动） |
| `src/components/` | 界面组件（`TemplatePreview.vue` 为模板生成面板） |
| `src/store/` | 项目状态（Pinia），也是「导出项目包」的数据结构来源 |
| `src/data/` | 生成的字表数据（`charset.js`，由脚本生成、请勿手改） |
| `public/fonts/` | 内置参考字字体子集（3.27MB，只含字表 6919 字）与它的 OFL 许可文本 |
| `scripts/` | 构建期脚本（字表转换、字体子集化） |
| `test/` | 分层验证脚本：每轮跑相关脚本、提交前跑全套 |
| `docs/` | 需求、实施计划、决策记录、待办清单、提交历史、样例图 |

## 第三方组件

见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)：内置参考字为霞鹜文楷（OFL-1.1，许可全文在 `public/fonts/OFL.txt`）。

## 文档

- [需求与技术方案](docs/手写字体制作软件-需求与技术方案.md)
- [实施计划](docs/实施计划.md)
- [决策记录](docs/决策记录.md)（本项目）｜[决策记录-通用](docs/决策记录-通用.md)
- [待办与风险清单](docs/待办与风险清单.md)
- [提交历史](docs/提交历史.md)

文档之间如有冲突，一律以《决策记录》为准。
