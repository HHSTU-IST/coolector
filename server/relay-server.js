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
  limitUploadName,
  makeAuthorizer,
  makeCorsHeaders,
  makeTicketStore,
  normalizeAllowedOrigins,
  normalizeIsoDate,
  parsePositiveInt,
  sanitizeMimeType,
  sanitizeRoomId,
  sanitizeStorageFileName,
  truncateUtf8
} from './relay-utils.js'

/**
 * 读取正整数型环境变量，非法即拒绝启动。
 * 不能让 `Number('10mb')` 这类笔误静默变成 `NaN` —— 那会让体积校验全部失效（fail-open）。
 */
function requirePositiveInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const result = parsePositiveInt(process.env[name], { fallback, min, max })

  if (!result.ok) {
    console.error(`[relay] 拒绝启动：环境变量 ${name} 必须是 ${min}–${max} 之间的整数，当前值为 ${JSON.stringify(result.raw)}。`)
    process.exit(1)
  }

  return result.value
}

const PORT = requirePositiveInt('PORT', 8787, { max: 65535 })
const HOST = process.env.HOST ?? '0.0.0.0'
// 单个文件「解码后」的体积上限，与前端 src/stores/file.ts 的 MAX_FILE_SIZE 保持一致
const MAX_FILE_BYTES = requirePositiveInt('MAX_FILE_BYTES', 10 * 1024 * 1024)
// 信封里 text 字段的上限。前端只发前 256KB，这里再兜一层防止第三方客户端塞入超大正文
const MAX_TEXT_BYTES = Math.max(
  requirePositiveInt('MAX_TEXT_BYTES', 1024 * 1024),
  // 不得低于客户端的正文上限，否则「10MB 文件 + 正文」会被自己的派生上限误判 413
  256 * 1024
)
// 请求体上限：contentBase64 相比原始字节膨胀约 4/3，**再加上信封里同时携带的 text**，
// 最后留 JSON 字段与头部开销余量。
// 过去只算 base64 膨胀，导致带提取正文的 docx 有效上限掉到约 8.55MB（名义 10MB）。
const MAX_BODY_BYTES = requirePositiveInt(
  'MAX_BODY_BYTES',
  Math.ceil((MAX_FILE_BYTES * 4) / 3) + MAX_TEXT_BYTES + 128 * 1024
)
const MAX_QUEUE_EVENTS = requirePositiveInt('MAX_QUEUE_EVENTS', 200)
const ROOM_TTL_MS = requirePositiveInt('ROOM_TTL_MS', 6 * 60 * 60 * 1000)
// 房间绝对存活上限：空闲 TTL 会被上传刷新，没有这一层则「每 <TTL 传 1 字节」即可永久占住配额
const ROOM_MAX_LIFETIME_MS = requirePositiveInt('ROOM_MAX_LIFETIME_MS', 24 * 60 * 60 * 1000)
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? fileURLToPath(new URL('./uploads', import.meta.url))

