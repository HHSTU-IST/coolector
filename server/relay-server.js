import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  contentDisposition,
  decodeHeaderValue,
  isLoopbackHost,
  isTextMimeType,
  isWeakRoomId,
  makeAuthorizer,
  makeCorsHeaders,
  makeTicketStore,
  normalizeAllowedOrigins,
  sanitizeRoomId,
  sanitizeStorageFileName
} from './relay-utils.js'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'
// 单个文件「解码后」的体积上限，与前端 src/stores/file.ts 的 MAX_FILE_SIZE 保持一致
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES ?? 10 * 1024 * 1024)
// 请求体上限：JSON 信封里的 contentBase64 相比原始字节膨胀约 4/3，另留头部与字段开销余量。
// 过去把请求体上限直接当成文件上限，导致二进制实际可用体积只有约 7.5MB，这里改为派生计算。
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? Math.ceil((MAX_FILE_BYTES * 4) / 3) + 64 * 1024)
const MAX_QUEUE_EVENTS = Number(process.env.MAX_QUEUE_EVENTS ?? 200)
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS ?? 6 * 60 * 60 * 1000)
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? fileURLToPath(new URL('./uploads', import.meta.url))

// 设为非空后，所有 /api 请求必须携带 `Authorization: Bearer <token>`。默认关闭以保持本地开箱可用。
const RELAY_TOKEN = process.env.RELAY_TOKEN ?? ''
// 逗号分隔的白名单；`*` 表示任意来源。部署到公网时务必收窄。
// 空串（如 docker-compose 的 ${VAR:-} 传入）在此归一为 `*`，避免白名单被误判为空导致 CORS 头缺失。
const ALLOWED_ORIGINS = normalizeAllowedOrigins(process.env.RELAY_ALLOWED_ORIGINS)
// UPLOAD_DIR 的磁盘配额，超出后拒绝新上传，避免磁盘被无限写满。
const MAX_TOTAL_UPLOAD_BYTES = Number(process.env.MAX_TOTAL_UPLOAD_BYTES ?? 1024 * 1024 * 1024)
// 仅在可信反向代理之后才信任 x-forwarded-* 头，避免直连时被伪造出错误跳转地址。
const TRUST_PROXY = (process.env.RELAY_TRUST_PROXY ?? 'false') === 'true'
// SSE 票据有效期（毫秒），短时效一次性，替代 URL 中的长期 token。
const STREAM_TICKET_TTL_MS = Number(process.env.STREAM_TICKET_TTL_MS ?? 60_000)

const rooms = new Map()

/** 已落盘的字节总数，用于配额判断；进程重启后重新累计。 */
let totalStoredBytes = 0

/** 按当前来源计算 CORS 响应头；来源不在白名单时返回空对象，浏览器会自行拦截 */
const corsHeaders = makeCorsHeaders(ALLOWED_ORIGINS)

/** 未配置 RELAY_TOKEN 时放行所有请求；配置后要求 Bearer 头或 ?token= 查询参数（SSE 用） */
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

function createRoom(roomId = randomUUID()) {
  const id = sanitizeRoomId(roomId)
  if (!id) {
    throw new Error('Invalid room id')
  }

  const existing = rooms.get(id)
  if (existing) {
    return { room: existing, created: false }
  }

  const room = {
    id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastActivity: Date.now(),
    receiver: null,
    queue: [],
    uploads: new Map(),
    stats: {
      receiverConnections: 0,
      uploads: 0,
      eventsDelivered: 0
    }
  }

  rooms.set(id, room)
  return { room, created: true }
}

function getRoom(roomId) {
  const id = sanitizeRoomId(roomId)
  if (!id) return null
  return rooms.get(id) ?? null
}

function roomSnapshot(room, req) {
  // 房间状态只暴露元信息与下载链接，正文走 details 端点按需拉取
  const uploads = Array.from(room.uploads.values())
    .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
    .map((upload) => uploadSummary(upload, req, { includeContent: false }))

  return {
    roomId: room.id,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    hasReceiver: Boolean(room.receiver),
    queuedEvents: room.queue.length,
    uploadCount: room.uploads.size,
    stats: room.stats,
    uploads
  }
}

