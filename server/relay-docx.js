// 服务端 docx 正文提取。
//
// 历史：这段逻辑原本只在**浏览器**里（`src/utils/docx.ts`，187 行手写 ZIP 解析）——
// 因为裸 body 通道「没有位置放带外正文」，docx 只能走 JSON 信封把提取结果一起送上来。
// 后果是所有 docx 都要先在客户端解压一遍、再 base64 膨胀 33% 上传。移到服务端之后：
//
//   ① docx 与普通文件走**同一条**裸 body 路径（原件字节原样上传，正文由服务端自己解）；
//   ② 同一份逻辑只存在一处（铁律 20）—— 两端各写一份必然漂移；
//   ③ 客户端少 187 行解析代码，也不再占用主线程。
//
// 与浏览器版的差异只有解压那一步：`DecompressionStream('deflate-raw')` → `zlib.inflateRawSync`。
// docx 的 ZIP 条目用的是 **raw deflate**（无 zlib/gzip 头），所以必须是 `inflateRaw*`。
//
// ⚠️ 只支持 ZIP 的最小可用子集：central directory → local file header → 单个条目。
// 不做 zip64、不做加密、不做多卷。任何环节不符合预期一律返回 `null`（降级为二进制），
// 绝不抛异常 —— 提取正文只影响预览，不该让一次上传失败。

import { inflateRawSync } from 'node:zlib'

/** docx 正文在包内的固定路径 */
const DOCUMENT_XML_PATH = 'word/document.xml'

/** ZIP 尾部目录记录签名，用于定位 central directory */
const EOCD_SIGNATURE = 0x06054b50

/** ZIP central directory 条目签名 */
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50

/** ZIP local file header 签名 */
const LOCAL_HEADER_SIGNATURE = 0x04034b50

/** 压缩方式：0 未压缩（stored），其余按 deflate 处理 */
const METHOD_STORED = 0

/** EOCD 固定 22 字节 */
const EOCD_LENGTH = 22

/** ZIP 尾部注释最长 64KB，EOCD 需在此范围内回溯 */
const MAX_COMMENT_LENGTH = 0xffff

/**
 * 解压输出上限（64 MB）：防「压缩炸弹」式 docx（几 KB 的包解出几个 GB）撑爆服务端内存。
 * `inflateRawSync` 的 `maxOutputLength` 超限时抛错，由外层 catch 统一降级。
 */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024

/**
 * 判断一次上传是否为 Word 文档。
 *
 * 同时看 MIME 与扩展名：浏览器给出的 docx MIME 并不总是那个长串
 * （某些平台是 `application/octet-stream` 甚至空串），而扩展名在这个文件类型上是可靠的。
 *
 * @param {string} mimeType
 * @param {string} fileName
 * @returns {boolean}
 */
export function isDocxMimeType(mimeType, fileName) {
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return true
  return /\.docx$/iu.test(fileName)
}

/**
 * 从尾部回溯 EOCD，返回其偏移量；找不到返回 null。
 *
 * @param {Buffer} buffer
 * @returns {number | null}
 */
function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - EOCD_LENGTH - MAX_COMMENT_LENGTH)

  for (let offset = buffer.length - EOCD_LENGTH; offset >= minimumOffset; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }

  return null
}

/**
 * 遍历 central directory 找到目标条目的压缩信息。
 *
 * @param {Buffer} buffer
 * @param {string} targetName
 * @returns {{ compressionMethod: number, compressedSize: number, localHeaderOffset: number } | null}
 */
function findZipEntry(buffer, targetName) {
  const eocdOffset = findEndOfCentralDirectory(buffer)
  if (eocdOffset === null) return null

  const entryCount = buffer.readUInt16LE(eocdOffset + 10)
  let offset = buffer.readUInt32LE(eocdOffset + 16)

  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > buffer.length) return null
    if (buffer.readUInt32LE(offset) !== CENTRAL_ENTRY_SIGNATURE) return null

    const compressionMethod = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)

    if (buffer.toString('utf8', offset + 46, offset + 46 + nameLength) === targetName) {
      return { compressionMethod, compressedSize, localHeaderOffset }
    }

    offset += 46 + nameLength + extraLength + commentLength
  }

  return null
}

