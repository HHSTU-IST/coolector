// 从 relay-server.js 抽出的纯函数与可注入配置的工厂，便于单元测试。
// relay-server.js 导入本模块复用；本模块不含副作用，可安全被 Vitest 加载。

import { basename } from 'node:path'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { BlockList, isIP } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
// docx 正文提取（zip 容器解析）。与文本解码一起构成「字节 → 可读正文」的唯一实现，见 deriveUploadText。
import { extractDocxText, isDocxMimeType } from './relay-docx.js'
// Relay 基址判据的**唯一**实现，与前端（src/utils/relay.ts）共用同一份。
// 跨端共享是为了消除「同一个语义值、两套判据」的漂移，详见该模块头部说明。
import { parseRelayBaseUrl } from '../shared/relay-base-url.js'

/**
 * 解析正整数型环境变量。非法值**不静默回退**，而是返回 `ok:false` 让调用方 fail-closed 退出。
 *
 * 背景：`Number('10mb')` 是 `NaN`，而 `size > NaN` 恒为 false —— 一个笔误就能让
 * 体积校验静默全失效（实测 12MB 文件被照单全收）。
 *
 * 返回的是**可判别联合**：`ok:false` 分支的 `value` 恒为 `null`，`ok:true` 分支的 `value`
 * 一定是 `number`。必须写判别联合而不是 `{ ok: boolean, value: number | null }` —— 后者会让
 * 调用方在 `process.exit(1)` 之后仍被推断成 `number | null`，再一路传染给全部配置常量
 * （实测这一处 typedef 曾连带产生 17 条 `possibly null`）。
 *
 * @param {string | undefined | null} raw
 * @param {{ fallback?: number, min?: number, max?: number }} [bounds]
 * @returns {{ ok: true, value: number, usedFallback: boolean } | { ok: false, value: null, raw: string }}
 */
export function parsePositiveInt(raw, { fallback = 0, min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: true, value: fallback, usedFallback: true }
  }

  const value = Number(String(raw).trim())
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    return { ok: false, value: null, raw: String(raw) }
  }

  return { ok: true, value, usedFallback: false }
}

/** MIME 类型 `type` / `subtype` 各自的长度上限（RFC 惯例），防止超长值撑爆响应头 */
const MAX_MIME_PART_LENGTH = 127

/**
 * 清洗 MIME 类型：只保留标准的 `type/subtype`，丢掉参数与控制字符，并限制长度。
 *
 * 只防注入是不够的：超长的 `mimeType` 会让下载响应头溢出，客户端连响应头都解析不了
 * （实测 node fetch 抛 `UND_ERR_HEADERS_OVERFLOW`、curl 退出码 100），该文件将**永久无法下载**。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeMimeType(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return 'application/octet-stream'

  const [essence] = raw.split(';')
  const [type, subtype] = essence.trim().toLowerCase().split('/')
  const token = /^[a-z0-9][a-z0-9!#$&^_.+-]*$/u

  if (!type || !subtype || !token.test(type) || !token.test(subtype)) {
    return 'application/octet-stream'
  }
  if (type.length > MAX_MIME_PART_LENGTH || subtype.length > MAX_MIME_PART_LENGTH) {
    return 'application/octet-stream'
  }

  return `${type}/${subtype}`
}

/**
 * 规范化日期字符串：校验可解析并统一为 ISO，同时限制长度。
 * 客户端传来的 `lastModified` 若不加约束，就是一个可写入任意长度内容的字段。
 *
 * @param {unknown} value
 * @param {string} fallback 不可解析时原样返回的兜底值
 * @returns {string}
 */
export function normalizeIsoDate(value, fallback) {
  const raw = String(value ?? '').trim().slice(0, 64)
  if (!raw) return fallback

  const time = Date.parse(raw)
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback
}

