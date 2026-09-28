import { describe, expect, it } from 'vitest'
import { parseRelayBaseUrl, RELAY_BASE_URL_REASON } from './relay-base-url.js'

/**
 * 这是判据的**直接**测试 —— 服务端（`server/relay-utils.js`）与前端（`src/utils/relay.ts`）
 * 都只是本模块的薄包装，它们各自的测试验证的是「文案/返回形态映射」，判定本身由这里锁死。
 */
describe('parseRelayBaseUrl', () => {
  it('未设置 / 空白 = 合法但不配置基址', () => {
    for (const raw of [undefined, null, '', '   ']) {
      expect(parseRelayBaseUrl(raw)).toEqual({ ok: true, value: null, reason: 'empty', raw: '' })
    }
  })

  it('http(s) 绝对地址合法，并去掉尾部斜杠（含连续斜杠）', () => {
    expect(parseRelayBaseUrl('https://relay.example.com')).toEqual({
      ok: true,
      value: 'https://relay.example.com',
      reason: '',
      raw: 'https://relay.example.com'
    })
    expect(parseRelayBaseUrl('https://relay.example.com/').value).toBe('https://relay.example.com')
    expect(parseRelayBaseUrl('https://relay.example.com//').value).toBe('https://relay.example.com')
    expect(parseRelayBaseUrl('  http://127.0.0.1:8787  ').value).toBe('http://127.0.0.1:8787')
  })

  it('保留路径前缀（反代常把 relay 挂在子路径下）', () => {
    expect(parseRelayBaseUrl('https://example.com/relay').value).toBe('https://example.com/relay')
    expect(parseRelayBaseUrl('https://example.com/relay/').value).toBe('https://example.com/relay')
  })

  it('归一即是输出：点段折叠、scheme/host 小写，校验的串就是返回的串', () => {
    expect(parseRelayBaseUrl('http://x/../y').value).toBe('http://x/y')
    expect(parseRelayBaseUrl('HTTP://Relay.Example.COM').value).toBe('http://relay.example.com')
    expect(parseRelayBaseUrl('http:///x').value).toBe('http://x')
  })

  it.each([
    ['裸域名（缺 scheme）', 'relay.example.com', RELAY_BASE_URL_REASON.UNPARSABLE],
    ['协议相对地址', '//evil.example', RELAY_BASE_URL_REASON.UNPARSABLE],
    ['同源相对路径', '/relay', RELAY_BASE_URL_REASON.UNPARSABLE],
    ['单独一个斜杠', '/', RELAY_BASE_URL_REASON.UNPARSABLE],
    ['无 host', 'http://', RELAY_BASE_URL_REASON.UNPARSABLE],
    ['含空格', 'https://a b.example.com', RELAY_BASE_URL_REASON.UNPARSABLE],
    ['非 http(s) 协议', 'ftp://example.com', RELAY_BASE_URL_REASON.SCHEME],
    ['javascript:', 'javascript:alert(1)', RELAY_BASE_URL_REASON.SCHEME],
    ['data:', 'data:text/html,x', RELAY_BASE_URL_REASON.SCHEME],
    ['带用户名密码', 'https://user:pass@example.com', RELAY_BASE_URL_REASON.CREDENTIALS],
    ['只带用户名', 'https://user@example.com', RELAY_BASE_URL_REASON.CREDENTIALS],
    ['带查询串', 'https://example.com/?x=1', RELAY_BASE_URL_REASON.QUERY_OR_HASH],
    ['带 hash', 'https://example.com/#x', RELAY_BASE_URL_REASON.QUERY_OR_HASH],
    // 尾随分隔符解析出的 search / hash 是空串，只看解析结果会漏判 —— 必须按原始输入判定
    ['尾随问号', 'https://example.com/relay?', RELAY_BASE_URL_REASON.QUERY_OR_HASH],
    ['尾随井号', 'https://example.com/relay#', RELAY_BASE_URL_REASON.QUERY_OR_HASH]
  ])('非法值 fail-closed：%s', (_label, raw, reason) => {
    const result = parseRelayBaseUrl(raw)
    expect(result.ok).toBe(false)
    expect(result.value).toBeNull()
    expect(result.reason).toBe(reason)
    expect(result.raw).toBe(raw)
  })
})
