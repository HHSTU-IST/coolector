// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DOCX_MIME, buildZip, buildDocumentXml } from '../scripts/lib/docx-fixture.mjs'
import {
  contentDisposition,
  decodeHeaderValue,
  decodeUploadFileName,
  deriveUploadText,
  digestName,
  isBindableHost,
  isLoopbackHost,
  isTextMimeType,
  isWeakRoomId,
  limitUploadName,
  makeAuthorizer,
  makeClientIpResolver,
  makeCorsHeaders,
  makeTicketStore,
  normalizeAllowedOrigins,
  normalizeIsoDate,
  parsePositiveInt,
  parsePublicBaseUrl,
  parseTrustedProxies,
  sanitizeMimeType,
  sanitizeRoomId,
  sanitizeStorageFileName,
  truncateUtf8
} from './relay-utils.js'

/**
 * `IncomingMessage` 替身。
 *
 * `makeAuthorizer` / `makeCorsHeaders` 实际只读 `headers` 与 `url`，而 `IncomingMessage` 是个庞大的类
 * （socket / method / 一堆事件方法）。这里集中做一次「只喂了这几个字段」的断言，好过在每个调用点各写
 * 一次 —— 那也正是这类替身最容易在类型收紧时集体失真的地方。
 *
 * @param {{ headers?: Record<string, string | undefined>, url?: string }} [init]
 * @returns {import('node:http').IncomingMessage}
 */
const makeReq = ({ headers = {}, url = '/' } = {}) => /** @type {any} */ ({ headers, url })

describe('parsePublicBaseUrl', () => {
  it('未设置 / 空白视为「不配置基址」，合法且值为 null', () => {
    for (const raw of [undefined, null, '', '   ']) {
      expect(parsePublicBaseUrl(raw)).toEqual({ ok: true, value: null })
    }
  })

  it('http(s) 绝对地址合法，并去掉尾部斜杠', () => {
    expect(parsePublicBaseUrl('https://relay.example.com')).toEqual({ ok: true, value: 'https://relay.example.com' })
    expect(parsePublicBaseUrl('https://relay.example.com/')).toEqual({ ok: true, value: 'https://relay.example.com' })
    expect(parsePublicBaseUrl('  http://127.0.0.1:8787  ')).toEqual({ ok: true, value: 'http://127.0.0.1:8787' })
  })

  it('保留路径前缀（反代常把 Relay 挂在子路径下）', () => {
    expect(parsePublicBaseUrl('https://example.com/relay')).toEqual({ ok: true, value: 'https://example.com/relay' })
    expect(parsePublicBaseUrl('https://example.com/relay/')).toEqual({ ok: true, value: 'https://example.com/relay' })
  })

  it('返回规范化后的 href —— 校验的串必须就是输出的串', () => {
    expect(parsePublicBaseUrl('http://x/../y')).toEqual({ ok: true, value: 'http://x/y' })
  })

  it.each([
    ['非 http(s) 协议', 'ftp://example.com'],
    ['不是 URL', 'example.com'],
    ['裸相对路径', '/relay'],
    ['带用户名密码', 'https://user:pass@example.com'],
    ['带查询串', 'https://example.com/?x=1'],
    ['带 hash', 'https://example.com/#x'],
    // 尾随分隔符：解析出的 search / hash 是**空串**，只看解析结果会漏判，
    // 而保留原样的 `.../relay?` 会拼出 `.../relay?/api/x`（路径被吞进 query）
    ['尾随问号', 'https://example.com/relay?'],
    ['尾随井号', 'https://example.com/relay#']
  ])('非法值 fail-closed：%s', (_label, raw) => {
    const result = parsePublicBaseUrl(raw)
    expect(result.ok).toBe(false)
    expect(result.value).toBeNull()
  })
})