// 设为非空后，除「发送方公开写」与 SSE 一次性票据外的 /api 请求必须携带 `Authorization: Bearer <token>`。
const RELAY_TOKEN = process.env.RELAY_TOKEN ?? ''
// 逗号分隔的白名单；`*` 表示任意来源。部署到公网时务必收窄。
// 空串（如 docker-compose 的 ${VAR:-} 传入）在此归一为 `*`，避免白名单被误判为空导致 CORS 头缺失。
const ALLOWED_ORIGINS = normalizeAllowedOrigins(process.env.RELAY_ALLOWED_ORIGINS)
// 整个上传目录的磁盘配额硬上限。
const MAX_TOTAL_UPLOAD_BYTES = requirePositiveInt('MAX_TOTAL_UPLOAD_BYTES', 1024 * 1024 * 1024)
// 单个房间的配额上限。默认取全局的 1/8 —— 免凭据的发送方只能填满「自己那个房间」，
// 而不是把全站配额吃光导致所有班级都上传失败。
const MAX_ROOM_UPLOAD_BYTES = requirePositiveInt(
  'MAX_ROOM_UPLOAD_BYTES',
  Math.max(Math.floor(MAX_TOTAL_UPLOAD_BYTES / 8), 8 * 1024 * 1024)
)
// 单个来源 IP 在限流窗口内可写入的字节数（0 = 关闭）。与请求计数限流互补，直接限制配额消耗速率。
const MAX_UPLOAD_BYTES_PER_WINDOW = requirePositiveInt('MAX_UPLOAD_BYTES_PER_WINDOW', 256 * 1024 * 1024, { min: 0 })
// 单个房间的上传条数上限：即使每个文件都是 0 字节，也不能让 room.uploads 无限增长
const MAX_ROOM_UPLOADS = requirePositiveInt('MAX_ROOM_UPLOADS', 500)
// 上传文件名上限（字节）。文件名会进入内存、房间快照、SSE 帧与审计日志，必须有界
const MAX_UPLOAD_NAME_BYTES = requirePositiveInt('MAX_UPLOAD_NAME_BYTES', 255)
// 房间清理扫描周期（毫秒）
const ROOM_CLEANUP_INTERVAL_MS = requirePositiveInt('ROOM_CLEANUP_INTERVAL_MS', 30 * 60 * 1000)
// 启动时是否保留「无主目录」（磁盘存在但内存无对应房间的目录）。
// 默认回收：房间只活在内存里，重启后这些文件已无法通过任何 HTTP 路径访问，
// 却会被 initStoredBytes 永久计入全局配额，且没有回收路径。
const KEEP_ORPHAN_UPLOADS = (process.env.RELAY_KEEP_ORPHAN_UPLOADS ?? 'false') === 'true'
// 仅测试用的故障注入：让 destroyRoom 的目录删除必定失败，用于验证错误隔离护栏。默认关闭。
const INJECT_RM_FAILURE = process.env.RELAY_TEST_INJECT_RM_FAILURE === 'true'
// 仅在可信反向代理之后才信任 x-forwarded-* 头，避免直连时被伪造出错误跳转地址。
const TRUST_PROXY = (process.env.RELAY_TRUST_PROXY ?? 'false') === 'true'
// SSE 票据有效期（毫秒），短时效一次性，替代 URL 中的长期 token。
const STREAM_TICKET_TTL_MS = requirePositiveInt('STREAM_TICKET_TTL_MS', 60_000)

const rooms = new Map()

/** 已落盘的字节总数，用于配额判断；进程重启后重新累计。 */
let totalStoredBytes = 0

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
    /** 本房间已占用的字节数（正文 + 元数据 + 保留文本），用于单房间配额 */
    storedBytes: 0,
    /** 已预占但尚未完成落盘的上传条数（见 reserveUploadSlot） */
    pendingUploads: 0,
    /** 是否已被销毁：用于让在途上传感知到「房间已没了」而不是静默写入 */
    destroyed: false,
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

/**
 * 原子预留存储配额 —— 本项目**唯一**允许增加 `room.storedBytes` / `totalStoredBytes` 的入口。
 *
 * 检查与扣减必须**同步**完成：一旦中间插入 `await`，并发请求会全部读到旧值而击穿配额
 * （实测 32 并发可把 4MB 配额打到 8.39×）。返回值是回滚函数，落盘失败时必须调用。
 */
function reserveStorageQuota(room, quotaBytes) {
  if (room.storedBytes + quotaBytes > MAX_ROOM_UPLOAD_BYTES) {
    throw new HttpError(507, `Room storage quota exceeded (limit ${MAX_ROOM_UPLOAD_BYTES} bytes)`)
  }
  if (totalStoredBytes + quotaBytes > MAX_TOTAL_UPLOAD_BYTES) {
    throw new HttpError(507, `Upload storage quota exceeded (limit ${MAX_TOTAL_UPLOAD_BYTES} bytes)`)
  }

  room.storedBytes += quotaBytes
  totalStoredBytes += quotaBytes

  return () => {
    // 房间已被销毁时，它的占用已经在 destroyRoom 里整体回收过了 —— 这里再减就会把
    // 其它房间的额度一起吃掉（全局计数被多减）。故以 destroyed 标记短路。
    if (room.destroyed) return
    room.storedBytes = Math.max(room.storedBytes - quotaBytes, 0)
    totalStoredBytes = Math.max(totalStoredBytes - quotaBytes, 0)
  }
}

