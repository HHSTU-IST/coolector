/** docx 正文在包内的固定路径 */
const DOCUMENT_XML_PATH = 'word/document.xml'

/** ZIP 尾部目录记录签名，用于定位 central directory */
const EOCD_SIGNATURE = 0x06054b50

/** ZIP central directory 条目签名 */
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50

/** ZIP local file header 签名 */
const LOCAL_HEADER_SIGNATURE = 0x04034b50

/** 压缩方式：0 未压缩，8 deflate */
const METHOD_STORED = 0

/** ZIP 尾部注释最长 64KB，EOCD 需在此范围内回溯 */
const MAX_COMMENT_LENGTH = 0xffff

interface ZipEntry {
  compressionMethod: number
  compressedSize: number
  localHeaderOffset: number
}

/** 从尾部回溯 EOCD，返回其偏移量 */
function findEndOfCentralDirectory(view: DataView): number | null {
  const minimumOffset = Math.max(0, view.byteLength - 22 - MAX_COMMENT_LENGTH)

  for (let offset = view.byteLength - 22; offset >= minimumOffset; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset
  }

  return null
}

function readUtf8(view: DataView, offset: number, length: number): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length)
  return new TextDecoder('utf-8').decode(bytes)
}

/** 遍历 central directory 找到目标文件的压缩信息 */
function findZipEntry(view: DataView, targetName: string): ZipEntry | null {
  const eocdOffset = findEndOfCentralDirectory(view)
  if (eocdOffset === null) return null

  const entryCount = view.getUint16(eocdOffset + 10, true)
  let offset = view.getUint32(eocdOffset + 16, true)

  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > view.byteLength) return null
    if (view.getUint32(offset, true) !== CENTRAL_ENTRY_SIGNATURE) return null

    const compressionMethod = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)

    if (readUtf8(view, offset + 46, nameLength) === targetName) {
      return { compressionMethod, compressedSize, localHeaderOffset }
    }

    offset += 46 + nameLength + extraLength + commentLength
  }

  return null
}

/** 按 local file header 定位条目的压缩数据 */
function readEntryData(view: DataView, entry: ZipEntry): Uint8Array | null {
  const header = entry.localHeaderOffset
  if (header + 30 > view.byteLength) return null
  if (view.getUint32(header, true) !== LOCAL_HEADER_SIGNATURE) return null

  const nameLength = view.getUint16(header + 26, true)
  const extraLength = view.getUint16(header + 28, true)
  const dataOffset = header + 30 + nameLength + extraLength

  if (dataOffset + entry.compressedSize > view.byteLength) return null

  return new Uint8Array(view.buffer, view.byteOffset + dataOffset, entry.compressedSize)
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // 显式拷贝：DOM BlobPart 要求视图底层是 ArrayBuffer 而非 SharedArrayBuffer
  const payload = new Uint8Array(data)
  const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
}

/** 过滤非法码点，避免 XML 数值实体构造出代理项错误 */
function safeCodePoint(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
}

function collectParagraphText(paragraphXml: string): string {
  const inlinePattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g
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

export function extractTextFromDocumentXml(xml: string): string {
  const paragraphs: string[] = []
  const paragraphPattern = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g

  for (const match of xml.matchAll(paragraphPattern)) {
    const paragraph = collectParagraphText(match[1])
    if (paragraph) paragraphs.push(paragraph)
  }

  return paragraphs.join('\n')
}

/**
 * 从 docx 里提取正文文本。docx 本身是 zip 容器，正文在 `word/document.xml`。
 * 任何环节失败都返回 null，交由调用方降级为「二进制」处理。
 */
export async function extractDocxText(buffer: ArrayBuffer): Promise<string | null> {
  try {
    const view = new DataView(buffer)
    const entry = findZipEntry(view, DOCUMENT_XML_PATH)
    if (!entry) return null

    const compressed = readEntryData(view, entry)
    if (!compressed) return null

    const decoder = new TextDecoder('utf-8')
    const xml = entry.compressionMethod === METHOD_STORED
      ? decoder.decode(compressed)
      : decoder.decode(await inflateRaw(compressed))

    const text = extractTextFromDocumentXml(xml)
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}
