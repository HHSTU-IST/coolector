/**
 * 上传侧与接收侧共用的「内容展示」工具。
 *
 * 二进制占位文案过去在 `stores/file.ts` 与 `RelayReceiver.vue` 各写了一份，
 * 改文案时容易只改一处、两边不一致 —— 这里只保留一份实现。
 */

/** 二进制文件不支持预览时的占位文案；`action` 保留「已上传 / 已接收」的语义差别 */
export const binaryPlaceholder = (fileName: string, action: '已上传' | '已接收' = '已上传') =>
  `此文件为二进制格式（${fileName}），${action}但暂不支持内容预览。`
