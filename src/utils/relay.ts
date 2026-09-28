import { ref, watch } from 'vue'
import { parseRelayBaseUrl, RELAY_BASE_URL_REASON, type RelayBaseUrlReason } from '../../shared/relay-base-url.js'

/** 构建期未配置时的回落地址（本机/局域网开发用；公网部署必须显式配置 VITE_RELAY_URL） */
const FALLBACK_RELAY_URL = 'http://127.0.0.1:8787'

/**
 * 非法原因 → 可直接展示的错误文案。
 *
 * **判据本身不在这里**：`VITE_RELAY_URL`（前端构建期）与 `RELAY_PUBLIC_BASE_URL`（服务端运维项）
 * 语义相同——都是「relay 的对外基址」——现已合并为 `shared/relay-base-url.js` 一份实现，
 * 前后端共用。之所以还要这张表，是因为两端**措辞**不同（服务端打启动日志，这里给界面看）。
 *
 * 唯一无法复用该模块的是 CI 门禁 `.github/workflows/deploy.yml` 的 shell `case` 块
 * （语言不同）—— 改判据时它需一并核对。
 */
const RELAY_URL_REASON_MESSAGES: Record<RelayBaseUrlReason, string> = {
  empty: 'Relay 地址不能为空',
  unparsable: 'Relay 地址必须是 http(s) 绝对地址（如 https://relay.example.com；同域子路径写成 https://app.example.com/relay）',
  scheme: 'Relay 地址必须以 http:// 或 https:// 开头',
  credentials: 'Relay 地址不能包含用户名或密码（如 https://user:pass@host）',
  'query-or-hash': 'Relay 地址不能带查询串（?）或锚点（#）—— 后续拼接的路径会被吞掉'
}

/**
 * 归一 Relay 地址：**只在形态合法时**返回归一值（去首尾空白与尾部斜杠、折叠点段、小写化
 * scheme/host），否则返回空串。
 *
 * 与旧实现的关键区别：旧版对任何输入都无脑剥掉查询串与 hash —— 那是把非法值**悄悄改写成
 * 合法值**（`https://a.example/?x=1` 被改成 `https://a.example` 后照样通过校验），判据形同虚设。
 * 现在非法值一律交回 `validateRelayUrl` 报错，因此调用方必须**先校验、再归一**。
 */
export const normalizeRelayUrl = (value: string): string => parseRelayBaseUrl(value).value ?? ''

/**
 * 校验 Relay 地址形态。合法返回空串，否则返回可直接展示的错误文案。
 *
 * ⚠️ 不能用共享判据的 `ok` 直接下结论：在服务端语义里「未设置」是**合法**状态
 * （不配置基址 = 对外只输出相对路径），但对界面输入框而言「空」就是**没填**，必须报错。
 * 若照搬 `ok`，用户清空地址框会被静默放行，随后拿空基址去拼请求 URL。
 */
export const validateRelayUrl = (value: string): string => {
  const result = parseRelayBaseUrl(value)
  if (result.reason === RELAY_BASE_URL_REASON.EMPTY) return RELAY_URL_REASON_MESSAGES.empty
  if (result.ok || !result.reason) return ''
  return RELAY_URL_REASON_MESSAGES[result.reason]
}

/**
 * 构建期注入的 Relay 地址（URL 不是密钥，可安全内联）。
 *
 * 构建期变量没有任何运行期输入校验兜底，因此在模块加载期就判定：形态不合法即**回落**到本机
 * 默认值并报错 —— 否则一个畸形的 `VITE_RELAY_URL` 就会把接收端凭据送到错误的地方。
 */
export const DEFAULT_RELAY_URL = (() => {
  const raw = (import.meta.env.VITE_RELAY_URL ?? '').trim()
  if (!raw) return FALLBACK_RELAY_URL

  const invalid = validateRelayUrl(raw)
  if (invalid) {
    console.error(`[relay] VITE_RELAY_URL 非法：${invalid}（收到 ${JSON.stringify(raw)}）；已回落到 ${FALLBACK_RELAY_URL}。`)
    return FALLBACK_RELAY_URL
  }

  return normalizeRelayUrl(raw)
})()

/**
 * 接收端管理密钥的本地存储键。
 *
 * 安全约束：管理密钥**绝不能**经 `VITE_*` 构建期注入 —— Vite 会把这类变量内联进
 * 公开的 `dist/` 产物，等于把接收端凭据分发给每一个发送方。因此密钥只从用户输入读取，
 * 并仅持久化在本机 `localStorage`。
 */
const TOKEN_STORAGE_KEY = 'coolector.relay-token'

/** 房间 ID 长度下限，与 server/relay-utils.js 的 ROOM_ID_MIN_LENGTH 保持一致（仅本模块使用） */
const ROOM_ID_MIN_LENGTH = 8

/**
 * 服务端返回的地址不可信（跨源 / 畸形 / 为空）时抛出的错误。
 *
 * 单列一个类型是为了让调用方能把「安全拒绝」与「网络抖动」区分开：
 * 前者必须显式告诉用户，后者静默处理即可。
 */
export class UntrustedRelayUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UntrustedRelayUrlError'
  }
}