/**
 * 原子预留一个上传槽位。
 *
 * 与配额同理：必须把「正在落盘中」的请求也计入，否则并发下每个请求都只看到
 * `uploads.size` 的旧值（实测限额 5、50 并发可全部通过）。成功落盘后调用返回的函数，
 * 此时 `uploads.size` 已经加过，`pendingUploads` 减回，账目守恒。
 */
function reserveUploadSlot(room) {
  if (room.uploads.size + room.pendingUploads >= MAX_ROOM_UPLOADS) {
    throw new HttpError(429, `Room upload count limit reached (limit ${MAX_ROOM_UPLOADS})`)
  }

  room.pendingUploads += 1
  let released = false

  return () => {
    if (released) return
    released = true
    room.pendingUploads = Math.max(room.pendingUploads - 1, 0)
  }
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
    storedBytes: room.storedBytes,
    storageLimitBytes: MAX_ROOM_UPLOAD_BYTES,
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
    previewText: upload.previewText ?? null,
    /** 正文是否因超过 MAX_TEXT_BYTES 被截断（前端据此提示用户） */
    textTruncated: Boolean(upload.textTruncated),
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

/**
 * 房间目录的归属标记文件名。
 *
 * 启动回收**只删**「内含该标记、且标记里的 roomId 与目录名一致」的目录。
 * 没有这一层守卫的话，一个无差别的 `rm -rf` 在 `UPLOAD_DIR` 指向卷根时会删掉无关数据
 * （实测把 `notes.backup/`、`my notes/` 一起删光）。
 */
const ROOM_SENTINEL_FILENAME = '.coolector-room'

async function writeRoomSentinel(roomUploadDir, roomId) {
  const payload = JSON.stringify({ generator: 'coolector-relay', version: 1, roomId })
  await writeFile(join(roomUploadDir, ROOM_SENTINEL_FILENAME), payload, 'utf8')
}

/** 读取目录归属标记；缺失 / 损坏 / 非本程序所写一律返回 null（此时**绝不删除**） */
async function readRoomSentinel(roomUploadDir) {
  try {
    const raw = await readFile(join(roomUploadDir, ROOM_SENTINEL_FILENAME), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed?.generator !== 'coolector-relay') return null
    return typeof parsed.roomId === 'string' ? parsed.roomId : null
  } catch {
    return null
  }
}

async function persistUpload(upload) {
  const roomUploadDir = join(UPLOAD_DIR, upload.roomId)
  const storageFileName = `${upload.id}-${sanitizeStorageFileName(upload.name)}`
  const storagePath = join(roomUploadDir, storageFileName)
  const buffer = Buffer.from(upload.contentBase64 ?? '', 'base64')

  await mkdir(roomUploadDir, { recursive: true })
  // 先写归属标记再写正文，保证目录一旦有内容就一定带标记
  await writeRoomSentinel(roomUploadDir, upload.roomId)
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

    const lastModified = raw.lastModified ?? nowIso()
    const safeMimeType = sanitizeMimeType(raw.mimeType ?? 'text/plain')
    const text = typeof raw.text === 'string' ? raw.text : typeof raw.contentText === 'string' ? raw.contentText : null
    const contentBase64 = typeof raw.contentBase64 === 'string'
      ? raw.contentBase64
      : text !== null
        ? Buffer.from(text, 'utf8').toString('base64')
        : typeof raw.content === 'string'
          ? Buffer.from(raw.content, 'utf8').toString('base64')
          : null

    // 用 typeof 判存在：0 字节文件的 contentBase64 是空串，不能当「缺失」拒绝
    if (typeof contentBase64 !== 'string') {
      throw new HttpError(400, 'Missing file content')
    }

    const decoded = Buffer.from(contentBase64, 'base64')
    const safeName = limitUploadName(fileName, MAX_UPLOAD_NAME_BYTES).name
    return {
      name: safeName,
      mimeType: safeMimeType,
      lastModified: normalizeIsoDate(lastModified, nowIso()),
      contentBase64,
      text: text ?? (isTextMimeType(safeMimeType, safeName) ? decoded.toString('utf8') : null)
    }
  }

  // 裸 body 分支：正文即请求体，元信息放在头或查询参数里（curl 等非浏览器客户端）
  const fileName = decodeHeaderValue(headers['x-relay-filename']) ?? query.get('name')
  if (!fileName) {
    throw new HttpError(400, 'Missing file name')
  }

  const safeMimeType = sanitizeMimeType(headers['x-relay-mime-type'] ?? 'application/octet-stream')
  const safeName = limitUploadName(fileName, MAX_UPLOAD_NAME_BYTES).name
  const contentBase64 = bodyBuffer.toString('base64')
  const text = isTextMimeType(safeMimeType, safeName)
    ? bodyBuffer.toString('utf8')
    : null

  return {
    name: safeName,
    mimeType: safeMimeType,
    lastModified: normalizeIsoDate(headers['x-relay-last-modified'], nowIso()),
    contentBase64,
    text
  }
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
    // 「房间号偏弱」的判定权威在服务端：前端据此提示，无需自己复刻一份弱名清单
    weakRoomId: isWeakRoomId(room.room.id),
    streamUrl: `${baseUrl(req)}/api/rooms/${room.room.id}/events`,
    streamTicketUrl: `${baseUrl(req)}/api/rooms/${room.room.id}/stream-ticket`,
    uploadUrl: `${baseUrl(req)}/api/rooms/${room.room.id}/uploads`,
    stateUrl: `${baseUrl(req)}/api/rooms/${room.room.id}`
  }, corsHeaders(req))
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

