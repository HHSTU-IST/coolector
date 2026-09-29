// 测试夹具：手工拼装的最小 docx。
//
// 三处需要「一个真实的 docx」：
//   - `server/relay-docx.test.js`（提取器单元测试）
//   - `server/relay-server.test.js`（裸 body 上传 → 服务端提取的集成测试）
//   - `scripts/e2e-upload.mjs`（真实浏览器端到端）
//
// 之所以不各写一份：夹具写歪了会让「三处都通过」变成假象（例如压缩方式标错，
// stored 分支其实从未被覆盖）。也刻意不引入 `zip` 或第三方库 —— 这里要的恰恰是
// 「能精确构造出真实包不会有的边界」（缺正文条目、deflate 数据损坏、central directory 多条目）。

import { deflateRawSync } from 'node:zlib'

/** Word 文档的标准 MIME（判据在 server/relay-docx.js 的 isDocxMimeType） */
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)

  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }

  return table
})()

/**
 * @param {Uint8Array} bytes 待校验的字节（`Buffer` 亦是 `Uint8Array`）
 * @returns {number}
 */
function crc32(bytes) {
  let crc = 0xffffffff

  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

/**
 * 手工拼装最小 ZIP：`local header + 数据`（每条目）→ central directory → EOCD。
 *
 * @param {{ name: string, content: string, compress?: boolean }[]} entries
 * @returns {Buffer}
 */
export function buildZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const raw = Buffer.from(entry.content, 'utf8')
    const stored = entry.compress === false ? raw : deflateRawSync(raw)
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const digest = crc32(raw)
    const method = entry.compress === false ? 0 : 8

    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(digest, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    nameBytes.copy(local, 30)

    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(digest, 16)
    central.writeUInt32LE(stored.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)

    localParts.push(local, stored)
    centralParts.push(central)

    offset += local.length + stored.length
  }

  const localBuffer = Buffer.concat(localParts)
  const centralBuffer = Buffer.concat(centralParts)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(localBuffer.length, 16)

  return Buffer.concat([localBuffer, centralBuffer, eocd])
}

/**
 * @param {string[]} paragraphs
 * @returns {string} word/document.xml 的内容
 */
export function buildDocumentXml(paragraphs) {
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${body}</w:body></w:document>`
}

/**
 * 一个**能被真实解析出正文**的 docx（含常见的三个条目，走 deflate）。
 *
 * @param {string[]} paragraphs 段落文本
 * @returns {Buffer}
 */
export function buildDocx(paragraphs) {
  return buildZip([
    { name: '[Content_Types].xml', content: '<Types/>' },
    { name: '_rels/.rels', content: '<Relationships/>' },
    { name: 'word/document.xml', content: buildDocumentXml(paragraphs) }
  ])
}