/** 生成上传摘要；SSE 广播传 includeContent:false 只推元信息，正文按需走 details 端点 */
function uploadSummary(upload, req, { includeContent = true } = {}) {
  const detailsUrl = `${baseUrl(req)}/api/rooms/${upload.roomId}/uploads/${upload.id}`
  const summary = {
    id: upload.id,
    name: upload.name,
    mimeType: upload.mimeType,
    size: upload.size,
    uploadedAt: upload.uploadedAt,
    lastModified: upload.lastModified,
    hasTextPreview: Boolean(upload.previewText),
    previewText: upload.previewText ?? null,
    contentIncluded: includeContent,
    contentText: includeContent ? upload.text ?? null : null,
    contentBase64: includeContent ? upload.contentBase64 : null,
    detailsUrl,
    downloadUrl: `${detailsUrl}?download=1`,
    // 只暴露「是否已落盘」，不返回服务端存储文件名/相对路径，避免路径信息泄露
    serverStored: Boolean(upload.storagePath)
  }

  return summary
}

function trimQueue(room) {
  while (room.queue.length > MAX_QUEUE_EVENTS) {
    room.queue.shift()
  }
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

function closeReceiver(room) {
  if (!room.receiver) return

  const { res, heartbeat } = room.receiver
  clearInterval(heartbeat)
  room.receiver = null

  if (!res.writableEnded) {
    res.end()
  }
}

function queueEvent(room, event) {
  room.queue.push(event)
  trimQueue(room)
}

function dispatchEvent(room, eventName, data) {
  const event = {
    id: randomUUID(),
    type: eventName,
    createdAt: nowIso(),
    data
  }

  room.updatedAt = event.createdAt
  room.lastActivity = Date.now()

  if (room.receiver && room.receiver.res.writable) {
    try {
      writeSseFrame(room.receiver.res, eventName, event)
      room.stats.eventsDelivered += 1
      return event
    } catch {
      closeReceiver(room)
    }
  }

  queueEvent(room, event)
  return event
}

async function persistUpload(upload) {
  const storageFileName = `${upload.id}-${sanitizeStorageFileName(upload.name)}`
  const roomUploadDir = join(UPLOAD_DIR, upload.roomId)
  const storagePath = join(roomUploadDir, storageFileName)
  const buffer = Buffer.from(upload.contentBase64, 'base64')

  await mkdir(roomUploadDir, { recursive: true })
  await writeFile(storagePath, buffer)

  upload.storagePath = storagePath
  upload.storageFileName = storageFileName
}

function parseUploadMetadata(req, bodyBuffer, headers, query) {
  // 是否按 JSON 信封解析，只取决于显式头 X-Relay-Envelope: 1。
  // 过去仅凭 Content-Type: application/json 判断，会把正文本身就是 JSON 的文件（如 .json/.ipynb）
  // 误当成信封，最终报 400 Missing file content。
  const isEnvelope = String(req.headers['x-relay-envelope'] ?? '') === '1'

  if (isEnvelope) {
    let raw
    try {
      raw = bodyBuffer.length ? JSON.parse(bodyBuffer.toString('utf8')) : {}
    } catch {
      throw new HttpError(400, 'Invalid JSON body')
    }

    const fileName = raw.name ?? raw.fileName
    if (!fileName) {
      throw new HttpError(400, 'Missing file name')
    }

    const mimeType = raw.mimeType ?? 'text/plain'
    const lastModified = raw.lastModified ?? nowIso()
    const text = typeof raw.text === 'string' ? raw.text : typeof raw.contentText === 'string' ? raw.contentText : null
    const contentBase64 = typeof raw.contentBase64 === 'string'
      ? raw.contentBase64
      : text !== null
        ? Buffer.from(text, 'utf8').toString('base64')
        : typeof raw.content === 'string'
          ? Buffer.from(raw.content, 'utf8').toString('base64')
          : null

    if (!contentBase64) {
      throw new HttpError(400, 'Missing file content')
    }

    const decoded = Buffer.from(contentBase64, 'base64')
    return {
      name: String(fileName),
      mimeType: String(mimeType),
      lastModified: String(lastModified),
      contentBase64,
      text: text ?? (isTextMimeType(String(mimeType), String(fileName)) ? decoded.toString('utf8') : null)
    }
  }

  // 裸 body 分支：正文即请求体，元信息放在头或查询参数里（curl 等非浏览器客户端）
  const fileName = decodeHeaderValue(headers['x-relay-filename']) ?? query.get('name')
  if (!fileName) {
    throw new HttpError(400, 'Missing file name')
  }

  const mimeType = headers['x-relay-mime-type'] ?? 'application/octet-stream'
  const lastModified = headers['x-relay-last-modified'] ?? nowIso()
  const contentBase64 = bodyBuffer.toString('base64')
  const text = isTextMimeType(String(mimeType), String(fileName))
    ? bodyBuffer.toString('utf8')
    : null

  return {
    name: String(fileName),
    mimeType: String(mimeType),
    lastModified: String(lastModified),
    contentBase64,
    text
  }
}

/**
 * 读取请求体，超过 limit 抛 413。
 * 超限时**不立即 destroy**：否则 socket 被抢先销毁，客户端只会看到网络中断
 * （浏览器报 Failed to fetch）而拿不到 413 响应体。改为停止累积、继续排空，
 * 仅在超出硬上限（4×limit）时才强制断开以防御超大体积滥用。
 */
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let exceeded = false

    req.on('data', (chunk) => {
      if (exceeded) return
      size += chunk.length

      if (size > limit) {
        exceeded = true
        if (size > limit * 4) {
          req.destroy()
        }
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

async function handleCreateRoom(req, res) {
  const body = await readBody(req)
  let requestedId = null

  if (body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString('utf8'))
      requestedId = sanitizeRoomId(parsed.roomId ?? parsed.id)
    } catch {
      throw new Error('Invalid JSON body')
    }
  }

  const room = createRoom(requestedId ?? undefined)
  if (room.created) {
    dispatchEvent(room.room, 'room.created', {
      roomId: room.room.id,
      createdAt: room.room.createdAt
    })
    auditLog('room_created', { roomId: room.room.id, ip: req.socket.remoteAddress })
    // 发送方公开写模型下房间 ID 即能力凭据；自定义弱 ID 只告警不阻断（班级可能确有命名约定）
    if (isWeakRoomId(room.room.id)) {
      auditLog('weak_room_id', { roomId: room.room.id, ip: req.socket.remoteAddress })
    }
  }

  return writeJson(res, 201, {
    roomId: room.room.id,
    createdAt: room.room.createdAt,
    streamUrl: `${baseUrl(req)}/api/rooms/${room.room.id}/events`,
    streamTicketUrl: `${baseUrl(req)}/api/rooms/${room.room.id}/stream-ticket`,
    uploadUrl: `${baseUrl(req)}/api/rooms/${room.room.id}/uploads`,
    stateUrl: `${baseUrl(req)}/api/rooms/${room.room.id}`
  }, corsHeaders(req))
}

async function handleUpload(req, res, room, query) {
  const headers = corsHeaders(req)
  const body = await readBody(req)
  const metadata = parseUploadMetadata(req, body, req.headers, query)
  const size = Buffer.from(metadata.contentBase64, 'base64').length

  if (size > MAX_FILE_BYTES) {
    throw new HttpError(413, `File exceeds size limit (${MAX_FILE_BYTES} bytes)`)
  }

  if (totalStoredBytes + size > MAX_TOTAL_UPLOAD_BYTES) {
    throw new HttpError(507, `Upload storage quota exceeded (limit ${MAX_TOTAL_UPLOAD_BYTES} bytes)`)
  }

  const upload = {
    id: randomUUID(),
    roomId: room.id,
    name: metadata.name,
    mimeType: metadata.mimeType,
    lastModified: metadata.lastModified,
    uploadedAt: nowIso(),
    size,
    contentBase64: metadata.contentBase64,
    text: metadata.text,
    previewText: metadata.text ? metadata.text.slice(0, 4096) : null
  }

  await persistUpload(upload)
  totalStoredBytes += size

  room.uploads.set(upload.id, upload)
  room.stats.uploads += 1
  room.updatedAt = upload.uploadedAt
  room.lastActivity = Date.now()
  auditLog('upload_created', { roomId: room.id, name: upload.name, size })

  // 响应里带上完整正文，广播事件里只带元信息
  const uploadPayload = uploadSummary(upload, req)
  const event = dispatchEvent(room, 'upload.created', {
    roomId: room.id,
    upload: uploadSummary(upload, req, { includeContent: false }),
    downloadUrl: `${baseUrl(req)}/api/rooms/${room.id}/uploads/${upload.id}`
  })

  return writeJson(res, 201, {
    upload: uploadPayload,
    eventId: event.id
  }, headers)
}

async function handleDownload(req, res, room, uploadId, query) {
  const headers = corsHeaders(req)
  const upload = room.uploads.get(uploadId)
  if (!upload) {
    return writeJson(res, 404, { error: 'Upload not found' }, headers)
  }

  const download = query.get('download')
  if (download === '1') {
    const buffer = upload.storagePath
      ? await readFile(upload.storagePath)
      : Buffer.from(upload.contentBase64, 'base64')
    res.writeHead(200, {
      ...headers,
      'Content-Type': upload.mimeType,
      'Content-Disposition': contentDisposition(upload.name),
      'Content-Length': buffer.length
    })
    res.end(buffer)
    return
  }

  return writeJson(res, 200, {
    upload: uploadSummary(upload, req),
    text: upload.previewText,
    contentBase64: upload.contentBase64
  }, headers)
}

function handleEvents(req, res, room) {
  closeReceiver(room)
  sendSseHeaders(res, corsHeaders(req))

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n')
    }
  }, 15000)

  room.receiver = { res, heartbeat }
  room.stats.receiverConnections += 1
  room.lastActivity = Date.now()
  auditLog('receiver_connected', { roomId: room.id })

  writeSseFrame(res, 'receiver.ready', {
    id: randomUUID(),
    type: 'receiver.ready',
    createdAt: nowIso(),
    data: {
      roomId: room.id,
      message: 'Receiver connected'
    }
  })

  while (room.queue.length > 0 && res.writable) {
    const event = room.queue.shift()
    writeSseFrame(res, event.type, event)
    room.stats.eventsDelivered += 1
  }

  req.on('close', () => {
    clearInterval(heartbeat)
    if (room.receiver?.res === res) {
      room.receiver = null
    }
  })
}