describe('normalizeIsoDate', () => {
  it('合法日期归一为 ISO', () => {
    expect(normalizeIsoDate('2026-09-13T00:00:00.000Z', 'fallback')).toBe('2026-09-13T00:00:00.000Z')
    expect(normalizeIsoDate('2026-09-13', 'fallback')).toBe('2026-09-13T00:00:00.000Z')
  })

  it('非法值回退到缺省值', () => {
    expect(normalizeIsoDate('not-a-date', 'fallback')).toBe('fallback')
    expect(normalizeIsoDate('', 'fallback')).toBe('fallback')
    expect(normalizeIsoDate(undefined, 'fallback')).toBe('fallback')
    expect(normalizeIsoDate('x'.repeat(4096), 'fallback')).toBe('fallback')
  })
})

describe('limitUploadName', () => {
  it('未超限时原样返回', () => {
    expect(limitUploadName('张三-20230101.md', 255)).toEqual({ name: '张三-20230101.md', truncated: false })
  })

  it('超限时截断并保留扩展名', () => {
    const result = limitUploadName(`${'n'.repeat(4096)}.docx`, 64)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.name, 'utf8')).toBeLessThanOrEqual(64)
    expect(result.name.endsWith('.docx')).toBe(true)
  })

  it('无扩展名时直接截断', () => {
    const result = limitUploadName('文'.repeat(500), 32)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.name, 'utf8')).toBeLessThanOrEqual(32)
  })

  it('上限极小时不会为了保留扩展名而越界', () => {
    const longName = `${'a'.repeat(60)}.md`

    for (const maxBytes of [1, 2, 3, 4, 8, 16, 32]) {
      const result = limitUploadName(longName, maxBytes)
      expect(result.truncated).toBe(true)
      expect(Buffer.byteLength(result.name, 'utf8')).toBeLessThanOrEqual(maxBytes)
    }
  })

  it('空值安全', () => {
    expect(limitUploadName('', 32)).toEqual({ name: '', truncated: false })
    expect(limitUploadName(undefined, 32)).toEqual({ name: '', truncated: false })
  })
})

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

  it('超长 mimeType 回落为 octet-stream（否则下载响应头会溢出、该文件永久无法下载）', () => {
    expect(sanitizeMimeType(`application/${'a'.repeat(127)}`)).toBe(`application/${'a'.repeat(127)}`)
    expect(sanitizeMimeType(`application/${'a'.repeat(128)}`)).toBe('application/octet-stream')
    expect(sanitizeMimeType(`${'a'.repeat(200)}/json`)).toBe('application/octet-stream')
    expect(sanitizeMimeType(`application/${'a'.repeat(200000)}`)).toBe('application/octet-stream')
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

describe('decodeUploadFileName', () => {
  it('latin1 直传的 UTF-8 字节还原（curl 路径）', () => {
    const latin1 = Buffer.from('赵六-20230104.json', 'utf8').toString('latin1')
    expect(decodeUploadFileName(latin1)).toBe('赵六-20230104.json')
  })

  it('百分号编码还原（此前被静默存成 %E8%B5%B5… 的那条）', () => {
    expect(decodeUploadFileName(encodeURIComponent('赵六-20230104.json'))).toBe('赵六-20230104.json')
  })

  it('纯 ASCII 的 %XX 原样保留 —— 不把合法文件名悄悄改掉', () => {
    for (const literal of ['note%20f.md', 'a%2Fb.txt', 'v1%2E0.md']) {
      expect(decodeUploadFileName(literal)).toBe(literal)
    }
  })

  it('残缺转义按字面量处理，不抛错', () => {
    for (const literal of ['100%.txt', '100%2.txt', '%zz.md', '%']) {
      expect(decodeUploadFileName(literal)).toBe(literal)
    }
  })

  it('非法 UTF-8 转义（%FF）按字面量处理', () => {
    expect(decodeUploadFileName('%FF.md')).toBe('%FF.md')
  })

  it('纯 ASCII 名与缺失值不变', () => {
    expect(decodeUploadFileName('report.md')).toBe('report.md')
    expect(decodeUploadFileName('')).toBe('')
    expect(decodeUploadFileName(undefined)).toBeUndefined()
  })
})

describe('normalizeAllowedOrigins', () => {
  it('未配置 / 空白 = 不给任何来源发 CORS 头（不再默认 *）', () => {
    expect(normalizeAllowedOrigins('')).toEqual([])
    expect(normalizeAllowedOrigins(undefined)).toEqual([])
    expect(normalizeAllowedOrigins('   ')).toEqual([])
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

/**
 * `deriveUploadText` 是「字节 → 可读正文」的**唯一**实现：上传路径与 `detailsUrl` 都调它。
 * 它一旦分叉出第二份实现，就会出现「刚上传时预览有正文、重启后拉正文变空」这类怪象。
 */
describe('deriveUploadText', () => {
  it('文本类按 UTF-8 解码（MIME 缺失时靠扩展名）', () => {
    const bytes = Buffer.from('作业正文：梯度下降', 'utf8')

    expect(deriveUploadText(bytes, 'text/markdown', 'a.md')).toBe('作业正文：梯度下降')
    expect(deriveUploadText(bytes, 'application/octet-stream', 'a.md')).toBe('作业正文：梯度下降')
  })

  it('docx 解压出正文（MIME 不可靠时靠扩展名）', () => {
    const bytes = buildZip([{ name: 'word/document.xml', content: buildDocumentXml(['第一段', '第二段']) }])

    expect(deriveUploadText(bytes, DOCX_MIME, '张三.docx')).toBe('第一段\n第二段')
    expect(deriveUploadText(bytes, 'application/octet-stream', '张三.DOCX')).toBe('第一段\n第二段')
  })

  it('非文本非 docx 返回 null（不是空串 —— 空串会与「0 字节文本文件」混淆）', () => {
    expect(deriveUploadText(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png', 'a.png')).toBeNull()
  })

  it('名字像 docx 但内容不是 zip 时返回 null，不抛异常', () => {
    expect(deriveUploadText(Buffer.from('not a zip at all'), DOCX_MIME, 'a.docx')).toBeNull()
  })

  it('非 Buffer 入参返回 null（fail-closed）', () => {
    // **故意违约**：`bytes` 声明为 Buffer，而这里验的正是运行时守卫本身。用断言表达「刻意违约」，
    // 而不是把生产签名放宽成 unknown —— 后者会让所有真实调用点一并失去检查。
    expect(deriveUploadText(/** @type {any} */ ('纯文本'), 'text/plain', 'a.txt')).toBeNull()
    expect(deriveUploadText(/** @type {any} */ (undefined), 'text/plain', 'a.txt')).toBeNull()
  })
})

describe('makeAuthorizer', () => {
  it('未配置 token 时全放行', () => {
    const auth = makeAuthorizer('')
    expect(auth(makeReq())).toBe(true)
  })

  it('Bearer 头放行', () => {
    const auth = makeAuthorizer('secret')
    expect(auth(makeReq({ headers: { authorization: 'Bearer secret' } }))).toBe(true)
  })

  it('拒绝 ?token= 查询参数（长期密钥不得进 URL）', () => {
    const auth = makeAuthorizer('secret')
    expect(auth(makeReq({ url: '/api/rooms/x/events?token=secret' }))).toBe(false)
    expect(auth(makeReq({ url: '/api/rooms?token=secret' }))).toBe(false)
  })

  it('拒绝裸 token，必须是 Bearer 形式', () => {
    const auth = makeAuthorizer('secret')
    expect(auth(makeReq({ headers: { authorization: 'secret' } }))).toBe(false)
  })

  it('错误 token 拒绝', () => {
    const auth = makeAuthorizer('secret')
    expect(auth(makeReq({ headers: { authorization: 'Bearer wrong' } }))).toBe(false)
  })

  it('长度不同的凭据直接拒绝且不抛异常（恒定时间比较的前置条件）', () => {
    const auth = makeAuthorizer('secret')
    expect(auth(makeReq({ headers: { authorization: 'Bearer s' } }))).toBe(false)
    expect(auth(makeReq({ headers: { authorization: '' } }))).toBe(false)
  })
})

describe('digestName', () => {
  it('同一文件名得同一摘要，不同文件名不同，长度固定', () => {
    expect(digestName('张三-20230101.md')).toBe(digestName('张三-20230101.md'))
    expect(digestName('张三-20230101.md')).not.toBe(digestName('李四-20230102.md'))
    expect(digestName('张三-20230101.md')).toHaveLength(12)
  })

  it('摘要里不含原始姓名（审计日志不落 PII）', () => {
    const digest = digestName('张三-20230101.md')
    expect(digest).not.toContain('张三')
    expect(digest).toMatch(/^[0-9a-f]{12}$/u)
  })
})

describe('makeCorsHeaders', () => {
  it('* 白名单返回任意来源', () => {
    const cors = makeCorsHeaders(['*'])
    const headers = cors(makeReq({ headers: { origin: 'https://x.com' } }))
    expect(headers['Access-Control-Allow-Origin']).toBe('*')
  })

  it('非白名单来源返回空对象', () => {
    const cors = makeCorsHeaders(['https://ok.com'])
    expect(cors(makeReq({ headers: { origin: 'https://evil.com' } }))).toEqual({})
  })

  it('白名单来源返回该来源并带 Vary', () => {
    const cors = makeCorsHeaders(['https://ok.com'])
    const headers = cors(makeReq({ headers: { origin: 'https://ok.com' } }))
    expect(headers['Access-Control-Allow-Origin']).toBe('https://ok.com')
    expect(headers.Vary).toBe('Origin')
  })

  it('空白名单（未配置）不给任何来源 —— 默认不放开跨源', () => {
    const cors = makeCorsHeaders([])
    expect(cors(makeReq({ headers: { origin: 'https://x.com' } }))).toEqual({})
    expect(cors(makeReq())).toEqual({})
  })
})

/**
 * 可信代理与限流分桶。
 *
 * 这里守的是一个真实可用性问题：反代后 socket 地址恒为代理 IP，若不按客户端分桶，
 * 单个滥用者足以让全班 429；而直连时若采信 X-Forwarded-For，攻击者可以随便换桶绕过限流。
 */
describe('parseTrustedProxies / makeClientIpResolver', () => {
  /**
   * @param {string} remoteAddress
   * @param {string} [forwardedFor]
   * @returns {import('node:http').IncomingMessage}
   */
  const req = (remoteAddress, forwardedFor) => /** @type {any} */ ({
    socket: { remoteAddress },
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }
  })

  /**
   * @param {string} raw
   * @returns {(req: import('node:http').IncomingMessage) => string}
   */
  const resolverFor = (raw) => makeClientIpResolver(parseTrustedProxies(raw).list)

  it('接受 IP 与 CIDR（含 IPv6），非法条目上报而非静默忽略', () => {
    expect(parseTrustedProxies('127.0.0.1, 10.0.0.0/8, ::1').invalid).toEqual([])
    expect(parseTrustedProxies('10.0.0.0/33, not-an-ip, 10.0.0.0/abc').invalid)
      .toEqual(['10.0.0.0/33', 'not-an-ip', '10.0.0.0/abc'])
  })

  it('未配置可信代理时忽略 X-Forwarded-For（直连语义，防伪造换桶）', () => {
    expect(resolverFor('')(req('203.0.113.7', '1.2.3.4'))).toBe('203.0.113.7')
  })

  it('socket 命中可信代理时从右往左取第一个不可信 IP（跳过可信跳）', () => {
    const resolve = resolverFor('10.0.0.0/8')
    expect(resolve(req('10.0.0.9', '203.0.113.7, 10.0.0.9'))).toBe('203.0.113.7')
    expect(resolve(req('10.0.0.9', 'not-an-ip, 203.0.113.7'))).toBe('203.0.113.7')
    // 没有可用 XFF 时回退 socket 地址，绝不把任意字符串当 IP 用
    expect(resolve(req('10.0.0.9', 'garbage'))).toBe('10.0.0.9')
    expect(resolve(req('10.0.0.9'))).toBe('10.0.0.9')
  })

  it('追加式 XFF 下取真实客户端：伪造的最左值换不掉桶', () => {
    const resolve = resolverFor('10.0.0.0/8')
    // 单代理追加形态：客户端伪造 9.9.9.9，代理在右侧追加它见证到的直接对端
    expect(resolve(req('10.0.0.9', '9.9.9.9, 203.0.113.7'))).toBe('203.0.113.7')
    // 多级可信代理链：连续跳过可信跳后停在真实客户端
    expect(resolve(req('10.0.0.2', '9.9.9.9, 203.0.113.7, 10.0.0.1'))).toBe('203.0.113.7')
    // 攻击者把可信网段内的地址也塞进 XFF：仍在最右侧的真实来源处停下
    expect(resolve(req('10.0.0.9', '9.9.9.9, 203.0.113.7, 10.0.0.1, 10.0.0.2'))).toBe('203.0.113.7')
  })

  it('XFF 全是可信跳或全是非法段时回退 socket 地址', () => {
    const resolve = resolverFor('10.0.0.0/8')
    expect(resolve(req('10.0.0.9', '10.0.0.1, 10.0.0.2'))).toBe('10.0.0.9')
    expect(resolve(req('10.0.0.9', ', , '))).toBe('10.0.0.9')
  })

  it('双栈监听下的 IPv4-mapped 地址也能命中 IPv4 网段', () => {
    expect(resolverFor('127.0.0.0/8')(req('::ffff:127.0.0.1', '203.0.113.7'))).toBe('203.0.113.7')
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

describe('isBindableHost', () => {
  // 这个函数只在「值会被拼进 shell 命令行」时被调用（server/start.js 的 vite 命令），
  // 所以下面的用例分两类：合法的常见取值必须放行，任何能被 shell 当语法解释的字符必须拒绝。
  it('放行常见的主机名与 IP 字面量', () => {
    for (const host of ['0.0.0.0', '127.0.0.1', '::', '::1', '[::1]', 'localhost', 'relay.example.com', 'my-host.local']) {
      expect(isBindableHost(host)).toBe(true)
    }
  })

  it('拒绝所有含 shell 元字符的值 —— 否则 .env 里的一行就能执行第二条命令', () => {
    for (const host of [
      '0.0.0.0 & calc',
      '0.0.0.0;ls',
      '0.0.0.0|ls',
      '0.0.0.0$(id)',
      '0.0.0.0`id`',
      '0.0.0.0%PATH%',
      '"0.0.0.0"',
      "'0.0.0.0'",
      '0.0.0.0>out',
      '0.0.0.0*',
      '0.0.0.0\n& calc',
      '../etc/passwd',
      'host=1'
    ]) {
      expect(isBindableHost(host)).toBe(false)
    }
  })

  it('拒绝空值 —— 监听地址必须是显式决定，空串不当作「监听全部网卡」', () => {
    expect(isBindableHost('')).toBe(false)
    expect(isBindableHost('   ')).toBe(false)
    expect(isBindableHost(undefined)).toBe(false)
    expect(isBindableHost(null)).toBe(false)
  })

  it('拒绝超长值（DNS 名上限 253）', () => {
    expect(isBindableHost('a'.repeat(253))).toBe(true)
    expect(isBindableHost('a'.repeat(254))).toBe(false)
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

  it('房间不匹配时**不烧票**（先校验后删，避免无关请求把有效票据销毁）', () => {
    const store = makeTicketStore()
    const ticket = store.issue('room-a')

    expect(store.consume(ticket, 'room-b')).toBe(false)
    // 拿 A 的票去打 B 之后，A 的票必须还能用
    expect(store.consume(ticket, 'room-a')).toBe(true)
    // 但用掉之后就真的没了（一次性语义不变）
    expect(store.consume(ticket, 'room-a')).toBe(false)
  })

  it('过期票据被清出存储且不可用', () => {
    let current = 0
    const store = makeTicketStore({ ttlMs: 100, now: () => current })
    const ticket = store.issue('room-a')

    current = 200
    expect(store.consume(ticket, 'room-a')).toBe(false)
    expect(store.size).toBe(0)
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
