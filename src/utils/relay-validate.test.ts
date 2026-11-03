import { describe, expect, it } from 'vitest'
import {
  RelayContractError,
  parseEventEnvelope,
  parseRoomResponse,
  parseRoomSnapshot,
  parseStreamTicket,
  parseUploadCreatedData,
  parseUploadDetailsResponse,
  parseUploadSummary
} from './relay-validate'

const roomResponse = () => ({
  roomId: 'r1',
  createdAt: '2020-01-01T00:00:00.000Z',
  weakRoomId: false,
  streamUrl: '/api/rooms/r1/events',
  streamTicketUrl: '/api/rooms/r1/stream-ticket',
  uploadUrl: '/api/rooms/r1/uploads',
  stateUrl: '/api/rooms/r1'
})

const summary = () => ({
  id: 'u1',
  name: 'a.md',
  mimeType: 'text/markdown',
  size: 12,
  uploadedAt: '2020-01-01T00:00:00.000Z',
  lastModified: '2020-01-01T00:00:00.000Z',
  previewText: null,
  textTruncated: false,
  contentIncluded: false,
  contentText: null,
  contentBase64: null,
  detailsUrl: '/api/rooms/r1/uploads/u1',
  downloadUrl: '/api/rooms/r1/uploads/u1?download=1'
})

describe('parseRoomResponse', () => {
  it('放行完整响应并原样交出关键字段', () => {
    expect(parseRoomResponse(roomResponse()).stateUrl).toBe('/api/rooms/r1')
  })

  it('缺失 stateUrl 时在边界即抛契约错误', () => {
    const partial = { ...roomResponse() } as Record<string, unknown>
    delete partial.stateUrl
    expect(() => parseRoomResponse(partial)).toThrow(RelayContractError)
  })

  it('拒绝非对象（数组 / null / 标量）', () => {
    expect(() => parseRoomResponse(null)).toThrow(RelayContractError)
    expect(() => parseRoomResponse([])).toThrow(RelayContractError)
    expect(() => parseRoomResponse('x')).toThrow(RelayContractError)
  })
})

describe('parseUploadSummary', () => {
  it('允许 previewText / contentText / contentBase64 为显式 null', () => {
    const parsed = parseUploadSummary(summary())
    expect(parsed.contentText).toBeNull()
    expect(parsed.contentBase64).toBeNull()
  })

  it('size 为 NaN 时拒绝（NaN 会污染配额展示）', () => {
    expect(() => parseUploadSummary({ ...summary(), size: NaN })).toThrow(RelayContractError)
  })

  it('把非字符串 name 判为畸形而非放行', () => {
    expect(() => parseUploadSummary({ ...summary(), name: 123 })).toThrow(RelayContractError)
  })

  it('容忍服务端多带的未知字段', () => {
    expect(parseUploadSummary({ ...summary(), serverStored: true }).id).toBe('u1')
  })
})

describe('parseRoomSnapshot', () => {
  it('uploads 必须是数组', () => {
    expect(() => parseRoomSnapshot({ uploads: 'nope' })).toThrow(RelayContractError)
  })

  it('空 uploads 仍视为合法快照（前端只遍历列表）', () => {
    expect(parseRoomSnapshot({ uploads: [] }).uploads).toEqual([])
  })

  it('逐条校验 uploads 元素', () => {
    expect(() => parseRoomSnapshot({ uploads: [{ id: 'u1' }] })).toThrow(RelayContractError)
    expect(parseRoomSnapshot({ uploads: [summary()] }).uploads[0]?.name).toBe('a.md')
  })
})

describe('SSE 信封与 upload.created', () => {
  it('信封缺 data 即抛', () => {
    expect(() => parseEventEnvelope({ id: 'e', type: 'x', createdAt: 'now' })).toThrow(RelayContractError)
  })

  it('信封字段类型正确才放行', () => {
    const env = parseEventEnvelope<{ n: number }>({ id: 'e', type: 'upload.created', createdAt: 'now', data: { n: 1 } })
    expect(env.type).toBe('upload.created')
    expect(env.data.n).toBe(1)
  })

  it('upload.created 校验内层 upload 摘要', () => {
    expect(() => parseUploadCreatedData({ roomId: 'r1', upload: { id: 'u1' } })).toThrow(RelayContractError)
    const data = parseUploadCreatedData({ roomId: 'r1', upload: summary(), downloadUrl: '/d' })
    expect(data.roomId).toBe('r1')
    expect(data.upload.id).toBe('u1')
  })

  it('downloadUrl 缺省时回退空串（客户端不消费它）', () => {
    expect(parseUploadCreatedData({ roomId: 'r1', upload: summary() }).downloadUrl).toBe('')
  })
})

describe('details 端点与流票据', () => {
  it('details 响应须包一层 upload', () => {
    expect(parseUploadDetailsResponse({ upload: summary() }).id).toBe('u1')
    expect(() => parseUploadDetailsResponse(summary())).toThrow(RelayContractError)
  })

  it('票据必须是字符串', () => {
    expect(parseStreamTicket({ ticket: 'abc' })).toBe('abc')
    expect(() => parseStreamTicket({ ticket: 42 })).toThrow(RelayContractError)
  })
})
