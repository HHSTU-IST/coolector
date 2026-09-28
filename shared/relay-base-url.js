// Relay 基址的**唯一**判据实现。
//
// 同一个语义值（「这台 relay 的对外基址」）有两个来源，历史上各自维护了一份判据：
//   - 服务端：`RELAY_PUBLIC_BASE_URL`（server/relay-utils.js 的 parsePublicBaseUrl）
//   - 前端：`VITE_RELAY_URL`（src/utils/relay.ts 的 RELAY_URL_PATTERN）
// 两份实现虽然都「只认 http(s) 绝对地址」，但一个用 `new URL` 解析、一个用正则匹配，
// 且对查询串的处理相反（服务端拒绝、前端静默剥离），属于典型的判据漂移。
//
// 本模块是这两处**共同的**判据：纯字符串 + 全局 `URL`，无任何依赖、无副作用，
// 因此可以同时被浏览器（经 Vite 打包）与 Node（服务端 / 构建守卫）加载。
// **判据只能改这里**。`.github/workflows/deploy.yml` 的 shell `case` 块因语言不同无法复用
// 本模块，是唯一需要人肉同步的例外（见该步骤的注释）。

/**
 * 非法原因码。调用方负责把 reason 映射为自己的文案（服务端与前端措辞不同），
 * 但**判定必须相同** —— 这是本模块存在的意义。
 *
 * @type {Readonly<Record<'EMPTY' | 'UNPARSABLE' | 'SCHEME' | 'CREDENTIALS' | 'QUERY_OR_HASH', string>>}
 */
export const RELAY_BASE_URL_REASON = Object.freeze({
  /** 未设置 / 空白：**合法**，表示「不配置基址」，具体语义由调用方决定 */
  EMPTY: 'empty',
  /** 无法被 `URL` 解析（缺 scheme 的裸域名、协议相对地址、含空格等） */
  UNPARSABLE: 'unparsable',
  /** 不是 http(s) 协议（`ftp:` / `javascript:` / `data:` 都不能承载 relay 请求） */
  SCHEME: 'scheme',
  /** 含用户名或密码 */
  CREDENTIALS: 'credentials',
  /** 含查询串或 hash（含尾随的 `?` / `#`） */
  QUERY_OR_HASH: 'query-or-hash'
})

/**
 * 解析 Relay 基址。返回 `{ ok, value, reason, raw }`：
 *
 * - 未设置 / 空白 → `{ ok: true, value: null, reason: 'empty' }`
 * - 非法 → `{ ok: false, value: null, reason: <原因码> }`，由调用方 fail-closed 处理
 * - 合法 → `{ ok: true, value: <归一后的绝对基址>, reason: '' }`
 *
 * 归一用 `URL.href` 而不是字符串拼接：`http://x/../y` 实际就是 `http://x/y`，
 * 「用于校验的串」必须**就是**「输出的串」，否则校验形同虚设。
 * 尾部斜杠统一去掉，因为后续要按前缀拼接路径。
 *
 * 三类会「把请求打错地方」的值被刻意拒绝：
 * - 非 http(s) 协议；
 * - 带用户名密码 —— 基址里不该出现凭据，且它会让同源判定失去意义；
 * - 含查询串或 hash —— 后续拼接的路径会被吞进 query（`https://x/relay?` 拼出
 *   `.../relay?/api/x`）。注意尾随的 `?` / `#` 经 `new URL` 解析后 `search` / `hash`
 *   都是**空串**（falsy），只看解析结果会漏判，故按**原始输入**判定分隔符是否存在。
 *
 * @param {string | null | undefined} raw
 * @returns {{ ok: boolean, value: string | null, reason: string, raw: string }}
 */
export function parseRelayBaseUrl(raw) {
  const value = raw === undefined || raw === null ? '' : String(raw).trim()
  if (value === '') return { ok: true, value: null, reason: RELAY_BASE_URL_REASON.EMPTY, raw: value }

  /** @type {(reason: string) => { ok: false, value: null, reason: string, raw: string }} */
  const invalid = (reason) => ({ ok: false, value: null, reason, raw: value })

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return invalid(RELAY_BASE_URL_REASON.UNPARSABLE)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return invalid(RELAY_BASE_URL_REASON.SCHEME)
  if (parsed.username || parsed.password) return invalid(RELAY_BASE_URL_REASON.CREDENTIALS)
  if (value.includes('?') || value.includes('#')) return invalid(RELAY_BASE_URL_REASON.QUERY_OR_HASH)

  return { ok: true, value: parsed.href.replace(/\/+$/u, ''), reason: '', raw: value }
}
