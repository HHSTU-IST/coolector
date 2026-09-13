import { describe, expect, it } from 'vitest'
import { normalizeRelayUrl, resolveRelayUrl, UntrustedRelayUrlError } from './relay'

const BASE = 'http://127.0.0.1:8787'

describe('resolveRelayUrl', () => {
  it('相对路径拼到配置的 Relay 地址上（服务端默认形态）', () => {
    expect(resolveRelayUrl('/api/rooms/r1/uploads/u1', BASE))
      .toBe('http://127.0.0.1:8787/api/rooms/r1/uploads/u1')
  })

  it('基址带路径前缀（反代挂在子路径下）也能正确拼接', () => {
    expect(resolveRelayUrl('/api/rooms/r1', 'https://example.com/relay/'))
      .toBe('https://example.com/relay/api/rooms/r1')
  })

  it('同源的绝对地址被接受（兼容旧版服务端）', () => {
    expect(resolveRelayUrl('http://127.0.0.1:8787/api/rooms/r1', BASE))
      .toBe('http://127.0.0.1:8787/api/rooms/r1')
  })

  /**
   * F-001 的第二道防线：即使服务端某条路径返回了外部地址，也绝不带着凭据去请求它。
   * 第一道防线是服务端不再用 Host 拼 URL；两道合起来才是「修到底」。
   */
  it('跨源绝对地址被拒绝', () => {
    expect(() => resolveRelayUrl('http://evil.example/api/rooms/r1', BASE))
      .toThrow(UntrustedRelayUrlError)
    expect(() => resolveRelayUrl('http://evil.example/api/rooms/r1', BASE))
      .toThrow(/非配置的 Relay 源/u)
  })

  it('协议或端口不同即视为跨源', () => {
    expect(() => resolveRelayUrl('https://127.0.0.1:8787/api', BASE)).toThrow(UntrustedRelayUrlError)
    expect(() => resolveRelayUrl('http://127.0.0.1:9999/api', BASE)).toThrow(UntrustedRelayUrlError)
  })

  it('协议相对地址（//host）不会被当作出站请求', () => {
    const resolved = resolveRelayUrl('//evil.example/x', BASE)
    expect(new URL(resolved).origin).toBe('http://127.0.0.1:8787')
  })

  it('空地址与畸形地址被拒绝', () => {
    expect(() => resolveRelayUrl('   ', BASE)).toThrow(UntrustedRelayUrlError)
    expect(() => resolveRelayUrl('not a url', BASE)).toThrow(UntrustedRelayUrlError)
  })

  it('未配置 Relay 地址时报错', () => {
    expect(() => resolveRelayUrl('/api/x', '')).toThrow('未配置 Relay 地址')
  })
})

describe('normalizeRelayUrl', () => {
  it('去掉首尾空白与尾部斜杠', () => {
    expect(normalizeRelayUrl('  http://a.example//  ')).toBe('http://a.example')
  })
})
