/**
 * `shared/relay-base-url.js` 的类型声明。
 *
 * 实现是纯 JS（服务端 Node 要直接 import，浏览器侧经 Vite 打包），因此这里手写声明。
 * **改行为只改 .js**；本文件只在签名变化时同步。
 */

export type RelayBaseUrlReason = 'empty' | 'unparsable' | 'scheme' | 'credentials' | 'query-or-hash'

export interface RelayBaseUrlResult {
  /** 形态是否合法。注意 `ok: true` 时 `value` 仍可能是 `null`（未配置基址）。 */
  ok: boolean
  /** 归一后的绝对基址；未配置时为 `null`，非法时也为 `null`。 */
  value: string | null
  /** 非法原因；合法时为 `''`。 */
  reason: RelayBaseUrlReason | ''
  /** 裁剪首尾空白后的原始输入，供报错信息使用。 */
  raw: string
}

export declare const RELAY_BASE_URL_REASON: Readonly<
  Record<'EMPTY' | 'UNPARSABLE' | 'SCHEME' | 'CREDENTIALS' | 'QUERY_OR_HASH', RelayBaseUrlReason>
>

export declare function parseRelayBaseUrl(raw?: string | null): RelayBaseUrlResult