async function handleUpload(req, res, room, query) {
  const headers = corsHeaders(req)
  const body = await readBody(req)
  const metadata = parseUploadMetadata(req, body, req.headers, query)
  const size = Buffer.from(metadata.contentBase64, 'base64').length

  if (size > MAX_FILE_BYTES) {
    throw new HttpError(413, `File exceeds size limit (${MAX_FILE_BYTES} bytes)`)
  }

  if (isUploadBytesExceeded(req, body.length)) {
    throw new HttpError(429, `Upload rate exceeded (limit ${MAX_UPLOAD_BYTES_PER_WINDOW} bytes per window)`)
  }

  // 正文只用于预览/展示，按 UTF-8 边界截断，避免第三方客户端塞入超大正文撑爆内存
  const textField = metadata.text === null ? null : truncateUtf8(metadata.text, MAX_TEXT_BYTES)

  // 元数据也要计入配额：`name` / `mimeType` / `lastModified` / `text` 都会常驻内存，
  // 并进入房间快照与 SSE 帧。过去只按 contentBase64 计费，0 字节文件带数 MB 文件名
  // 就能以 storedBytes=0 通过全部配额检查。
  const metadataBytes = Buffer.byteLength(metadata.name, 'utf8')
    + Buffer.byteLength(metadata.mimeType, 'utf8')
    + Buffer.byteLength(metadata.lastModified, 'utf8')
    + (textField ? Buffer.byteLength(textField.text, 'utf8') : 0)
  const quotaBytes = size + metadataBytes

  // —— 两处原子预留，都必须在任何 await 之前同步完成 ——
  // 条数与字节是两类独立资源，历史上各自被并发绕过过一次（字节 8.39×、条数 10×）。
  const releaseSlot = reserveUploadSlot(room)
  let releaseQuota

  try {
    releaseQuota = reserveStorageQuota(room, quotaBytes)
  } catch (error) {
    releaseSlot()
    throw error
  }

  const upload = {
    id: randomUUID(),
    roomId: room.id,
    name: metadata.name,
    mimeType: metadata.mimeType,
    lastModified: metadata.lastModified,
    uploadedAt: nowIso(),
    size,
    /** 该条上传占用配额的字节数（正文 + 元数据 + 保留文本），回收时按此值扣减 */
    quotaBytes,
    contentBase64: metadata.contentBase64,
    text: textField ? textField.text : null,
    textTruncated: Boolean(textField?.truncated),
    previewText: textField ? textField.text.slice(0, 4096) : null
  }

  try {
    await persistUpload(upload)
  } catch (error) {
    // 落盘失败必须退回预占的配额与槽位，否则房间会被永久"占额"
    releaseQuota()
    releaseSlot()
    throw error
  }

  // 落盘期间房间可能已被销毁（绝对上限到期，或收到 DELETE）。
  // 此时必须把刚写下的文件删掉并回滚配额，并明确告知调用方 —— 绝不能返回 201 让
  // 发送方以为成功，而接收端永远收不到（静默丢件）。
  if (room.destroyed || !rooms.has(room.id)) {
    try {
      await rm(upload.storagePath, { force: true })
    } catch (error) {
      auditLog('orphan_file_cleanup_failed', {
        roomId: room.id,
        message: error instanceof Error ? error.message : String(error)
      })
    }
    releaseQuota()
    releaseSlot()
    throw new HttpError(410, 'Room was deleted while the upload was in flight')
  }

  // 落盘已成功，内存里不再保留 base64 副本（details 端点按需从磁盘读）。
  // 一份 10MB 上传若常驻 base64，会让 RSS 多出 1.33× 文件体积。
  upload.contentBase64 = null

  room.uploads.set(upload.id, upload)
  releaseSlot()
  room.stats.uploads += 1
  room.updatedAt = upload.uploadedAt
  room.lastActivity = Date.now()
  // 只记录截断后的名字与长度，避免超长文件名把审计日志放大到 MB 级
  auditLog('upload_created', { roomId: room.id, name: upload.name.slice(0, 120), nameLength: upload.name.length, size })

  // 201 响应里带上完整正文（发送方原本就能拿到），广播事件里只带元信息
  const uploadPayload = uploadSummary(upload, req)
  uploadPayload.contentBase64 = metadata.contentBase64

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
      : Buffer.from(upload.contentBase64 ?? '', 'base64')
    res.writeHead(200, {
      ...headers,
      'Content-Type': upload.mimeType,
      // 下载是附件语义：加 nosniff 防止浏览器把内容按上传者声明的类型嗅探渲染
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': contentDisposition(upload.name),
      'Content-Length': buffer.length
    })
    res.end(buffer)
    return
  }

  // 落盘后内存里不保留 base64 副本（见 handleUpload），这里按需从磁盘读回。
  // 只放在 `upload.contentBase64` 一处 —— 顶层曾经还有一份完全重复的副本，无人读取。
  const summary = uploadSummary(upload, req)
  summary.contentBase64 = upload.contentBase64 ?? (upload.storagePath
    ? (await readFile(upload.storagePath)).toString('base64')
    : null)

  return writeJson(res, 200, { upload: summary }, headers)
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

