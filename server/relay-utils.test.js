// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  contentDisposition,
  decodeHeaderValue,
  isLoopbackHost,
  isTextMimeType,
  isWeakRoomId,
  makeAuthorizer,
  makeCorsHeaders,
  makeTicketStore,
  normalizeAllowedOrigins,
  parsePositiveInt,
  sanitizeMimeType,
  sanitizeRoomId,
  sanitizeStorageFileName,
  truncateUtf8
} from './relay-utils.js'

describe('parsePositiveInt', () => {
  it('空值回退到默认值', () => {
    expect(parsePositiveInt(undefined, { fallback: 42 })).toEqual({ ok: true, value: 42, usedFallback: true })
    expect(parsePositiveInt('', { fallback: 42 })).toEqual({ ok: true, value: 42, usedFallback: true })
    expect(parsePositiveInt('   ', { fallback: 42 })).toEqual({ ok: true, value: 42, usedFallback: true })
  })

  it('接受合法正整数', () => {
    expect(parsePositiveInt('1024')).toEqual({ ok: true, value: 1024, usedFallback: false })
    expect(parsePositiveInt(' 1024 ')).toEqual({ ok: true, value: 1024, usedFallback: false })
  })

  it('拒绝非数字 —— 否则 NaN 会让体积校验静默全失效', () => {
    for (const bad of ['abc', '10mb', '1e', '--5', 'NaN', 'Infinity']) {
      expect(parsePositiveInt(bad, { fallback: 1 }).ok).toBe(false)
    }
  })

  it('拒绝负数、零与小数', () => {
    expect(parsePositiveInt('-1', { fallback: 1 }).ok).toBe(false)
    expect(parsePositiveInt('0', { fallback: 1 }).ok).toBe(false)
    expect(parsePositiveInt('1.5', { fallback: 1 }).ok).toBe(false)
  })

  it('让 min=0 放行 0（用于可关闭的开关型上限）', () => {
    expect(parsePositiveInt('0', { fallback: 5, min: 0 })).toEqual({ ok: true, value: 0, usedFallback: false })
  })

  it('遵守 max 上界', () => {
    expect(parsePositiveInt('70000', { fallback: 8787, max: 65535 }).ok).toBe(false)
    expect(parsePositiveInt('65535', { fallback: 8787, max: 65535 }).value).toBe(65535)
  })
})

