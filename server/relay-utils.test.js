// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  contentDisposition,
  decodeHeaderValue,
  isLoopbackHost,
  isTextMimeType,
  makeAuthorizer,
  makeCorsHeaders,
  normalizeAllowedOrigins,
  sanitizeRoomId,
  sanitizeStorageFileName
} from './relay-utils.js'

describe('sanitizeRoomId', () => {
  it('接受合法房间 ID', () => {
    expect(sanitizeRoomId('demo-room')).toBe('demo-room')
    expect(sanitizeRoomId('abc_123-xyz')).toBe('abc_123-xyz')
    expect(sanitizeRoomId('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toHaveLength(32)
  })

  it('去除首尾空白', () => {
    expect(sanitizeRoomId('  demo-room  ')).toBe('demo-room')
  })

  it('拒绝过短 / 非法字符 / 超长 / 非字符串', () => {
    expect(sanitizeRoomId('ab')).toBeNull()
    expect(sanitizeRoomId('room/../etc')).toBeNull()
    expect(sanitizeRoomId('a'.repeat(65))).toBeNull()
    expect(sanitizeRoomId(null)).toBeNull()
    expect(sanitizeRoomId(undefined)).toBeNull()
  })
})

describe('sanitizeStorageFileName', () => {
  it('取 basename 阻断路径穿越', () => {
    expect(sanitizeStorageFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeStorageFileName('/var/log/app.log')).toBe('app.log')
  })

  it('替换非法字符', () => {
    expect(sanitizeStorageFileName('a*b.txt')).toBe('a_b.txt')
  })

  it('纯点号名回退为 file', () => {
    expect(sanitizeStorageFileName('...')).toBe('file')
  })

  it('空名回退为 file', () => {
    expect(sanitizeStorageFileName('')).toBe('file')
  })
})

describe('contentDisposition', () => {
  it('中文名用 filename* 编码并给 ASCII 回退', () => {
    const header = contentDisposition('张三.md')
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('张三.md')}`)
    expect(header).toContain('filename="')
  })

  it('纯 ASCII 名原样回退', () => {
    const header = contentDisposition('report.md')
    expect(header).toContain('filename="report.md"')
  })
})

describe('decodeHeaderValue', () => {
  it('latin1 还原 UTF-8 文件名', () => {
    const latin1 = Buffer.from('张三.md', 'utf8').toString('latin1')
    expect(decodeHeaderValue(latin1)).toBe('张三.md')
  })

  it('非字符串原样返回', () => {
    expect(decodeHeaderValue(undefined)).toBeUndefined()
  })
})

describe('normalizeAllowedOrigins', () => {
  it('空串 / undefined 归一为 *', () => {
    expect(normalizeAllowedOrigins('')).toEqual(['*'])
    expect(normalizeAllowedOrigins(undefined)).toEqual(['*'])
    expect(normalizeAllowedOrigins('   ')).toEqual(['*'])
  })

  it('逗号分隔白名单', () => {
    expect(normalizeAllowedOrigins('a.com, b.com')).toEqual(['a.com', 'b.com'])
  })

  it('单个来源返回单元素数组', () => {
    expect(normalizeAllowedOrigins('a.com')).toEqual(['a.com'])
  })
})

describe('isTextMimeType', () => {
  it('text/* 与文本扩展名判定为文本', () => {
    expect(isTextMimeType('text/plain', 'a.bin')).toBe(true)
    expect(isTextMimeType('application/octet-stream', 'note.md')).toBe(true)
    expect(isTextMimeType('application/octet-stream', 'note.MD')).toBe(true)
  })

  it('二进制扩展名判定为非文本', () => {
    expect(isTextMimeType('application/octet-stream', 'pic.png')).toBe(false)
  })
})

describe('makeAuthorizer', () => {
  it('未配置 token 时全放行', () => {
    const auth = makeAuthorizer('')
    expect(auth({ headers: {}, url: '/' })).toBe(true)
  })

  it('Bearer 头放行', () => {
    const auth = makeAuthorizer('secret')
    expect(auth({ headers: { authorization: 'Bearer secret' }, url: '/' })).toBe(true)
  })

  it('?token= 查询参数放行（SSE）', () => {
    const auth = makeAuthorizer('secret')
    expect(auth({ headers: {}, url: '/api/rooms/x/events?token=secret' })).toBe(true)
  })

  it('错误 token 拒绝', () => {
    const auth = makeAuthorizer('secret')
    expect(auth({ headers: { authorization: 'Bearer wrong' }, url: '/' })).toBe(false)
  })
})

describe('makeCorsHeaders', () => {
  it('* 白名单返回任意来源', () => {
    const cors = makeCorsHeaders(['*'])
    const headers = cors({ headers: { origin: 'https://x.com' } })
    expect(headers['Access-Control-Allow-Origin']).toBe('*')
  })

  it('非白名单来源返回空对象', () => {
    const cors = makeCorsHeaders(['https://ok.com'])
    expect(cors({ headers: { origin: 'https://evil.com' } })).toEqual({})
  })

  it('白名单来源返回该来源并带 Vary', () => {
    const cors = makeCorsHeaders(['https://ok.com'])
    const headers = cors({ headers: { origin: 'https://ok.com' } })
    expect(headers['Access-Control-Allow-Origin']).toBe('https://ok.com')
    expect(headers.Vary).toBe('Origin')
  })
})

describe('isLoopbackHost', () => {
  it('回环地址返回 true', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
  })

  it('非回环返回 false', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('::')).toBe(false)
  })
})