/**
 * 把服务端返回的地址解析成可直接请求的绝对 URL，并**拒绝把带凭据的请求发往非配置的源**。
 *
 * 服务端现在默认只返回相对路径（`/api/rooms/...`），由这里拼到用户在界面上填写的 Relay
 * 地址上 —— 服务端因此不需要、也不被允许从请求头推断自己的对外地址。
 *
 * 绝对 URL 仍被接受，但**必须与配置的 Relay 源同源**，否则抛错。这是第二道防线：
 * 即便将来有某条响应返回了外部地址（例如服务端被换成旧版本、或又引入了请求头参与拼接），
 * 接收端的 `RELAY_TOKEN` 也不会被送到攻击者域（F-001）。
 *
 * 同源判定基于 `origin`（协议 + 主机 + 端口）——`http` 与 `https`、不同端口都视为跨源。
 */
export const resolveRelayUrl = (target: string, baseUrl: string): string => {
  // 变量名避开下面的 `parsedBase: URL`（那是解析 target 用的）
  const baseResult = parseRelayBaseUrl(baseUrl)
  // 「空」与「非法」必须分开报告：归一后两者都得到空串，若不在此区分，
  // 一个写错的地址会被误报成「未配置」，用户按提示去填也永远填不对。
  if (baseResult.reason === RELAY_BASE_URL_REASON.EMPTY) throw new Error('未配置 Relay 地址')
  if (!baseResult.ok || baseResult.value === null) {
    throw new UntrustedRelayUrlError(`配置的 Relay 地址不合法：${JSON.stringify(baseUrl)}`)
  }
  const base = baseResult.value

  // 反斜杠先归一为正斜杠：浏览器对 http(s) 会把 `\` 当 `/`，
  // 不归一的话 `/\evil.example` 这类写法可以绕过下面的「协议相对」判定。
  const value = target.trim().replace(/\\/gu, '/')
  if (!value) throw new UntrustedRelayUrlError('Relay 返回了空地址')

  // 相对路径（服务端默认形态）：拼到配置的 Relay 地址上，保留基址的路径前缀。
  // 注意不能依赖页面自身的 origin —— 纯静态前端常与 Relay 不同源。
  // `//host` 不算相对路径（那是协议相对地址），必须走下面的同源检查。
  if (value.startsWith('/') && !value.startsWith('//')) return `${base}${value}`

  let parsedTarget: URL
  let parsedBase: URL
  try {
    parsedBase = new URL(base)
    // 协议相对地址：补上基址的协议再解析，随后**照常做同源检查**。
    // 既不能当相对路径拼（会变成同源但语义错误的 `base//host/...`），
    // 更不能直接采信 —— 那正是把凭据送往攻击者域的路径。
    parsedTarget = value.startsWith('//')
      ? new URL(`${parsedBase.protocol}${value}`)
      : new URL(value)
  } catch {
    throw new UntrustedRelayUrlError(`无法解析 Relay 返回的地址：${target}`)
  }

  if (parsedTarget.origin !== parsedBase.origin) {
    throw new UntrustedRelayUrlError(`拒绝向非配置的 Relay 源发起带凭据的请求：${parsedTarget.origin}`)
  }

  // 同源但带 userinfo 的地址会被 fetch 直接拒绝（规范禁止含凭据的 URL），且它没有任何用途
  parsedTarget.username = ''
  parsedTarget.password = ''

  return parsedTarget.toString()
}

const readStoredToken = (): string => {
  try {
    return globalThis.localStorage?.getItem(TOKEN_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

/** 接收端管理密钥；由用户在界面上填写并持久化在 localStorage，不来自构建产物 */
export const relayToken = ref(readStoredToken())

watch(relayToken, (value) => {
  try {
    if (value) {
      globalThis.localStorage?.setItem(TOKEN_STORAGE_KEY, value)
    } else {
      globalThis.localStorage?.removeItem(TOKEN_STORAGE_KEY)
    }
  } catch {
    // localStorage 不可用（隐私模式 / 配额满）时退化为仅内存保存
  }
})

/** 组装带鉴权头的请求头；未配置密钥时不带 Authorization（服务端未设 RELAY_TOKEN 时才允许） */
export const withAuth = (headers: Record<string, string> = {}): Record<string, string> => {
  if (!relayToken.value) return { ...headers }
  return { ...headers, Authorization: `Bearer ${relayToken.value}` }
}

/**
 * 校验房间 ID 格式。合法返回空串，否则返回可直接展示的错误文案。
 * 只需覆盖「明显写错」的情况做即时反馈；上界与字符集的权威判定在服务端的 `sanitizeRoomId`。
 * `allowEmpty` 为 true 时把空值视为「由服务端生成 UUID」而非错误。
 */
export const validateRoomId = (value: string, { allowEmpty = false } = {}): string => {
  const id = value.trim()
  if (!id) return allowEmpty ? '' : '房间 ID 不能为空'
  if (id.length < ROOM_ID_MIN_LENGTH) return `房间 ID 至少 ${ROOM_ID_MIN_LENGTH} 位（过短易被猜到）`
  if (!/^[a-zA-Z0-9_-]+$/u.test(id)) return '房间 ID 只能包含字母、数字、下划线与连字符'
  return ''
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * 房间号是否「看起来不是随机生成的」—— 只做 UUID 形态判断，用于发送方的**非阻断提示**。
 *
 * 注意这里**刻意不再维护弱名清单**：判定「弱房间号」是服务端的职责（建房响应里带
 * `weakRoomId`），前端复刻一份清单只会随时间与服务端脱节。
 */
export const looksWeakRoomId = (value: string): boolean => {
  const id = value.trim()
  if (!id) return true
  return !UUID_PATTERN.test(id)
}