/**
 * 限制上传文件名长度。超长名会同时放大内存、房间快照、SSE 帧与审计日志，
 * 也是「元数据不计配额」绕过的入口。
 * 截断时尽量保留扩展名，避免接收端把 `.md` / `.docx` 识别成无扩展名文件。
 *
 * @param {unknown} name
 * @param {number} maxBytes
 * @returns {{ name: string, truncated: boolean }}
 */
export function limitUploadName(name, maxBytes) {
  const raw = String(name ?? '')
  if (Buffer.byteLength(raw, 'utf8') <= maxBytes) return { name: raw, truncated: false }

  const dotIndex = raw.lastIndexOf('.')
  const extension = dotIndex > 0 && dotIndex >= raw.length - 16 ? raw.slice(dotIndex) : ''
  const extensionBytes = Buffer.byteLength(extension, 'utf8')

  // 扩展名本身就放不下时整段丢弃，否则会为了"保留扩展名"而越过上限
  if (extensionBytes <= 0 || extensionBytes > maxBytes) {
    return { name: truncateUtf8(raw, maxBytes).text, truncated: true }
  }

  const stem = truncateUtf8(raw.slice(0, dotIndex), maxBytes - extensionBytes).text
  return { name: `${stem}${extension}`, truncated: true }
}

/**
 * 按 UTF-8 字节数截断字符串，不产生半个码点（不完整的多字节序列被 StringDecoder 丢弃）
 *
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncateUtf8(value, maxBytes) {
  const text = String(value ?? '')
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return { text, truncated: false }

  return { text: new StringDecoder('utf8').write(buffer.subarray(0, maxBytes)), truncated: true }
}

/**
 * 房间 ID 只允许字母数字、下划线、连字符，长度 8–64。
 * 下限设为 8（而非 4）是因为「发送方公开写」模型下房间 ID 本身就是能力凭据，
 * 过短的自定义 ID 极易被枚举。不传时由服务端生成完整 UUID。
 */
const ROOM_ID_MIN_LENGTH = 8
const ROOM_ID_MAX_LENGTH = 64

/**
 * @param {unknown} roomId
 * @returns {string | null} 合法时返回归一后的 ID，否则 `null`
 */
export function sanitizeRoomId(roomId) {
  if (!roomId || typeof roomId !== 'string') return null
  const normalized = roomId.trim()
  if (normalized.length < ROOM_ID_MIN_LENGTH || normalized.length > ROOM_ID_MAX_LENGTH) return null
  return /^[a-zA-Z0-9_-]+$/u.test(normalized) ? normalized : null
}

/** 常见弱房间名；仅在服务端审计告警，不阻断（班级可能确有固定命名约定） */
const WEAK_ROOM_IDS = new Set([
  'demo-room', 'demo-room-1', 'test-room', 'default-room', 'sample-room',
  'classroom', 'my-room', 'coolector', 'homework', 'assignment'
])

/**
 * 判断房间 ID 是否熵不足：弱命名，或字符种类过少（<2 类），或长度 < 12 且非 UUID 形态。
 * 服务端据此写审计告警、前端据此提示用户「请勿公开分享房间号」。
 *
 * @param {unknown} roomId
 * @returns {boolean}
 */
export function isWeakRoomId(roomId) {
  const raw = typeof roomId === 'string' ? roomId.trim() : ''
  if (!raw) return true
  if (WEAK_ROOM_IDS.has(raw.toLowerCase())) return true
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(raw)) return false

  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[_-]/u].filter((re) => re.test(raw)).length
  return classes < 2 || raw.length < 12
}

/**
 * 清洗存储文件名：取 basename 阻断路径穿越，替换控制字符与非法字符，防纯点号名
 *
 * @param {unknown} fileName
 * @returns {string}
 */
export function sanitizeStorageFileName(fileName) {
  const safeBaseName = basename(String(fileName))
    // 有意匹配控制字符：清洗它们以阻断路径穿越与非法文件名
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/gu, '_')
    .replace(/^\.+$/u, 'file')
    .trim()

  return (safeBaseName || 'file').slice(0, 180)
}

