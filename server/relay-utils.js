// 从 relay-server.js 抽出的纯函数与可注入配置的工厂，便于单元测试。
// relay-server.js 导入本模块复用；本模块不含副作用，可安全被 Vitest 加载。

import { basename } from 'node:path'

/** 房间 ID 只允许字母数字、下划线、连字符，长度 4–64 */
export function sanitizeRoomId(roomId) {
  if (!roomId || typeof roomId !== 'string') return null
  const normalized = roomId.trim()
  return /^[a-zA-Z0-9_-]{4,64}$/u.test(normalized) ? normalized : null
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
  return /\.(txt|md|json|xml|csv|log|conf|ini|yaml|yml|env|toml|sql|js|ts|tsx|jsx|css|scss|html|htm)$/iu.test(fileName)
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
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Relay-Filename, X-Relay-Mime-Type, X-Relay-Last-Modified, X-Relay-Text-Preview'
    }

    if (!allowAll) {
      headers.Vary = 'Origin'
    }

    return headers
  }
}

/** 鉴权工厂：未配置 token 时全放行；配置后要求 Bearer 头或 ?token= 查询参数（SSE 用） */
export function makeAuthorizer(relayToken) {
  return (req) => {
    if (!relayToken) return true

    const header = String(req.headers.authorization ?? '')
    if (header === `Bearer ${relayToken}` || header === relayToken) return true

    // EventSource 无法自定义请求头，SSE 连接改由查询参数携带 token
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.searchParams.get('token') === relayToken) return true
    } catch {
      // 忽略非法 URL
    }

    return false
  }
}
