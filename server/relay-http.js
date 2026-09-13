// 与业务无关的 HTTP 传输原语与「请求准入」：错误类型、审计日志、CORS、鉴权、限流、读写。
// 本模块不持有房间状态，可被单测直接 import。

import { makeAuthorizer, makeCorsHeaders, makeTicketStore, sanitizeRoomId } from './relay-utils.js'
import {
  ALLOWED_ORIGINS, MAX_BODY_BYTES, MAX_UPLOAD_BYTES_PER_WINDOW, PORT,
  RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, RELAY_TOKEN, STREAM_TICKET_TTL_MS, TRUST_PROXY
} from './relay-config.js'

/** 按当前来源计算 CORS 响应头；来源不在白名单时返回空对象，浏览器会自行拦截 */
const corsHeaders = makeCorsHeaders(ALLOWED_ORIGINS)


/** 未配置 RELAY_TOKEN 时放行所有请求；配置后只接受 `Authorization: Bearer <token>`（?token= 已移除） */
const isAuthorized = makeAuthorizer(RELAY_TOKEN)


/** SSE 短时效一次性票据存储（避免长期 token 进 URL） */
const streamTickets = makeTicketStore({ ttlMs: STREAM_TICKET_TTL_MS })


function nowIso() {
  return new Date().toISOString()
}


/**
 * 带 HTTP 状态码的错误。携带状态码的错误其 message 视为「可安全回传给客户端」，
 * 未包装的异常一律脱敏为 400 Bad request 并只落审计日志。
 */
class HttpError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.name = 'HttpError'
    this.statusCode = statusCode
  }
}


/** 结构化安全审计日志（房间/上传/鉴权失败/限流等关键事件） */
function auditLog(event, details = {}) {
  console.log(`[relay][audit] ${JSON.stringify({ ts: nowIso(), event, ...details })}`)
}


function baseUrl(req) {
  // 仅在可信代理后才采信 x-forwarded-*，否则忽略（防止直连时被伪造出恶意跳转地址）
  if (TRUST_PROXY) {
    const forwardedProto = req.headers['x-forwarded-proto']
    const forwardedHost = req.headers['x-forwarded-host']
    const protocol = typeof forwardedProto === 'string' ? forwardedProto : 'http'
    const host = typeof forwardedHost === 'string' ? forwardedHost : (req.headers.host ?? `localhost:${PORT}`)
    return `${protocol}://${host}`
  }

  const host = req.headers.host ?? `localhost:${PORT}`
  return `http://${host}`
}


/** /events 允许携带一次性票据代替长期 token；票据与房间绑定、用后即焚 */
function isStreamTicketAuthorized(req, pathname) {
  const match = pathname.match(/^\/api\/rooms\/([^/]+)\/events$/u)
  if (!match) return false

  const roomId = sanitizeRoomId(match[1])
  if (!roomId) return false

  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    return streamTickets.consume(url.searchParams.get('ticket'), roomId)
  } catch {
    return false
  }
}


/** 发送方公开写路径：仅 POST /api/rooms/:roomId/uploads 免凭据（房间 ID 即能力凭据） */
function isPublicUpload(req, pathname) {
  return req.method === 'POST' && /^\/api\/rooms\/[^/]+\/uploads$/u.test(pathname)
}


function writeJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(statusCode, {
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}


function writeSseFrame(res, eventName, payload) {
  res.write(`event: ${eventName}\n`)
  res.write(`id: ${payload.id}\n`)
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}


/**
 * 读取请求体，超过 limit 抛 413。
 *
 * 超限时**不立即 destroy**：socket 被抢先销毁的话，客户端只会看到网络中断
 * （浏览器报 `Failed to fetch`）而拿不到 413 响应体。这里只停止累积、丢弃后续数据，
 * 让 Node 在响应写完后自行收尾连接。
 */
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let exceeded = false

    req.on('data', (chunk) => {
      // 一旦超限就只丢弃、不再累加：既保住内存上限，也把完整响应留给客户端
      if (exceeded) return
      size += chunk.length

      if (size > limit) {
        exceeded = true
        reject(new HttpError(413, `Request body too large (limit ${limit} bytes)`))
        return
      }

      chunks.push(chunk)
    })

    req.on('end', () => {
      if (!exceeded) resolve(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      if (!exceeded) reject(error)
    })
  })
}


function sendSseHeaders(res, headers = {}) {
  res.writeHead(200, {
    ...headers,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.flushHeaders?.()
}


/**
 * 公开写路径的「按字节」限流：与请求计数限流互补。
 * 请求计数限流挡不住「120 次 × 10MB」这种量级的配额消耗，字节限流才能直接约束它。
 */
function isUploadBytesExceeded(req, size) {
  if (MAX_UPLOAD_BYTES_PER_WINDOW <= 0) return false

  const bucket = takeBucket(uploadByteBuckets, req)
  if (bucket.bytes + size > MAX_UPLOAD_BYTES_PER_WINDOW) return true

  bucket.bytes += size
  return false
}


const rateBuckets = new Map()

/** 上传字节限流的窗口桶（见 isUploadBytesExceeded） */
const uploadByteBuckets = new Map()


/**
 * 取出（必要时新建）某个来源在当前限流窗口内的计数桶。
 * 两个限流器共用这一种桶形状，避免各写一遍「取桶 → 判过期 → 新建」。
 */
function takeBucket(store, req) {
  const key = req.socket.remoteAddress ?? 'unknown'
  const now = Date.now()
  let bucket = store.get(key)

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, bytes: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }
    store.set(key, bucket)
  }

  return bucket
}


function isRateLimited(req) {
  // 注意：限流一旦启用就一定计数，即使随后请求因其他原因被拒（fail-closed 方向）
  const bucket = takeBucket(rateBuckets, req)
  bucket.count += 1
  return bucket.count > RATE_LIMIT_MAX
}



export {
  corsHeaders,
  isAuthorized,
  streamTickets,
  nowIso,
  HttpError,
  auditLog,
  baseUrl,
  isStreamTicketAuthorized,
  isPublicUpload,
  writeJson,
  writeSseFrame,
  readBody,
  sendSseHeaders,
  isUploadBytesExceeded,
  rateBuckets,
  uploadByteBuckets,
  takeBucket,
  isRateLimited
}
