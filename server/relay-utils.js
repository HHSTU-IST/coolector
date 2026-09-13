// 从 relay-server.js 抽出的纯函数与可注入配置的工厂，便于单元测试。
// relay-server.js 导入本模块复用；本模块不含副作用，可安全被 Vitest 加载。

import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 房间 ID 只允许字母数字、下划线、连字符，长度 8–64。
 * 下限设为 8（而非 4）是因为「发送方公开写」模型下房间 ID 本身就是能力凭据，
 * 过短的自定义 ID 极易被枚举。不传时由服务端生成完整 UUID。
 */
export const ROOM_ID_MIN_LENGTH = 8
export const ROOM_ID_MAX_LENGTH = 64

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