/** 删除房间并回收其占用的磁盘配额 */
function destroyRoom(room) {
  closeReceiver(room)
  rooms.delete(room.id)

  for (const upload of room.uploads.values()) {
    totalStoredBytes -= upload.size
  }
  room.uploads.clear()

  void rm(join(UPLOAD_DIR, room.id), { recursive: true, force: true })
}

function handleRoomDelete(req, res, roomId) {
  const room = getRoom(roomId)
  if (!room) {
    return writeJson(res, 404, { error: 'Room not found' }, corsHeaders(req))
  }

  destroyRoom(room)
  auditLog('room_deleted', { roomId: room.id })
  return writeJson(res, 200, {
    deleted: true,
    roomId: room.id
  }, corsHeaders(req))
}

function cleanupRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS

  for (const room of rooms.values()) {
    // 房间过期后即使仍有上传也要回收，否则磁盘只增不减
    if (room.lastActivity < cutoff && !room.receiver) {
      destroyRoom(room)
    }
  }

  if (totalStoredBytes < 0) {
    totalStoredBytes = 0
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `localhost:${PORT}`}`)
    const pathname = url.pathname.replace(/\/+$/u, '') || '/'

    const cors = corsHeaders(req)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'Access-Control-Max-Age': '86400'
      })
      res.end()
      return
    }

    // 速率限制：/api 请求按来源 IP 计数，超出上限返回 429
    if (pathname.startsWith('/api/') && isRateLimited(req)) {
      auditLog('rate_limited', { ip: req.socket.remoteAddress, path: pathname })
      writeJson(res, 429, { error: 'Too many requests' }, cors)
      return
    }

    if (req.method === 'GET' && pathname === '/') {
      writeJson(res, 200, {
        name: 'Coolector Relay Server',
        status: 'ok',
        routes: {
          createRoom: 'POST /api/rooms',
          roomState: 'GET /api/rooms/:roomId',
          receiverStream: 'GET /api/rooms/:roomId/events',
          streamTicket: 'POST /api/rooms/:roomId/stream-ticket',
          upload: 'POST /api/rooms/:roomId/uploads',
          uploadDetails: 'GET /api/rooms/:roomId/uploads/:uploadId',
          download: 'GET /api/rooms/:roomId/uploads/:uploadId?download=1',
          deleteRoom: 'DELETE /api/rooms/:roomId',
          healthz: 'GET /healthz'
        },
        authRequired: Boolean(RELAY_TOKEN),
        storageUsedBytes: totalStoredBytes,
        storageLimitBytes: MAX_TOTAL_UPLOAD_BYTES
      }, cors)
      return
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      writeJson(res, 200, {
        status: 'ok',
        rooms: rooms.size,
        uptimeSeconds: Math.floor(process.uptime())
      }, cors)
      return
    }

    // /api 下统一走鉴权，但有两类例外：
    // 1) 发送方公开写：POST /api/rooms/:roomId/uploads 不要求凭据 —— 发送方（学生）本就不该持有
    //    接收端管理密钥，房间 ID 本身就是不可猜的能力凭据；配合限流与体积上限控制滥用。
    // 2) SSE 一次性票据：EventSource 无法自定义请求头，用短时效票据替代长期 token。
    if (pathname.startsWith('/api/') && !isAuthorized(req) && !isStreamTicketAuthorized(req, pathname) && !isPublicUpload(req, pathname)) {
      auditLog('auth_failed', { method: req.method, path: pathname, ip: req.socket.remoteAddress })
      writeJson(res, 401, { error: 'Unauthorized' }, cors)
      return
    }

    if (req.method === 'POST' && pathname === '/api/rooms') {
      await handleCreateRoom(req, res)
      return
    }

    const roomMatch = pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(events|uploads|stream-ticket)(?:\/([^/]+))?)?$/u)
    if (!roomMatch) {
      writeJson(res, 404, { error: 'Not found' }, cors)
      return
    }

    const [, roomIdRaw, subresource, subresourceId] = roomMatch
    const roomId = sanitizeRoomId(roomIdRaw)
    if (!roomId) {
      writeJson(res, 400, { error: 'Invalid room id' }, cors)
      return
    }

    // 房间必须由接收端（持凭据）先创建。取消「上传即建房」是因为：发送方落进一个
    // 没有接收端的房间等于进黑洞，且允许自造 ID 建房会让任何人无限占用内存与磁盘。
    const room = getRoom(roomId)
    if (!room) {
      writeJson(res, 404, { error: 'Room not found or expired' }, cors)
      return
    }

    if (req.method === 'GET' && !subresource) {
      writeJson(res, 200, roomSnapshot(room, req), cors)
      return
    }

    if (req.method === 'DELETE' && !subresource) {
      handleRoomDelete(req, res, roomId)
      return
    }

    if (req.method === 'POST' && subresource === 'stream-ticket') {
      const ticket = streamTickets.issue(room.id)
      auditLog('stream_ticket_issued', { roomId: room.id, ip: req.socket.remoteAddress })
      writeJson(res, 201, { ticket, expiresInMs: STREAM_TICKET_TTL_MS }, cors)
      return
    }

    if (req.method === 'GET' && subresource === 'events') {
      handleEvents(req, res, room)
      return
    }

    if (req.method === 'POST' && subresource === 'uploads') {
      await handleUpload(req, res, room, url.searchParams)
      return
    }

    if (req.method === 'GET' && subresource === 'uploads' && subresourceId) {
      await handleDownload(req, res, room, subresourceId, url.searchParams)
      return
    }

    writeJson(res, 405, { error: 'Method not allowed' }, cors)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error'
    auditLog('request_error', { path: req.url, message })

    // HttpError 的 message 由本服务自行构造，可安全回传给客户端（400/413/507 等）
    if (error instanceof HttpError) {
      writeJson(res, error.statusCode, { error: error.message }, corsHeaders(req))
      return
    }

    // 任何未包装的异常一律脱敏，细节只落审计日志
    writeJson(res, 400, { error: 'Bad request' }, corsHeaders(req))
  }
})

// —— 速率限制（固定窗口，按 socket 来源 IP 计数；反向代理后为代理 IP，属尽力而为） ——
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60 * 1000)
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 120)
const rateBuckets = new Map()

function isRateLimited(req) {
  const ip = req.socket.remoteAddress ?? 'unknown'
  const now = Date.now()
  let bucket = rateBuckets.get(ip)

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }
    rateBuckets.set(ip, bucket)
  }

  bucket.count += 1
  return bucket.count > RATE_LIMIT_MAX
}

setInterval(() => {
  const now = Date.now()
  for (const [ip, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(ip)
  }
}, RATE_LIMIT_WINDOW_MS).unref()

/** 启动时扫描 UPLOAD_DIR，用磁盘实际占用初始化配额计数，避免重启后配额归零被绕过 */
async function initStoredBytes() {
  try {
    const entries = await readdir(UPLOAD_DIR, { withFileTypes: true })
    let total = 0

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const files = await readdir(join(UPLOAD_DIR, entry.name), { withFileTypes: true })

      for (const file of files) {
        if (!file.isFile()) continue
        const fileStat = await stat(join(UPLOAD_DIR, entry.name, file.name))
        total += fileStat.size
      }
    }

    totalStoredBytes = total
  } catch {
    totalStoredBytes = 0
  }
}

setInterval(cleanupRooms, 30 * 60 * 1000).unref()

// fail-closed：非回环监听且未配置 RELAY_TOKEN 时拒绝启动，防止公网裸奔
if (!RELAY_TOKEN && !isLoopbackHost(HOST)) {
  console.error('[relay] 拒绝启动：未设置 RELAY_TOKEN 时仅允许监听回环地址（127.0.0.1 / localhost / ::1）。')
  console.error(`[relay] 当前 HOST=${HOST}。请在 .env 设置 RELAY_TOKEN，或将 HOST 改为回环地址用于本地调试。`)
  process.exit(1)
}

await initStoredBytes()

server.listen(PORT, HOST, () => {
  console.log(`Relay server listening on http://${HOST}:${PORT}`)
})
