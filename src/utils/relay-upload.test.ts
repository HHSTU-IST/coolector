import { describe, expect, it } from 'vitest'
import {
  ENVELOPE_TEXT_MAX_BYTES,
  arrayBufferToBase64,
  blobToBase64,
  buildRelayUploadRequest,
  truncateEnvelopeText
} from './relay-upload'

const BASE = 'http://127.0.0.1:8787'
const ROOM = 'room-abcdef01'
const LAST_MODIFIED = new Date('2023-01-04T08:30:00.000Z')

const bytesOf = (value: string) => new TextEncoder().encode(value)
const byteLength = (value: string) => new TextEncoder().encode(value).length

/** 用浏览器原语解 base64 —— 刻意不复用被测实现，避免「自证」 */
const decodeBase64 = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))

const headersOf = (init: RequestInit) => init.headers as Record<string, string>
const envelopeOf = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, unknown>

/**
 * 基准值由 Node 的 `Buffer.toString('base64')` 独立算出后写死在这里 ——
 * 前端 tsconfig 里没有 Node 的 `Buffer`，且用它做基准才能证明本实现与 Node 语义一致。
 */
const BASE64_ORACLE: ReadonlyArray<readonly [string, string]> = [
  ['', ''],
  ['A', 'QQ=='],
  ['ABC', 'QUJD'],
  ['作业正文', '5L2c5Lia5q2j5paH']
]

describe('arrayBufferToBase64', () => {
  it.each(BASE64_ORACLE)('与 Node 的 base64 语义一致：%j', (input, expected) => {
    expect(arrayBufferToBase64(bytesOf(input).buffer as ArrayBuffer)).toBe(expected)
  })

  it('跨过 8KB 分块边界也不丢字节', () => {
    const payload = new Uint8Array(0x2000 * 3 + 7).map((_, index) => index % 256)
    const decoded = decodeBase64(arrayBufferToBase64(payload.buffer))

    expect(decoded.length).toBe(payload.length)
    expect([...decoded].every((byte, index) => byte === payload[index])).toBe(true)
  })
})

describe('truncateEnvelopeText', () => {
  it('未超限时原样返回', () => {
    expect(truncateEnvelopeText('短正文')).toEqual({ text: '短正文', truncated: false })
  })

  it('刚好处在上限时不截断', () => {
    const value = 'A'.repeat(ENVELOPE_TEXT_MAX_BYTES)
    expect(truncateEnvelopeText(value)).toEqual({ text: value, truncated: false })
  })

  it('按字节截断且不产生半个码点', () => {
    const value = '作'.repeat(ENVELOPE_TEXT_MAX_BYTES) // 每个汉字 3 字节，必然超限
    const result = truncateEnvelopeText(value)

    expect(result.truncated).toBe(true)
    expect(byteLength(result.text)).toBeLessThanOrEqual(ENVELOPE_TEXT_MAX_BYTES)
    // 截断点落在一个汉字中间时，`stream: true` 会丢弃不完整序列而不是吐替换字符
    expect(result.text).not.toContain('\ufffd')
  })
})

describe('buildRelayUploadRequest · 裸 body（默认形态）', () => {
  it('正文就是文件字节本身，不做 base64', async () => {
    const blob = new Blob([bytesOf('作业正文')], { type: 'text/markdown' })
    const request = await buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: ROOM,
      name: '张三-20230101.md',
      mimeType: 'text/markdown',
      lastModified: LAST_MODIFIED,
      blob
    })

    expect(request.form).toBe('raw')
    // 关键性质：请求体是 Blob 而不是字符串。旧实现把它换成 base64 文本
    // （带宽 +33%、10MB 文件要在主线程阻塞约 187ms），这条断言就是那个行为的反例。
    expect(request.init.body).toBe(blob)
    expect(typeof request.init.body).not.toBe('string')
    expect(request.url).toBe(`${BASE}/api/rooms/${ROOM}/uploads?name=${encodeURIComponent('张三-20230101.md')}`)
  })

  it('中文名经百分号编码后可被 URLSearchParams 原样还原（与服务端解码对齐）', async () => {
    const name = '李四-20230102 作业（终稿）.md'
    const request = await buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: ROOM,
      name,
      mimeType: 'text/markdown',
      lastModified: LAST_MODIFIED,
      blob: new Blob(['x'])
    })

    expect(new URL(request.url).searchParams.get('name')).toBe(name)
    // 编码后必须仍是纯 ASCII —— 含非 ASCII 字节的 URL 会被 fetch 直接拒绝
    expect([...request.url].every((char) => char.charCodeAt(0) < 0x80)).toBe(true)
  })

  it('名字里本就含 %XX 时，字面量不会被误解码', async () => {
    const name = 'note%20f.md'
    const request = await buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: ROOM,
      name,
      mimeType: 'text/markdown',
      lastModified: LAST_MODIFIED,
      blob: new Blob(['x'])
    })

    expect(new URL(request.url).searchParams.get('name')).toBe(name)
  })

  it('MIME 与修改时间走请求头，且不带信封标志', async () => {
    const request = await buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: ROOM,
      name: '王五-20230103.ipynb',
      mimeType: 'application/x-ipynb+json',
      lastModified: LAST_MODIFIED,
      blob: new Blob(['{}'])
    })

    const headers = headersOf(request.init)
    expect(headers['X-Relay-Mime-Type']).toBe('application/x-ipynb+json')
    expect(headers['X-Relay-Last-Modified']).toBe(LAST_MODIFIED.toISOString())
    // 带上信封标志会让服务端去找 base64 正文，而裸 body 里根本没有 → 必须不出现
    expect(headers['X-Relay-Envelope']).toBeUndefined()
  })

  it('MIME 为空串时兜底为 application/octet-stream（空头值不合法）', async () => {
    const request = await buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: ROOM,
      name: '王五-20230103.ipynb',
      mimeType: '',
      lastModified: LAST_MODIFIED,
      blob: new Blob(['{}'])
    })

    expect(headersOf(request.init)['X-Relay-Mime-Type']).toBe('application/octet-stream')
  })

  it('房间号会被编进路径，不逃逸出 /uploads', async () => {
    const request = await buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: 'room/abc',
      name: 'a.md',
      mimeType: 'text/markdown',
      lastModified: LAST_MODIFIED,
      blob: new Blob(['x'])
    })

    expect(request.url.startsWith(`${BASE}/api/rooms/room%2Fabc/uploads?name=`)).toBe(true)
  })
})

