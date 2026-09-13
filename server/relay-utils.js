// 从 relay-server.js 抽出的纯函数与可注入配置的工厂，便于单元测试。
// relay-server.js 导入本模块复用；本模块不含副作用，可安全被 Vitest 加载。

import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

/**
 * 解析正整数型环境变量。非法值**不静默回退**，而是返回 `ok:false` 让调用方 fail-closed 退出。
 *
 * 背景：`Number('10mb')` 是 `NaN`，而 `size > NaN` 恒为 false —— 一个笔误就能让
 * 体积校验静默全失效（实测 12MB 文件被照单全收）。
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

/** 按 UTF-8 字节数截断字符串，不产生半个码点（不完整的多字节序列被 StringDecoder 丢弃） */
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
 */
export function isWeakRoomId(roomId) {
  const raw = typeof roomId === 'string' ? roomId.trim() : ''
  if (!raw) return true
  if (WEAK_ROOM_IDS.has(raw.toLowerCase())) return true
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(raw)) return false

  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[_-]/u].filter((re) => re.test(raw)).length
  return classes < 2 || raw.length < 12
}

/** 清洗存储文件名：取 basename 阻断路径穿越，替换控制字符与非法字符，防纯点号名 */
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
 */
export function decodeHeaderValue(value) {
  if (typeof value !== 'string') return value
  return Buffer.from(value, 'latin1').toString('utf8')
}

export function isTextMimeType(mimeType, fileName) {
  if (mimeType.startsWith('text/')) return true
  // ipynb 是 JSON 文本，但浏览器常给不出可靠 MIME（空串或无注册），必须靠扩展名兜底
  return /\.(txt|md|markdown|json|ipynb|xml|csv|log|conf|ini|yaml|yml|env|toml|sql|js|mjs|cjs|ts|tsx|jsx|vue|css|scss|html|htm|sh|py)$/iu.test(fileName)
}

/**
 * 把 RELAY_ALLOWED_ORIGINS 归一为数组。空串 / undefined / 纯空白一律视为 `*`，
 * 修复 docker-compose 的 `${VAR:-}` 传入空串导致白名单被误判为空、CORS 头缺失的问题。
 */
export function normalizeAllowedOrigins(raw) {
  const value = typeof raw === 'string' && raw.trim() ? raw : '*'
  return value.split(',').map((entry) => entry.trim()).filter(Boolean)
}

/** 判断监听地址是否为回环地址（用于 fail-closed 鉴权启动检查） */
export function isLoopbackHost(host) {
  const normalized = String(host).trim().toLowerCase().replace(/^\[|\]$/gu, '')
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
}

/** 按白名单生成 CORS 头工厂；来源不在白名单时返回空对象，浏览器会自行拦截 */
export function makeCorsHeaders(allowedOrigins) {
  const allowAll = allowedOrigins.includes('*')

  return (req) => {
    const origin = req.headers.origin

    if (!allowAll && !(origin && allowedOrigins.includes(origin))) {
      return {}
    }

    const headers = {
      'Access-Control-Allow-Origin': allowAll ? '*' : origin,
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
 * 鉴权工厂：未配置 token 时全放行；配置后只接受 `Authorization: Bearer <token>`。
 *
 * 注意：这里**刻意不支持** `?token=` 查询参数。长期密钥进入 URL 会残留在访问日志、
 * Referer 与浏览器历史中；SSE 无法自定义请求头的问题已由一次性短时效票据
 * （见 makeTicketStore + relay-server 的 isStreamTicketAuthorized）解决。
 */
export function makeAuthorizer(relayToken) {
  return (req) => {
    if (!relayToken) return true

    const header = String(req.headers.authorization ?? '')
    return header === `Bearer ${relayToken}`
  }
}

/**
 * 短时效、一次性 SSE 票据存储。
 * 用票据替代 URL 中的长期 token，规避 token 进入访问日志 / Referer / 浏览器历史。
 * 注入 `now` 便于单元测试。
 */
export function makeTicketStore({ ttlMs = 60_000, now = () => Date.now() } = {}) {
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
    /** 校验并消费票据；房间不匹配 / 过期 / 已用一律 false */
    consume(ticket, roomId) {
      if (!ticket) return false
      const entry = tickets.get(ticket)
      tickets.delete(ticket)
      return Boolean(entry) && entry.expiresAt > now() && entry.roomId === roomId
    },
    get size() {
      return tickets.size
    }
  }
}
