import { describe, expect, it } from 'vitest'
import { normalizeRelayUrl, resolveRelayUrl, UntrustedRelayUrlError, validateRelayUrl } from './relay'

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

  it('协议相对地址（//host）走同源检查：跨源直接拒绝，同源则按基址协议正确解析', () => {
    expect(() => resolveRelayUrl('//evil.example/x', BASE)).toThrow(UntrustedRelayUrlError)
    // 同源时补上基址协议解析，而不是拼成 `base//host/...` 这种垃圾路径
    expect(resolveRelayUrl('//127.0.0.1:8787/api/rooms/r1', BASE))
      .toBe('http://127.0.0.1:8787/api/rooms/r1')
  })

  it('反斜杠形态不能绕过源判定（浏览器把 `\\` 当 `/`）', () => {
    expect(() => resolveRelayUrl('/\\evil.example/x', BASE)).toThrow(UntrustedRelayUrlError)
    expect(() => resolveRelayUrl('\\\\evil.example\\x', BASE)).toThrow(UntrustedRelayUrlError)
  })

  it('userinfo 伪装不能混淆源；同源 userinfo 会被剥离（fetch 不接受含凭据的 URL）', () => {
    expect(() => resolveRelayUrl('http://relay.example.com@evil.example/x', BASE))
      .toThrow(UntrustedRelayUrlError)
    expect(resolveRelayUrl('http://user:pass@127.0.0.1:8787/api/x', BASE))
      .toBe('http://127.0.0.1:8787/api/x')
  })

  it('制表符 / 换行 / 空白包裹不能绕过源判定', () => {
    expect(() => resolveRelayUrl('http://evil.example\t/api', BASE)).toThrow(UntrustedRelayUrlError)
    expect(() => resolveRelayUrl('  //evil.example/x  ', BASE)).toThrow(UntrustedRelayUrlError)
  })

  it('大小写不改变源判定', () => {
    expect(resolveRelayUrl('HTTP://127.0.0.1:8787/api/x', BASE)).toBe('http://127.0.0.1:8787/api/x')
    expect(() => resolveRelayUrl('HTTP://EVIL.EXAMPLE/api', BASE)).toThrow(UntrustedRelayUrlError)
  })

  it('非 http(s) 协议一律拒绝', () => {
    expect(() => resolveRelayUrl('ftp://127.0.0.1:8787/x', BASE)).toThrow(UntrustedRelayUrlError)
    expect(() => resolveRelayUrl('javascript:alert(1)', BASE)).toThrow(UntrustedRelayUrlError)
    expect(() => resolveRelayUrl('data:text/html,<p>x</p>', BASE)).toThrow(UntrustedRelayUrlError)
  })

  it('基址不可解析时拒绝（绝不回退到页面自身 origin）', () => {
    expect(() => resolveRelayUrl('http://127.0.0.1:8787/api', 'not a url')).toThrow(UntrustedRelayUrlError)
  })

  it('空地址与畸形地址被拒绝', () => {
    expect(() => resolveRelayUrl('   ', BASE)).toThrow(UntrustedRelayUrlError)
    expect(() => resolveRelayUrl('not a url', BASE)).toThrow(UntrustedRelayUrlError)
  })

  it('未配置 Relay 地址时报错', () => {
    expect(() => resolveRelayUrl('/api/x', '')).toThrow('未配置 Relay 地址')
  })

  /**
   * 「未配置」与「配置错」对应两种不同的用户动作：前者去填地址，后者去改地址。
   * 归一后两者都得到空串，所以这里必须直接看判据结果来区分，不能只看归一值。
   */
  it('基址「空」与「形态非法」被区分：前者提示未配置，后者提示不合法', () => {
    expect(() => resolveRelayUrl('/api/x', '   ')).toThrow('未配置 Relay 地址')
    expect(() => resolveRelayUrl('/api/x', 'https://a.example/?x=1')).toThrow(UntrustedRelayUrlError)
    expect(() => resolveRelayUrl('/api/x', 'https://a.example/?x=1')).toThrow(/不合法/u)
  })
})

describe('normalizeRelayUrl', () => {
  it('合法地址归一：去首尾空白与尾部斜杠、折叠点段、小写化 scheme 与主机', () => {
    expect(normalizeRelayUrl('  http://a.example//  ')).toBe('http://a.example')
    expect(normalizeRelayUrl('https://a.example/relay/')).toBe('https://a.example/relay')
    expect(normalizeRelayUrl('HTTP://Relay.Example.COM')).toBe('http://relay.example.com')
  })

  it('非法地址**不**被悄悄改写成合法值，而是返回空串（交回校验环节报错）', () => {
    // 旧版会剥掉查询串后返回 `https://a.example`，让 validateRelayUrl 的判据形同虚设
    expect(normalizeRelayUrl('https://a.example/relay?x=1#y')).toBe('')
    expect(normalizeRelayUrl('https://a.example/?x=1')).toBe('')
    expect(normalizeRelayUrl('relay.example.com')).toBe('')
    expect(normalizeRelayUrl('   ')).toBe('')
  })
})

/**
 * 构建期注入的 `VITE_RELAY_URL` 没有任何运行期输入校验兜底，因此这里锁死它的合法形态。
 * 两类「凭据打错地方」的值必须被拒绝：协议相对地址（外部主机）、无 scheme 的裸域名
 * （会被当成页面相对路径，静默打到静态站自己身上）。
 *
 * 判定本身来自 `shared/relay-base-url.js`，与构建守卫（`scripts/check-no-secrets.mjs`）、
 * 服务端启动检查（`server/relay-utils.js` 的 `parsePublicBaseUrl`）**共用同一份实现**；
 * 这里断言的是「非法输入映射出的文案非空」，判定细节由 `shared/relay-base-url.test.js` 锁死。
 * 唯一无法复用该模块的是 CI 门禁（`.github/workflows/deploy.yml`）的 shell `case` 块。
 *
 * 曾经放行的同源相对路径 `/relay` 已移除，且**必须保持被拒绝** —— 若有人把它加回来，
 * 这里先失败，而不是等 CI 拒发版本时才发现。
 */
describe('validateRelayUrl', () => {
  it('接受绝对 http(s) 地址（含带路径前缀的同域子路径）', () => {
    expect(validateRelayUrl('https://relay.example.com')).toBe('')
    expect(validateRelayUrl('http://127.0.0.1:8787')).toBe('')
    expect(validateRelayUrl('https://app.example.com/relay')).toBe('')
  })

  it('拒绝同源相对路径（判据与 CI 门禁一致）', () => {
    expect(validateRelayUrl('/relay')).not.toBe('')
    expect(validateRelayUrl('/')).not.toBe('')
  })

  it('拒绝协议相对地址、裸域名、非 http(s) 协议与空值', () => {
    expect(validateRelayUrl('//evil.example')).not.toBe('')
    expect(validateRelayUrl('relay.example.com')).not.toBe('')
    expect(validateRelayUrl('javascript:alert(1)')).not.toBe('')
    expect(validateRelayUrl('data:text/html,x')).not.toBe('')
    expect(validateRelayUrl('   ')).not.toBe('')
  })

  it('拒绝带查询串 / hash / 凭据的地址（判定与服务端一致）', () => {
    // 查询串会把后续拼接的路径吞进 query；基址里的凭据则会让同源判定失去意义
    expect(validateRelayUrl('https://a.example/?x=1')).not.toBe('')
    expect(validateRelayUrl('https://a.example/relay#')).not.toBe('')
    expect(validateRelayUrl('https://user:pass@a.example')).not.toBe('')
  })
})
