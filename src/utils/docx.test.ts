// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { extractDocxText, extractTextFromDocumentXml } from './docx'

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

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff

  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0

  for (const part of parts) {
    merged.set(part, offset)
    offset += part.length
  }

  return merged
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const payload = new Uint8Array(bytes)
  const stream = new Blob([payload]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const textBytes = (value: string) => new TextEncoder().encode(value)

interface ZipInput {
  name: string
  content: string
  compress: boolean
}

/** 手工拼装最小 ZIP：local header + 数据 + central directory + EOCD */
async function buildZip(entries: ZipInput[]): Promise<ArrayBuffer> {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const raw = textBytes(entry.content)
    const stored = entry.compress ? await deflateRaw(raw) : raw
    const nameBytes = textBytes(entry.name)
    const digest = crc32(raw)
    const method = entry.compress ? 8 : 0

    const local = new Uint8Array(30 + nameBytes.length)
    const localView = new DataView(local.buffer, local.byteOffset, local.byteLength)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(8, method, true)
    localView.setUint32(14, digest, true)
    localView.setUint32(18, stored.length, true)
    localView.setUint32(22, raw.length, true)
    localView.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)

    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer, central.byteOffset, central.byteLength)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(10, method, true)
    centralView.setUint32(16, digest, true)
    centralView.setUint32(20, stored.length, true)
    centralView.setUint32(24, raw.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(42, offset, true)
    central.set(nameBytes, 46)

    localParts.push(local, stored)
    centralParts.push(central)

    offset += local.length + stored.length
  }

  const localBuffer = concatBytes(localParts)
  const centralBuffer = concatBytes(centralParts)

  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, entries.length, true)
  eocdView.setUint16(10, entries.length, true)
  eocdView.setUint32(12, centralBuffer.length, true)
  eocdView.setUint32(16, localBuffer.length, true)

  const archive = concatBytes([localBuffer, centralBuffer, eocd])
  return archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer
}

function buildDocumentXml(paragraphs: string[]): string {
  const body = paragraphs.map(text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
}

describe('extractDocxText', () => {
  it('提取 deflate 压缩的 docx 正文', async () => {
    const xml = buildDocumentXml(['第一段内容', '第二段内容'])
    const buffer = await buildZip([{ name: 'word/document.xml', content: xml, compress: true }])

    expect(await extractDocxText(buffer)).toBe('第一段内容\n第二段内容')
  })

  it('支持未压缩存储的条目', async () => {
    const xml = buildDocumentXml(['Stored 模式'])
    const buffer = await buildZip([{ name: 'word/document.xml', content: xml, compress: false }])

    expect(await extractDocxText(buffer)).toBe('Stored 模式')
  })

  it('在含多个条目的包内定位到正文', async () => {
    const xml = buildDocumentXml(['唯一正文'])
    const buffer = await buildZip([
      { name: '[Content_Types].xml', content: '<Types/>', compress: true },
      { name: 'word/document.xml', content: xml, compress: true },
      { name: 'word/styles.xml', content: '<Styles/>', compress: true }
    ])

    expect(await extractDocxText(buffer)).toBe('唯一正文')
  })

  it('缺少正文.xml 时返回 null', async () => {
    const buffer = await buildZip([{ name: 'readme.txt', content: 'no doc here', compress: false }])

    expect(await extractDocxText(buffer)).toBeNull()
  })

  it('非 zip 的垃圾数据降级返回 null', async () => {
    await expect(extractDocxText(new ArrayBuffer(0))).resolves.toBeNull()
    await expect(extractDocxText(Uint8Array.from([1, 2, 3, 4, 5]).buffer)).resolves.toBeNull()
  })
})

describe('extractTextFromDocumentXml', () => {
  it('解码 XML 实体并还原 tab、br', () => {
    const xml = '<w:p><w:t>AT&amp;T &lt;ok&gt;</w:t><w:tab/><w:t>后文</w:t><w:br/><w:t>换行</w:t></w:p>'

    expect(extractTextFromDocumentXml(xml)).toBe('AT&T <ok>\t后文\n换行')
  })

  it('忽略空白段落', () => {
    const xml = '<w:p></w:p><w:p><w:t>有字</w:t></w:p><w:p>   </w:p>'

    expect(extractTextFromDocumentXml(xml)).toBe('有字')
  })

  it('空正文返回空串', () => {
    expect(extractTextFromDocumentXml('<w:document></w:document>')).toBe('')
  })
})