/**
 * 删除房间并回收其占用的磁盘配额。
 *
 * **错误隔离**：`rm` 失败（文件被占用、权限不足等）绝不允许冒泡 —— 清理任务由定时器驱动，
 * 未处理的拒绝会让整个 relay 进程退出（实测 exit=1，整站下线）。
 * 删除失败时返回 false，由调用方记录并等待下次重试。
 */
async function destroyRoom(room) {
  // 先置标记：在途上传据此判断「房间已经没了」，避免落盘后静默写入无人认领的文件
  room.destroyed = true
  closeReceiver(room)
  rooms.delete(room.id)

  totalStoredBytes = Math.max(totalStoredBytes - (room.storedBytes ?? 0), 0)
  room.storedBytes = 0
  room.pendingUploads = 0
  room.uploads.clear()

  const roomDir = join(UPLOAD_DIR, room.id)

  try {
    // 故障注入（仅测试用）：验证「删除失败不得冒泡成进程退出」这条护栏。
    // 只影响可靠性、不涉及安全，默认关闭。
    if (INJECT_RM_FAILURE) {
      throw new Error('injected rm failure (RELAY_TEST_INJECT_RM_FAILURE)')
    }

    await rm(roomDir, { recursive: true, force: true })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    auditLog('room_delete_failed', { roomId: room.id, message })
    console.error(`[relay] 房间目录删除失败，留待下次重试或人工清理：${roomDir} —— ${message}`)
    return false
  }
}

