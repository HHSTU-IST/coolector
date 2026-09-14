// 与业务无关的 HTTP 传输原语与「请求准入」：错误类型、审计日志、CORS、鉴权、限流、读写。
// 本模块不持有房间状态，可被单测直接 import。

import { makeAuthorizer, makeClientIpResolver, makeCorsHeaders, makeTicketStore, sanitizeRoomId } from './relay-utils.js'
import {
  ALLOWED_ORIGINS, MAX_BODY_BYTES, MAX_UPLOAD_BYTES_PER_WINDOW, PUBLIC_BASE_URL,
  RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, RELAY_TOKEN, STREAM_TICKET_TTL_MS, TRUSTED_PROXIES
} from './relay-config.js'

/** 限流分桶用的客户端 IP：只有可信代理后的请求才采信 X-Forwarded-For（见 relay-utils） */
const resolveClientIp = makeClientIpResolver(TRUSTED_PROXIES)

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


/**
 * 构造对外可用的资源地址。
 *
 * **默认只返回相对路径**（如 `/api/rooms/<id>/uploads/<uid>`），由客户端按自己配置的
 * Relay 地址解析。这里刻意不接受 `req`：服务端不得从 `Host` / `x-forwarded-*` 推断自身的
 * 对外地址 —— 这些请求头完全由调用方控制，而接收端前端会自动**带着管理密钥**去拉取服务端
 * 返回的 URL。无凭据的发送方只要在普通上传请求里伪造 `Host: evil.example`，就能让接收端把
 * `RELAY_TOKEN` 发往攻击者域（F-001）。
 *
 * 需要绝对 URL 的部署（例如给 curl / 自定义集成消费）请显式配置 `RELAY_PUBLIC_BASE_URL`；
 * 那是唯一能产生绝对 URL 的来源，而它是运维配置而非请求输入，因此不可被外部左右。
 */
function relayUrl(path) {
  return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${path}` : path
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
  const key = resolveClientIp(req)
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
  relayUrl,
  isStreamTicketAuthorized,
  isPublicUpload,
  writeJson,
  writeSseFrame,
  readBody,
  sendSseHeaders,
  isUploadBytesExceeded,
  rateBuckets,
  uploadByteBuckets,
  isRateLimited
}