describe('buildRelayUploadRequest · JSON 信封（仅带外数据场景）', () => {
  it('docx 提取正文需与原件同请求送达 → 走信封', async () => {
    const rawBytes = bytesOf('PK\u0003\u0004伪造的 docx 字节')
    const request = await buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: ROOM,
      name: '李四-20230102.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      lastModified: LAST_MODIFIED,
      blob: new Blob([rawBytes]),
      extractedText: '这是提取出来的正文'
    })

    expect(request.form).toBe('envelope')
    expect(headersOf(request.init)['X-Relay-Envelope']).toBe('1')
    // 信封没有 ?name= 通道：文件名在 body 里，body 是 UTF-8，不受「头只能 ISO-8859-1」约束
    expect(request.url).toBe(`${BASE}/api/rooms/${ROOM}/uploads`)

    const envelope = envelopeOf(request.init)
    expect(envelope.name).toBe('李四-20230102.docx')
    expect(envelope.text).toBe('这是提取出来的正文')
    // 正文必须是**原件**的字节，而不是提取文本 —— 否则接收端下载到的是纯文本，原件就丢了
    expect(envelope.contentBase64).toBe('UEsDBOS8qumAoOeahCBkb2N4IOWtl+iKgg==')
    expect([...decodeBase64(String(envelope.contentBase64))].every((byte, index) => byte === rawBytes[index])).toBe(true)
    expect(envelope.textTruncatedByClient).toBeUndefined()
  })

  it('提取正文超限时客户端截断并上报，避免内容被静默丢掉', async () => {
    const request = await buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: ROOM,
      name: 'a.docx',
      mimeType: 'application/octet-stream',
      lastModified: LAST_MODIFIED,
      blob: new Blob([bytesOf('PK')]),
      extractedText: '作'.repeat(ENVELOPE_TEXT_MAX_BYTES)
    })

    const envelope = envelopeOf(request.init)
    expect(envelope.textTruncatedByClient).toBe(true)
    expect(byteLength(String(envelope.text))).toBeLessThanOrEqual(ENVELOPE_TEXT_MAX_BYTES)
  })

  it('本地无原始字节（中继接收来的文件）时退回信封，沿用已有 base64', async () => {
    const request = await buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: ROOM,
      name: '已接收.md',
      mimeType: 'text/markdown',
      lastModified: LAST_MODIFIED,
      contentBase64: 'QUJD'
    })

    expect(request.form).toBe('envelope')
    expect(envelopeOf(request.init).contentBase64).toBe('QUJD')
  })

  it('既无 blob 也无 base64 时不伪造内容字段（交由服务端报 400，不静默传空文件）', async () => {
    const request = await buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: ROOM,
      name: '空.md',
      mimeType: 'text/markdown',
      lastModified: LAST_MODIFIED
    })

    expect(request.form).toBe('envelope')
    expect(Object.hasOwn(envelopeOf(request.init), 'contentBase64')).toBe(false)
  })
})

describe('blobToBase64', () => {
  it('与 Node 的 base64 语义一致', async () => {
    expect(await blobToBase64(new Blob([bytesOf('作业正文')]))).toBe('5L2c5Lia5q2j5paH')
  })
})