/**
 * HTTP 头值只能是 latin1，中文文件名需按 RFC 6266 用 filename* 携带 UTF-8 百分号编码，
 * 并给一份 ASCII 回退的 filename 供旧客户端使用。
 *
 * @param {unknown} fileName
 * @returns {string}
 */
export function contentDisposition(fileName) {
  const name = String(fileName)
  const fallback = name
    .replace(/[^\x20-\x7e]+/gu, '_')
    .replaceAll('"', '')

  return `attachment; filename="${fallback || 'file'}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * Node 的 req.headers 按 latin1 解码，浏览器发来的 UTF-8 文件名会变成乱码。
 * 以 latin1 还原原始字节再按 UTF-8 解码；纯 ASCII 值经此转换保持不变。
 *
 * 注意这是**原语**，只做字节还原。裸 body 路径的上传文件名请用 `decodeUploadFileName`。
 *
 * @param {unknown} value 非 string 原样返回，故返回类型同为 `unknown`（调用方自行收窄）
 * @returns {unknown}
 */
export function decodeHeaderValue(value) {
  if (typeof value !== 'string') return value
  return Buffer.from(value, 'latin1').toString('utf8')
}

/**
 * 是否全部为可打印 ASCII（HTTP 头值在 latin1 通道下的正常形态）
 *
 * @param {string} value
 * @returns {boolean}
 */
function isPrintableAscii(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

/**
 * 是否含非 ASCII 码点（即「百分号转义确实承载了一个非 ASCII 文件名」）
 *
 * @param {string} value
 * @returns {boolean}
 */
function hasNonAscii(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return true
  }
  return false
}

/**
 * 解析裸 body 上传路径里 `X-Relay-Filename` 头的文件名。
 *
 * 该头是一条 **latin1 通道**（HTTP 头只接受 ISO-8859-1），于是同一个文件名有两种到达方式：
 * ① curl 之类客户端把 UTF-8 字节直接写进头里 —— latin1 还原即可；
 * ② 浏览器 `fetch` 与多数脚本语言**无法**把非 ASCII 写进头值，因此改用百分号编码。
 *
 * 旧实现只做 ①，② 会被**静默**存成 `%E4%BD%9C...`：接收端看到乱码文件名，下载时
 * `contentDisposition` 再把它二次编码（`%` → `%25`），老师拿到的是一个打不开的名字。
 *
 * 解码规则**刻意收窄**：只有「百分号转义解出来确实含非 ASCII 码点」时才采用解码结果。
 * 纯 ASCII 的 `%XX`（`note%20f.md`、`a%2Fb.txt`）**原样保留** —— 那本来就是一个合法文件名，
 * 自动解码等于把它悄悄改掉（正是本仓铁律禁止的「把非法值悄悄改成合法值」的反向版本：
 * 把合法值悄悄改成另一个值）。残缺转义（`100%.txt`）同理，按字面量处理、不报错。
 *
 * @param {unknown} value
 * @returns {unknown} 与 `decodeHeaderValue` 同口径：非字符串入参原样透传
 */
export function decodeUploadFileName(value) {
  const restored = decodeHeaderValue(value)
  if (typeof restored !== 'string' || !restored) return restored

  // 非 ASCII 说明 ① 已经还原完成；不含 `%XX` 则没有任何转义可解
  if (!isPrintableAscii(restored) || !/%[0-9a-f]{2}/iu.test(restored)) return restored

  let decoded
  try {
    decoded = decodeURIComponent(restored)
  } catch {
    return restored
  }

  return hasNonAscii(decoded) ? decoded : restored
}

/**
 * @param {string} mimeType
 * @param {string} fileName
 * @returns {boolean}
 */
export function isTextMimeType(mimeType, fileName) {
  if (mimeType.startsWith('text/')) return true
  // ipynb 是 JSON 文本，但浏览器常给不出可靠 MIME（空串或无注册），必须靠扩展名兜底
  return /\.(txt|md|markdown|json|ipynb|xml|csv|log|conf|ini|yaml|yml|env|toml|sql|js|mjs|cjs|ts|tsx|jsx|vue|css|scss|html|htm|sh|py)$/iu.test(fileName)
}

/**
 * 「字节 → 可读正文」的**唯一**实现：文本类直接按 UTF-8 解码，docx 解压出正文，其余为 null。
 *
 * 抽成一处的原因有两条，缺一条它就该是两处：
 *
 * - 上传路径与 `detailsUrl` 必须给出**同一个**答案。以前客户端自己解 docx、服务端只负责存，
 *   于是同一份逻辑存在两份（浏览器 `DecompressionStream` 一份、服务端 zlib 一份），
 *   任何一方改了解析规则，上传时的预览与接收端拉到的正文就会不一致（铁律 20）。
 * - 落盘后正文不再常驻内存（`upload.text` 恢复时是 null），`detailsUrl` 需要**按需**从
 *   磁盘字节重新推导 —— 若那是第二份实现，重启前后的正文就可能不同。
 *
 * 只影响预览：原始字节始终完整落盘，`?download=1` 拿到的永远是原件。
 *
 * @param {Buffer} bytes 原始文件字节
 * @param {string} mimeType
 * @param {string} fileName
 * @returns {string | null}
 */
export function deriveUploadText(bytes, mimeType, fileName) {
  if (!Buffer.isBuffer(bytes)) return null
  if (isTextMimeType(mimeType, fileName)) return bytes.toString('utf8')
  if (isDocxMimeType(mimeType, fileName)) return extractDocxText(bytes)
  return null
}

/**
 * 把 RELAY_ALLOWED_ORIGINS 归一为数组。
 *
 * **未配置 = 不发送任何 CORS 头**（即拒绝所有跨源前端），而不再是 `*`。
 * 免凭据的公开写路径意味着任意站点都能向「已知房间号」灌文件，因此「谁可以跨源调用」
 * 必须是显式决定。本机开发由 `server/start.js` 显式注入 localhost 白名单，
 * 端到端脚本亦自带白名单，都不依赖这个默认值。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeAllowedOrigins(raw) {
  if (typeof raw !== 'string') return []
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean)
}

/**
 * 解析「对外基址」配置（`RELAY_PUBLIC_BASE_URL`）。
 *
 * 这是服务端**唯一**允许产生绝对 URL 的来源：请求头（`Host` / `x-forwarded-*`）完全由调用方
 * 控制，用它拼出的绝对 URL 会把接收端的凭据引向攻击者域（详见 relay-http.js 的 relayUrl）。
 *
 * - 未设置 / 空白 → `{ ok: true, value: null }`，表示对外只输出**相对路径**（默认且推荐）
 * - 非法值 → `ok: false`，由调用方 fail-closed 退出（与 `parsePositiveInt` 同一套约定）
 * - 合法值 → 去掉尾部斜杠并保留可选路径前缀（反代常把 Relay 挂在子路径下）
 *
 * 判定本身**不在本文件**：与前端 `VITE_RELAY_URL` 共用 `shared/relay-base-url.js`。
 * 这两个值语义相同（都是「relay 的对外基址」），历史上各有一份实现且规则不同
 * （前端用正则、还会静默剥掉查询串，服务端用 `new URL` 解析并拒绝查询串），
 * 同一个地址可能「前端放行、服务端拒绝启动」或反之。现在只剩一处判据。
 * 本函数只负责把共享结果映射成服务端惯用的返回形态，`raw` 供启动失败的日志使用。
 *
 * @param {string | null | undefined} raw
 * @returns {{ ok: true, value: string | null } | { ok: false, value: null, raw: string }}
 */
export function parsePublicBaseUrl(raw) {
  const result = parseRelayBaseUrl(raw)
  if (!result.ok) return { ok: false, value: null, raw: result.raw }
  return { ok: true, value: result.value }
}

/**
 * 判断监听地址是否为回环地址（用于 fail-closed 鉴权启动检查）
 *
 * @param {unknown} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  const normalized = String(host).trim().toLowerCase().replace(/^\[|\]$/gu, '')
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
}

/**
 * 判断监听地址是否具备「主机名 / IP 字面量」的形态。
 *
 * 存在的理由是**拼接**：`server/start.js` 要把地址拼进一条经 `sh`（Windows 上是 `cmd`）
 * 解析的命令行（`pnpm exec vite --host <host>`）。此时 `.env` 里的值就是 shell 语法的一部分 ——
 * `APP_HOST='0.0.0.0 & calc'` 会被当成第二条命令执行。Node 的 `shell: true` 只做拼接、
 * 不做转义（这正是 DEP0190 警告的内容），转义责任在调用方，而**白名单比转义更难写错**。
 *
 * 白名单按「合法取值」而非「危险字符」来定：IPv4 / IPv6（可带方括号）/ 主机名。常见取值
 * `0.0.0.0`、`127.0.0.1`、`::`、`::1`、`[::1]`、`localhost` 全在集合内，而空格、`&`、`|`、
 * `;`、`$`、反引号、`%`、引号、重定向符、通配符、`/`、`=`、换行一个都不在。
 *
 * ⚠️ 这里判的是**形态**，不是「本机是否真能绑上」—— 后者只有 `listen` 知道，由
 * `relay-server.js` 的 bind 失败提示负责。不要把本函数当可用性校验用。
 *
 * 空值一律拒绝（而非当作「监听全部网卡」）：监听地址必须是**显式决定**的，
 * 与 `RELAY_ALLOWED_ORIGINS` 默认不放开跨源是同一个理由。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBindableHost(value) {
  const host = String(value ?? '').trim()
  if (host.length === 0 || host.length > 253) return false
  return /^[A-Za-z0-9._:[\]-]+$/u.test(host)
}

/**
 * 按白名单生成 CORS 头工厂；来源不在白名单时返回空对象，浏览器会自行拦截。
 *
 * `@returns` 里必须显式写出 `req` 的类型：工厂返回的是内联箭头函数，签名只能从这里推断，
 * 否则 `req` 与随后动态挂上的 `Vary` 都会退化（前者隐式 `any`，后者被字面量类型拒绝）。
 *
 * @param {string[]} allowedOrigins
 * @returns {(req: import('node:http').IncomingMessage) => Record<string, string>}
 */
export function makeCorsHeaders(allowedOrigins) {
  const allowAll = allowedOrigins.includes('*')

  return (req) => {
    const origin = req.headers.origin

    if (!allowAll && !(origin && allowedOrigins.includes(origin))) {
      return {}
    }

    /** @type {Record<string, string>} */
    const headers = {
      // allowAll 时用 `*`；否则上面那道守卫已经保证 origin 是命中的非空字符串。
      // 这里必须写断言：TS 不跨闭包边界收窄外层 const，若不写会认为 origin 仍是 `string | undefined`。
      'Access-Control-Allow-Origin': allowAll ? '*' : /** @type {string} */ (origin),
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Relay-Envelope, X-Relay-Filename, X-Relay-Mime-Type, X-Relay-Last-Modified'
    }

    if (!allowAll) {
      headers.Vary = 'Origin'
    }

    return headers
  }
}

/**
 * 解析可信代理网段（`RELAY_TRUSTED_PROXIES`，逗号分隔的 IP 或 CIDR）。
 *
 * 为什么需要它：反代之后所有请求的 socket 地址都是**代理自己的 IP**，限流会退化成
 * 「全站共用一个桶」—— 单个滥用者（或一个班的同一出口）足以让所有人 429，
 * 而且没有任何「正确配置即可缓解」的路径。显式声明可信代理后，才按 `X-Forwarded-For` 分桶。
 *
 * 默认留空 = 不采信任何转发头（直连部署行为不变）。非法条目**不静默忽略**，
 * 由调用方 fail-closed 退出（与 `parsePositiveInt` 同一约定）。
 *
 * @param {unknown} raw
 * @returns {{ list: import('node:net').BlockList, invalid: string[] }}
 */
export function parseTrustedProxies(raw) {
  const entries = typeof raw === 'string' ? raw.split(',').map((entry) => entry.trim()).filter(Boolean) : []
  const list = new BlockList()
  /** @type {string[]} */
  const invalid = []

  for (const entry of entries) {
    const [address, prefixRaw] = entry.split('/')
    const family = isIP(address)
    const maxPrefix = family === 4 ? 32 : 128
    const prefix = prefixRaw === undefined || prefixRaw === '' ? maxPrefix : Number(prefixRaw)

    if (family === 0 || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      invalid.push(entry)
      continue
    }

    list.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6')
  }

  return { list, invalid }
}

/**
 * 生成限流分桶用的「客户端 IP 解析器」。
 *
 * - socket 地址**不在**可信代理网段内（默认情况）→ 用 socket 地址并忽略 `X-Forwarded-For`：
 *   该头由调用方任意伪造，直连时采信它等于把限流桶的分配权交给攻击者（可无限换桶绕过）。
 * - socket 地址命中可信代理 → 从 `X-Forwarded-For` 的**最右端向左**逐跳回退，跳过仍属可信网段的
 *   跳，取第一个**不可信**的合法 IP；非法段跳过，全部跳尽（或全无可信跳之外的段）时回退 socket 地址。
 *
 *   ⚠️ 为何不能取**最左**值：多跳代理普遍采用「追加」语义（nginx 的
 *   `$proxy_add_x_forwarded_for` 展开为 `$http_x_forwarded_for, $remote_addr`），最左段恰好是
 *   客户端自己塞进去的、可任意伪造的那一段 —— 采信它等于把「换桶权」交给攻击者。而最右段一定
 *   由链上某个可信代理写入（写的是它的直接对端），因此「从右往左跳过可信跳、停在第一个不可信
 *   地址」得到的就是最靠近本服务、且已被可信代理见证过的真实来源。
 *
 *   前提：`RELAY_TRUSTED_PROXIES` 只覆盖**代理自身**网段，**不得包含客户端地址段** ——
 *   否则真实客户端也会被当成可信跳一并跳过，退回到伪造值（见 `RELAY_DEPLOY.md` §4.1）。
 *
 *   前提二：多跳拓扑下该声明必须覆盖**链上每一跳**（含本函数的 socket 对端 —— 上面第一条判断
 *   就是「对端可不可信」，不可信时根本不看 XFF）。只声明直接对端会在三层链上停在最内层见证的
 *   那一跳，退化成「全站单桶」；实测其读数与正确配置一致，只有「同伪造值、异源地址」的对照
 *   组能区分（`RELAY_DEPLOY.md` §4.1 三层表）。
 *
 * @param {import('node:net').BlockList} trustedProxies
 * @returns {(req: import('node:http').IncomingMessage) => string}
 */
export function makeClientIpResolver(trustedProxies) {
  return (req) => {
    const socketAddress = req.socket?.remoteAddress ?? 'unknown'
    const family = isIP(socketAddress)
    if (family === 0) return socketAddress

    if (!trustedProxies.check(socketAddress, family === 4 ? 'ipv4' : 'ipv6')) {
      return socketAddress
    }

    const hops = String(req.headers?.['x-forwarded-for'] ?? '')
      .split(',')
      .map((part) => part.trim())

    for (let index = hops.length - 1; index >= 0; index -= 1) {
      const hop = hops[index]
      const hopFamily = isIP(hop)
      // 非法段无法充当分桶键（绝不把任意字符串当 IP 用）；仍属可信代理的跳继续左移
      if (hopFamily === 0) continue
      if (trustedProxies.check(hop, hopFamily === 4 ? 'ipv4' : 'ipv6')) continue
      return hop
    }

    return socketAddress
  }
}

/**
 * 鉴权工厂：未配置 token 时全放行；配置后只接受 `Authorization: Bearer <token>`。
 *
 * 注意：这里**刻意不支持** `?token=` 查询参数。长期密钥进入 URL 会残留在访问日志、
 * Referer 与浏览器历史中；SSE 无法自定义请求头的问题已由一次性短时效票据
 * （见 makeTicketStore + relay-server 的 isStreamTicketAuthorized）解决。
 *
 * @param {string} relayToken 空串表示未配置（放行一切）
 * @returns {(req: import('node:http').IncomingMessage) => boolean}
 */
export function makeAuthorizer(relayToken) {
  return (req) => {
    if (!relayToken) return true

    const header = String(req.headers.authorization ?? '')
    return safeEqual(header, `Bearer ${relayToken}`)
  }
}

/**
 * 恒定时间字符串比较（用于密钥/票据比对）。
 *
 * `===` 会短路于首个不同字符，理论上是可测量侧信道；网络噪声远大于这个差异，
 * 但既然比较的是长期密钥，就没有理由不用恒定时间实现。
 * 长度不同直接返回 false：`timingSafeEqual` 对长度不等会抛错，且长度本身不是秘密。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * 文件名的不可逆摘要（默认 12 位十六进制）。
 *
 * 审计日志里原本记的是**原始文件名**，而学生作业名普遍含「学号+姓名」——那就是 PII。
 * 换成摘要后：既不能反推姓名，又能让运维对「同一个文件被反复上传」做归并排查。
 *
 * @param {unknown} name
 * @param {{ length?: number }} [options]
 * @returns {string}
 */
export function digestName(name, { length = 12 } = {}) {
  return createHash('sha256').update(String(name ?? ''), 'utf8').digest('hex').slice(0, length)
}

/**
 * 短时效、一次性 SSE 票据存储。
 * 用票据替代 URL 中的长期 token，规避 token 进入访问日志 / Referer / 浏览器历史。
 * 注入 `now` 便于单元测试。
 *
 * @param {{ ttlMs?: number, now?: () => number }} [options]
 * @returns {{
 *   issue: (roomId: string) => string,
 *   consume: (ticket: string | null | undefined, roomId: string) => boolean,
 *   readonly size: number
 * }}
 */
export function makeTicketStore({ ttlMs = 60_000, now = () => Date.now() } = {}) {
  /** @type {Map<string, { roomId: string, expiresAt: number }>} */
  const tickets = new Map()

  const prune = () => {
    const current = now()
    for (const [ticket, entry] of tickets) {
      if (entry.expiresAt <= current) tickets.delete(ticket)
    }
  }

  return {
    /** 为指定房间签发一次性票据 */
    issue(roomId) {
      prune()
      const ticket = randomUUID()
      tickets.set(ticket, { roomId, expiresAt: now() + ttlMs })
      return ticket
    },
    /**
     * 校验并消费票据。**先校验、后删除**：房间不匹配 / 过期时不烧票。
     *
     * 原先「先删后校验」会造成误烧：拿 A 房间的票去打 B 房间（哪怕是攻击者随手试探），
     * 就会把 A 的票作废，接收端随后的合法连接被 401 —— 一张有效票据被一次无关请求销毁。
     */
    consume(ticket, roomId) {
      if (!ticket) return false

      const entry = tickets.get(ticket)
      if (!entry) return false
      if (entry.expiresAt <= now()) {
        tickets.delete(ticket)
        return false
      }
      if (entry.roomId !== roomId) return false

      tickets.delete(ticket)
      return true
    },
    get size() {
      return tickets.size
    }
  }
}