async function handleRoomDelete(req, res, roomId) {
  const room = getRoom(roomId)
  if (!room) {
    return writeJson(res, 404, { error: 'Room not found' }, corsHeaders(req))
  }

  const removed = await destroyRoom(room)
  auditLog('room_deleted', { roomId: room.id, dirRemoved: removed })

  // 即使磁盘目录没删干净，房间在服务端也已经不存在了 —— 对外仍报成功，
  // 否则调用方会以为删除失败而反复重试，反而放大问题。
  return writeJson(res, 200, {
    deleted: true,
    roomId: room.id,
    storageRemoved: removed
  }, corsHeaders(req))
}

async function cleanupRooms() {
  const now = Date.now()
  const idleCutoff = now - ROOM_TTL_MS
  const expired = []

  for (const room of rooms.values()) {
    const age = now - new Date(room.createdAt).getTime()
    // 空闲回收：无接收端且长时间无活动（上传会刷新 lastActivity，这是有意的）
    const expiredByIdle = room.lastActivity < idleCutoff && !room.receiver
    // 绝对年龄上限：**不豁免 receiver** —— 否则持一条 SSE 连接就能把房间与配额永久钉住，
    // 「绝对上限」也就名不副实了。
    const expiredByAge = age > ROOM_MAX_LIFETIME_MS

    if (expiredByIdle || expiredByAge) {
      expired.push({ room, age, reason: expiredByAge ? 'max_lifetime' : 'idle' })
    }
  }

  // 每个房间独立处理：一个房间删除失败不能中断整轮清理（否则后续房间永远等不到回收）
  for (const { room, age, reason } of expired) {
    auditLog('room_expired', {
      roomId: room.id,
      reason,
      ageMs: age,
      storedBytes: room.storedBytes ?? 0
    })

    try {
      await destroyRoom(room)
    } catch (error) {
      // destroyRoom 内部已经吞掉了 rm 失败；这里兜住任何意外，保证清理循环不中断
      auditLog('room_expire_failed', {
        roomId: room.id,
        message: error instanceof Error ? error.message : String(error)
      })
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
      await handleRoomDelete(req, res, roomId)
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
const RATE_LIMIT_WINDOW_MS = requirePositiveInt('RATE_LIMIT_WINDOW_MS', 60 * 1000)
const RATE_LIMIT_MAX = requirePositiveInt('RATE_LIMIT_MAX', 120)
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

setInterval(() => {
  const now = Date.now()
  for (const [ip, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(ip)
  }
  for (const [ip, bucket] of uploadByteBuckets) {
    if (bucket.resetAt <= now) uploadByteBuckets.delete(ip)
  }
}, RATE_LIMIT_WINDOW_MS).unref()

/**
 * 启动时扫描 UPLOAD_DIR。
 *
 * 房间只存在于内存，所以**启动瞬间磁盘上的每个目录都是「无主目录」** ——
 * 它们已无法通过任何 HTTP 路径访问（房间 404），却会被永久计入全局配额、把磁盘占住。
 *
 * ⚠️ 但回收**必须可判定**：只删「内含本程序写的归属标记、且标记里的 roomId 与目录名一致」的目录。
 * 无标记 / 标记不匹配 / 标记损坏的目录一律**不动**（宁可留一点占用，也不能误删运维自己的数据），
 * 并且不计入配额 —— 它们不是本程序产生的，与配额无关。
 */
async function measureDirectoryBytes(dirPath) {
  let total = 0
  const files = await readdir(dirPath, { withFileTypes: true })

  for (const file of files) {
    if (!file.isFile()) continue
    const fileStat = await stat(join(dirPath, file.name))
    total += fileStat.size
  }

  return total
}

async function initStoredBytes() {
  totalStoredBytes = 0

  let entries
  try {
    entries = await readdir(UPLOAD_DIR, { withFileTypes: true })
  } catch {
    // 目录不存在（首次启动），无需初始化
    return
  }

  let reclaimedDirs = 0
  let reclaimedBytes = 0
  let keptBytes = 0
  const foreignDirs = []
  let strayFiles = 0

  for (const entry of entries) {
    const entryPath = join(UPLOAD_DIR, entry.name)

    if (!entry.isDirectory()) {
      strayFiles += 1
      continue
    }

    const sentinelRoomId = await readRoomSentinel(entryPath)
    if (!sentinelRoomId || sentinelRoomId !== entry.name || !sanitizeRoomId(sentinelRoomId)) {
      foreignDirs.push(entry.name)
      continue
    }

    let dirBytes = 0
    try {
      dirBytes = await measureDirectoryBytes(entryPath)
    } catch {
      foreignDirs.push(entry.name)
      continue
    }

    if (KEEP_ORPHAN_UPLOADS) {
      keptBytes += dirBytes
      continue
    }

    try {
      await rm(entryPath, { recursive: true, force: true })
      reclaimedDirs += 1
      reclaimedBytes += dirBytes
    } catch (error) {
      // 删不掉就保留并计入配额 —— 启动过程绝不能因为一个目录删不掉而失败
      keptBytes += dirBytes
      console.warn(`[relay] 无主上传目录删除失败，已保留并计入配额：${entryPath} —— ${error instanceof Error ? error.message : error}`)
    }
  }

  if (reclaimedDirs > 0) {
    auditLog('orphan_uploads_reclaimed', { dirs: reclaimedDirs, bytes: reclaimedBytes })
    console.log(`[relay] 已回收 ${reclaimedDirs} 个无主上传目录（${reclaimedBytes} 字节）：房间仅存于内存，重启后这些文件已不可访问。`)
  }
  if (keptBytes > 0) {
    console.warn(`[relay] 保留了 ${keptBytes} 字节无主上传文件（RELAY_KEEP_ORPHAN_UPLOADS=true 或删除失败）：仍计入配额，只能人工清理。`)
  }
  if (foreignDirs.length > 0) {
    // 这里是刻意不删、也不计账的：无法证明它们是本程序产生的
    console.warn(`[relay] ⚠️ UPLOAD_DIR 下有 ${foreignDirs.length} 个目录不属于本程序（无有效归属标记），已跳过、不计入配额、也不会被删除：`)
    console.warn(`[relay]    ${foreignDirs.slice(0, 10).join(', ')}${foreignDirs.length > 10 ? ` …（共 ${foreignDirs.length} 个）` : ''}`)
    console.warn('[relay]    若确认这些是历史版本遗留的上传目录，请人工删除或迁移；UPLOAD_DIR 建议指向专用子目录。')
  }
  if (strayFiles > 0) {
    console.warn(`[relay] UPLOAD_DIR 根目录下有 ${strayFiles} 个散落文件：既不计入配额也不会被回收，请确认 UPLOAD_DIR 配置是否正确。`)
  }

  totalStoredBytes = keptBytes
}

setInterval(() => {
  // 定时任务绝不允许抛未处理拒绝 —— 那会让整个 relay 进程退出
  cleanupRooms().catch((error) => {
    console.error(`[relay] 房间清理任务异常：${error instanceof Error ? error.message : error}`)
  })
}, ROOM_CLEANUP_INTERVAL_MS).unref()

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