describe('sanitizeMimeType', () => {
  it('保留标准 mime', () => {
    expect(sanitizeMimeType('text/markdown')).toBe('text/markdown')
    expect(sanitizeMimeType('TEXT/Plain')).toBe('text/plain')
    expect(sanitizeMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  })

  it('去掉参数部分', () => {
    expect(sanitizeMimeType('text/plain; charset=utf-8')).toBe('text/plain')
  })

  it('含控制字符的畸形值被中和（防响应头注入，不再让该文件永久下载 400）', () => {
    expect(sanitizeMimeType('text/plain\r\nX-Injected: 1')).toBe('application/octet-stream')
    expect(sanitizeMimeType('text/plain\n')).toBe('text/plain')
  })

  it('任何输入的结果都不含控制字符且形如 type/subtype', () => {
    const cases = [
      'text/plain\r\nX-Injected: 1',
      'text/\rhtml',
      'a\r\nb/c',
      'text/plain; charset=utf-8',
      '\u0000application/json',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]

    for (const value of cases) {
      const result = sanitizeMimeType(value)
      const hasControlChar = Array.from(result).some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
      expect(hasControlChar).toBe(false)
      expect(result).toMatch(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u)
    }
  })

  it('畸形值回退为 application/octet-stream', () => {
    expect(sanitizeMimeType('')).toBe('application/octet-stream')
    expect(sanitizeMimeType(undefined)).toBe('application/octet-stream')
    expect(sanitizeMimeType('noslash')).toBe('application/octet-stream')
    expect(sanitizeMimeType('/')).toBe('application/octet-stream')
    expect(sanitizeMimeType('text/plain extra')).toBe('application/octet-stream')
  })
})

describe('truncateUtf8', () => {
  it('未超限时原样返回', () => {
    expect(truncateUtf8('abc', 10)).toEqual({ text: 'abc', truncated: false })
  })

  it('按 UTF-8 字节截断且不切出半个码点', () => {
    // 每个中文字符 3 字节；限 7 字节只能装下 2 个字符
    const result = truncateUtf8('中文中文', 7)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('中文')
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(7)
  })

  it('空值安全', () => {
    expect(truncateUtf8(null, 10)).toEqual({ text: '', truncated: false })
    expect(truncateUtf8(undefined, 10)).toEqual({ text: '', truncated: false })
  })
})

describe('sanitizeRoomId', () => {
  it('接受合法房间 ID', () => {
    expect(sanitizeRoomId('demo-room')).toBe('demo-room')
    expect(sanitizeRoomId('abc_123-xyz')).toBe('abc_123-xyz')
    expect(sanitizeRoomId('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toHaveLength(32)
  })

  it('去除首尾空白', () => {
    expect(sanitizeRoomId('  demo-room  ')).toBe('demo-room')
  })

  it('长度下限为 8（房间 ID 是发送方唯一能力凭据）', () => {
    expect(sanitizeRoomId('abcdefgh')).toBe('abcdefgh')
    expect(sanitizeRoomId('abcdefg')).toBeNull()
    expect(sanitizeRoomId('room1')).toBeNull()
  })

  it('拒绝过短 / 非法字符 / 超长 / 非字符串', () => {
    expect(sanitizeRoomId('ab')).toBeNull()
    expect(sanitizeRoomId('room/../etc')).toBeNull()
    expect(sanitizeRoomId('a'.repeat(65))).toBeNull()
    expect(sanitizeRoomId(null)).toBeNull()
    expect(sanitizeRoomId(undefined)).toBeNull()
  })
})

describe('isWeakRoomId', () => {
  it('UUID 视为强', () => {
    expect(isWeakRoomId('2a1bc04f-ca01-420b-a3f9-7e6f22a4daa4')).toBe(false)
    expect(isWeakRoomId('2A1BC04F-CA01-420B-A3F9-7E6F22A4DAA4')).toBe(false)
  })

  it('常见弱命名视为弱', () => {
    expect(isWeakRoomId('demo-room')).toBe(true)
    expect(isWeakRoomId('Demo-Room')).toBe(true)
    expect(isWeakRoomId('test-room')).toBe(true)
  })

  it('字符种类单一或过短视为弱', () => {
    expect(isWeakRoomId('abcdefghij')).toBe(true)
    expect(isWeakRoomId('1234567890')).toBe(true)
    expect(isWeakRoomId('abc12345')).toBe(true)
  })

  it('混合字符且足够长视为强', () => {
    expect(isWeakRoomId('class-2026-A')).toBe(false)
    expect(isWeakRoomId('2026-class-3a')).toBe(false)
  })

  it('空值视为弱', () => {
    expect(isWeakRoomId('')).toBe(true)
    expect(isWeakRoomId(undefined)).toBe(true)
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

  it('拒绝 ?token= 查询参数（长期密钥不得进 URL）', () => {
    const auth = makeAuthorizer('secret')
    expect(auth({ headers: {}, url: '/api/rooms/x/events?token=secret' })).toBe(false)
    expect(auth({ headers: {}, url: '/api/rooms?token=secret' })).toBe(false)
  })

  it('拒绝裸 token，必须是 Bearer 形式', () => {
    const auth = makeAuthorizer('secret')
    expect(auth({ headers: { authorization: 'secret' }, url: '/' })).toBe(false)
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

describe('makeTicketStore', () => {
  it('签发的票据可用且一次性', () => {
    const store = makeTicketStore()
    const ticket = store.issue('room-a')
    expect(store.consume(ticket, 'room-a')).toBe(true)
    expect(store.consume(ticket, 'room-a')).toBe(false)
  })

  it('房间不匹配拒绝', () => {
    const store = makeTicketStore()
    const ticket = store.issue('room-a')
    expect(store.consume(ticket, 'room-b')).toBe(false)
  })

  it('过期票据拒绝', () => {
    let clock = 1_000
    const store = makeTicketStore({ ttlMs: 100, now: () => clock })
    const ticket = store.issue('room-a')
    clock = 1_101
    expect(store.consume(ticket, 'room-a')).toBe(false)
  })

  it('空票据拒绝', () => {
    const store = makeTicketStore()
    expect(store.consume(null, 'room-a')).toBe(false)
    expect(store.consume(undefined, 'room-a')).toBe(false)
  })
})
