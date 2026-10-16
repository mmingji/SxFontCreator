// 第 1 步的下载产物：模板压缩包（决策 一-17）
// 职责：把"这一次要打印的四件东西"打成一个 zip —— 模板 PDF、空白更正册、《使用说明》、字序文件。
// 结构与文件名（用户口径：压缩包里要有文件夹装着，文件夹名也带日期）：
//   SxFontCreator-模板-<YYYYMMDD>.zip
//     └─ SxFontCreator-模板-<YYYYMMDD>/
//          ├─ 模板-<YYYYMMDD>.pdf
//          ├─ 更正册-空白5页-<YYYYMMDD>.pdf
//          ├─ 使用说明.html
//          └─ 字序.sxorder
// 为什么要有这个包：原来一次只出一件，用户得跑两三次、还得自己对上"哪份纸配哪份字序"；
//   而字序原来只活在程序内部，纸一离开程序就无从知道该按什么字序对应（决策 一-18）。
// 只依赖 jszip（拿字节 → 打包，不碰 pdf-lib / fonteditor），因此能在 Node 里直接断言 zip 内容。
import JSZip from 'jszip'
import { ORDER_FILE_NAME, serializeOrderFile } from './orderFile.js'

// 文件名主干（测试与界面提示共用同一份拼法，避免两处各写一遍）
export const TEMPLATE_PACK_PREFIX = 'SxFontCreator-模板-'
// 空白更正册页数：原第 1 步的独立按钮固定 5 页（够写 680 个错字），现在随包一起出
export const CORRECTION_BOOK_PAGES = 5
// 字序文件的 zip 条目属性：DOS 只读位（0x01）。**2026-10-16 用户口径**：这份文件是给程序读的，
//   用户不需要打开它 —— 手改一下就可能让识别读不出来（一-18 ④ 宁严勿宽）。
//   边界（实测，见 orderFile.js 文件头）：7-Zip / WinRAR 解压会保留只读，Windows 资源管理器
//   双击 zip 解压不保留 —— 所以防误改主要靠扩展名（.sxorder 双击没有关联程序），只读位是第二道。
export const ORDER_FILE_DOS_PERMISSIONS = 0x01

/**
 * 这一次产物的所有文件名（都由同一个日期戳派生，改命名规则只动这里）。
 * @param {string} stamp 日期戳 `YYYYMMDD`（orderFile.dateStamp()）
 */
export function templatePackNames(stamp, options = {}) {
  const correctionPages = options.correctionPages || CORRECTION_BOOK_PAGES
  const folder = TEMPLATE_PACK_PREFIX + stamp
  return {
    folder,
    zip: folder + '.zip',
    template: '模板-' + stamp + '.pdf',
    correction: '更正册-空白' + correctionPages + '页-' + stamp + '.pdf',
    guide: '使用说明.html',
    orderFile: ORDER_FILE_NAME
  }
}

/** 包里应有的文件名清单（《使用说明》取不到时会少一件，那时界面要明确提示） */
export function templatePackEntries(names, options = {}) {
  const list = [names.template, names.correction]
  if (options.withGuide !== false) list.push(names.guide)
  list.push(names.orderFile)
  return list
}

/**
 * 打包。
 * @param {object} input
 * @param {Uint8Array} input.templateBytes 模板 PDF 字节
 * @param {Uint8Array} input.correctionBytes 空白更正册 PDF 字节
 * @param {string} [input.guideHtml] 《使用说明》HTML 正文（取不到时不传，界面另行提示）
 * @param {object} input.orderFile 字序文件对象（lib/orderFile.js 的 buildOrderFile 产物）
 * @param {string} input.stamp 日期戳
 * @returns {Promise<{bytes:Uint8Array, names:object}>}
 */
export async function packTemplateZip(input) {
  const names = templatePackNames(input.stamp, { correctionPages: input.correctionPages })
  const zip = new JSZip()
  const folder = zip.folder(names.folder) || zip
  folder.file(names.template, input.templateBytes)
  folder.file(names.correction, input.correctionBytes)
  if (input.guideHtml) folder.file(names.guide, input.guideHtml)
  // 字序文件带 DOS 只读位（见上面 ORDER_FILE_DOS_PERMISSIONS 的边界说明）
  folder.file(names.orderFile, serializeOrderFile(input.orderFile), {
    dosPermissions: ORDER_FILE_DOS_PERMISSIONS
  })
  const bytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    // platform 必须是 DOS（JSZip 的默认值，这里显式写死）：DOS 平台才会把 dosPermissions 写进
    //   zip 的 externalFileAttributes；换成 'UNIX' 的话只读位会被丢掉、字序文件就是普通文件了。
    platform: 'DOS'
  })
  return { bytes, names }
}
