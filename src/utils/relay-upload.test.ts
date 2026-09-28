import { describe, expect, it } from 'vitest'
import { base64ToBlob, buildRelayUploadRequest } from './relay-upload'

const BASE = 'http://127.0.0.1:8787'
const ROOM = 'room-abcdef01'
const LAST_MODIFIED = new Date('2023-01-04T08:30:00.000Z')

const bytesOf = (value: string) => new TextEncoder().encode(value)

const headersOf = (init: RequestInit) => init.headers as Record<string, string>

/**
 * 基准值由 Node 的 `Buffer.toString('base64')` 独立算出后写死在这里 ——
 * 前端 tsconfig 里没有 Node 的 `Buffer`，且用它做基准才能证明本实现与 Node 语义一致。
 * （`作业正文` → `5L2c5Lia5q2j5paH`；`[0x00,0x80,0xff]` → `AID/`）
 */
const BASE64_ORACLE: ReadonlyArray<readonly [string, string]> = [
  ['', ''],
  ['A', 'QQ=='],
  ['ABC', 'QUJD'],
  ['作业正文', '5L2c5Lia5q2j5paH']
]

describe('base64ToBlob（中继接收来的文件的本地还原）', () => {
  it.each(BASE64_ORACLE)('与 Node 的 base64 语义一致：%j', async (plain, encoded) => {
    const blob = base64ToBlob(encoded, 'text/markdown')
    const bytes = new Uint8Array(await blob.arrayBuffer())

    expect([...bytes]).toEqual([...bytesOf(plain)])
  })

  it('高位字节不被 charCode 截断', async () => {
    const blob = base64ToBlob('AID/', 'application/octet-stream')
    const bytes = new Uint8Array(await blob.arrayBuffer())

    expect([...bytes]).toEqual([0x00, 0x80, 0xff])
  })

  it('带上 MIME 作为 Blob 类型', () => {
    expect(base64ToBlob('QQ==', 'application/x-ipynb+json').type).toBe('application/x-ipynb+json')
  })
})

describe('buildRelayUploadRequest · 唯一形态：裸 body', () => {
  it('正文就是文件字节本身，不做 base64', () => {
    const blob = new Blob([bytesOf('作业正文')], { type: 'text/markdown' })
    const request = buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: ROOM,
      name: '张三-20230101.md',
      mimeType: 'text/markdown',
      lastModified: LAST_MODIFIED,
      blob
    })

    // 关键性质：请求体是 Blob 而不是字符串。旧的信封实现把它换成 base64 文本
    // （带宽 +33%、10MB 文件要在主线程阻塞约 188ms），这条断言就是那个行为的反例。
    expect(request.init.body).toBe(blob)
    expect(typeof request.init.body).not.toBe('string')
    expect(request.bodyBytes).toBe(bytesOf('作业正文').length)
    expect(request.url).toBe(`${BASE}/api/rooms/${ROOM}/uploads?name=${encodeURIComponent('张三-20230101.md')}`)
  })

  /**
   * docx 曾经是**唯一**必须走信封的文件类型（客户端提取的正文没有位置放）。
   * 服务端接管提取之后它必须与普通文件走同一条路径 —— 否则信封会借着这个理由长期留在主路径上。
   */
  it('docx 与普通文件走同一条裸 body 路径（正文提取已移到服务端）', () => {
    const docx = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])])

    const request = buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: ROOM,
      name: '李四-20230102.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      lastModified: LAST_MODIFIED,
      blob: docx
    })

    expect(request.init.body).toBe(docx)
    expect(headersOf(request.init)['X-Relay-Envelope']).toBeUndefined()
    expect(new URL(request.url).searchParams.get('name')).toBe('李四-20230102.docx')
  })

  it('中文名经百分号编码后可被 URLSearchParams 原样还原（与服务端解码对齐）', () => {
    const name = '李四-20230102 作业（终稿）.md'
    const request = buildRelayUploadRequest({
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

  it('名字里本就含 %XX 时，字面量不会被误解码', () => {
    const name = 'note%20f.md'
    const request = buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: ROOM,
      name,
      mimeType: 'text/markdown',
      lastModified: LAST_MODIFIED,
      blob: new Blob(['x'])
    })

    expect(new URL(request.url).searchParams.get('name')).toBe(name)
  })

  it('MIME 与修改时间走请求头，且不带信封标志', () => {
    const request = buildRelayUploadRequest({
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

  it('MIME 为空串时兜底为 application/octet-stream（空头值不合法）', () => {
    const request = buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: ROOM,
      name: '王五-20230103.ipynb',
      mimeType: '',
      lastModified: LAST_MODIFIED,
      blob: new Blob(['{}'])
    })

    expect(headersOf(request.init)['X-Relay-Mime-Type']).toBe('application/octet-stream')
  })

  it('房间号会被编进路径，不逃逸出 /uploads', () => {
    const request = buildRelayUploadRequest({
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

describe('buildRelayUploadRequest · 本地只有 base64 的情形', () => {
  /**
   * 中继接收来的文件本地没有字节句柄。此前这条路径退回 JSON 信封（因为信封是
   * 「没有 blob」时的唯一出口）。现在改为在本地还原成 Blob，走**同一条**路径 ——
   * 前后端都只剩一种传输形态，`X-Relay-Envelope` 不再是任何主路径的一部分。
   */
  it('没有 blob 时把 contentBase64 还原成 Blob，仍走裸 body', async () => {
    const request = buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: ROOM,
      name: '已接收.md',
      mimeType: 'text/markdown',
      lastModified: LAST_MODIFIED,
      contentBase64: '5L2c5Lia5q2j5paH'
    })

    expect(headersOf(request.init)['X-Relay-Envelope']).toBeUndefined()
    expect(request.init.body).toBeInstanceOf(Blob)
    expect(request.bodyBytes).toBe(bytesOf('作业正文').length)
    expect(new Uint8Array(await (request.init.body as Blob).arrayBuffer())).toEqual(bytesOf('作业正文'))
  })

  it('blob 优先于 contentBase64（本地有真字节就不用绕 base64）', () => {
    const blob = new Blob(['local'])
    const request = buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: ROOM,
      name: 'a.md',
      mimeType: 'text/markdown',
      lastModified: LAST_MODIFIED,
      blob,
      contentBase64: 'QUJD'
    })

    expect(request.init.body).toBe(blob)
  })

  /**
   * 旧实现把「两者都没有」交给服务端报 400（信封里不写 contentBase64 即可）。
   * 现在没有信封可发，静默发一个 0 字节请求会让接收端收到一个空文件 —— 必须在本地抛出。
   */
  it('既无 blob 也无 base64 时抛错，不静默上传空文件', () => {
    expect(() => buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: ROOM,
      name: '空.md',
      mimeType: 'text/markdown',
      lastModified: LAST_MODIFIED
    })).toThrowError(/缺少文件字节/u)
  })

  it('空串 contentBase64 视为「0 字节文件」而不是缺失（与服务端同一判据）', () => {
    const request = buildRelayUploadRequest({
      baseUrl: BASE,
      roomId: ROOM,
      name: '空.md',
      mimeType: 'text/markdown',
      lastModified: LAST_MODIFIED,
      contentBase64: ''
    })

    expect(request.bodyBytes).toBe(0)
  })
})