/**
 * 按 local file header 定位条目的压缩数据。
 *
 * 注意 central directory 里的 `extraLength` 与 local header 里的不一定相同
 * （两者可以各自携带不同的扩展字段），因此必须重新读 local header，不能复用。
 *
 * @param {Buffer} buffer
 * @param {{ compressedSize: number, localHeaderOffset: number }} entry
 * @returns {Buffer | null}
 */
function readEntryData(buffer, entry) {
  const header = entry.localHeaderOffset
  if (header + 30 > buffer.length) return null
  if (buffer.readUInt32LE(header) !== LOCAL_HEADER_SIGNATURE) return null

  const nameLength = buffer.readUInt16LE(header + 26)
  const extraLength = buffer.readUInt16LE(header + 28)
  const dataOffset = header + 30 + nameLength + extraLength

  if (dataOffset + entry.compressedSize > buffer.length) return null

  return buffer.subarray(dataOffset, dataOffset + entry.compressedSize)
}

/**
 * 过滤非法码点：`0` 与超出 Unicode 区间的值会被 `String.fromCodePoint` 抛错，
 * 而**代理项区间**（U+D800–U+DFFF）更隐蔽 —— 它不抛错，却会产出孤立代理项，
 * 让整段正文变成 ill-formed UTF-16（下游 `JSON.stringify` / 落盘各处的行为随之变得可疑）。
 *
 * @param {number} code
 * @returns {string}
 */
function safeCodePoint(code) {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
  if (code >= 0xd800 && code <= 0xdfff) return ''
  return String.fromCodePoint(code)
}

/**
 * 还原 XML 实体。`&amp;` 必须**最后**替换，否则 `&amp;lt;` 会被错误地二次还原成 `<`。
 *
 * @param {string} value
 * @returns {string}
 */
function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#x([0-9a-fA-F]+);/gu, (_, hex) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, dec) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/gu, '&')
}

/**
 * 取单个段落内的可读文本：`<w:t>` 取内容，`<w:tab/>` / `<w:br/>` 变成制表符与换行。
 *
 * @param {string} paragraphXml
 * @returns {string}
 */
function collectParagraphText(paragraphXml) {
  const inlinePattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/gu
  let text = ''

  for (const match of paragraphXml.matchAll(inlinePattern)) {
    const token = match[0]

    if (token.startsWith('<w:tab')) {
      text += '\t'
    } else if (token.startsWith('<w:br')) {
      text += '\n'
    } else {
      text += decodeXmlEntities(match[1])
    }
  }

  return text.trim()
}

/**
 * 从 `word/document.xml` 取纯文本。
 *
 * @param {string} xml
 * @returns {string}
 */
export function extractTextFromDocumentXml(xml) {
  const paragraphs = []
  const paragraphPattern = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gu

  for (const match of xml.matchAll(paragraphPattern)) {
    const paragraph = collectParagraphText(match[1])
    if (paragraph) paragraphs.push(paragraph)
  }

  return paragraphs.join('\n')
}

/**
 * 从 docx 字节里提取正文。**任何环节失败都返回 null**（调用方降级为二进制）。
 *
 * @param {Buffer} bytes docx 原始字节
 * @returns {string | null}
 */
export function extractDocxText(bytes) {
  try {
    if (!Buffer.isBuffer(bytes)) return null

    const entry = findZipEntry(bytes, DOCUMENT_XML_PATH)
    if (!entry) return null

    const compressed = readEntryData(bytes, entry)
    if (!compressed) return null

    const xml = entry.compressionMethod === METHOD_STORED
      ? compressed.toString('utf8')
      : inflateRawSync(compressed, { maxOutputLength: MAX_INFLATED_BYTES }).toString('utf8')

    const text = extractTextFromDocumentXml(xml)
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}
